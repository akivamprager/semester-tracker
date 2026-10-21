import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWidget, widgetFile, sameWidget } from '../widget.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const now = new Date('2026-10-18T09:00:00+03:00'); // Sunday

test('buildWidget: own sessions ahead, catch-up with times, done items left out', () => {
  const key = '2027A/83325/lecture/1';
  const w = buildWidget(sem, { [key]: { s: 'done', t: 1 } }, now);
  assert.ok(w.sessions.length > 0);
  assert.ok(w.sessions.every((s) => new Date(s.end) > new Date('2026-10-18T00:00:00+03:00')));
  assert.ok(w.sessions.every((s, i, a) => i === 0 || a[i - 1].start <= s.start));
  assert.ok(!w.catchUp.some((u) => u.key === key));
  assert.ok(w.catchUp.some((u) => new Date(u.availableAt) <= now)); // something is already owed
  assert.ok(w.catchUp.some((u) => new Date(u.availableAt) > now)); // and later ones come with their time
  for (const t of w.tasks) assert.match(t.key, /^2027A\/task\//);
});

test('sameWidget ignores generatedAt', () => {
  const w = buildWidget(sem, {}, now);
  assert.ok(sameWidget(widgetFile(w, now), w));
  assert.ok(sameWidget(widgetFile(w, new Date(+now + 60e3)), w));
  assert.ok(!sameWidget(widgetFile({ ...w, inbox: 99 }, now), w));
  assert.ok(!sameWidget(undefined, w));
});

test('home days: no "next class" in the widget, 🏠 in the calendar and the morning summary', async () => {
  const { buildCalendar } = await import('../calendar.js');
  const { dailySummary } = await import('../summary.js');
  const home = { 'prefs/home': { s: 'set', t: 1, d: { days: [1] } } }; // Monday
  const monday = new Date('2026-10-19T08:00:00+03:00');
  const w = buildWidget(sem, home, monday);
  assert.ok(!w.sessions.some((s) => new Date(s.start).getDay() === 1));
  assert.ok(buildWidget(sem, {}, monday).sessions.some((s) => new Date(s.start).getDay() === 1));
  const ics = buildCalendar(sem, home);
  assert.match(ics, /SUMMARY:🏠 🌊 גלים · הרצאה/);
  assert.match(ics, /LOCATION:בבית \(הקלטה\)/);
  assert.match(dailySummary(sem, home, monday)?.body || '', /🏠 בבית/);
});

test('in-person sessions (Waves quizzes) override a home day: shown, ❗ in the calendar, exam task', async () => {
  const { buildCalendar } = await import('../calendar.js');
  const { mergeTasks, computeUnits } = await import('../schedule.js');
  const home = { 'prefs/home': { s: 'set', t: 1, d: { days: [1] } } };
  const quizDay = new Date('2026-10-26T07:00:00+02:00'); // Monday, recitation 3
  const w = buildWidget(sem, home, quizDay);
  assert.ok(w.sessions.some((s) => s.course === '83325' && /בוחן/.test(s.label)));
  assert.ok(!w.sessions.some((s) => s.course === '83325' && /הרצאה/.test(s.label) && s.start.startsWith('2026-10-26'))); // lecture: still at home
  assert.match(buildCalendar(sem, home), /SUMMARY:❗ 🌊 גלים · תרגול 3 · בוחן/);
  const quizzes = mergeTasks(sem, computeUnits(sem, quizDay), {}, quizDay).filter((t) => t.id.startsWith('83325-quiz'));
  assert.deepEqual(quizzes.map((t) => t.due), ['2026-10-26T10:00', '2026-11-16T10:00', '2026-12-14T10:00', '2027-01-04T10:00']);
});
