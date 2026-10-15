/**
 * הסמסטרון — Google Apps Script companion (runs in your own Google account, free).
 *
 *  • every hour: copies the app's calendar (calendar.ics in your sync gist) into a real Google
 *    calendar "הסמסטרון" — adds / updates / removes events, colors by course, reminders.
 *    (A link-subscribed calendar is refreshed by Google only every ~8–24h; this is ≤1h.)
 *  • 07:00–07:30 daily: starts the morning job on GitHub (the morning push) — on time,
 *    unlike GitHub's own scheduler.
 *  • every 2 hours (07:00–23:00): starts the job again for the Moodle check.
 *  • every 30 minutes: copies new emails from Moodle and the university (MAIL_SENDERS only)
 *    into the sync gist (mail.json) and starts the job, which shows them in the app's 🔔.
 *    Read-only: nothing in Gmail is changed, labeled or sent. Email addresses and private
 *    links are removed from the copied text.
 *
 * Setup (once):
 *  1. script.google.com → New project → paste this file over Code.gs → Save.
 *  2. Project Settings (⚙️) → Script properties → add:
 *       CALENDAR_URL  = the address from the app: ⚙️ → 📆 יומן → "העתק"
 *       GITHUB_TOKEN  = fine-grained token, repo semester-tracker only, Actions: Read and write
 *                       (optional — without it only the calendar sync runs)
 *       GIST_TOKEN    = classic token with only the "gist" scope (optional — for the emails)
 *  3. Editor → choose the function "setup" → Run → allow the permissions it asks for.
 *     It creates the triggers and fills the calendar the first time.
 *  Then in Google Calendar: remove the old link-subscribed "שיעורים" calendar (duplicates).
 *
 * Other functions you can run by hand: syncCalendar, checkMail, testMorningNow (sends the summary now).
 */

const OWNER = 'akivamprager';
const REPO = 'semester-tracker';
const CAL_NAME = 'הסמסטרון';
const OLD_CAL_NAMES = ['מעקב שיעורים', 'סמסטרון']; // renamed in place (keeps its events and settings)
const TZ = 'Asia/Jerusalem';
const REMINDER_CLASS_MIN = 15; // classes, prayers (0 = none)
const REMINDER_DEADLINE_MIN = 24 * 60; // deadlines and exams: a day before (0 = none)
const RANGE_BACK_DAYS = 30; // events older than this are left alone
const RANGE_AHEAD_DAYS = 200;
const MAX_RUN_MS = 4.5 * 60 * 1000; // Apps Script stops at 6 min; the next run continues
// Emails copied into the app. Nothing else in the mailbox is read.
const MAIL_SENDERS = ['noreply@moodle.huji.ac.il', 'do_not_reply@savion.huji.ac.il', 'estii@savion.huji.ac.il'];
const MAIL_FIRST_DAYS = 14; // the first run brings the last two weeks (shown, no push)
const MAIL_KEEP_DAYS = 45;
const MAIL_MAX_CHARS = 4000;
// Automatic mails that are never course news — not copied at all (login alerts hold your IP).
const MAIL_SKIP = /כניסה חדשה לחשבון|new sign-?in|מועד הפעילויות הבאות מתקרב|upcoming activities/i;
// Course name (CATEGORIES in the .ics) → Google event color.
const COLORS = {
  'גלים': 'CYAN',
  'הסתברות': 'MAUVE',
  'מבוא להנדסת חשמל': 'ORANGE',
  'מבני נתונים': 'GREEN',
  'C/C++': 'RED',
};

// ---------- triggers ----------
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncCalendar').timeBased().everyHours(1).create();
  const props = PropertiesService.getScriptProperties();
  const hasToken = !!props.getProperty('GITHUB_TOKEN');
  const hasGist = !!props.getProperty('GIST_TOKEN');
  if (hasGist) ScriptApp.newTrigger('checkMail').timeBased().everyMinutes(30).create();
  if (hasToken) {
    // nearMinute(15) → runs between 07:00 and 07:30 (the job only sends from 07:00)
    ScriptApp.newTrigger('morning').timeBased().atHour(7).nearMinute(15).everyDays(1).inTimezone(TZ).create();
    ScriptApp.newTrigger('checkMoodle').timeBased().everyHours(2).create();
  }
  syncCalendar();
  if (hasGist) checkMail();
  Logger.log('Triggers: syncCalendar (hourly)'
    + (hasToken ? ', morning (07:00–07:30), checkMoodle (every 2h)' : ' — no GITHUB_TOKEN: morning/Moodle skipped')
    + (hasGist ? ', checkMail (every 30 min).' : ' — no GIST_TOKEN: emails skipped.'));
}

function morning() { triggerJob_(false); }

function checkMoodle() {
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (hour >= 7 && hour <= 23) triggerJob_(false);
}

