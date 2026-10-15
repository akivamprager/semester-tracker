import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandGroup, computeUnits, ymd } from '../schedule.js';

// 2026-11-01 is a Sunday.
const sem = {
  id: 'T',
  start: '2026-11-01',
  end: '2026-11-21',
  noClass: [{ from: '2026-11-09', to: '2026-11-10' }],
  cancellations: [{ course: 'C1', group: '1-02', date: '2026-11-16' }],
  extras: [{ course: 'C1', group: '1-02', date: '2026-11-20', start: '09:00', end: '10:00' }],
  courses: [
    {
      code: 'C1',
      name: 'Course 1',
      myGroups: { lecture: '1-01', recitation: '2-01' },
      groups: [
        { code: '1-01', type: 'lecture', slots: [{ day: 3, start: '10:00', end: '12:00' }] }, // Wed
        { code: '1-02', type: 'lecture', slots: [{ day: 1, start: '14:00', end: '16:00' }] }, // Mon
        { code: '1-03', type: 'lecture', slots: [
          { day: 0, start: '08:00', end: '09:00' }, { day: 2, start: '08:00', end: '09:00' }] },
        { code: '2-01', type: 'recitation', slots: [{ day: 4, start: '12:00', end: '13:00' }] },
      ],
    },
  ],
};
const course = sem.courses[0];
const days = (g) => expandGroup(sem, course, g).map((o) => o.start.getDate());

test('expansion skips holidays and cancellations, adds extras', () => {
  assert.deepEqual(days(course.groups[0]), [4, 11, 18]);
  assert.deepEqual(days(course.groups[1]), [2, 20]); // 9 holiday, 16 cancelled, 20 makeup
});

test('running count: another group makes my unit available early', () => {
  const now = new Date(2026, 10, 2, 17, 0); // Mon after 1-02 lecture
  const [c] = computeUnits(sem, now);
  const lec = c.types.find((t) => t.type === 'lecture');
  assert.equal(lec.units.length, 3);
  assert.equal(lec.units[0].available, true);
  assert.equal(lec.units[0].first.group.code, '1-02');
  assert.equal(lec.units[1].available, false);
  const rec = c.types.find((t) => t.type === 'recitation');
  assert.equal(rec.units[0].available, false);
});

test('group with different slot count is not compared', () => {
  const now = new Date(2026, 10, 1, 10, 0); // Sunday after 1-03's 08:00 lecture
  const [c] = computeUnits(sem, now);
  assert.equal(c.types[0].units[0].available, false);
});

test('unit keys and later availability', () => {
  const now = new Date(2026, 10, 30);
  const [c] = computeUnits(sem, now);
  assert.equal(c.types[0].units[2].key, 'T/C1/lecture/3');
  assert.ok(c.types.every((t) => t.units.every((u) => u.available)));
  assert.equal(c.types[0].units[1].first.group.code, '1-01'); // 1-02's #2 is the 20th makeup
});

test('units cover the group with the most sessions; generated tasks use the last group', async () => {
  const { builtinTasks } = await import('../schedule.js');
  const s = structuredClone(sem);
  s.courses[0].groups[1].slots = [{ day: 0, start: '14:00', end: '16:00' }]; // Sun group, no holiday loss
  s.cancellations = [];
  s.extras = [];
  s.generatedTasks = [{ id: 'lab', course: 'C1', type: 'lecture', count: 2, offsetDays: 7, title: 'Lab {n}' }];
  const courses = computeUnits(s, new Date(2026, 10, 30));
  const lec = courses[0].types[0];
  assert.equal(lec.units.length, 3); // Sun: 1, 8, 15 / Wed: 4, 11, 18
  const tasks = builtinTasks(s, courses);
  assert.deepEqual(tasks.map((t) => [t.title, t.due]), [['Lab 1', '2026-11-11T12:00'], ['Lab 2', '2026-11-18T12:00']]);
});

test('sessionsBetween lists every comparable group, with unit numbers', async () => {
  const { sessionsBetween } = await import('../schedule.js');
  const courses = computeUnits(sem, new Date(2026, 10, 1));
  const list = sessionsBetween(courses, new Date(2026, 10, 1), new Date(2026, 10, 5));
  // 1–4.11: Mon 2.11 group 1-02 lecture #1, Wed 4.11 own group 1-01 lecture #1
  // (the 1-03 group meets twice a week, so it isn't comparable and isn't listed).
  assert.deepEqual(list.map((x) => [x.occ.start.getDate(), x.group.code, x.unit.n, x.mine]), [
    [2, '1-02', 1, false],
    [4, '1-01', 1, true],
  ]);
});

test('gaps between own sessions (≥30 min; 15-min breaks are not gaps)', async () => {
  const { readFileSync } = await import('node:fs');
  const { gapsOn } = await import('../schedule.js');
  const real = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
  const courses = computeUnits(real, new Date(2027, 1, 1));
  const hm = (d) => d.toTimeString().slice(0, 5);
  const g = (d) => gapsOn(courses, new Date(2026, 10, d)).map((x) => `${hm(x.start)}-${hm(x.end)}`);
  assert.deepEqual(g(11), ['11:45-13:00']); // Wed: EE lecture → C/C++ recitation
  assert.deepEqual(g(10), []); // Tue: back to back
  assert.deepEqual(g(12), []); // Thu: back to back
});

test('roomChanges: permanent move from a date, earlier sessions keep the old room', () => {
  const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
  const course = sem.courses.find((c) => c.code === '83335');
  const occ = expandGroup(sem, course, course.groups.find((g) => g.code === '1-01'));
  const on = (ds) => occ.find((o) => ymd(o.start) === ds).room;
  assert.equal(on('2026-10-14'), 'ברנדמן ב 101');
  assert.equal(on('2026-10-21'), 'אולם קפלן');
  const rec = expandGroup(sem, course, course.groups.find((g) => g.code === '2-03'));
  assert.equal(rec.find((o) => ymd(o.start) === '2026-10-21').room, 'ברנדמן ב 101');
});
