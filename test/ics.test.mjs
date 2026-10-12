process.env.TZ = 'Asia/Jerusalem';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIcs, icsTaskChanges, cleanTitle } from '../ics.js';
import { computeUnits, mergeTasks } from '../schedule.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const ics = (events) => ['BEGIN:VCALENDAR', ...events.flatMap((e) => [
  'BEGIN:VEVENT', `UID:${e.uid}@moodle.huji.ac.il/2026-27`, `SUMMARY:${e.summary}`,
  `DTSTART:${e.start}`, `CATEGORIES:${e.cat}`, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const tasksAt = (now) => mergeTasks(sem, computeUnits(sem, now), {}, now);

test('weekly lab rule matches Moodle: opens Sun 08:00, due next Thu 23:59, skips Hanukkah', () => {
  const all = tasksAt(new Date(2027, 1, 1));
  const lab = (n) => all.find((t) => t.id === `67315-lab-${n}`);
  assert.equal(lab(1).due, '2026-10-22T23:59');
  assert.equal(lab(3).due, '2026-11-05T23:59');
  assert.equal(lab(6).due, '2026-11-26T23:59');
  assert.equal(lab(9).due, '2026-12-24T23:59'); // week of 13.12 (after the Hanukkah break)
  assert.equal(lab(6).estimated, false);
  assert.equal(lab(7).estimated, true);
});

test('labs stay hidden until they open', () => {
  const ids = tasksAt(new Date(2026, 9, 17, 12)).map((t) => t.id);
  assert.ok(ids.includes('67315-lab-1'));
  assert.ok(!ids.includes('67315-lab-2')); // opens Sun 18.10 08:00
});

test('Moodle export: UTC → Israel time, rules, no duplicates', () => {
  const events = parseIcs(ics([
    { uid: 1, summary: 'C Lab week 2 closes', start: '20261029T215900Z', cat: '67315_1-C' },
    { uid: 2, summary: 'C Lab week 7 closes', start: '20261204T100000Z', cat: '67315_1-C' },
    { uid: 3, summary: 'נוכחות הרצאות', start: '20261013T090000Z', cat: '67315_1-C' },
    { uid: 46354, summary: 'תרגיל 1- אוסילטור הרמוני\\, קירובים is due', start: '20261019T205900Z', cat: '83325-גלים' },
    { uid: 99, summary: 'Ex 09 2025-26 is due', start: '20261215T085839Z', cat: '83335-EE' },
    { uid: 98, summary: 'Something opens', start: '20261215T085839Z', cat: '83335-EE' },
  ]));
  const changes = icsTaskChanges(sem, events, tasksAt(new Date(2027, 1, 1)));
  assert.deepEqual(changes, [
    { id: '67315-lab-7', d: { due: '2026-12-04T12:00' } }, // differs from the rule → update
    { id: 'ics-99', d: { course: '83335', title: 'Ex 09', kind: 'hw', due: '2026-12-15T10:58', note: 'מהמודל' } },
  ]); // lab 2 and the waves exercise already match; attendance ignored; "opens" skipped
});

test('the real export adds nothing new (already in the semester data)', () => {
  const text = readFileSync(new URL('./fixtures/moodle-sample.ics', import.meta.url), 'utf8');
  assert.deepEqual(icsTaskChanges(sem, parseIcs(text), tasksAt(new Date(2027, 1, 1))), []);
});

test('cleanTitle', () => {
  assert.equal(cleanTitle('תרגיל 02 2025-26 is due'), 'תרגיל 02');
});

test('import also updates tasks that are still hidden', () => {
  const now = new Date(2026, 9, 12);
  const all = mergeTasks(sem, computeUnits(sem, now), {}, now, { includeHidden: true });
  const events = parseIcs(ics([{ uid: 2, summary: 'C Lab week 7 closes', start: '20261204T215900Z', cat: '67315_1-C' }]));
  assert.deepEqual(icsTaskChanges(sem, events, all), [{ id: '67315-lab-7', d: { due: '2026-12-04T23:59' } }]);
});