function testMorningNow() { triggerJob_(true); }

// Starts .github/workflows/morning.yml. force=false keeps the "once a day from 07:00" rule.
function triggerJob_(force) {
  const res = UrlFetchApp.fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/morning.yml/dispatches`,
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + prop_('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
      payload: JSON.stringify({ ref: 'main', inputs: { force: force ? 'true' : 'false' } }),
      muteHttpExceptions: true,
    },
  );
  const code = res.getResponseCode();
  if (code !== 204) throw new Error(`GitHub ${code}: ${res.getContentText().slice(0, 300)}`);
  Logger.log(`Morning job started (force=${force}).`);
}

// ---------- course emails ----------
function checkMail() {
  const gistId = gistId_();
  const gist = gist_('get', gistId);
  const file = gist.files['mail.json'];
  const store = file
    ? JSON.parse(file.truncated ? UrlFetchApp.fetch(file.raw_url, gistAuth_()).getContentText() : file.content)
    : { messages: [] };
  const seen = new Set(store.messages.map((m) => m.id));
  const days = store.messages.length ? 3 : MAIL_FIRST_DAYS;
  const query = `from:(${MAIL_SENDERS.join(' OR ')}) newer_than:${days}d`;

  let added = 0;
  for (const thread of GmailApp.search(query, 0, 100)) {
    for (const msg of thread.getMessages()) {
      const id = msg.getId();
      if (seen.has(id)) continue;
      const fromRaw = msg.getFrom();
      const from = MAIL_SENDERS.find((s) => fromRaw.toLowerCase().includes(s));
      if (!from) continue; // a reply from someone else in the same thread
      if (MAIL_SKIP.test(msg.getSubject())) { seen.add(id); continue; }
      store.messages.push({
        id,
        from,
        fromName: ((fromRaw.match(/^"?([^"<]*)"?\s*</) || [])[1] || '').trim(),
        subject: msg.getSubject(),
        date: msg.getDate().toISOString(),
        text: cleanMail_(msg.getPlainBody()),
      });
      seen.add(id);
      added++;
    }
  }
  const keepFrom = Date.now() - MAIL_KEEP_DAYS * 864e5;
  const before = store.messages.length;
  store.messages = store.messages.filter((m) => new Date(m.date) >= keepFrom && !MAIL_SKIP.test(m.subject))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Write when something arrived, and every few hours anyway (the app shows "last checked").
  const stale = !store.checkedAt || Date.now() - new Date(store.checkedAt) > 3 * 3600e3;
  if (added || stale || store.messages.length < before) { // new, periodic, or something removed
    store.checkedAt = new Date().toISOString();
    gist_('patch', gistId, { files: { 'mail.json': { content: JSON.stringify(store, null, 1) } } });
  }
  Logger.log(`Mail: ${added} new`);
  // Let the job put them in the app now (daytime only — at night the 07:00 run does it).
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (added && hour >= 7 && hour <= 23 && PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN')) {
    triggerJob_(false);
  }
}

// No email addresses, no links that carry a key/token, no Moodle footer, limited length.
function cleanMail_(text) {
  return (text || '')
    .replace(/\r/g, '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[מייל]')
    .replace(/https?:\/\/\S*(token|key|sesskey|unsubscribe|auth)\S*/gi, '[קישור]')
    .split('\n')
    .filter((l) => !/unsubscribe|לביטול המינוי|הפסקת המינוי|העדפות|preferences/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAIL_MAX_CHARS);
}

// The gist id is part of the calendar address (…/<user>/<id>/raw/calendar.ics).
function gistId_() {
  const m = prop_('CALENDAR_URL').match(/gist\.githubusercontent\.com\/[^/]+\/([0-9a-f]+)/);
  if (!m) throw new Error('CALENDAR_URL is not a gist address');
  return m[1];
}

function gistAuth_() {
  return { headers: { Authorization: 'Bearer ' + prop_('GIST_TOKEN'), Accept: 'application/vnd.github+json' }, muteHttpExceptions: true };
}

function gist_(method, id, body) {
  const opts = { ...gistAuth_(), method };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch('https://api.github.com/gists/' + id, opts);
  if (res.getResponseCode() !== 200) throw new Error(`Gist ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
  return JSON.parse(res.getContentText());
}

