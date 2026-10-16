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
