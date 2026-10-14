// Mincha / Maariv planner: for each campus day, picks the minyan (from the semester's
// `minyanim` list) that clashes least with the user's own sessions. Pure — used by the app
// (timetable, Settings), summary.js (morning push) and calendar.js.
import { ymd } from './schedule.js';

export const PRAYER_PREFS_KEY = 'prefs/prayer';
export const PRAYER_DEFAULTS = {
  enabled: false,
  skipDays: [1], // 0 = Sunday … 6; Monday at home
  walk: 5, // minutes of walking before/after a minyan
  maarivMaxWait: 30, // suggest Maariv only if it starts ≤ this long after the last session
};
export const prayerPrefs = (progress) => ({ ...PRAYER_DEFAULTS, ...(progress[PRAYER_PREFS_KEY]?.d || {}) });

export const PRAYER_LABELS = { mincha: 'מנחה', maariv: 'ערבית' };

// Sunset — NOAA solar calculator equations, plus the horizon dip for the observer's
// elevation (Jerusalem's published sunset is ~5 min later than at sea level; checked against
// 18:14 on 13.10.2026). Default location: Givat Ram campus, ~780 m.
export function sunset(date, lat = 31.7717, lon = 35.1981, elevation = 780) {
  const zenith = 90.833 + 0.0347 * Math.sqrt(elevation);
  const rad = Math.PI / 180;
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const jc = (day / 864e5 + 2440587.5 + 0.5 - 2451545) / 36525; // Julian century at 12:00 UTC
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(M * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * rad) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime = 4 / rad * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad)
    + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
    - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const ha = Math.acos(Math.cos(zenith * rad) / (Math.cos(lat * rad) * Math.cos(decl))
    - Math.tan(lat * rad) * Math.tan(decl)) / rad;
  const minutesUtc = 720 - 4 * lon - eqTime + 4 * ha;
  return new Date(day + minutesUtc * 60e3);
}

// Sunset for a date: the semester's published table (sem.sunsets, from Hebcal) when it has
// the day, otherwise the calculation above.
export function sunsetFor(sem, date) {
  const hhmm = sem.sunsets?.[ymd(date)];
  if (!hhmm) return sunset(date);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
}

// Israel winter time (UTC+2) vs. summer time (UTC+3), from the device/runner time zone.
const isWinterTime = (date) => -date.getTimezoneOffset() === 120;

const atTime = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
};
const addMin = (d, m) => new Date(+d + m * 60e3);

// Busy intervals of a session, leaving out the breaks between academic hours
// (45 min teaching + 15 min break, e.g. 13:00–13:45 · 14:00–14:45). Other lengths: continuous.
function busyParts(o) {
  const mins = (o.end - o.start) / 60e3;
  if (mins === 45 || mins === 105 || mins === 165) {
    const parts = [];
    for (let s = 0; s < mins; s += 60) parts.push([addMin(o.start, s), addMin(o.start, s + 45)]);
    return parts;
  }
  return [[o.start, o.end]];
}

const overlapMin = (a0, a1, b0, b1) => Math.max(0, (Math.min(+a1, +b1) - Math.max(+a0, +b0)) / 60e3);

// When a minyan from the list takes place on `date` (or null if not that day).
function minyanTime(sem, m, date) {
  if (m.winterOnly && !isWinterTime(date)) return null;
  if (m.sunsetOffset != null) {
    const s = addMin(sunsetFor(sem, date), m.sunsetOffset);
    s.setMinutes(Math.floor(s.getMinutes() / 5) * 5, 0, 0); // shuls post round times
    return s;
  }
  return atTime(date, m.time);
}

// The user's own sessions on that day (all courses/types), sorted.
function ownSessions(courses, date) {
  const day = ymd(date);
  return courses
    .flatMap((c) => c.types.flatMap((t) => t.units.map((u) => u.own).filter(Boolean)))
    .filter((o) => ymd(o.start) === day)
    .sort((a, b) => a.start - b.start);
}

// Progress key for "davened this prayer on that day" (same map as lessons/tasks).
export const prayerKey = (sem, p) => `${sem.id}/prayer/${ymd(p.start)}/${p.prayer}`;

// Plan for one day: [{ prayer, minyan, start, end, overlap, alternatives: [...] }].
export function planDay(sem, courses, date, prefs) {
  if (!prefs.enabled || prefs.skipDays.includes(date.getDay())) return [];
  const sessions = ownSessions(courses, date);
  if (!sessions.length) return [];
  const busy = sessions.flatMap(busyParts);
  const first = sessions[0].start;
  const last = sessions[sessions.length - 1].end;
  const options = (prayer) =>
    (sem.minyanim || [])
      .filter((m) => m.prayer === prayer)
      .map((m) => {
        const start = minyanTime(sem, m, date);
        if (!start) return null;
        const end = addMin(start, m.minutes || 15);
        const from = addMin(start, -prefs.walk);
        const to = addMin(end, prefs.walk);
        const overlap = busy.reduce((n, [b0, b1]) => n + overlapMin(from, to, b0, b1), 0);
        return { prayer, minyan: m, start, end, overlap };
      })
      .filter(Boolean);

  const plan = [];
  // Mincha: while on campus (from 30 min before the first session to 20 min after the last).
  // "Workable" = clashes by at most the walking margin. Among workable minyanim a regular one
  // always beats a short one (short isn't לכתחילה); otherwise the least clashing, regular first.
  const workable = (o) => o.overlap <= prefs.walk;
  const mincha = options('mincha')
    .filter((o) => o.start >= addMin(first, -30) && o.end <= addMin(last, 20))
    .sort((a, b) =>
      workable(b) - workable(a)
      || (workable(a) ? !!a.minyan.short - !!b.minyan.short : a.overlap - b.overlap)
      || !!a.minyan.short - !!b.minyan.short
      || a.overlap - b.overlap
      || a.start - b.start);
  if (mincha.length) plan.push({ ...mincha[0], alternatives: mincha.slice(1) });
  // Maariv: only after sunset (no early "plag" minyanim), and only if it starts soon
  // after the last session ends.
  const sunsetToday = sunsetFor(sem, date);
  const maariv = options('maariv')
    .filter((o) => o.start >= sunsetToday)
    .filter((o) => o.start >= last && o.start <= addMin(last, prefs.maarivMaxWait))
    .sort((a, b) => a.start - b.start);
  if (maariv.length) plan.push({ ...maariv[0], alternatives: maariv.slice(1) });
  return plan;
}

// Plans for every teaching day of the semester (for the calendar feed).
export function planSemester(sem, courses, prefs) {
  const out = [];
  if (!prefs.enabled) return out;
  const end = new Date(`${sem.end}T00:00:00`);
  for (let d = new Date(`${sem.start}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(...planDay(sem, courses, new Date(d), prefs));
  }
  return out;
}
