// Runs from .github/workflows/morning.yml. On every run:
//   1. Moodle (if MOODLE_ICS_URL is set): fetch the calendar export, compare it with the
//      previous fetch (gist file moodle-feed.json) → messages in the app's notification
//      center + a push; and apply the task changes (new / moved / deleted assignments).
//   1b. Course emails (gist file mail.json, filled by the Google Apps Script) → notification
//      center + a push. Only counts are logged (the repo, and so its logs, are public).
//   1c. Panopto (if the PANOPTO_* secrets and the token file exist): match each course
//      folder's recordings to sessions → progress <sem>/rec/<course> (links in the app).
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
import { MAIL_FILE, mailInboxUpdates } from '../mail.js';
import { matchRecordings, recKey } from '../recordings.js';
import { WIDGET_FILE, buildWidget, widgetFile, sameWidget } from '../widget.js';
import { TOKEN_FILE, encrypt, decrypt, refreshToken, folderSessions } from './panopto-lib.mjs';
import { merge } from '../sync.js';
import { isShabbat } from '../prayer.js';

const SEND_HOUR = 7;
const SEND_UNTIL = 11; // a "good morning" summary arriving later than this is useless
// private gist (progress, subscriptions, emails, tokens) / published gist (calendar + widget
// summary only — its address is the shared calendar link). See sync.js.
const GIST_DESC = 'semester-tracker-progress';
const PUBLISHED_DESC = 'semester-tracker-published';
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

async function findGist(description = GIST_DESC) {
  for (let page = 1; page < 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find((g) => g.description === description);
    if (found) return gh(`/gists/${found.id}`);
    if (list.length < 100) break;
  }
  if (description !== GIST_DESC) return null; // the app creates the published gist
  throw new Error('Sync gist not found — connect sync in the app first.');
}

