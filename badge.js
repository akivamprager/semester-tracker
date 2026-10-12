// What the number on the app icon counts. Shared by the app and the morning push
// (tools/morning.mjs via summary.js), configured in Settings and stored in the synced
// progress map under PREFS_KEY so every device and the push use the same choice.
import { mergeTasks, sessionsBetween } from './schedule.js';

export const PREFS_KEY = 'prefs/badge';

export const BADGE_DEFAULTS = {
  lessons: true, // lectures/recitations already held that aren't marked done
  hw: true, // graded homework due within hwDays (or overdue)
  hwDays: 3,
  practice: false, // ungraded practice still open
  exams: false, // exams within examDays
  examDays: 3,
  today: false, // sessions (any group) still ahead today for material not yet done
};

export const badgePrefs = (progress) => ({ ...BADGE_DEFAULTS, ...(progress[PREFS_KEY]?.d || {}) });

const daysFrom = (now, n) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };

// Returns { total, parts: { lessons, hw, practice, exams, today } } (only enabled parts).
export function badgeCount(sem, courses, progress, now, prefs = badgePrefs(progress)) {
  const parts = {};
  const done = (key) => !!progress[key]?.s;
  if (prefs.lessons) {
    parts.lessons = courses
      .flatMap((c) => c.types.flatMap((t) => t.units))
      .filter((u) => u.available && !done(u.key)).length;
  }
  if (prefs.hw || prefs.practice || prefs.exams) {
    const tasks = mergeTasks(sem, courses, progress, now).filter((t) => !t.done);
    if (prefs.hw) {
      const until = daysFrom(now, prefs.hwDays);
      parts.hw = tasks.filter((t) => t.kind === 'hw' && t.dueDate && t.dueDate <= until).length;
    }
    if (prefs.practice) parts.practice = tasks.filter((t) => t.kind === 'practice').length;
    if (prefs.exams) {
      const until = daysFrom(now, prefs.examDays);
      parts.exams = tasks.filter((t) => t.kind === 'exam' && t.dueDate && t.dueDate >= now && t.dueDate <= until).length;
    }
  }
  if (prefs.today) {
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    parts.today = sessionsBetween(courses, now, midnight).filter((x) => !done(x.unit.key)).length;
  }
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}
