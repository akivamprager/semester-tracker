// Builds the subscription calendar (.ics) of the user's own sessions, deadlines and exams.
// Written to the sync gist as calendar.ics (by the app on sync and by tools/morning.mjs),
// so Google Calendar / Apple Calendar can subscribe to its raw URL.
// Output is deterministic (no "now" inside) so it's only re-uploaded when it changes.
import { computeUnits, mergeTasks, ymd, homeSession, inPersonRule, personalBetween } from './schedule.js';
import { planSemester, prayerPrefs, prayerKey, PRAYER_LABELS } from './prayer.js';

export const CALENDAR_FILE = 'calendar.ics';

const pad = (n) => String(n).padStart(2, '0');
const utc = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const dateOnly = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

// RFC 5545: lines longer than 75 octets are folded (continuation lines start with a space).
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildCalendar(sem, progress) {
  // Everything here is independent of the current time: compute as if after the semester.
  const after = new Date(8640000000000000);
  const courses = computeUnits(sem, after);
  const stamp = utc(new Date(`${sem.start}T00:00:00Z`));
  const events = [];
  const add = (fields) => events.push(['BEGIN:VEVENT', `DTSTAMP:${stamp}`, ...fields, 'END:VEVENT']);

  for (const c of courses) {
    for (const t of c.types) {
      for (const u of t.units) {
        const o = u.own;
        if (!o) continue;
        const done = !!progress[u.key]?.s;
        const home = homeSession(sem, progress, c.code, t.type, u); // 🏠 = watched at home: no reminder (Apps Script)
        const must = inPersonRule(sem, c.code, t.type, u.n); // ❗ = attendance required (e.g. a quiz)
        add([
          `UID:${u.key.replace(/\//g, '-')}@semester-tracker`,
          `DTSTART:${utc(o.start)}`,
          `DTEND:${utc(o.end)}`,
          `SUMMARY:${text(`${done ? '✓ ' : ''}${home ? '🏠 ' : ''}${must ? '❗ ' : ''}${c.emoji} ${c.short} · ${t.label} ${u.n}${must ? ` · ${must.label}` : ''}`)}`,
          home ? `LOCATION:${text('בבית (הקלטה)')}` : o.room ? `LOCATION:${text(o.room)}` : null,
          `DESCRIPTION:${text([must ? `${must.label} — חובת נוכחות` : '', u.topic, t.mine.lecturer, `קבוצה ${t.mine.code}`, c.name].filter(Boolean).join('\n'))}`,
          `CATEGORIES:${text(c.short)}`,
        ].filter(Boolean));
      }
    }
  }

  // personal weekly commitments (⚙️ → קבועים)
  for (const x of personalBetween(sem, new Date(`${sem.start}T00:00:00`), new Date(`${sem.end}T23:59:59`))) {
    add([
      `UID:${x.key.replace(/\//g, '-')}@semester-tracker`,
      `DTSTART:${utc(x.start)}`,
      `DTEND:${utc(x.end)}`,
      `SUMMARY:${text(`${x.item.emoji || '📌'} ${x.item.title}`)}`,
      x.item.place ? `LOCATION:${text(x.item.place)}` : null,
    ].filter(Boolean));
  }

  for (const p of planSemester(sem, courses, prayerPrefs(progress))) {
    add([
      `UID:prayer-${ymd(p.start)}-${p.prayer}@semester-tracker`,
      `DTSTART:${utc(p.start)}`,
      `DTEND:${utc(p.end)}`,
      `SUMMARY:${text(`${progress[prayerKey(sem, p)]?.s ? '✓ ' : ''}🙏 ${PRAYER_LABELS[p.prayer]}${p.minyan.sunsetOffset != null ? ' (≈)' : ''}`)}`,
      `LOCATION:${text(p.minyan.place)}`,
      p.minyan.note ? `DESCRIPTION:${text(p.minyan.note)}` : null,
    ].filter(Boolean));
  }

  const tasks = mergeTasks(sem, courses, progress, after);
  for (const task of tasks) {
    if (!task.dueDate) continue;
    const c = courses.find((x) => x.code === task.course);
    const icon = task.kind === 'exam' ? '📝' : task.kind === 'practice' ? '📘' : '✏️';
    const title = `${task.done ? '✓ ' : ''}${icon} ${task.title}${c ? ` (${c.short})` : ''}`;
    const timed = task.due.includes('T');
    const when = timed
      ? [`DTSTART:${utc(task.dueDate)}`, `DTEND:${utc(new Date(+task.dueDate + (task.kind === 'exam' ? 3 * 3600e3 : 15 * 60e3)))}`]
      : [`DTSTART;VALUE=DATE:${dateOnly(task.dueDate)}`];
    add([
      `UID:task-${task.id}@semester-tracker`,
      ...when,
      `SUMMARY:${text(title)}`,
      task.note ? `DESCRIPTION:${text(task.note)}` : null,
      c ? `CATEGORIES:${text(c.short)}` : null,
    ].filter(Boolean));
  }

  // notes for a day (all-day event with the plan in the description)
  for (const n of sem.dayNotes || []) {
    const d = new Date(`${n.date}T00:00:00`);
    add([
      `UID:note-${n.date}@semester-tracker`,
      `DTSTART;VALUE=DATE:${dateOnly(d)}`,
      `SUMMARY:${text(n.title)}`,
      `DESCRIPTION:${text(n.lines.join('\n'))}`,
    ]);
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//semester-tracker//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(`הסמסטרון · ${sem.name}`)}`,
    'X-WR-TIMEZONE:Asia/Jerusalem',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...events.flat(),
    'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}
