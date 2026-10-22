// The Shnaton (HUJI course catalog) as a compact snapshot, and what changed between two
// snapshots → messages for the notification center. Pure; tools/morning.mjs fetches
// https://shnaton.huji.ac.il/api/courses/groups-with-sessions and keeps the last snapshot in
// the private gist (shnaton.json). Staff emails in the feed are never kept.
//
// snapshot = { <course code>: { <group code>: { type, teachers: [names], slots: ["d|HH:MM|HH:MM|room"],
//                                               dates: { "YYYY-MM-DD": "HH:MM|room" (overrides) or "" } } } }

export const SHNATON_FILE = 'shnaton.json';
export const SHNATON_API = 'https://shnaton.huji.ac.il/api';

const hhmm = (ms) => {
  if (ms == null) return '';
  const m = Math.round(ms / 60000);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const TYPES = { 1: 'lecture', 2: 'recitation' };

// groups: the API's array of groups for one course.
export function courseSnapshot(groups) {
  const out = {};
  for (const g of groups || []) {
    const teachers = new Set();
    const slots = [];
    const dates = {};
    for (const s of g.studySessions || []) {
      for (const t of s.teachers || []) if (t.name?.he) teachers.add(t.name.he);
      const room = s.room?.name?.he || '';
      slots.push(`${s.dayOfWeek}|${hhmm(s.startTime)}|${hhmm(s.endTime)}|${room}`);
      for (const d of s.studySessionSchedules || []) {
        const date = (d.date || '').slice(0, 10);
        if (!date) continue;
        // a date-specific time or room (else "" = as usual)
        const over = d.startTime != null || d.room ? `${hhmm(d.startTime ?? s.startTime)}|${d.room?.name?.he || room}` : '';
        dates[date] = over;
      }
    }
    out[g.code] = {
      type: TYPES[g.studySessionTypeCode] || g.studySessionTypeName?.he || '',
      teachers: [...teachers].sort(),
      slots: slots.sort(),
      dates,
    };
  }
  return out;
}

const slotText = (s) => {
  const [d, a, b, room] = s.split('|');
  return `יום ${DAYS[d] || d} ${a}–${b}${room ? ` ב${room}` : ''}`;
};
const dm = (date) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;

// Readable changes between two snapshots, only for dates from `today` on.
// names: { code: short name } for the messages.
export function diffShnaton(prev, next, today, names = {}) {
  const out = [];
  for (const [code, groups] of Object.entries(next)) {
    const before = prev?.[code];
    if (!before) continue; // first time this course is seen: baseline
    const who = (g, x) => `${names[code] || code} · ${x?.type === 'lecture' ? 'הרצאה' : x?.type === 'recitation' ? 'תרגול' : ''} קב׳ ${g}`;
    for (const [g, x] of Object.entries(groups)) {
      const p = before[g];
      if (!p) { out.push({ course: code, text: `קבוצה חדשה — ${who(g, x)}: ${x.slots.map(slotText).join(', ')}` }); continue; }
      if (p.slots.join() !== x.slots.join()) {
        out.push({ course: code, text: `${who(g, x)}: ${p.slots.map(slotText).join(', ')} ← ${x.slots.map(slotText).join(', ')}` });
      }
      if (p.teachers.join() !== x.teachers.join()) {
        out.push({ course: code, text: `${who(g, x)}: מרצה/מתרגל ${p.teachers.join(', ') || '—'} ← ${x.teachers.join(', ') || '—'}` });
      }
      for (const date of Object.keys({ ...p.dates, ...x.dates }).sort()) {
        if (date < today) continue;
        const a = p.dates[date];
        const b = x.dates[date];
        if (a === b) continue;
        if (b === undefined) out.push({ course: code, text: `${who(g, x)}: המפגש ב-${dm(date)} הוסר (ביטול?)` });
        else if (a === undefined) out.push({ course: code, text: `${who(g, x)}: מפגש נוסף ב-${dm(date)}${b ? ` (${b.replace('|', ' ב')})` : ''}` });
        else out.push({ course: code, text: `${who(g, x)}: ב-${dm(date)} ${b ? b.replace('|', ' ב') : 'כרגיל'}${a ? ` (במקום ${a.replace('|', ' ב')})` : ''}` });
      }
    }
    for (const g of Object.keys(before)) {
      if (!groups[g]) out.push({ course: code, text: `${who(g, before[g])}: הקבוצה הוסרה מהשנתון` });
    }
  }
  return out;
}
