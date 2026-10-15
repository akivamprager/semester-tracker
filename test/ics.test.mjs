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

// Apply import changes the way the app/morning job do: merge into <sem>/taskdata/<id>.
function applyChanges(progress, changes) {
  const out = { ...progress };
  for (const { id, d } of changes) {
    const key = `${sem.id}/taskdata/${id}`;
    out[key] = { s: 'set', d: { ...(out[key]?.d || {}), ...d }, t: 1 };
  }
  return out;
}

test('an outdated export (12.10) cannot bring back assignments Moodle has deleted', () => {
  const now = new Date(2026, 9, 14, 12);
  const old = parseIcs(readFileSync(new URL('./fixtures/moodle-sample.ics', import.meta.url), 'utf8'));
  const tasks = mergeTasks(sem, computeUnits(sem, now), {}, now, { includeHidden: true });
  const progress = applyChanges({}, icsTaskChanges(sem, old, tasks, { now }));
  const visible = mergeTasks(sem, computeUnits(sem, now), progress, now).map((x) => x.id);
  for (const id of ['ics-54053', 'ics-54054', 'ics-54055', 'ics-54056', 'ics-54058']) assert.ok(!visible.includes(id), id);
});

test('live export (Hebrew titles, C++ labs, deletions)', () => {
  const now = new Date(2026, 9, 14, 12); // 14.10
  const events = parseIcs(ics([
    { uid: 54051, summary: "יש להגיש את 'Ex 01'", start: '20261024T215900Z', cat: '83335-מבוא להנדסת חשמל' },
    { uid: 60001, summary: "יש להגיש את 'תרגיל 2'", start: '20261102T215900Z', cat: '83325-גלים' },
    { uid: 60002, summary: 'בוחן קצר נסגר', start: '20261105T100000Z', cat: '67315_1-C' },
    { uid: 30111, summary: 'C++ Lab week 7 closes', start: '20261204T215900Z', cat: '67315_1-C' },
    { uid: 1, summary: "תחילת סמסטר א'", start: '20261010T210000Z', cat: 'אירועי מערכת' },
  ]));
  const tasks = mergeTasks(sem, computeUnits(sem, now), {}, now, { includeHidden: true });
  const changes = icsTaskChanges(sem, events, tasks, { now });
  const byId = Object.fromEntries(changes.map((c) => [c.id, c.d]));
  assert.equal(byId['ics-60001'].title, 'תרגיל 2'); // Hebrew "submit 'X'" → new task X
  assert.equal(byId['ics-60001'].due, '2026-11-02T23:59'); // 21:59Z after the clock change = 23:59
  assert.equal(byId['ics-60002'].title, 'בוחן קצר'); // Hebrew "X closes"
  assert.deepEqual(byId['67315-lab-7'], { due: '2026-12-04T23:59' }); // "C++ Lab" counts as a lab
  assert.equal(byId['ics-54051'], undefined); // Ex 01 already at its new date
  // Waves ex 1 (due 19.10) is missing from this feed, upcoming and inside its window → removed
  assert.deepEqual(byId['ics-46354'], { deleted: true });
});

test('a missing assignment is removed only if upcoming and inside the export window', () => {
  const now = new Date(2026, 9, 14, 12);
  const tasks = [
    { id: 'ics-1', dueDate: new Date(2026, 9, 20) }, // upcoming, inside window → removed
    { id: 'ics-2', dueDate: new Date(2026, 9, 10) }, // already past → kept
    { id: 'ics-3', dueDate: new Date(2027, 0, 30) }, // beyond the window → kept
    { id: '67315-lab-9', dueDate: new Date(2026, 9, 20) }, // not from Moodle → kept
  ];
  const events = parseIcs(ics([{ uid: 9, summary: 'x is due', start: '20261201T100000Z', cat: '83335-EE' }]));
  const removed = icsTaskChanges(sem, events, tasks, { now }).filter((c) => c.d.deleted).map((c) => c.id);
  assert.deepEqual(removed, ['ics-1']);
});

test('cleanTitle', () => {
  assert.equal(cleanTitle('תרגיל 02 2025-26 is due'), 'תרגיל 02');
  assert.equal(cleanTitle("יש להגיש את 'Ex 01'"), 'Ex 01');
});

test('import also updates tasks that are still hidden', () => {
  const now = new Date(2026, 9, 12);
  const all = mergeTasks(sem, computeUnits(sem, now), {}, now, { includeHidden: true });
  const events = parseIcs(ics([{ uid: 2, summary: 'C Lab week 7 closes', start: '20261204T215900Z', cat: '67315_1-C' }]));
  assert.deepEqual(icsTaskChanges(sem, events, all), [{ id: '67315-lab-7', d: { due: '2026-12-04T23:59' } }]);
});