const fileJson = (gist, name) => JSON.parse(gist.files[name]?.content || '{}');
// Big gist files come back truncated; the full text is at raw_url.
const fullJson = async (gist, name) => {
  const f = gist.files[name];
  if (!f) return {};
  if (!f.truncated) return JSON.parse(f.content);
  const res = await fetch(f.raw_url, { headers: { Authorization: `Bearer ${process.env.GIST_TOKEN}` } });
  return res.json();
};
const writeFiles = (gist, files) => gh(`/gists/${gist.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) }),
});

// No notifications on Shabbat: Moodle/email pushes are counted instead, and one short
// "waiting for you" push goes out on the first run after Shabbat (entries still reach 🔔).
async function notify(push, payload) {
  if (isShabbat(sem, now)) {
    push.heldOnShabbat = (push.heldOnShabbat || 0) + 1;
    console.log('Shabbat — push held');
    return;
  }
  await sendPush(push, payload);
}

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
        await notify(push, { title: '📥 עדכונים מהמודל', body: lines.join('\n'), tag: 'moodle', url: './?inbox=1' });
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
    // shown in the app's Settings ("last checked …")
    updates['status/moodle'] = { s: 'set', t: now.getTime(), d: { at: now.toISOString(), events: events.length } };

    // c. save: re-read progress first so app changes made meanwhile aren't overwritten
    gist = await gh(`/gists/${gist.id}`);
    progress = merge(fileJson(gist, 'progress.json'), updates);
    await writeFiles(gist, { 'progress.json': JSON.stringify(progress), [FEED_FILE]: JSON.stringify(feedSnapshot(events)) });
  } catch (e) {
    console.error('Moodle import failed:', e.message); // never block the rest of the run
  }
}

// ---- 1b. course emails ----
if (!calendarOnly && gist.files[MAIL_FILE]) {
  try {
    const mail = await fullJson(gist, MAIL_FILE);
    const { updates, notify } = mailInboxUpdates(sem, mail, progress, now);
    console.log(`Mail: ${Object.keys(updates).length} new message(s), ${notify.length} to notify`);
    // shown in the app's Settings ("last checked …")
    if (mail.checkedAt && progress['status/mail']?.d?.at !== mail.checkedAt) {
      updates['status/mail'] = { s: 'set', t: now.getTime(), d: { at: mail.checkedAt, messages: mail.messages?.length || 0 } };
    }
    if (Object.keys(updates).length) {
      gist = await gh(`/gists/${gist.id}`);
      progress = merge(fileJson(gist, 'progress.json'), updates);
      await writeFiles(gist, { 'progress.json': JSON.stringify(progress) });
    }
    if (notify.length) {
      const shortName = (code) => sem.courses.find((c) => c.code === code)?.short;
      const lines = notify.slice(0, 4).map((m) => (m.course ? `${shortName(m.course)}: ${m.subject}` : m.subject));
      if (notify.length > 4) lines.push(`ועוד ${notify.length - 4}`);
      await notify(push, { title: '📢 הודעות בקורסים', body: lines.join('\n'), tag: 'mail', url: './?inbox=1' });
      pushChanged = true;
    }
  } catch (e) {
    console.error('Mail import failed:', e.message);
  }
}

// ---- 1c. Panopto recordings ----
if (!calendarOnly && sem.panopto && process.env.PANOPTO_KEY && gist.files[TOKEN_FILE]) {
  const updates = {};
  try {
    const key = Buffer.from(process.env.PANOPTO_KEY, 'base64');
    const saved = fileJson(gist, TOKEN_FILE);
    const refresh = decrypt(saved.token, key);
    const tok = await refreshToken(sem.panopto.host, refresh, process.env.PANOPTO_CLIENT_ID, process.env.PANOPTO_CLIENT_SECRET);
    if (tok.refresh_token && tok.refresh_token !== refresh) {
      // save the new one right away — the old one may already be invalid
      await writeFiles(gist, { [TOKEN_FILE]: JSON.stringify({ ...saved, token: encrypt(tok.refresh_token, key), savedAt: now.toISOString() }) });
    }
    let total = 0;
    for (const course of sem.courses) {
      const folder = sem.panopto.folders?.[course.code];
      if (!folder) continue;
      const sessions = await folderSessions(sem.panopto.host, tok.access_token, folder, sem.start);
      const map = matchRecordings(sem, course, sessions);
      total += Object.keys(map).length;
      if (JSON.stringify(map) !== JSON.stringify(progress[recKey(sem, course.code)]?.d)) {
        updates[recKey(sem, course.code)] = { s: 'set', t: now.getTime(), d: map };
      }
    }
    console.log(`Panopto: ${total} recorded session(s), ${Object.keys(updates).length} course(s) changed`);
    updates['status/panopto'] = { s: 'set', t: now.getTime(), d: { at: now.toISOString(), sessions: total } };
  } catch (e) {
    const expired = e.message === 'expired';
    console.error('Panopto failed:', expired ? 'login expired — run node tools/panopto-login.mjs again' : e.message);
    updates['status/panopto'] = { s: 'set', t: now.getTime(), d: { ...(progress['status/panopto']?.d || {}), error: expired ? 'expired' : 'failed', errorAt: now.toISOString() } };
  }
  try {
    gist = await gh(`/gists/${gist.id}`);
    progress = merge(fileJson(gist, 'progress.json'), updates);
    await writeFiles(gist, { 'progress.json': JSON.stringify(progress) });
  } catch (e) {
    console.error('Panopto save failed:', e.message);
  }
}

// ---- 2. calendar + Mac widget summary → the published gist ----
const published = await findGist(PUBLISHED_DESC);
if (!published) {
  console.log('No published gist yet — open the app once (it creates it)');
} else {
  if (progress['prefs/calendar']?.d?.enabled) {
    const ics = buildCalendar(sem, progress);
    if (published.files[CALENDAR_FILE]?.content !== ics) {
      await writeFiles(published, { [CALENDAR_FILE]: ics });
      console.log('Calendar updated');
    }
  }
  try {
    const widget = buildWidget(sem, progress, now);
    if (!sameWidget(published.files[WIDGET_FILE]?.content, widget)) {
      await writeFiles(published, { [WIDGET_FILE]: widgetFile(widget, now) });
      console.log('Widget summary updated');
    }
  } catch (e) {
    console.error('Widget summary failed:', e.message);
  }
}

// ---- 3. morning summary ----
// ---- after Shabbat: what came in meanwhile ----
if (!calendarOnly && push.heldOnShabbat && !isShabbat(sem, now)) {
  await sendPush(push, { title: '🔔 עדכונים משבת', body: 'הגיעו עדכונים מהמודל או מהמייל בזמן השבת — פתח את 🔔 לפרטים.', tag: 'shabbat', url: './?inbox=1' });
  push.heldOnShabbat = 0;
  pushChanged = true;
}

// no morning summary on Shabbat (Saturday) — Sunday's covers the week
const shabbatMorning = isShabbat(sem, now);
const sendMorning = !calendarOnly && !shabbatMorning
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
  // shown in the app's Settings ("sent today at 07:12 to 3 devices")
  gist = await gh(`/gists/${gist.id}`);
  progress = merge(fileJson(gist, 'progress.json'), {
    'status/morning': { s: 'set', t: Date.now(), d: { at: new Date().toISOString(), devices: push.subs?.length || 0, sent: !!(summary || force) } },
  });
  await writeFiles(gist, { 'progress.json': JSON.stringify(progress) });
}
if (pushChanged) await writeFiles(gist, { 'push.json': JSON.stringify(push, null, 1) });
