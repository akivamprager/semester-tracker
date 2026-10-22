import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeUnits, mergeTasks } from '../schedule.js';
import { backlog, hoursLabel, courseProgress, readiness, parseSubmission, matchSubmission } from '../insights.js';
import { mailInboxUpdates } from '../mail.js';
import { courseSnapshot, diffShnaton } from '../shnaton.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const now = new Date('2026-10-22T18:00:00+03:00');
const courses = computeUnits(sem, now);

test('backlog counts held, unmarked lessons and their minutes', () => {
  const all = backlog(sem, courses, {});
  assert.ok(all.total.count > 0 && all.total.minutes >= all.total.count * 45);
  const waves = courses.find((c) => c.code === '83325');
  const first = waves.types[0].units[0];
  const less = backlog(sem, courses, { [first.key]: { s: 'done', t: 1 } });
  assert.equal(less.byCourse['83325'].count, all.byCourse['83325'].count - 1);
  assert.equal(hoursLabel(270), '4.5 ש׳');
  assert.equal(hoursLabel(50), '50 דק׳');
  const p = courseProgress(waves, { [first.key]: { s: 'done', t: 1 } });
  assert.ok(p.held >= 1 && p.done === 1);
});

test('readiness: a quiz covers the lessons before its week, since the previous quiz', () => {
  const tasks = mergeTasks(sem, courses, {}, now).filter((t) => t.kind === 'exam');
  const q1 = tasks.find((t) => t.id === '83325-quiz-1'); // Monday 26.10 → material up to Sat 24.10
  const r1 = readiness(courses, {}, q1, tasks);
  assert.ok(r1.total > 0 && r1.done === 0 && r1.upcoming === 0);
  assert.ok(r1.owed.every(({ u }) => u.first.end < new Date('2026-10-25T00:00:00+03:00')));
  const q2 = tasks.find((t) => t.id === '83325-quiz-2');
  const r2 = readiness(courses, {}, q2, tasks);
  assert.ok(r2.owed.every(({ u }) => u.first.end >= new Date('2026-10-25T00:00:00+03:00'))); // after quiz 1's week
  const final = readiness(courses, {}, tasks.find((t) => t.id === '83325-final-a'), tasks);
  assert.ok(final.total > r1.total + r2.total - 1);
});

test('submissions: same name, or the same number in another language', () => {
  const tasks = mergeTasks(sem, courses, {}, now, { includeHidden: true });
  const ee = parseSubmission({ subject: "אישור הגשת המטלה 'Ex 01'", text: '83335-מבוא להנדסת חשמל -> מטלה -> Ex 01' });
  assert.deepEqual(ee, { course: '83335', name: 'Ex 01' });
  assert.equal(matchSubmission(ee, tasks, '2026-10-18T14:28:02Z').id, 'ics-54051'); // "תרגיל 01"
  const waves = parseSubmission({ subject: "אישור הגשת המטלה 'תרגיל 1- אוסילטור הרמוני, קירובים'", text: '83325-גלים ויסודות פיסיקה א -> מטלה -> …' });
  assert.equal(matchSubmission(waves, tasks, '2026-10-18T06:50:14Z').id, 'ics-46354');
  assert.equal(parseSubmission({ subject: 'ברוכים הבאים', text: '' }), null);
});

test('mail: a submission confirmation ticks its task, quietly, once', () => {
  const tasks = mergeTasks(sem, courses, {}, now, { includeHidden: true });
  const mail = { messages: [{ id: 's1', from: 'noreply@moodle.huji.ac.il', subject: "אישור הגשת המטלה 'Ex 01'", date: '2026-10-18T14:28:02Z', text: '83335-מבוא להנדסת חשמל -> מטלה -> Ex 01' }] };
  const { updates, notify } = mailInboxUpdates(sem, mail, {}, now, tasks);
  assert.equal(updates['2027A/task/ics-54051'].s, 'done');
  assert.equal(updates['2027A/inbox/mail-s1'].d.icon, '✅');
  assert.equal(updates['2027A/inbox/mail-s1'].d.read, true);
  assert.deepEqual(notify, []);
  const again = mailInboxUpdates(sem, mail, updates, now, tasks);
  assert.ok(!again.updates['2027A/task/ics-54051']); // already processed → never re-ticks
});

test('shnaton: snapshot without emails; room, teacher and session changes become messages', () => {
  const group = (room, teacher, dates) => ({
    code: '2-03', studySessionTypeCode: '2', studySessions: [{
      dayOfWeek: 1, startTime: 36000000, endTime: 42300000, room: { name: { he: room } },
      teachers: [{ name: { he: teacher }, hujiEmail: 'x@mail.huji.ac.il' }],
      studySessionSchedules: dates.map((d) => ({ date: `${d}T00:00:00`, startTime: null, room: null })),
    }],
  });
  const a = { 83325: courseSnapshot([group('ברנדמן ב 102', 'יואב בן חיים', ['2026-10-26', '2026-11-02'])]) };
  assert.ok(!JSON.stringify(a).includes('@'));
  assert.equal(a[83325]['2-03'].slots[0], '1|10:00|11:45|ברנדמן ב 102');
  const b = { 83325: courseSnapshot([group('קפלן', 'יוגב קורן', ['2026-10-26'])]) };
  const msgs = diffShnaton(a, b, '2026-10-22', { 83325: 'גלים' }).map((m) => m.text);
  assert.equal(msgs.length, 3);
  assert.ok(msgs.some((m) => m.includes('בקפלן')) && msgs.some((m) => m.includes('יוגב קורן')) && msgs.some((m) => m.includes('2.11')));
  assert.deepEqual(diffShnaton(null, b, '2026-10-22'), []); // first fetch = baseline
});
