// Derived views of the semester, shared by the app, the morning summary and the job. Pure.
//  - backlog: how much there is to catch up on, in lessons and in time
//  - readiness: before a quiz/exam, which lessons of its material are still unwatched
//  - submissions: Moodle's "assignment submitted" email → the matching task

import { recKey, sessionKey } from './recordings.js';

export const READINESS_KEY = 'prefs/readiness'; // on unless switched off
export const readinessOn = (progress) => progress?.[READINESS_KEY]?.d?.enabled !== false;

const isDone = (progress, key) => !!progress?.[key]?.s;

// Length of one lesson: its recording when known (Panopto), else the session's length.
export function unitMinutes(sem, progress, course, type, u) {
  const recs = sem.panopto ? progress?.[recKey(sem, course.code)]?.d : null;
  if (recs) {
    for (const { group, occ } of type.options || []) {
      const o = occ[u.n - 1];
      const ids = o && recs[sessionKey(group, o)];
      if (ids?.[0]?.[1]) return Math.round(ids[0][1] / 60);
    }
  }
  const o = u.own || u.first;
  return Math.round((o.end - o.start) / 60e3);
}

// Lessons held and not marked done: { total: { count, minutes }, byCourse: { code: { count, minutes } } }.
export function backlog(sem, courses, progress) {
  const out = { total: { count: 0, minutes: 0 }, byCourse: {} };
  for (const c of courses) {
    const mine = { count: 0, minutes: 0 };
    for (const t of c.types) {
      for (const u of t.units) {
        if (!u.available || isDone(progress, u.key)) continue;
        mine.count += 1;
        mine.minutes += unitMinutes(sem, progress, c, t, u);
      }
    }
    out.byCourse[c.code] = mine;
    out.total.count += mine.count;
    out.total.minutes += mine.minutes;
  }
  return out;
}

// "4.5 ש׳" / "50 דק׳"
export const hoursLabel = (min) => (min < 60 ? `${Math.round(min)} דק׳` : `${Math.round(min / 30) / 2} ש׳`);

// Lessons held so far in a course and how many of them are done (progress bars).
export function courseProgress(c, progress) {
  let held = 0;
  let done = 0;
  for (const t of c.types) {
    for (const u of t.units) {
      if (!u.available) continue;
      held += 1;
      if (isDone(progress, u.key)) done += 1;
    }
  }
  return { held, done, pct: held ? done / held : 1 };
}

const weekStart = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // Sunday
  return x;
};
const isFinal = (t) => /final/.test(t.id);

// Material of an exam and how ready the user is. Quizzes cover what was taught since the
// previous quiz's week up to the quiz's own week (not included); finals cover everything.
// exams: all exam tasks (any course). Returns null if not applicable.
export function readiness(courses, progress, exam, exams) {
  const c = courses.find((x) => x.code === exam.course);
  if (!c || !exam.dueDate) return null;
  let from = -Infinity;
  let until = +exam.dueDate;
  if (!isFinal(exam)) {
    until = +weekStart(exam.dueDate);
    const prev = exams
      .filter((e) => e.course === exam.course && !isFinal(e) && e.dueDate && e.dueDate < exam.dueDate)
      .sort((a, b) => b.dueDate - a.dueDate)[0];
    if (prev) from = +weekStart(prev.dueDate);
  }
  const units = c.types
    .filter((t) => isFinal(exam) || c.quizMaterial !== 'recitation' || t.type === 'recitation')
    .flatMap((t) => t.units.map((u) => ({ u, label: t.label })))
    .filter(({ u }) => +u.first.end >= from && +u.first.end < until);
  if (!units.length) return null;
  const done = units.filter(({ u }) => isDone(progress, u.key));
  const owed = units.filter(({ u }) => u.available && !isDone(progress, u.key));
  const upcoming = units.filter(({ u }) => !u.available);
  return { total: units.length, done: done.length, owed, upcoming: upcoming.length };
}

// ---------- submissions ----------
const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const firstNumber = (s) => {
  const m = (s || '').match(/\d+/);
  return m ? Number(m[0]) : null;
};

// Moodle's "אישור הגשת המטלה 'Ex 01'" → { course, name } (else null).
export function parseSubmission(msg) {
  const m = (msg.subject || '').match(/אישור הגשת המטלה\s*['׳"״]?(.+?)['׳"״]?\s*$/);
  if (!m) return null;
  const course = (msg.text || '').match(/^\s*(\d{5})/)?.[1] || (msg.subject || '').match(/\b(\d{5})\b/)?.[1] || '';
  return { course, name: m[1].trim() };
}

// The open task that a submitted assignment belongs to: the same name, else the only open
// homework of that course with the same number (e.g. "Ex 01" ↔ "תרגיל 01"), the one due
// nearest the submission if several. tasks: merged tasks ({ id, course, title, kind, done, dueDate }).
export function matchSubmission(sub, tasks, at) {
  if (!sub?.course) return null;
  const open = tasks.filter((t) => t.course === sub.course && t.kind !== 'exam' && !t.done);
  const name = norm(sub.name);
  const exact = open.find((t) => norm(t.title) === name || norm(t.title).startsWith(name) || name.startsWith(norm(t.title)));
  if (exact) return exact;
  const n = firstNumber(sub.name);
  if (n == null) return null;
  const same = open.filter((t) => firstNumber(t.title) === n);
  if (same.length <= 1) return same[0] || null;
  const when = +new Date(at);
  return same.sort((a, b) => Math.abs((a.dueDate || 0) - when) - Math.abs((b.dueDate || 0) - when))[0];
}
