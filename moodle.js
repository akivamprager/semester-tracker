// Changes between two Moodle calendar fetches → messages for the in-app notification
// center ("inbox"). Pure: used by tools/morning.mjs (which keeps the previous fetch as a
// snapshot in the sync gist) and testable in node.
//
// Inbox entries live in the synced progress map:
//   <sem>/inbox/<id> = { s: 'set', d: { at, kind, icon, text, course, read } }

import { cleanTitle, deadlineTitle } from './ics.js';

export const INBOX_PREFIX = (sem) => `${sem.id}/inbox/`;

// "Ex 01" for "יש להגיש את 'Ex 01'" / "Ex 01 2025-26 is due"; other events keep their name.
const name = (s) => cleanTitle(s);
const isDeadline = (s) => deadlineTitle(s) !== null;

const p2 = (n) => String(n).padStart(2, '0');
const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const when = (d) => `יום ${DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

// A compact, JSON-safe copy of a fetch: uid → { s: summary, t: start ms, c: category }.
export function feedSnapshot(events) {
  return Object.fromEntries(events.map((e) => [e.uid.split('@')[0], { s: e.summary, t: +e.start, c: e.category || '' }]));
}

// added / removed / changed events between the previous snapshot and this fetch.
// Events that only dropped out of the export's window (already past) are not "removed".
export function diffFeeds(prev, events, now, ignore = []) {
  const skip = (summary) => ignore.some((re) => new RegExp(re).test(summary));
  const next = feedSnapshot(events);
  const out = [];
  for (const [id, e] of Object.entries(next)) {
    if (skip(e.s)) continue;
    const p = prev[id];
    if (!p) out.push({ type: 'added', id, e });
    else if (p.s !== e.s || p.t !== e.t) out.push({ type: 'changed', id, e, p });
  }
  for (const [id, p] of Object.entries(prev)) {
    if (!next[id] && !skip(p.s) && p.t > +now) out.push({ type: 'removed', id, p });
  }
  return out;
}

// Readable Hebrew messages for the inbox.
export function diffMessages(diff, courseName) {
  const course = (c) => courseName(c?.match(/^(\d{5})/)?.[1]) || '';
  return diff.map(({ type, id, e, p }) => {
    const ev = e || p;
    const base = { id, course: ev.c?.match(/^(\d{5})/)?.[1] || '', courseLabel: course(ev.c) };
    const label = (s) => (isDeadline(s) ? `${name(s)} (הגשה)` : name(s));
    if (type === 'added') return { ...base, icon: '➕', kind: 'added', text: `חדש במודל: ${label(e.s)} — ${when(new Date(e.t))}` };
    if (type === 'removed') return { ...base, icon: '🗑️', kind: 'removed', text: `נמחק מהמודל: ${label(p.s)} (היה ב${when(new Date(p.t))})` };
    const parts = [];
    if (p.t !== e.t) parts.push(`${when(new Date(p.t))} ← ${when(new Date(e.t))}`);
    // only a real rename — not Moodle switching language ("X is due" → "יש להגיש את 'X'")
    if (name(p.s) !== name(e.s)) parts.push(`שם: "${name(p.s)}" ← "${name(e.s)}"`);
    if (!parts.length) return null;
    return { ...base, icon: '🕑', kind: 'changed', text: `עודכן במודל: ${label(e.s)} — ${parts.join(' · ')}` };
  }).filter(Boolean);
}
