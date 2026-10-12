import test from 'node:test';
import assert from 'node:assert/strict';
import { expandGroup, computeUnits } from '../schedule.js';

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
