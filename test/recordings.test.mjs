import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hebrewNumber, parseSessionName, matchRecordings } from '../recordings.js';
import { encrypt, decrypt } from '../tools/panopto-lib.mjs';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const course = (code) => sem.courses.find((c) => c.code === code);

test('hebrewNumber / parseSessionName', () => {
  assert.equal(hebrewNumber('יב'), 12);
  assert.equal(hebrewNumber('טו'), 15);
  assert.equal(hebrewNumber('ג'), 3);
  assert.equal(hebrewNumber('abc'), null);
  assert.deepEqual(parseSessionName('67315 2026-10-14 תרגיל יב'), { date: '2026-10-14', type: 'recitation', n: 12 });
  assert.deepEqual(parseSessionName('83335 2026-10-14 שעור א'), { date: '2026-10-14', type: 'lecture', n: 1 });
  assert.deepEqual(parseSessionName('83325 12.10 10-12'), {});
});

test('matchRecordings: by name, by time when renamed or the group was cancelled, nothing before the course starts', () => {
  const ee = matchRecordings(sem, course('83335'), [
    { Id: 'lec', Name: '83335 2026-10-14 שעור א', StartTime: '2026-10-14T09:00:01Z', Duration: 10198 },
    { Id: 'a', Name: '83335 2026-10-14 תרגיל א', StartTime: '2026-10-14T13:00:02Z', Duration: 6598 }, // 2-01 cancelled
    { Id: 'b', Name: '83335 2026-10-14 תרגיל ב', StartTime: '2026-10-14T13:00:01Z', Duration: 6599 },
  ]);
  assert.deepEqual(ee['1-01|2026-10-14|09:00'], [['lec', 10198]]);
  assert.deepEqual(ee['2-02|2026-10-14|13:00'].map((r) => r[0]).sort(), ['a', 'b']);
  const waves = matchRecordings(sem, course('83325'), [
    { Id: 'r', Name: '83325 12.10 10-12', StartTime: '2026-10-12T10:00:02Z', Duration: 6598 },
  ]);
  assert.deepEqual(Object.keys(waves), ['2-03|2026-10-12|10:00']);
  const prob = matchRecordings(sem, course('80430'), [
    { Id: 'x', Name: '80430 2026-10-13 שעור א', StartTime: '2026-10-13T10:00:01Z', Duration: 6599 },
  ]);
  assert.deepEqual(prob, {}); // 80430 starts 25.10 — that was 80431
});

test('panopto token encryption round-trip', () => {
  const key = randomBytes(32);
  assert.equal(decrypt(encrypt('refresh-123', key), key), 'refresh-123');
  assert.throws(() => decrypt(encrypt('x', key), randomBytes(32)));
});