// ---------- calendar sync ----------
function syncCalendar() {
  const started = Date.now();
  const res = UrlFetchApp.fetch(prop_('CALENDAR_URL'), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('calendar.ics: HTTP ' + res.getResponseCode());
  const events = parseIcs_(res.getContentText());
  if (!events.length) throw new Error('calendar.ics is empty — is the calendar turned on in the app?');

  const cal = getCalendar_();
  const from = new Date(Date.now() - RANGE_BACK_DAYS * 864e5);
  const to = new Date(Date.now() + RANGE_AHEAD_DAYS * 864e5);
  const existing = {};
  for (const ev of cal.getEvents(from, to)) {
    const uid = ev.getTag('uid');
    if (!uid) continue;
    if (existing[uid]) ev.deleteEvent(); // a duplicate from an interrupted run
    else existing[uid] = ev;
  }

  let created = 0, updated = 0, deleted = 0, unchanged = 0, finished = true;
  for (const e of events) {
    if (Date.now() - started > MAX_RUN_MS) { finished = false; break; }
    if (e.end < from || e.start > to) continue;
    const cur = existing[e.uid];
    delete existing[e.uid];
    if (!cur) {
      const ev = e.allDay
        ? cal.createAllDayEvent(e.title, e.start, { location: e.location, description: e.description })
        : cal.createEvent(e.title, e.start, e.end, { location: e.location, description: e.description });
      ev.setTag('uid', e.uid);
      decorate_(ev, e);
      created++;
      Utilities.sleep(120); // Google rate-limits bursts of event creation
    } else if (differs_(cur, e)) {
      cur.setTitle(e.title);
      if (e.allDay) cur.setAllDayDate(e.start); else cur.setTime(e.start, e.end);
      cur.setLocation(e.location);
      cur.setDescription(e.description);
      decorate_(cur, e);
      updated++;
      Utilities.sleep(80);
    } else {
      unchanged++;
    }
  }
  // Only remove leftovers after a complete pass (a timed-out run hasn't seen everything).
  if (finished) {
    for (const uid in existing) { existing[uid].deleteEvent(); deleted++; Utilities.sleep(80); }
  }
  Logger.log(`Calendar: +${created} ~${updated} -${deleted} =${unchanged}${finished ? '' : ' (continues next hour)'}`);
}

function getCalendar_() {
  const own = CalendarApp.getCalendarsByName(CAL_NAME).filter((c) => c.isOwnedByMe());
  if (own.length) return own[0];
  for (const old of OLD_CAL_NAMES) {
    const prev = CalendarApp.getCalendarsByName(old).filter((c) => c.isOwnedByMe());
    if (prev.length) { prev[0].setName(CAL_NAME); return prev[0]; }
  }
  const cal = CalendarApp.createCalendar(CAL_NAME, { color: CalendarApp.Color.BLUE });
  cal.setTimeZone(TZ);
  return cal;
}

function differs_(ev, e) {
  if (ev.getTitle() !== e.title || (ev.getLocation() || '') !== e.location
    || (ev.getDescription() || '') !== e.description || ev.isAllDayEvent() !== e.allDay) return true;
  if (e.allDay) return ev.getAllDayStartDate().getTime() !== e.start.getTime();
  return ev.getStartTime().getTime() !== e.start.getTime() || ev.getEndTime().getTime() !== e.end.getTime();
}

// Color by course; reminders: classes/prayers 15 min, deadlines/exams a day before; none once done.
function decorate_(ev, e) {
  const color = COLORS[e.category];
  if (color) ev.setColor(CalendarApp.EventColor[color]);
  else if (e.uid.startsWith('prayer-')) ev.setColor(CalendarApp.EventColor.GRAY);
  ev.removeAllReminders();
  if (e.allDay || e.title.startsWith('✓')) return;
  const minutes = e.uid.startsWith('task-') ? REMINDER_DEADLINE_MIN : REMINDER_CLASS_MIN;
  if (minutes) ev.addPopupReminder(minutes);
}

// ---------- helpers ----------
function prop_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(`Missing script property ${name} (Project Settings → Script properties).`);
  return v.trim();
}

function parseIcs_(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  const date = (name, value) => {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    if (!m[4] || /VALUE=DATE(?!-)/.test(name)) return { d: new Date(+m[1], m[2] - 1, +m[3]), allDay: true };
    return {
      d: m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
        : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
      allDay: false,
    };
  };
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { location: '', description: '', category: '' }; continue; }
    if (line === 'END:VEVENT') {
      if (ev && ev.uid && ev.start) {
        if (!ev.end) ev.end = ev.allDay ? ev.start : new Date(ev.start.getTime() + 15 * 60e3);
        out.push(ev);
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i);
    const key = name.split(';')[0];
    const value = line.slice(i + 1);
    if (key === 'UID') ev.uid = value;
    else if (key === 'SUMMARY') ev.title = unescape(value);
    else if (key === 'LOCATION') ev.location = unescape(value);
    else if (key === 'DESCRIPTION') ev.description = unescape(value);
    else if (key === 'CATEGORIES') ev.category = unescape(value);
    else if (key === 'DTSTART') { const r = date(name, value); if (r) { ev.start = r.d; ev.allDay = r.allDay; } }
    else if (key === 'DTEND') { const r = date(name, value); if (r) ev.end = r.d; }
  }
  return out;
}
