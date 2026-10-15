// Panopto recordings → the sessions they belong to. Pure: used by tools/morning.mjs (which
// lists each course folder through the Panopto API) and by the app (links per session).
//
// Stored in the synced progress map, one entry per course:
//   <sem>/rec/<course> = { s: 'set', d: { "<group>|<YYYY-MM-DD>|<HH:MM>": [[viewerId, seconds], …] } }
// The key is the *scheduled* session (from expandGroup), so moved/extra sessions still match.

import { expandGroup, ymd } from './schedule.js';

const p2 = (n) => String(n).padStart(2, '0');
const hm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export const sessionKey = (group, occ) => `${group.code}|${ymd(occ.start)}|${hm(occ.start)}`;
export const recKey = (sem, code) => `${sem.id}/rec/${code}`;
export const viewerUrl = (sem, id) => `https://${sem.panopto.host}/Panopto/Pages/Viewer.aspx?id=${id}`;

// Hebrew numerals as used in group names: א=1 … י=10, יא=11 … טו=15, טז=16, כ=20.
const GEMATRIA = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30 };
export function hebrewNumber(s) {
  const letters = [...(s || '').replace(/["'׳״]/g, '')];
  if (!letters.length || letters.some((l) => !GEMATRIA[l])) return null;
  return letters.reduce((n, l) => n + GEMATRIA[l], 0);
}

// "67315 2026-10-14 תרגיל יב" → { date, type: 'recitation', n: 12 }. Other names → { }.
export function parseSessionName(name) {
  const m = (name || '').match(/^\d{5}\s+(\d{4}-\d{2}-\d{2})\s+(שי?עור|תרגיל|תרגול)\s+([א-ת"'׳״]+)/);
  if (!m) return {};
  return { date: m[1], type: m[2].startsWith('ת') ? 'recitation' : 'lecture', n: hebrewNumber(m[3]) };
}

// Panopto's StartTime at HUJI is the local wall-clock time (despite the "Z").
const wallClock = (startTime) => {
  const m = (startTime || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  return m ? { date: m[1], minutes: +m[2] * 60 + +m[3] } : null;
};

// sessions: Panopto API objects ({ Id, Name, StartTime, Duration }) of one course folder.
// 1. By name: group number + date → that group's session on that date.
// 2. Otherwise (renamed recordings, cancelled group whose room was reused): the session of
//    the same type on that date whose start is closest, within 45 minutes.
export function matchRecordings(sem, course, sessions) {
  const occs = course.groups.flatMap((group) => expandGroup(sem, course, group).map((o) => ({ group, o })));
  const out = {};
  for (const s of sessions) {
    const wall = wallClock(s.StartTime);
    if (!wall) continue;
    const parsed = parseSessionName(s.Name);
    let hit = null;
    if (parsed.n) {
      const code = `${parsed.type === 'lecture' ? 1 : 2}-${p2(parsed.n)}`;
      hit = occs.find(({ group, o }) => group.code === code && group.type === parsed.type && ymd(o.start) === parsed.date);
    }
    if (!hit) {
      let best = 46;
      for (const x of occs) {
        if (ymd(x.o.start) !== wall.date || (parsed.type && x.group.type !== parsed.type)) continue;
        const diff = Math.abs(x.o.start.getHours() * 60 + x.o.start.getMinutes() - wall.minutes);
        if (diff < best) { best = diff; hit = x; }
      }
    }
    if (!hit) continue;
    const key = sessionKey(hit.group, hit.o);
    (out[key] ||= []).push([s.Id, Math.round(s.Duration || 0)]);
  }
  for (const list of Object.values(out)) list.sort((a, b) => b[1] - a[1]); // longest first
  return out;
}
