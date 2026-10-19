// Summary for the Mac menu bar app and widget (mac/): the next days of the user's own
// sessions, lessons to catch up on, open tasks and prayers — with times, so the Mac app only
// filters by the clock and never needs the schedule logic. Pure; written to the sync gist as
// widget.json by tools/morning.mjs and by the app on every sync.
//
// Items carry their progress `key`; the Mac app marks one done by writing
// progress[key] = { s: 'done', t } (the same entry the web app writes).

import { computeUnits, mergeTasks, atHome, personalBetween } from './schedule.js';
import { planDay, prayerPrefs, prayerKey, PRAYER_LABELS } from './prayer.js';
import { recKey, sessionKey, viewerUrl } from './recordings.js';

export const WIDGET_FILE = 'widget.json';
const DAYS_AHEAD = 4; // covers a weekend without a refresh
const TASK_DAYS = 14;

const iso = (d) => new Date(d).toISOString();
const courseInfo = (c) => ({ course: c.code, short: c.short, emoji: c.emoji, color: c.color });

export function buildWidget(sem, progress, now) {
  const courses = computeUnits(sem, now);
  const until = new Date(+now + DAYS_AHEAD * 864e5);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const done = (key) => !!progress[key]?.s;

  const sessions = [];
  const catchUp = [];
  for (const c of courses) {
    const recs = sem.panopto ? progress[recKey(sem, c.code)]?.d || null : null;
    for (const t of c.types) {
      for (const u of t.units) {
        // home days: not a class to go to (it shows up in catchUp once held)
        if (u.own && u.own.end > dayStart && u.own.start < until && !atHome(progress, u.own.start)) {
          sessions.push({
            ...courseInfo(c), key: u.key, label: `${t.label} ${u.n}`, topic: u.topic || '',
            start: iso(u.own.start), end: iso(u.own.end), room: u.own.room || '',
            lecturer: t.mine.lecturer || '', done: done(u.key),
          });
        }
        if (!done(u.key) && u.first.end < until) {
          // recording: own group's, else the group that taught it first, else any
          const order = [...t.options].sort((a, b) => (b.group === t.mine) - (a.group === t.mine)
            || (b.group === u.first.group) - (a.group === u.first.group));
          const hit = recs && order.map(({ group, occ }) => recs[occ[u.n - 1] ? sessionKey(group, occ[u.n - 1]) : '']).find(Boolean);
          catchUp.push({
            ...courseInfo(c), key: u.key, label: `${t.label} ${u.n}`, topic: u.topic || '',
            availableAt: iso(u.first.end), recording: hit ? viewerUrl(sem, hit[0][0]) : null,
          });
        }
      }
    }
  }

  // personal commitments show like sessions (no course; label empty)
  for (const x of personalBetween(sem, dayStart, until)) {
    sessions.push({
      course: '', short: x.item.title, emoji: x.item.emoji || '📌', color: '#64748b', key: x.key, label: '', topic: '',
      start: iso(x.start), end: iso(x.end), room: x.item.place || '', lecturer: '', done: false,
    });
  }

  const taskUntil = new Date(+now + TASK_DAYS * 864e5);
  const tasks = mergeTasks(sem, courses, progress, now)
    .filter((t) => !t.done && t.dueDate && t.dueDate >= dayStart && t.dueDate <= taskUntil)
    .sort((a, b) => a.dueDate - b.dueDate)
    .slice(0, 10)
    .map((t) => {
      const c = courses.find((x) => x.code === t.course);
      return {
        ...(c ? courseInfo(c) : { course: t.course || '', short: '', emoji: '📌', color: '' }),
        key: `${sem.id}/task/${t.id}`, title: t.title, kind: t.kind, due: iso(t.dueDate),
      };
    });

  const prayers = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = new Date(dayStart); day.setDate(day.getDate() + i);
    for (const p of planDay(sem, courses, day, prayerPrefs(progress))) {
      const key = prayerKey(sem, p);
      prayers.push({
        key, prayer: p.prayer, label: PRAYER_LABELS[p.prayer], start: iso(p.start),
        place: p.minyan.place, approx: p.minyan.sunsetOffset != null, done: done(key),
      });
    }
  }

  const inbox = Object.entries(progress)
    .filter(([k, v]) => k.startsWith(`${sem.id}/inbox/`) && v.d && !v.d.read && !v.d.hidden).length;

  return {
    v: 1,
    semester: sem.name,
    sessions: sessions.sort((a, b) => a.start.localeCompare(b.start)),
    catchUp: catchUp.sort((a, b) => a.availableAt.localeCompare(b.availableAt)),
    tasks,
    prayers,
    inbox,
  };
}

// The file content; `generatedAt` is left out of change detection by the writers.
export const widgetFile = (data, now) => JSON.stringify({ ...data, generatedAt: iso(now) });
export const sameWidget = (text, data) => {
  try { const { generatedAt, ...rest } = JSON.parse(text); return JSON.stringify(rest) === JSON.stringify(data); } catch { return false; }
};
