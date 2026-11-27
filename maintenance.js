// Maintenance notices: things that quietly go stale unless the user does something — the next
// semester's details, a GitHub token about to expire, the automatic job or the Google script
// that stopped running, an expired Panopto login. Pure: shown at the top of the app's "today"
// page (and in the Mac panel, via widget.json) and pushed by tools/morning.mjs — once when
// a notice first appears, then weekly while it's still there (unless snoozed in the app).
//
// Inputs come from progress: status/* entries written by the job (status/moodle every run,
// status/tokens and status/repo once a day, status/mail copied from the Google script).

import { ymd } from './schedule.js';

export const MAINT_SNOOZE_KEY = 'prefs/maint-snooze'; // d: { [notice id]: ISO "remind again after" }
export const MAINT_REPUSH_DAYS = 7;

const DAY = 864e5;
const NEXT_SEM_DAYS = 21;   // before classes end
const TOKEN_DAYS = 21;      // before a token expires
const JOB_STALE_H = 26;     // the job checks Moodle every 2 hours
const SCRIPT_STALE_H = 24;  // the Google script writes mail.json at least every 3 hours
const REPO_IDLE_DAYS = 45;  // GitHub turns off scheduled workflows after 60 days without a commit
const REPO_OFF_DAYS = 60;

const date = (d) => { const x = new Date(d); return `${x.getDate()}.${x.getMonth() + 1}.${String(x.getFullYear()).slice(2)}`; };
const daysUntil = (d, now) => Math.ceil((new Date(d) - now) / DAY);
const inDays = (n) => (n <= 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`);
// GitHub's header: "2027-01-15 08:00:00 UTC"
export const parseGithubExpiry = (s) => (s ? new Date(String(s).replace(' UTC', 'Z').replace(' ', 'T')) : null);

const TOKEN_PLACES = {
  job: { who: 'המשימה האוטומטית (GitHub Actions)', where: 'ב-GitHub: המאגר ← Settings ← Secrets and variables ← Actions ← <bdi>GIST_TOKEN</bdi> ← Update' },
  scriptGist: { who: 'הסקריפט של Google (מיילים ויומן)', where: 'ב-script.google.com ← Project Settings ← Script properties ← <bdi>GIST_TOKEN</bdi>' },
  scriptGithub: { who: 'הסקריפט של Google (הפעלת התראת הבוקר)', where: 'ב-script.google.com ← Project Settings ← Script properties ← <bdi>GITHUB_TOKEN</bdi>' },
};

/** All current notices, newest problem first: [{ id, icon, title, fix }] (fix may hold simple HTML). */
export function maintenanceNotices(sem, index, progress, now = new Date()) {
  const out = [];
  const st = (k) => progress[`status/${k}`]?.d;

  // ---- the next semester ----
  const newer = (index?.semesters || []).filter((s) => s.id > sem.id);
  const end = new Date(`${sem.end}T23:59`);
  if (!newer.length && now >= new Date(+end - NEXT_SEM_DAYS * DAY)) {
    out.push({
      id: `next-semester/${sem.id}`, icon: '🗓️',
      title: now > end ? `${sem.name} נגמר — אין עדיין סמסטר הבא` : `${sem.name} נגמר ב-${date(end)} — צריך להכין את הסמסטר הבא`,
      fix: 'לבקש מ-Claude "תכין את הסמסטר הבא", עם הקורסים והקבוצות (מערכת השעות האישית או צילום מסך). '
        + 'נכנסים: שעות וכיתות מהשנתון, ימים בלי לימודים, המניינים, תיקיות ההקלטות.',
    });
  }
  const started = newer.filter((s) => s.start && new Date(s.start) <= new Date(+now + 3 * DAY)).pop();
  if (started && index.default === sem.id) {
    out.push({
      id: `switch-semester/${started.id}`, icon: '🔀',
      title: `${started.name} מתחיל — האפליקציה עדיין על ${sem.name}`,
      fix: 'לבקש מ-Claude להעביר את ברירת המחדל לסמסטר החדש (semesters/index.json), אחרי שאין יותר בחינות בקודם.',
    });
  }

  // ---- tokens (expiry from GitHub, checked by the job) ----
  const tokens = st('tokens') || {};
  for (const [which, place] of Object.entries(TOKEN_PLACES)) {
    const exp = parseGithubExpiry(tokens[which]);
    if (!exp || isNaN(exp)) continue;
    const n = daysUntil(exp, now);
    if (n > TOKEN_DAYS) continue;
    out.push({
      id: `token/${which}/${ymd(exp)}`, icon: '🔑',
      title: n < 0 ? `הטוקן של ${place.who} פג ב-${date(exp)}` : `הטוקן של ${place.who} פג ${inDays(n)} (${date(exp)})`,
      fix: `טוקן חדש ב-github.com/settings/tokens (אותן הרשאות), ואז ${place.where}. אם זה אותו טוקן כמו באפליקציה ובמק — להחליף גם שם (⚙️ ← סנכרון).`,
    });
  }

  // ---- the automatic job ----
  const moodle = st('moodle');
  if (moodle?.at && now - new Date(moodle.at) > JOB_STALE_H * 3600e3) {
    out.push({
      id: 'job-stopped', icon: '⚙️',
      title: `המשימה האוטומטית לא רצה מאז ${date(moodle.at)} — אין התראות ועדכונים מהמודל`,
      fix: 'ב-GitHub: המאגר ← Actions ← Morning summary. אם כתוב שהיא מושבתת — Enable workflow; '
        + 'אם הריצות נכשלות — לפתוח אחת ולראות את השגיאה (לרוב טוקן שפג).',
    });
  } else if (moodle?.error && moodle.errorAt > (moodle.at || '')) {
    out.push({
      id: 'moodle-link', icon: '📥',
      title: 'הבדיקה במודל נכשלת — ייתכן שהקישור ללוח השנה פג',
      fix: 'במודל: לוח שנה ← ייצוא ← "קבל כתובת" — ולהדביק ב-GitHub secret <bdi>MOODLE_ICS_URL</bdi>.',
    });
  }
  const repo = st('repo');
  if (repo?.lastCommit) {
    const idle = Math.floor((now - new Date(repo.lastCommit)) / DAY);
    if (idle >= REPO_IDLE_DAYS) {
      const left = REPO_OFF_DAYS - idle;
      out.push({
        id: `repo-idle/${ymd(new Date(repo.lastCommit))}`, icon: '💤',
        title: left > 0 ? `GitHub יכבה את המשימה האוטומטית ${inDays(left)} (אין שינויים במאגר ${idle} יום)` : `אין שינויים במאגר ${idle} יום — GitHub כנראה כיבה את המשימה האוטומטית`,
        fix: 'מספיק commit אחד (כל שינוי, גם קטן), או: המאגר ← Actions ← Morning summary ← Enable workflow.',
      });
    }
  }

  // ---- other connections ----
  const panopto = st('panopto');
  if (panopto?.error === 'expired' && (!panopto.at || panopto.errorAt > panopto.at)) {
    out.push({
      id: `panopto-login/${(panopto.errorAt || '').slice(0, 10)}`, icon: '🎬',
      title: 'ההתחברות ל-Panopto פגה — ההקלטות לא מתעדכנות',
      fix: 'במק, בתיקיית tracker: <bdi>node tools/panopto-login.mjs</bdi>',
    });
  }
  const mail = st('mail');
  if (mail?.at && now - new Date(mail.at) > SCRIPT_STALE_H * 3600e3) {
    out.push({
      id: 'script-stopped', icon: '📢',
      title: `הסקריפט של Google לא רץ מאז ${date(mail.at)} — אין מיילים, ו-Google Calendar לא מתעדכן`,
      fix: 'script.google.com ← הפרויקט ← Executions: שגיאת 401 = טוקן שפג (Script properties); בקשת הרשאה = להריץ setup שוב.',
    });
  }
  const morning = st('morning');
  if (morning && morning.devices === 0) {
    out.push({
      id: 'no-devices', icon: '🔕',
      title: 'אף מכשיר לא מקבל התראות (גם לא את אלה)',
      fix: 'בטלפון: ⚙️ ← התראות ← הפעל התראת בוקר.',
    });
  }
  return out;
}

/** Notices not snoozed in the app. */
export function activeNotices(notices, progress, now = new Date()) {
  const snooze = progress[MAINT_SNOOZE_KEY]?.d || {};
  return notices.filter((n) => !(snooze[n.id] && new Date(snooze[n.id]) > now));
}

/** Which notices to push now: new ones, and ones last pushed a week ago. `sent` = { id: ISO }. */
export function noticesToPush(notices, sent = {}, now = new Date()) {
  return notices.filter((n) => !sent[n.id] || now - new Date(sent[n.id]) >= MAINT_REPUSH_DAYS * DAY - 3600e3);
}
