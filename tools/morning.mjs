// Sends the morning summary as a Web Push notification. Run by
// .github/workflows/morning.yml; reads progress + push subscriptions from the sync gist.
// Env: GIST_TOKEN, VAPID_PRIVATE_KEY, TZ=Asia/Jerusalem, FORCE=true to send regardless
// of the hour / whether today's summary was already sent.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import { dailySummary } from '../summary.js';
import { ymd } from '../schedule.js';
import { buildCalendar, CALENDAR_FILE } from '../calendar.js';

const SEND_HOUR = 7;
const GIST_DESC = 'semester-tracker-progress';
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

const now = new Date();
const today = ymd(now);
const gist = await findGist();
const push = fileJson(gist, 'push.json');

const index = JSON.parse(readFileSync(new URL('../semesters/index.json', import.meta.url)));
const entry = index.semesters.find((s) => s.id === index.default) || index.semesters[0];
const sem = JSON.parse(readFileSync(new URL(`../semesters/${entry.file}`, import.meta.url)));
const progress = fileJson(gist, 'progress.json');

// Keep the subscription calendar current (if turned on in the app).
if (progress['prefs/calendar']?.d?.enabled) {
  const ics = buildCalendar(sem, progress);
  if (gist.files[CALENDAR_FILE]?.content !== ics) {
    await gh(`/gists/${gist.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [CALENDAR_FILE]: { content: ics } } }),
    });
    console.log('Calendar updated');
  }
}
if (calendarOnly) process.exit(0);

if (!force && (now.getHours() < SEND_HOUR || push.lastSent === today)) {
  console.log(`Skip: hour ${now.getHours()}, last sent ${push.lastSent}`);
  process.exit(0);
}
if (!push.subs?.length) {
  console.log('No subscriptions — turn on the morning notification in the app.');
  process.exit(0);
}

const summary = dailySummary(sem, progress, now);
if (!summary && !force) {
  console.log('Nothing to report today.');
} else {
  const payload = JSON.stringify(summary || { title: 'בוקר טוב!', body: 'אין היום שום דבר פתוח 🎉' });
  const { vapidPublicKey } = JSON.parse(readFileSync(new URL('../push-config.json', import.meta.url)));
  webpush.setVapidDetails(SITE, vapidPublicKey, process.env.VAPID_PRIVATE_KEY);
  const alive = [];
  for (const sub of push.subs) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'normal' });
      alive.push(sub);
      console.log('Sent to', new URL(sub.endpoint).host);
    } catch (e) {
      // 404/410: the device unsubscribed or the subscription expired — drop it.
      if (e.statusCode === 404 || e.statusCode === 410) console.log('Dropping expired subscription');
      else { alive.push(sub); console.error('Send failed:', e.statusCode, e.body || e.message); }
    }
  }
  push.subs = alive;
}

push.lastSent = today;
await gh(`/gists/${gist.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ files: { 'push.json': { content: JSON.stringify(push, null, 1) } } }),
});
