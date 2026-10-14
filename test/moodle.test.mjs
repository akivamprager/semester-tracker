process.env.TZ = 'Asia/Jerusalem';
import test from 'node:test';
import assert from 'node:assert/strict';
import { feedSnapshot, diffFeeds, diffMessages } from '../moodle.js';

const ev = (uid, summary, start, c = '83335-EE') => ({ uid: `${uid}@moodle`, summary, start: new Date(start), category: c });
const now = new Date('2026-10-14T12:00:00+03:00');
const prev = feedSnapshot([
  ev(1, "יש להגיש את 'Ex 01'", '2026-10-12T11:58:00+03:00'), // will move
  ev(2, "יש להגיש את 'Ex 02'", '2026-10-19T11:58:00+03:00'), // will be deleted (upcoming)
  ev(3, 'נוכחות הרצאות', '2026-10-13T12:00:00+03:00', '67315_1-C'), // ignored
  ev(4, 'C Lab week 1 opens', '2026-10-11T08:00:00+03:00', '67315_1-C'), // past, drops out of the window
  ev(5, 'Old name', '2026-11-01T10:00:00+02:00'), // will be renamed
]);
const next = [
  ev(1, "יש להגיש את 'Ex 01'", '2026-10-24T00:59:00+03:00'),
  ev(5, 'New name', '2026-11-01T10:00:00+02:00'),
  ev(6, 'C++ Lab week 7 opens', '2026-11-22T08:00:00+02:00', '67315_1-C'), // new
];

test('diffFeeds: added / changed / deleted; past drop-outs and ignored events are not changes', () => {
  const d = diffFeeds(prev, next, now, ['^נוכחות הרצאות$']);
  assert.deepEqual(d.map((x) => `${x.type}:${x.id}`).sort(), ['added:6', 'changed:1', 'changed:5', 'removed:2']);
});

test('diffMessages: readable Hebrew, with the course', () => {
  const names = { 83335: 'מבוא להנדסת חשמל', 67315: 'C/C++' };
  const m = diffMessages(diffFeeds(prev, next, now, ['^נוכחות הרצאות$']), (c) => names[c]);
  const byId = Object.fromEntries(m.map((x) => [x.id, x]));
  assert.equal(byId[1].text, 'עודכן במודל: Ex 01 (הגשה) — יום ב׳ 12.10 11:58 ← יום ש׳ 24.10 00:59');
  assert.equal(byId[2].text, 'נמחק מהמודל: Ex 02 (הגשה) (היה ביום ב׳ 19.10 11:58)');
  assert.equal(byId[5].text, 'עודכן במודל: New name — שם: "Old name" ← "New name"');
  assert.equal(byId[6].text, 'חדש במודל: C++ Lab week 7 opens — יום א׳ 22.11 08:00');
  assert.equal(byId[6].course, '67315');
  assert.equal(byId[6].icon, '➕');
});

test('a language-only change (English → Hebrew title) is not a notification', () => {
  const before = feedSnapshot([ev(7, 'Ex 03 2025-26 is due', '2026-11-20T10:00:00+02:00')]);
  const after = [ev(7, "יש להגיש את 'Ex 03'", '2026-11-20T10:00:00+02:00')];
  assert.deepEqual(diffMessages(diffFeeds(before, after, now), () => ''), []);
});
