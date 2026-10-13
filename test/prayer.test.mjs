process.env.TZ = 'Asia/Jerusalem';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeUnits } from '../schedule.js';
import { planDay, sunset, sunsetFor, PRAYER_DEFAULTS, PRAYER_PREFS_KEY } from '../prayer.js';
import { dailySummary } from '../summary.js';
import { buildCalendar } from '../calendar.js';
import { parseIcs } from '../ics.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const courses = computeUnits(sem, new Date(2027, 1, 1));
const on = { ...PRAYER_DEFAULTS, enabled: true };
const hm = (d) => d.toTimeString().slice(0, 5);
const plan = (y, m, d, prefs = on) =>
  planDay(sem, courses, new Date(y, m - 1, d), prefs).map((p) => `${p.prayer} ${hm(p.start)} ${p.minyan.id}`);

test('sunset in Jerusalem (with elevation), matches the published time', () => {
  const near = (d, hhmm, tol = 1) => {
    const [h, m] = hhmm.split(':').map(Number);
    assert.ok(Math.abs(d.getHours() * 60 + d.getMinutes() - (h * 60 + m)) <= tol, `${hm(d)} vs ${hhmm}`);
  };
  near(sunset(new Date(2026, 9, 13)), '18:14'); // published for Jerusalem on 13.10.2026
  near(sunset(new Date(2026, 11, 21)), '16:44', 2); // winter solstice
});

test('weekday plans', () => {
  // Tue 3.11: C/C++ ends 13:45, DS recitation 14:00 → short Mincha in B125; done at 15:45 → no Maariv
  assert.deepEqual(plan(2026, 11, 3), ['mincha 13:50 mincha-1350']);
  // Wed 4.11: 13:50 falls in the break of the C/C++ recitation (13:00–14:45); finishes 16:45 → no Maariv
  assert.deepEqual(plan(2026, 11, 4), ['mincha 13:50 mincha-1350']);
  // Thu 5.11: Probability lecture until 13:45, Data Structures 14:00 → 13:50 in B125
  assert.deepEqual(plan(2026, 11, 5), ['mincha 13:50 mincha-1350']);
  // Sun 8.11: first class 14:00 → 13:30 at the new shul; recitation until 17:45 → 18:00
  assert.deepEqual(plan(2026, 11, 8), ['mincha 13:30 mincha-1330', 'maariv 18:00 maariv-1800']);
  // Monday at home; Friday no classes
  assert.deepEqual(plan(2026, 11, 2), []);
  assert.deepEqual(plan(2026, 11, 6), []);
  // Before winter time there is no 18:00 Maariv, and 19:00 is too long a wait
  assert.ok(!plan(2026, 10, 18).some((x) => x.startsWith('maariv')));
  // Off by default
  assert.deepEqual(plan(2026, 11, 3, PRAYER_DEFAULTS), []);
});

test('prayers reach the morning summary and the calendar only when enabled', () => {
  const progress = { [PRAYER_PREFS_KEY]: { s: 'set', t: 1, d: { enabled: true } } };
  const tue = dailySummary(sem, progress, new Date(2026, 10, 3, 7, 0)).body;
  assert.ok(tue.includes('🙏 מנחה 13:50 (B125)'), tue);
  const sun = dailySummary(sem, progress, new Date(2026, 10, 8, 7, 0)).body; // recitation until 17:45
  assert.ok(sun.includes('🙏 ערבית 18:00'), sun);
  const withPrayers = parseIcs(buildCalendar(sem, progress)).filter((e) => e.uid.startsWith('prayer-'));
  assert.ok(withPrayers.length > 40);
  assert.equal(parseIcs(buildCalendar(sem, {})).filter((e) => e.uid.startsWith('prayer-')).length, 0);
});

test('Maariv is never before sunset', () => {
  // A hypothetical 17:00 Maariv on Sun 8.11 (sunset ≈16:45 → after, OK) vs. on Sun 18.10
  // (summer time, sunset ≈18:00 → before, excluded) — with classes ending right before it.
  const early = { ...sem, minyanim: [...sem.minyanim, { id: 'maariv-1750', prayer: 'maariv', time: '17:50', place: 'x', minutes: 10 }] };
  const ids = (y, m, d) => planDay(early, courses, new Date(y, m - 1, d), on).map((p) => p.minyan.id);
  assert.ok(ids(2026, 11, 8).includes('maariv-1750')); // 17:50 > sunset (≈16:50)
  assert.ok(!ids(2026, 10, 18).includes('maariv-1750')); // 17:50 < sunset (≈18:08)
});

test('published sunset table (Hebcal) is used and agrees with the calculation', () => {
  assert.equal(Object.keys(sem.sunsets).length, 97);
  assert.equal(sunsetFor(sem, new Date(2026, 9, 13)).toTimeString().slice(0, 5), '18:14');
  for (const [day, hhmm] of Object.entries(sem.sunsets)) {
    const [y, m, d] = day.split('-').map(Number);
    const calc = sunset(new Date(y, m - 1, d));
    const [h, mi] = hhmm.split(':').map(Number);
    assert.ok(Math.abs(calc.getHours() * 60 + calc.getMinutes() - (h * 60 + mi)) <= 1, `${day}: ${hhmm} vs calc`);
  }
});
