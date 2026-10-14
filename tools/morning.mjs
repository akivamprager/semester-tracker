// Runs from .github/workflows/morning.yml. On every run:
//   1. Moodle (if MOODLE_ICS_URL is set): fetch the calendar export, compare it with the
//      previous fetch (gist file moodle-feed.json) → messages in the app's notification
//      center + a push; and apply the task changes (new / moved / deleted assignments).
//   2. Keep the subscription calendar (calendar.ics) current.
//   3. Once a day after 07:00: the morning summary push.
// Progress, subscriptions and snapshots live in the private sync gist.
// Env: GIST_TOKEN, VAPID_PRIVATE_KEY, MOODLE_ICS_URL (optional), TZ=Asia/Jerusalem,
//      FORCE=true (send the morning summary now), EVENT (push = calendar only).
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import { dailySummary } from '../summary.js';
import { ymd, computeUnits, mergeTasks } from '../schedule.js';
import { buildCalendar, CALENDAR_FILE } from '../calendar.js';
import { parseIcs, icsTaskChanges } from '../ics.js';
import { feedSnapshot, diffFeeds, diffMessages, INBOX_PREFIX } from '../moodle.js';
import { merge } from '../sync.js';

const SEND_HOUR = 7;
const SEND_UNTIL = 11; // a "good morning" summary arriving later than this is useless
const GIST_DESC = 'semester-tracker-progress';
const FEED_FILE = 'moodle-feed.json';
const SITE = 'https://akivamprager.github.io/semester-tracker/';
const force = process.env.FORCE === 'true';
// On a push (schedule data changed) only the calendar is refreshed, no notification.
const calendarOnly = process.env.EVENT === 'push';

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findGist() {
  for (let page = 1; page < 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find((g) => g.description === GIST_DESC);
    if (found) return gh(`/gists/${found.id}`);
    if (list.length < 100) break;
  }
  throw new Error('Sync gist not found — connect sync in the app first.');
}

const fileJson = (gist, name) => JSON.parse(gist.files[name]?.content || '{}');
const writeFiles = (gist, files) => gh(`/gists/${gist.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) }),
});

async function sendPush(push, payload) {
  if (!push.subs?.length) { console.log('No subscriptions — turn on the morning notification in the app.'); return; }
  const { vapidPublicKey } = JSON.parse(readFileSync(new URL('../push-config.json', import.meta.url)));
  webpush.setVapidDetails(SITE, vapidPublicKey, process.env.VAPID_PRIVATE_KEY);
  const alive = [];
  for (const sub of push.subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal' });
      alive.push(sub);
      console.log('Sent to', sub.label || '(unnamed device)', '—', new URL(sub.endpoint).host);
    } catch (e) {
      // 404/410: the device unsubscribed or the subscription expired — drop it.
      if (e.statusCode === 404 || e.statusCode === 410) console.log('Dropping expired subscription:', sub.label || '(unnamed device)');
      else { alive.push(sub); console.error('Send failed:', e.statusCode, e.body || e.message); }
    }
  }
  push.subs = alive;
}

const now = new Date();
const today = ymd(now);
let gist = await findGist();
const push = fileJson(gist, 'push.json');
let pushChanged = false;

const index = JSON.parse(readFileSync(new URL('../semesters/index.json', import.meta.url)));
const entry = index.semesters.find((s) => s.id === index.default) || index.semesters[0];
const sem = JSON.parse(readFileSync(new URL(`../semesters/${entry.file}`, import.meta.url)));
let progress = fileJson(gist, 'progress.json');

// ---- 1. Moodle ----
if (process.env.MOODLE_ICS_URL && !calendarOnly) {
  try {
    const res = await fetch(process.env.MOODLE_ICS_URL);
    if (!res.ok) throw new Error(`Moodle ${res.status}`);
    const events = parseIcs(await res.text());
    if (!events.length) throw new Error('Moodle export is empty (link expired?)');
    const prev = gist.files[FEED_FILE] ? fileJson(gist, FEED_FILE) : null;
    const courses = computeUnits(sem, now);
    const updates = {};

    // a. notification center: anything that changed since the previous fetch
    if (prev) {
      const ignore = (sem.icsRules || []).filter((r) => r.ignore).map((r) => r.match);
      const shortName = (code) => sem.courses.find((c) => c.code === code)?.short;
      const messages = diffMessages(diffFeeds(prev, events, now, ignore), shortName);
      messages.forEach((m, i) => {
        updates[`${INBOX_PREFIX(sem)}${now.getTime()}-${i}`] = { s: 'set', t: now.getTime(), d: { ...m, at: now.toISOString(), read: false } };
      });
      console.log(`Moodle: ${messages.length} change(s) since the previous fetch`);
      if (messages.length) {
        const lines = messages.slice(0, 4).map((m) => `${m.icon} ${m.text}`);
        if (messages.length > 4) lines.push(`ועוד ${messages.length - 4}`);
        await sendPush(push, { title: '📥 עדכונים מהמודל', body: lines.join('\n'), tag: 'moodle', url: './?inbox=1' });
        pushChanged = true;
      }
    } else {
      console.log('Moodle: first fetch — saved as the baseline, no notifications');
    }

    // b. tasks: new / moved / deleted assignments (same logic as the app's import button)
    const tasks = mergeTasks(sem, courses, progress, now, { includeHidden: true });
    for (const { id, d } of icsTaskChanges(sem, events, tasks, { now })) {
      const key = `${sem.id}/taskdata/${id}`;
      updates[key] = { s: 'set', t: now.getTime(), d: { ...(progress[key]?.d || {}), ...d } };
    }
    console.log(`Moodle: ${Object.keys(updates).length} progress update(s)`);

    // c. save: re-read progress first so app changes made meanwhile aren't overwritten
    const snapshot = JSON.stringify(feedSnapshot(events));
    if (Object.keys(updates).length || gist.files[FEED_FILE]?.content !== snapshot) {
      gist = await gh(`/gists/${gist.id}`);
      progress = merge(fileJson(gist, 'progress.json'), updates);
      await writeFiles(gist, { 'progress.json': JSON.stringify(progress), [FEED_FILE]: snapshot });
    }
  } catch (e) {
    console.error('Moodle import failed:', e.message); // never block the rest of the run
  }
}

// ---- 2. calendar ----
if (progress['prefs/calendar']?.d?.enabled) {
  const ics = buildCalendar(sem, progress);
  if (gist.files[CALENDAR_FILE]?.content !== ics) {
    await writeFiles(gist, { [CALENDAR_FILE]: ics });
    console.log('Calendar updated');
  }
}

// ---- 3. morning summary ----
const sendMorning = !calendarOnly
  && (force || (now.getHours() >= SEND_HOUR && now.getHours() < SEND_UNTIL && push.lastSent !== today));
if (!sendMorning) {
  console.log(`Morning summary: skip (hour ${now.getHours()}, last sent ${push.lastSent})`);
} else {
  const summary = dailySummary(sem, progress, now);
  if (summary || force) {
    await sendPush(push, summary || { title: 'בוקר טוב!', body: 'אין היום שום דבר פתוח 🎉' });
  } else {
    console.log('Nothing to report today.');
  }
  push.lastSent = today;
  pushChanged = true;
}
if (pushChanged) await writeFiles(gist, { 'push.json': JSON.stringify(push, null, 1) });
