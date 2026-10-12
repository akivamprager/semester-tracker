// Builds the morning notification text: today's sessions, lessons waiting to be caught up,
// and homework/exams coming up. Pure, so both the app (test button) and the GitHub Action
// (tools/morning.mjs) use it.
import { computeUnits, mergeTasks, DAY_LABELS } from './schedule.js';

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function dayDiff(d, now) {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(d); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

function when(t, now) {
  const n = dayDiff(t.dueDate, now);
  const time = t.due.includes('T') ? ' ' + hm(t.dueDate) : '';
  if (t.dueDate < now) return 'באיחור';
  if (n === 0) return 'היום' + time;
  if (n === 1) return 'מחר' + time;
  return `יום ${DAY_LABELS[t.dueDate.getDay()]}${time}`;
}

// Returns { title, body } or null when there is nothing to report.
export function dailySummary(sem, progress, now) {
  const courses = computeUnits(sem, now);
  const lines = [];

  const today = [];
  for (const c of courses) {
    for (const t of c.types) {
      for (const u of t.units) {
        if (u.own && dayDiff(u.own.start, now) === 0 && !progress[u.key]?.s) {
          const room = u.own.room ? ` (${u.own.room})` : '';
          today.push({ start: u.own.start, text: `${c.emoji} ${c.short} ${t.label} ${hm(u.own.start)}${room}` });
        }
      }
    }
  }
  if (today.length) {
    lines.push('📅 היום: ' + today.sort((a, b) => a.start - b.start).map((x) => x.text).join(' · '));
  }

  const owed = courses
    .map((c) => {
      const units = c.types
        .flatMap((t) => t.units)
        .filter((u) => u.available && !progress[u.key]?.s)
        .sort((a, b) => a.first.end - b.first.end);
      return { c, units };
    })
    .filter((x) => x.units.length)
    .sort((a, b) => a.units[0].first.end - b.units[0].first.end);
  if (owed.length) {
    lines.push('▶ להשלים: ' + owed.map(({ c, units }) => `${c.emoji} ${c.short} ${units.length}`).join(' · '));
  }

  const soon = new Date(now); soon.setDate(soon.getDate() + 3);
  const tasks = mergeTasks(sem, courses, progress, now).filter((t) => !t.done);
  const short = (code) => {
    const c = courses.find((x) => x.code === code);
    return c ? `${c.emoji} ${c.short}` : '';
  };
  const items = [
    ...tasks
      .filter((t) => t.kind === 'exam' && t.dueDate && t.dueDate >= now && t.dueDate <= soon)
      .map((t) => ({ d: t.dueDate, text: `📝 ${t.title} – ${short(t.course)} ${when(t, now)}` })),
    ...tasks
      .filter((t) => t.kind === 'hw' && t.dueDate && t.dueDate <= soon)
      .map((t) => ({ d: t.dueDate, text: `${t.title} – ${short(t.course)} ${when(t, now)}` })),
  ].sort((a, b) => a.d - b.d);
  if (items.length) {
    const shown = items.slice(0, 5).map((x) => x.text);
    if (items.length > 5) shown.push(`ועוד ${items.length - 5}`);
    lines.push('✏️ מטלות: ' + shown.join(' · '));
  }
  const practice = {};
  for (const t of tasks.filter((x) => x.kind === 'practice')) {
    practice[short(t.course)] = (practice[short(t.course)] || 0) + 1;
  }
  const practiceList = Object.entries(practice);
  if (practiceList.length) {
    lines.push('📘 לא נבדקים: ' + practiceList.map(([c, n]) => `${c} ${n}`).join(' · '));
  }

  if (!lines.length) return null;
  const owedCount = owed.reduce((n, { units }) => n + units.length, 0);
  const urgent = tasks.filter((t) => t.kind === 'hw' && t.dueDate && t.dueDate <= soon).length;
  return {
    title: `בוקר טוב! יום ${DAY_LABELS[now.getDay()]} ${now.getDate()}.${now.getMonth() + 1}`,
    body: lines.join('\n'),
    badge: owedCount + urgent, // same number the app shows on its icon
  };
}
