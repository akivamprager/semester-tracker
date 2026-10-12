process.env.TZ = 'Asia/Jerusalem';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeUnits } from '../schedule.js';
import { badgeCount, PREFS_KEY } from '../badge.js';
import { dailySummary } from '../summary.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const now = new Date(2026, 10, 2, 9, 30); // Mon 2.11 09:30
const courses = computeUnits(sem, now);

test('default badge = lessons to catch up + graded homework within 3 days', () => {
  const { total, parts } = badgeCount(sem, courses, {}, now);
  assert.deepEqual(Object.keys(parts), ['lessons', 'hw']);
  assert.equal(total, parts.lessons + parts.hw);
  assert.ok(parts.lessons > 0 && parts.hw > 0);
});

test('custom prefs: only exams within 1 day and sessions left today', () => {
  const prefs = { lessons: false, hw: false, practice: false, exams: true, examDays: 1, today: true };
  const { parts } = badgeCount(sem, courses, {}, now, prefs);
  assert.equal(parts.exams, 1); // probability quiz 1, Tue 3.11 09:00
  assert.equal(parts.today, 6); // 2.11 from 09:30: 10:00, 12:00 ×3, 14:00, 16:00
});

test('marking a lesson done lowers the count; prefs from synced progress reach the push', () => {
  const before = badgeCount(sem, courses, {}, now).parts.lessons;
  const key = courses.find((c) => c.code === '83325').types[0].units[0].key;
  assert.equal(badgeCount(sem, courses, { [key]: { s: 'done', t: 1 } }, now).parts.lessons, before - 1);
  const progress = { [PREFS_KEY]: { s: 'set', t: 1, d: { lessons: false, hw: false } } };
  assert.equal(dailySummary(sem, progress, now).badge, 0);
});
