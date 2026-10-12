process.env.TZ = 'Asia/Jerusalem';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCalendar } from '../calendar.js';
import { parseIcs } from '../ics.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));

test('calendar: own sessions (with rooms, moved sessions) and deadlines; deterministic', () => {
  const ics = buildCalendar(sem, {});
  assert.equal(ics, buildCalendar(sem, {}));
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  const events = parseIcs(ics);
  const waves = events.filter((e) => e.summary.includes('גלים'));
  // Sun 1.11: lecture at 14:00 and the moved lecture at 16:00 (Kanada); own recitation moved to Mon 2.11 12:00.
  const on = (d, m) => waves.filter((e) => e.start.getDate() === d && e.start.getMonth() === m - 1)
    .map((e) => `${e.start.getHours()}:${e.summary.split('· ')[1]}`);
  assert.deepEqual(on(1, 11), ['14:הרצאה 7', '16:הרצאה 8']);
  assert.deepEqual(on(2, 11), ['12:תרגול 4']);
  assert.ok(ics.includes('LOCATION:קנדה'));
  const lab1 = events.find((e) => e.uid === 'task-67315-lab-1@semester-tracker');
  assert.equal(lab1.start.getHours(), 23);
  assert.ok(lab1.summary.startsWith('✏️ מעבדה 1'));
});

test('calendar marks done items with ✓', () => {
  const key = '2027A/83325/lecture/1';
  const ics = buildCalendar(sem, { [key]: { s: 'done', t: 1 } });
  const ev = parseIcs(ics).find((e) => e.uid === '2027A-83325-lecture-1@semester-tracker');
  assert.ok(ev.summary.startsWith('✓ '));
});
