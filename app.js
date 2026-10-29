import { computeUnits, mergeTasks, sessionsBetween, gapsOn, atHome, homeSession, inPersonRule, dayNote, homeDays, HOME_PREFS_KEY, personalBetween, personalOn, DAY_LABELS } from './schedule.js';
import { dailySummary } from './summary.js';
import { badgeCount, badgePrefs, PREFS_KEY } from './badge.js';
import { buildCalendar } from './calendar.js';
import { planDay, prayerPrefs, prayerKey, PRAYER_PREFS_KEY, PRAYER_LABELS } from './prayer.js';
import { parseIcs, icsTaskChanges } from './ics.js';
import { recKey, sessionKey, viewerUrl } from './recordings.js';
import { backlog, hoursLabel, courseProgress, readiness, readinessOn, READINESS_KEY } from './insights.js';
import { buildWidget, widgetFile } from './widget.js';
import * as store from './sync.js';

const LS_SEMESTER = 'tracker.semester';

// ?tab=tasks etc. — used by the app-icon shortcuts (manifest.webmanifest).
const TABS = ['today', 'todo', 'schedule', 'tasks', 'courses', 'settings'];
const startTab = new URLSearchParams(location.search).get('tab');

const state = {
  tab: TABS.includes(startTab) ? startTab : 'today',
  index: null,
  sem: null,
  progress: store.loadLocal(),
  sync: { status: 'idle', msg: '' },
  editing: null, // task id whose edit form is open ('new' for a new task)
  sheetKey: null, // unit whose "all sessions" sheet is open
  panel: null, // 'inbox' when the notification center is open
  expanded: new Set(), // to-do items whose sessions drop-down is open
  taskQuery: '', // tasks search box
  horizon: 'short', // timetable range: 'short' = today + tomorrow, 'week' = 7 days
  owedCount: 0,
};

// ?now=2026-11-20T12:00 overrides the current time (for testing).
const nowParam = new URLSearchParams(location.search).get('now');
const now = () => (nowParam ? new Date(nowParam) : new Date());

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function dayDiff(d) {
  const today = new Date(now()); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  return Math.round((day - today) / 86400000);
}

function fmt(d, withTime = true) {
  const rel = { 0: 'היום', '-1': 'אתמול', 1: 'מחר' }[dayDiff(d)];
  const hm = withTime ? ' ' + d.toTimeString().slice(0, 5) : '';
  return `${rel ? rel + ', ' : ''}יום ${DAY_LABELS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}${hm}`;
}

function relDays(d) {
  const n = dayDiff(d);
  if (n === 0) return 'היום';
  if (n === 1) return 'מחר';
  if (n > 1) return `בעוד ${n} ימים`;
  return n === -1 ? 'אתמול' : `לפני ${-n} ימים`;
}

// Group codes like "2-01" must stay left-to-right inside Hebrew text.
const grp = (code) => `<bdi dir="ltr">${esc(code)}</bdi>`;

// Course header: emoji + name + course-number badge, colored by the course.
const courseTitle = (c) =>
  `<span class="course-name">${c.emoji} <bdi>${esc(c.short)}</bdi> <span class="code-badge">${esc(c.code)}</span></span>`;
const courseStyle = (c) => `style="--c:${esc(c.color)}"`;

// Session length in academic hours (45 min + break): 45′ → שעה, 1:45 → שעתיים, 2:45 → 3 שעות.
function durLabel(o) {
  if (!o) return '';
  const h = Math.max(1, Math.round((o.end - o.start) / 60000 / 55));
  return h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
}
const durTag = (o) => (o ? ` <span class="dur">⏱ ${durLabel(o)}</span>` : '');

const roomText = (o) => (o?.room ? ` · 📍 <bdi>${esc(o.room)}</bdi>` : '');

const statusOf = (key) => state.progress[key]?.s || null;

function put(key, entry) {
  state.progress[key] = { ...entry, t: Date.now() };
  store.saveLocal(state.progress);
  render();
  scheduleSync();
}

const setStatus = (key, s) => put(key, { s });

// ---------- tasks ----------
// Built-in tasks come from the semester file; the user can add tasks or override
// built-in ones. Both are stored in the synced progress map:
//   <sem>/taskdata/<id> = { s:'set', d:{course,title,due,note,kind,deleted} }
//   <sem>/task/<id>     = { s:'done' | null }
const taskDataKey = (id) => `${state.sem.id}/taskdata/${id}`;
const taskDoneKey = (id) => `${state.sem.id}/task/${id}`;

const allTasks = (courses) => mergeTasks(state.sem, courses, state.progress, now());

const byDue = (a, b) => (a.dueDate || Infinity) - (b.dueDate || Infinity);

// ---------- sync ----------
let syncTimer = null;
let syncing = false;
let syncAgain = false;

function scheduleSync(delay = 1500) {
  if (!store.getToken()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!store.getToken()) { state.sync = { status: 'off', msg: '' }; renderChip(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  state.sync = { status: 'busy', msg: '' };
  renderChip();
  try {
    state.progress = await store.sync();
    if (calendarEnabled()) await store.publishCalendar(buildCalendar(state.sem, state.progress));
    // the Mac menu bar app reads this; failing to update it must not fail the sync
    const widget = buildWidget(state.sem, state.progress, now());
    await store.publishWidget(widget, widgetFile(widget, now())).catch(() => {});
    state.sync = { status: 'ok', msg: '' };
  } catch (e) {
    state.sync = { status: 'err', msg: e.message };
  }
  syncing = false;
  if (!state.editing) render(); else renderChip();
  if (syncAgain) { syncAgain = false; runSync(); }
}

function renderChip() {
  const chip = document.getElementById('sync-chip');
  const { status } = state.sync;
  chip.className = 'chip ' + ({ ok: 'ok', err: 'err' }[status] || '');
  chip.textContent = !store.getToken()
    ? 'ללא סנכרון'
    : { busy: 'מסנכרן…', ok: 'מסונכרן ✓', err: 'שגיאת סנכרון ⟳' }[status] || 'סנכרן ⟳';
}

// ---------- views ----------
function taskRow(t, courses) {
  const course = courses.find((c) => c.code === t.course);
  if (state.editing === t.id) return taskForm(t, courses);
  const isExam = t.kind === 'exam';
  const overdue = t.kind === 'hw' && !t.done && t.dueDate && t.dueDate < now();
  const when = t.dueDate
    ? `${fmt(t.dueDate, t.due.includes('T'))} · ${relDays(t.dueDate)}`
    : 'אין מועד עדיין';
  const search = `${t.title} ${course?.short || ''} ${course?.code || ''} ${t.note || ''}`.toLowerCase();
  const swipe = !isExam && !t.done ? ` data-swipe-key="${esc(taskDoneKey(t.id))}" data-swipe-label="${esc(t.title)}"` : '';
  return `<div class="task ${t.done ? 'is-done' : ''} ${overdue ? 'overdue' : ''}" data-search="${esc(search)}"${swipe}>
    ${isExam
      ? '<span class="task-icon">📝</span>'
      : `<input type="checkbox" class="task-check" data-action="toggle-task" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}>`}
    <div class="task-body">
      <div class="name">${esc(t.title)} ${course ? `<span class="course-tag colored" ${courseStyle(course)}>${course.emoji} <bdi>${esc(course.short)}</bdi></span>` : ''}${t.kind === 'practice' ? ' <span class="course-tag">לא נבדק</span>' : ''}</div>
      <div class="meta when">${t.kind === 'practice' && t.dueDate ? 'יעד: ' : ''}${when}${t.estimated && t.kind !== 'practice' ? ' · <span class="est">משוער</span>' : ''}</div>
      ${t.note ? `<div class="meta">${esc(t.note)}</div>` : ''}
      ${isExam && !t.done ? readinessLine(t, courses) : ''}
    </div>
    <div class="task-side">
      ${taskLink(t)}
      <button class="link" data-action="edit-task" data-id="${esc(t.id)}">✎</button>
    </div>
  </div>`;
}

// ---------- readiness: before a quiz/exam, how much of its material has been watched ----------
let examCache = null; // exam tasks of this render
function readinessLine(t, courses) {
  if (!readinessOn(state.progress) || !t.dueDate || t.dueDate < now()) return '';
  examCache ||= allTasks(courses).filter((x) => x.kind === 'exam');
  const r = readiness(courses, state.progress, t, examCache);
  if (!r) return '';
  const missing = r.owed.map(({ u, label }) => `${label} ${u.n}`).join(', ');
  const ready = !r.owed.length && !r.upcoming;
  return `<div class="meta readiness ${ready ? 'ready' : r.owed.length ? 'behind' : ''}">📚 ${ready
    ? `כל החומר נצפה (${r.total} שיעורים) ✓`
    : `חומר: ${r.done}/${r.total} שיעורים נצפו${r.owed.length ? ` · להשלים: ${esc(missing)}` : ''}${r.upcoming ? ` · עוד ${r.upcoming} יתקיימו לפני` : ''}`}</div>`;
}

// Moodle: the event in Moodle's calendar (→ "עבור לפעילות"), or a link pasted in the task form.
function taskLink(t) {
  if (!/^https:\/\//.test(t.url || '')) return '';
  const label = t.url.includes('/calendar/view.php') ? 'מודל ↗' : 'מטלה ↗';
  return `<a class="link task-link" href="${esc(t.url)}" target="_blank" rel="noopener">${label}</a>`;
}

function taskForm(t, courses) {
  const [date, time] = (t.due || '').split('T');
  const opts = courses
    .map((c) => `<option value="${c.code}" ${c.code === t.course ? 'selected' : ''}>${c.emoji} ${esc(c.short)}</option>`)
    .join('');
  return `<form class="task-form" data-id="${esc(t.id)}">
    <label>קורס</label><select name="course">${opts}</select>
    <label>כותרת</label><input type="text" name="title" value="${esc(t.title)}" required>
    <div class="row">
      <div style="flex:1"><label>תאריך</label><input type="date" name="date" value="${esc(date || '')}"></div>
      <div style="flex:1"><label>שעה</label><input type="time" name="time" value="${esc(time || '')}"></div>
    </div>
    <label>סוג</label>
    <select name="kind">
      <option value="hw" ${t.kind === 'hw' ? 'selected' : ''}>מטלה / תרגיל להגשה</option>
      <option value="practice" ${t.kind === 'practice' ? 'selected' : ''}>תרגול עצמי (לא נבדק)</option>
      <option value="exam" ${t.kind === 'exam' ? 'selected' : ''}>בחינה / בוחן</option>
    </select>
    <label>הערה</label><input type="text" name="note" value="${esc(t.note || '')}">
    <label>קישור (למשל דף המטלה במודל)</label><input type="url" name="url" value="${esc(t.url || '')}" placeholder="https://moodle.huji.ac.il/…" dir="ltr" pattern="https://.*">
    <div class="row">
      <button class="btn primary" type="submit">שמור</button>
      <button class="btn" type="button" data-action="cancel-edit">ביטול</button>
      ${t.id !== 'new' ? `<button class="btn danger" type="button" data-action="delete-task" data-id="${esc(t.id)}">מחק</button>` : ''}
    </div>
  </form>`;
}

function viewTasks(courses) {
  const tasks = allTasks(courses).sort(byDue);
  const t0 = now();
  const week = new Date(t0); week.setDate(week.getDate() + 7);
  const open = tasks.filter((t) => !t.done && !(t.kind === 'exam' && t.dueDate && t.dueDate < t0));
  // Ungraded practice is never "late": once published it stays with this week's work until done.
  const isPractice = (t) => t.kind === 'practice';
  const groups = [
    ['באיחור', open.filter((t) => !isPractice(t) && t.dueDate && t.dueDate < t0)],
    ['השבוע הקרוב', open.filter((t) => t.dueDate && t.dueDate <= week && (isPractice(t) || t.dueDate >= t0))],
    ['בהמשך', open.filter((t) => t.dueDate && t.dueDate > week)],
    ['ללא מועד', open.filter((t) => !t.dueDate)],
  ];
  const done = tasks.filter((t) => t.done).reverse();
  const row = (t) => taskRow(t, courses);
  return `
    <div class="tasks-toolbar">
      <input type="search" id="task-search" placeholder="חיפוש מטלות…" value="${esc(state.taskQuery)}" autocomplete="off">
      ${state.editing === 'new' ? '' : '<button class="btn primary" data-action="new-task">+ מטלה חדשה</button>'}
    </div>
    ${state.editing === 'new'
      ? `<section class="card">${taskForm({ id: 'new', course: courses[0]?.code, title: '', kind: 'hw' }, courses)}</section>`
      : ''}
    ${groups.filter(([, list]) => list.length).map(([title, list]) => `
      <section class="card task-group">
        <h2>${title} <span class="h2-side"><small>${list.length}</small>${title === 'השבוע הקרוב'
          ? '<button class="link share-btn" data-action="share-tasks" title="שתף">↗ שתף</button>' : ''}</span></h2>
        ${list.map(row).join('')}
      </section>`).join('')}
    ${done.length ? `<section class="card task-group"><details><summary>הושלמו (${done.length})</summary>${done.map(row).join('')}</details></section>` : ''}
    <p class="help">מועדי ההגשה של תרגילי הבית מתפרסמים במודל — הוסף אותם כאן (או ערוך עם ✎). מועדים "משוערים" חושבו לפי נהלי הקורס.</p>`;
}

function viewTodo(courses, { withSoon = true } = {}) {
  let total = 0;
  const t0 = now();
  const week = new Date(t0); week.setDate(week.getDate() + 7);
  const soon = allTasks(courses)
    .filter((t) => !t.done && t.dueDate && t.dueDate <= week && (t.kind !== 'exam' || t.dueDate >= t0))
    .sort(byDue);
  const soonCard = withSoon && soon.length ? `<section class="card soon">
      <h2>מטלות ובחינות קרובות <button class="link" data-tab-link="tasks">לכל המשימות</button></h2>
      ${soon.map((t) => taskRow(t, courses)).join('')}
    </section>` : '';
  // Sessions running right now (any group) whose material isn't marked done yet — these can
  // be checked off while sitting in class, before they count as "held".
  const liveByCourse = new Map();
  const runningKeys = new Set(); // any unit being taught right now (also ones already held elsewhere)
  for (const x of sessionsBetween(courses, t0, new Date(+t0 + 1))) {
    if (x.occ.start > t0 || statusOf(x.unit.key)) continue;
    runningKeys.add(x.unit.key);
    if (x.unit.available) continue;
    const list = liveByCourse.get(x.course.code) || [];
    const same = list.findIndex((y) => y.unit.key === x.unit.key);
    if (same < 0) list.push(x);
    else if (x.mine) list[same] = x; // prefer the user's own group when several run at once
    liveByCourse.set(x.course.code, list);
  }

  const bl = backlog(state.sem, courses, state.progress);
  const cards = courses.map((c) => {
    const live = liveByCourse.get(c.code) || [];
    const liveKeys = new Set(live.map((x) => x.unit.key));
    const owed = c.types
      .flatMap((t) => t.units.map((u) => ({ ...u, label: t.label, mine: t.mine, options: t.options })))
      .filter((u) => u.available && !statusOf(u.key))
      .sort((a, b) => a.first.end - b.first.end);
    total += owed.length;
    const upcoming = c.types
      .map((t) => ({ t, u: t.units.find((u) => !u.available && !liveKeys.has(u.key)) }))
      .filter((x) => x.u);
    const next = upcoming
      .map(({ t, u }) => `${t.label} ${u.n}${u.topic ? ` (${esc(u.topic)})` : ''}: ${fmt(u.first.start)} (${durLabel(u.first)}) · ${u.first.group.lecturer ? esc(u.first.group.lecturer) : 'קב׳ ' + grp(u.first.group.code)}${roomText(u.first)}`);
    if (!owed.length && !next.length && !live.length) return null;
    // Courses with something to catch up on (or in class right now) first, longest-waiting
    // first; then the rest by their next session.
    const sortKey = owed.length || live.length
      ? [0, Math.min(...owed.map((u) => +u.first.end), ...live.map((x) => +x.occ.start))]
      : [1, Math.min(...upcoming.map(({ u }) => u.first.start))];
    const liveRows = live.map((x) => `<div class="unit live">
        <div class="name">${x.type.label} ${x.unit.n}${durTag(x.occ)} <span class="pill live"><span class="live-dot" aria-hidden="true"></span>מתקיים עכשיו</span>${x.unit.topic ? ` · <span class="topic">${esc(x.unit.topic)}</span>` : ''}</div>
        <div class="meta">${hm(x.occ.start)}–${hm(x.occ.end)} · ${x.group.lecturer ? esc(x.group.lecturer) + ' · ' : ''}קב׳ ${grp(x.group.code)}${roomText(x.occ)}${x.mine ? ` · הקבוצה שלך${homeSession(state.sem, state.progress, x.course.code, x.type.type, x.unit) ? ' · 🏠 בבית' : ''}` : ''}</div>
        <div class="actions">
          <button class="attend" data-action="mark" data-key="${x.unit.key}" data-s="done" data-label="${esc(`${c.short} · ${x.type.label} ${x.unit.n}`)}">✓ סיימתי</button>
        </div>
        ${sessionsDropdown(courses, x.unit.key)}
      </div>`).join('');
    const rows = owed.map((u) => {
      const firstIsMine = u.first.group === u.mine;
      let where;
      if (u.first.missed) where = `במקום ${fmt(u.first.start)} (בוטל)${u.first.note ? `: ${esc(u.first.note)}` : ''}`;
      else if (firstIsMine) where = `התקיים בקבוצה שלך: ${fmt(u.first.start)}`;
      else {
        where = `התקיים לראשונה: ${fmt(u.first.start)} · ${esc(u.first.group.lecturer)} (קב׳ ${grp(u.first.group.code)})<br>`;
        where += u.own
          ? `בקבוצה שלך: ${fmt(u.own.start)}${u.own.end > t0 ? ` (עוד לא)${roomText(u.own)}` : ''}`
          : u.ownMissed
            ? `בקבוצה שלך: בוטל (${fmt(u.ownMissed.start, false)})${u.ownMissed.note ? ` — ${esc(u.ownMissed.note)}` : ''}`
            : 'אין מפגש מקביל בקבוצה שלך (בגלל חג/ביטול)';
      }
      return `<div class="unit" data-swipe-key="${u.key}" data-swipe-label="${esc(`${c.short} · ${u.label} ${u.n}`)}">
        <div class="name">${u.label} ${u.n}${durTag(u.own || u.first)}${runningKeys.has(u.key) ? ' <span class="pill live"><span class="live-dot" aria-hidden="true"></span>מתקיים עכשיו</span>' : ''}${u.topic ? ` · <span class="topic">${esc(u.topic)}</span>` : ''}</div>
        <div class="meta">${where}</div>
        <div class="actions">
          <button class="attend" data-action="mark" data-key="${u.key}" data-s="done" data-label="${esc(`${c.short} · ${u.label} ${u.n}`)}">✓ סיימתי</button>
          ${watchButton(c, u)}
        </div>
        ${sessionsDropdown(courses, u.key)}
      </div>`;
    }).join('');
    const pr = courseProgress(c, state.progress);
    const mins = bl.byCourse[c.code]?.minutes || 0;
    return { sortKey, html: `<section class="card course" ${courseStyle(c)}>
      <h2>${courseTitle(c)} <small>${owed.length ? `${owed.length} להשלים · ${hoursLabel(mins)}` : live.length ? '<span class="live-dot" aria-hidden="true"></span>עכשיו' : 'מעודכן ✓'}</small></h2>
      ${progressBar(pr)}
      ${liveRows}${rows}
      ${next.length ? `<div class="upcoming">הבא: ${next.join('<br>הבא: ')}</div>` : ''}
      ${owed.length > 1 ? `<button class="link" data-action="mark-all" data-course="${c.code}">סמן הכל כבוצע</button>` : ''}
    </section>` };
  })
    .filter(Boolean)
    .sort((a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1])
    .map((card) => card.html)
    .join('');
  document.getElementById('todo-count').textContent = total || '';
  state.owedCount = total;
  const banner = total
    ? `<div class="backlog-total">⏳ סה״כ ${total} שיעורים · ${hoursLabel(bl.total.minutes)} <small>(≈${hoursLabel(bl.total.minutes / 1.5)} במהירות 1.5×)</small></div>`
    : '<div class="empty">אין שיעורים שמחכים לך 🎉</div>';
  const isNew = !localStorage.getItem('tracker.welcomed')
    && !Object.keys(state.progress).some((k) => k.startsWith(state.sem.id + '/'));
  const welcome = isNew ? `<section class="card welcome">
      <h2>👋 חדש כאן?</h2>
      <p class="help">כאן מופיעים הרצאות ותרגולים שכבר התקיימו ועוד לא השלמת. מדריך קצר מסביר הכל בדקה.</p>
      <div class="row">
        <a class="btn primary" href="guide.html">למדריך</a>
        <button class="btn" data-action="dismiss-welcome">הבנתי</button>
      </div>
    </section>` : '';
  return welcome + scheduleStrip(courses) + soonCard + banner + cards;
}

function progressBar({ held, done, pct }) {
  if (!held) return '';
  return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${held}" aria-valuenow="${done}"
      aria-label="${done} מתוך ${held} שיעורים שהתקיימו" title="${done}/${held} שיעורים שהתקיימו"><span style="width:${Math.round(pct * 100)}%"></span></div>`;
}

// ---------- today: one screen for the day ----------
function owedRow(c, t, u) {
  const v = { ...u, label: t.label, mine: t.mine, options: t.options };
  const label = `${c.short} · ${t.label} ${u.n}`;
  return `<div class="unit" data-swipe-key="${u.key}" data-swipe-label="${esc(label)}">
    <div class="name"><span class="course-tag colored" ${courseStyle(c)}>${c.emoji} <bdi>${esc(c.short)}</bdi></span> ${t.label} ${u.n}${durTag(u.own || u.first)}${u.topic ? ` · <span class="topic">${esc(u.topic)}</span>` : ''}</div>
    <div class="meta">התקיים: ${fmt(u.first.start)}</div>
    <div class="actions">
      <button class="attend" data-action="mark" data-key="${u.key}" data-s="done" data-label="${esc(label)}">✓ סיימתי</button>
      ${watchButton(c, v)}
    </div>
  </div>`;
}

function viewToday(courses) {
  const t0 = now();
  const tomorrow = startOfDay(t0); tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(tomorrow); dayAfter.setDate(dayAfter.getDate() + 1);
  const week = new Date(t0); week.setDate(week.getDate() + 7);
  const d = startOfDay(t0);
  const title = `היום · יום ${DAY_LABELS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}`;

  // my day: own classes, prayers, commitments, exams and gaps from now on
  const day = [...openSessions(courses, tomorrow), ...gapItems(courses, t0, tomorrow)]
    .filter((x) => x.gap || x.prayer || x.personal || x.exam || x.mine)
    .sort((a, b) => a.start - b.start || (b.gap ? 1 : 0) - (a.gap ? 1 : 0));
  const next = day.length ? '' : (() => {
    const n = openSessions(courses, week).filter((x) => x.mine && x.start >= tomorrow)[0];
    return n ? `<div class="meta">הבא: ${n.course.emoji} <bdi>${esc(n.course.short)}</bdi> ${n.type.label} · ${fmt(n.start)}${roomText(n.occ)}</div>` : '';
  })();

  // to hand in: overdue, today and tomorrow; exams within a week (with readiness)
  const tasks = allTasks(courses).filter((t) => !t.done && t.dueDate
    && ((t.kind !== 'exam' && t.dueDate < dayAfter) || (t.kind === 'exam' && t.dueDate >= t0 && t.dueDate < week)))
    .sort(byDue);

  // to catch up: the oldest few
  const bl = backlog(state.sem, courses, state.progress);
  const owed = courses.flatMap((c) => c.types.flatMap((t) => t.units
    .filter((u) => u.available && !statusOf(u.key)).map((u) => ({ c, t, u }))))
    .sort((a, b) => a.u.first.end - b.u.first.end);

  // a note for today, or tomorrow's in advance (election day, quiz day…)
  const notes = [[dayNote(state.sem, t0), ''], [dayNote(state.sem, tomorrow), 'מחר: ']]
    .filter(([n]) => n)
    .map(([n, when]) => `<section class="card day-note">
      <h2>${esc(when + n.title)}</h2>
      <ul>${n.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    </section>`).join('');

  return `${notes}<section class="card today-head">
      <h2>${title}</h2>
      ${day.length ? `<div class="slots">${day.map(slotRow).join('')}</div>` : `<div class="empty small">אין יותר שיעורים היום</div>${next}`}
    </section>
    ${tasks.length ? `<section class="card">
      <h2>להגשה ולבחינה <button class="link" data-tab-link="tasks">לכל המשימות</button></h2>
      ${tasks.map((t) => taskRow(t, courses)).join('')}
    </section>` : ''}
    <section class="card">
      <h2>להשלים ${owed.length ? `<small>${owed.length} שיעורים · ${hoursLabel(bl.total.minutes)}</small>` : ''}</h2>
      ${owed.length ? owed.slice(0, 3).map(({ c, t, u }) => owedRow(c, t, u)).join('')
        + (owed.length > 3 ? `<button class="link" data-tab-link="todo">לכל ${owed.length} השיעורים ›</button>` : '')
        : '<div class="empty small">הכל מעודכן 🎉</div>'}
    </section>`;
}

// ---------- header icon: the ring shows how much of what was taught you've done ----------
let ringPct = null;
function renderBrandRing(courses) {
  let held = 0;
  let done = 0;
  for (const c of courses) { const p = courseProgress(c, state.progress); held += p.held; done += p.done; }
  const pct = held ? done / held : 0;
  if (pct === ringPct) return;
  ringPct = pct;
  const el = document.querySelector('.brand-icon');
  if (!el) return;
  const C = 2 * Math.PI * 33;
  el.outerHTML = `<svg class="brand-icon" viewBox="0 0 100 100" role="img" aria-label="התקדמות: ${Math.round(pct * 100)}% מהשיעורים שהתקיימו">
    <title>${done}/${held} שיעורים שהתקיימו (${Math.round(pct * 100)}%)</title>
    <rect width="100" height="100" rx="22" fill="#1f5fd1"/>
    <circle cx="50" cy="50" r="33" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="6"/>
    ${pct > 0 ? `<circle cx="50" cy="50" r="33" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/>` : ''}
    <path d="M38 52 L38 60 Q50 67 62 60 L62 52 Z" fill="#b5d4f4"/>
    <path d="M50 36 L72 46 L50 56 L28 46 Z" fill="#fff"/>
    <path d="M50 46 L66 50 L66 60" fill="none" stroke="#fac775" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="66" cy="62" r="3.5" fill="#fac775"/>
  </svg>`;
}

// ---------- timetable: which sessions can I go to ----------
const hm = (d) => d.toTimeString().slice(0, 5);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Upcoming sessions (any group) whose material isn't marked done yet, plus exams.
function openSessions(courses, to) {
  const t0 = now();
  const sessions = sessionsBetween(courses, t0, to)
    .filter((x) => !statusOf(x.unit.key))
    .map((x) => ({ ...x, start: x.occ.start }));
  const exams = allTasks(courses)
    .filter((t) => t.kind === 'exam' && t.dueDate && t.dueDate >= t0 && t.dueDate < to)
    .map((t) => ({ exam: t, course: courses.find((c) => c.code === t.course), start: t.dueDate }));
  const prayers = [];
  const prefs = prayerPrefs(state.progress);
  if (prefs.enabled) {
    for (let d = startOfDay(t0); d < to; d.setDate(d.getDate() + 1)) {
      // Today's prayers stay (dimmed after their time) until marked, so they can still be checked off.
      prayers.push(...planDay(state.sem, courses, new Date(d), prefs)
        .map((p) => ({ prayer: p, start: p.start, key: prayerKey(state.sem, p) }))
        .filter((x) => !statusOf(x.key) && (x.prayer.end > t0 || dayDiff(x.start) === 0)));
    }
  }
  const personal = personalBetween(state.sem, startOfDay(t0), to)
    .filter((x) => x.end > t0)
    .map((x) => ({ personal: x, start: x.start }));
  return [...sessions, ...exams, ...prayers, ...personal].sort((a, b) => a.start - b.start);
}

function personalRow({ personal: x }) {
  const t0 = now();
  const live = x.start <= t0 && t0 < x.end;
  return `<div class="slot personal ${live ? 'live' : ''}" style="--c:#64748b">
    <div class="slot-time">${hm(x.start)}<small>–${hm(x.end)}</small></div>
    <div class="slot-body">
      <div class="name">${esc(x.item.emoji || '📌')} ${esc(x.item.title)}${live ? ' <span class="pill live"><span class="live-dot" aria-hidden="true"></span>עכשיו</span>' : ''}</div>
      ${x.item.place ? `<div class="meta">📍 ${esc(x.item.place)}</div>` : ''}
    </div>
  </div>`;
}

function horizonEnd() {
  const end = startOfDay(now());
  end.setDate(end.getDate() + (state.horizon === 'week' ? 7 : 2));
  return end;
}

function prayerRow({ prayer: p, key }) {
  const t0 = now();
  const live = p.start <= t0 && t0 < p.end;
  const past = p.end <= t0;
  const today = dayDiff(p.start) === 0;
  const m = p.minyan;
  const clash = (o) => (o.overlap ? `חופף ${Math.round(o.overlap)} דק׳` : 'פנוי');
  const alts = p.alternatives
    .map((a) => `${a.minyan.sunsetOffset != null ? '≈' : ''}${hm(a.start)} ${esc(a.minyan.place)} (${clash(a)})`).join(' · ');
  return `<div class="slot prayer ${live ? 'live' : ''} ${past ? 'past' : ''}" style="--c:#64748b">
    <div class="slot-time">${m.sunsetOffset != null ? '≈' : ''}${hm(p.start)}</div>
    <div class="slot-body">
      <div class="name">🙏 ${PRAYER_LABELS[p.prayer]}${m.kind ? ` <span class="dur">${esc(m.kind)}</span>` : ''}</div>
      <div class="meta">📍 ${esc(m.place)}${m.note ? ` · ${esc(m.note)}` : ''}</div>
      <div class="pills"><span class="pill mine">${p.overlap ? `הכי פחות מתנגש (${Math.round(p.overlap)} דק׳)` : 'מתאים למערכת שלך'}</span>${live ? '<span class="pill live"><span class="live-dot" aria-hidden="true"></span>עכשיו</span>' : ''}</div>
      ${alts && !past ? `<div class="meta alts">חלופות: ${alts}</div>` : ''}
      ${today ? `<button class="mini-done" data-action="mark" data-key="${key}" data-s="done" data-label="🙏 ${PRAYER_LABELS[p.prayer]}">✓ סיימתי</button>` : ''}
    </div>
  </div>`;
}

function slotRow(x) {
  if (x.gap) return gapRow(x);
  if (x.prayer) return prayerRow(x);
  if (x.personal) return personalRow(x);
  const c = x.course;
  if (x.exam) {
    return `<div class="slot exam" ${courseStyle(c)}>
      <div class="slot-time">${x.exam.due.includes('T') ? hm(x.start) : 'כל היום'}</div>
      <div class="slot-body"><div class="name">📝 ${esc(x.exam.title)} <span class="course-tag colored" ${courseStyle(c)}>${c.emoji} <bdi>${esc(c.short)}</bdi></span></div></div>
    </div>`;
  }
  const t0 = now();
  const live = x.occ.start <= t0 && t0 < x.occ.end;
  const own = x.unit.own;
  const tags = [
    x.mine ? '<span class="pill mine">הקבוצה שלך</span>' : '',
    x.mine && homeSession(state.sem, state.progress, c.code, x.type.type, x.unit) ? '<span class="pill">🏠 בבית — הקלטה</span>' : '',
    x.mine && inPersonRule(state.sem, c.code, x.type.type, x.unit.n)
      ? `<span class="pill must">❗ ${esc(inPersonRule(state.sem, c.code, x.type.type, x.unit.n).label)} — חובת נוכחות</span>` : '',
    live ? '<span class="pill live"><span class="live-dot" aria-hidden="true"></span>עכשיו</span>' : '',
    !x.mine && own && own.start > x.occ.start ? `<span class="pill">בקבוצה שלך: ${fmt(own.start)}</span>` : '',
  ].join('');
  return `<div class="slot tappable ${x.mine ? 'mine' : ''} ${live ? 'live' : ''}" ${courseStyle(c)}
    data-action="unit-info" data-key="${x.unit.key}" role="button" tabindex="0" aria-haspopup="dialog">
    <div class="slot-time">${hm(x.occ.start)}<small>–${hm(x.occ.end)}</small></div>
    <div class="slot-body">
      <div class="name">${c.emoji} <bdi>${esc(c.short)}</bdi> · ${x.type.label} ${x.unit.n}${durTag(x.occ)}${x.unit.topic ? ` <span class="topic">${esc(x.unit.topic)}</span>` : ''}</div>
      <div class="meta">${x.group.lecturer ? esc(x.group.lecturer) + ' · ' : ''}קב׳ ${grp(x.group.code)}${roomText(x.occ)}</div>
      ${tags ? `<div class="pills">${tags}</div>` : ''}
      ${live ? `<button class="mini-done" data-action="mark" data-key="${x.unit.key}" data-s="done" data-label="${esc(`${c.short} · ${x.type.label} ${x.unit.n}`)}">✓ סיימתי</button>` : ''}
    </div>
  </div>`;
}

// "שעה ורבע", "45 דק׳", "שעתיים" …
function minutesLabel(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  const hours = h === 0 ? '' : h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
  if (!m) return hours;
  if (!h) return `${m} דק׳`;
  const part = { 15: 'ורבע', 30: 'וחצי', 45: 'ושלושה רבעים' }[m] || `ו-${m} דק׳`;
  return `${hours} ${part}`;
}

// Gaps of the user's own day, as timetable items, with a catch-up suggestion that fits.
function gapItems(courses, from, to) {
  const t0 = now();
  const owed = courses
    .flatMap((c) => c.types.flatMap((t) => t.units
      .filter((u) => u.available && !statusOf(u.key))
      .map((u) => ({ c, t, u, len: ((u.own || u.first).end - (u.own || u.first).start) / 60e3 }))))
    .sort((a, b) => a.u.first.end - b.u.first.end);
  const items = [];
  for (let d = startOfDay(from); d < to; d.setDate(d.getDate() + 1)) {
    if (atHome(state.progress, d)) continue; // nothing to bridge on a day at home
    for (const g of gapsOn(courses, new Date(d), 30, personalOn(state.sem, d))) {
      if (g.end <= t0) continue;
      const min = (g.end - g.start) / 60e3;
      const fit = owed.find((x) => x.len <= min);
      items.push({ gap: g, start: g.start, min, suggest: fit });
    }
  }
  return items;
}

function gapRow({ gap, min, suggest }) {
  const t0 = now();
  const live = gap.start <= t0 && t0 < gap.end;
  return `<div class="slot gap ${live ? 'live' : ''}">
    <div class="slot-time">${hm(gap.start)}<small>–${hm(gap.end)}</small></div>
    <div class="slot-body">
      <div class="name">☕ חלון של ${minutesLabel(min)}${live ? ' <span class="pill live"><span class="live-dot" aria-hidden="true"></span>עכשיו</span>' : ''}</div>
      ${suggest ? `<div class="meta">אפשר להשלים: ${suggest.c.emoji} <bdi>${esc(suggest.c.short)}</bdi> ${suggest.t.label} ${suggest.u.n} (${durLabel(suggest.u.own || suggest.u.first)})</div>` : ''}
    </div>
  </div>`;
}

function viewSchedule(courses) {
  const list = [...openSessions(courses, horizonEnd()), ...gapItems(courses, now(), horizonEnd())]
    .sort((a, b) => a.start - b.start || (b.gap ? 1 : 0) - (a.gap ? 1 : 0));
  const days = new Map();
  for (const x of list) {
    const k = startOfDay(x.start).getTime();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(x);
  }
  const dayTitle = (d) => {
    const rel = { 0: 'היום', 1: 'מחר' }[dayDiff(d)];
    return `${rel ? rel + ' · ' : ''}יום ${DAY_LABELS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}`;
  };
  const toggle = `<div class="segmented">
      <button class="${state.horizon === 'short' ? 'active' : ''}" data-action="horizon" data-h="short">היום ומחר</button>
      <button class="${state.horizon === 'week' ? 'active' : ''}" data-action="horizon" data-h="week">7 ימים</button>
    </div>`;
  const body = days.size
    ? '<div class="sched-days">' + [...days.entries()].map(([k, items]) => `<section class="card day">
        <h2>${dayTitle(new Date(k))} <span class="h2-side"><small>${items.filter((x) => x.occ).length} מפגשים</small>
          <button class="link share-btn" data-action="share-day" data-day="${k}" title="שתף">↗ שתף</button></span></h2>
        ${items.map(slotRow).join('')}
      </section>`).join('') + '</div>'
    : '<div class="empty">אין מפגשים פתוחים בטווח הזה 🎉</div>';
  return `${toggle}
    <p class="help">כל ההרצאות והתרגולים בכל הקבוצות, לחומר שעוד לא סימנת כבוצע — כדי לבחור לאן ללכת השבוע.</p>
    ${body}`;
}

// One line on the to-do page: how many options today / tomorrow.
function scheduleStrip(courses) {
  const end = startOfDay(now()); end.setDate(end.getDate() + 2);
  const list = openSessions(courses, end).filter((x) => x.occ);
  const today = list.filter((x) => dayDiff(x.start) === 0);
  const tomorrow = list.filter((x) => dayDiff(x.start) === 1);
  if (!list.length) return '';
  const nextOne = list[0];
  const live = nextOne.occ.start <= now();
  return `<button class="strip" data-tab-link="schedule">
    <span>📅 היום: <b>${today.length}</b> אפשרויות · מחר: <b>${tomorrow.length}</b></span>
    <span class="strip-next">${live ? 'עכשיו' : 'הבא'}: ${nextOne.course.emoji} ${esc(nextOne.course.short)} ${nextOne.type.label} ${nextOne.unit.n} ${hm(nextOne.occ.start)}${nextOne.mine ? ' (שלך)' : ''} <span class="chev" aria-hidden="true"></span></span>
  </button>`;
}

function viewCourses(courses) {
  const tasks = allTasks(courses);
  return courses.map((c) => {
    const units = c.types.flatMap((t) => t.units.map((u) => ({ ...u, label: t.label })));
    const avail = units.filter((u) => u.available).length;
    const done = units.filter((u) => statusOf(u.key));
    const pct = avail ? Math.round((done.length / avail) * 100) : 0;
    const exams = tasks.filter((t) => t.course === c.code && t.kind === 'exam').sort(byDue);
    const syllabus = c.types.filter((t) => t.units.some((u) => u.topic));
    return `<section class="card course" ${courseStyle(c)}>
      <h2>${courseTitle(c)} <small>${done.length} / ${avail} שהתקיימו · ${units.length} בסמסטר</small></h2>
      <div class="progress"><div style="width:${Math.min(pct, 100)}%"></div></div>
      ${exams.length ? `<div class="meta">${exams.map((t) => `📝 ${esc(t.title)}: ${t.dueDate ? fmt(t.dueDate, t.due.includes('T')) : 'טרם נקבע'}`).join('<br>')}</div>` : ''}
      ${c.info.length ? `<details><summary>נהלים ומידע</summary><ul class="info">${c.info.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}
      ${syllabus.map((t) => `<details><summary>נושאי ${t.label === 'הרצאה' ? 'ההרצאות' : 'התרגולים'}</summary>
        <ol class="syllabus">${t.units.map((u) => `<li class="${statusOf(u.key) ? 'done' : u.available ? 'owed' : ''}">${esc(u.topic || '—')}${statusOf(u.key) ? ' ✓' : ''}</li>`).join('')}</ol>
      </details>`).join('')}
      ${done.length ? `<details><summary>סימנתי (${done.length})</summary>
        ${done.sort((a, b) => b.first.end - a.first.end).map((u) => `<div class="done-row">
          <span>✓ ${u.label} ${u.n}${u.topic ? ' · ' + esc(u.topic) : ''}</span>
          <button class="link" data-action="mark" data-key="${u.key}" data-s="">בטל</button>
        </div>`).join('')}</details>` : ''}
      ${c.url ? `<a class="link" href="${esc(c.url)}" target="_blank" rel="noopener">שנתון ↗</a>` : ''}
    </section>`;
  }).join('');
}

function viewSettings() {
  const sems = state.index.semesters
    .map((s) => `<option value="${s.id}" ${s.id === state.sem.id ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  const connected = !!store.getToken();
  return `
  <section class="card">
    <h2>📖 מדריך</h2>
    <p class="help">סיור קצר באפליקציה: מה כל לשונית עושה, התקנה בטלפון ובמחשב, סנכרון ויומן.</p>
    <div class="row">
      <a class="btn" href="guide.html">לפתוח את המדריך</a>
      <button class="btn" data-action="share-guide">↗ לשתף עם חבר</button>
    </div>
  </section>
  <section class="card">
    <h2>🎨 מראה</h2>
    <div class="segmented theme-pick" role="radiogroup" aria-label="מראה">
      ${[['system', '🖥️ אוטומטי'], ['light', '☀️ בהיר'], ['dark', '🌙 כהה']].map(([v, label]) =>
        `<button role="radio" aria-checked="${window.trackerTheme?.get() === v}" class="${window.trackerTheme?.get() === v ? 'active' : ''}"
          data-action="theme" data-theme="${v}">${label}</button>`).join('')}
    </div>
    <p class="help">"אוטומטי" עוקב אחרי הגדרות המכשיר. נשמר בכל מכשיר בנפרד.</p>
  </section>
  <h3 class="settings-group">חשבון וסנכרון</h3>
  <div id="old-gist"></div>
  <section class="card">
    <h2>☁️ סנכרון בין מכשירים</h2>
    ${connected
      ? `<p class="help">מחובר ל-GitHub Gist פרטי. ${state.sync.status === 'err' ? 'שגיאה: ' + esc(state.sync.msg) : ''}</p>
         <div class="row">
           <button class="btn primary" data-action="sync">סנכרן עכשיו</button>
           <button class="btn" data-action="disconnect">נתק</button>
         </div>`
      : `<p class="help">כדי לסנכרן בין הטלפון למחשב ולשמור גיבוי בענן: צור
           <a href="https://github.com/settings/tokens/new?scopes=gist&description=semester-tracker" target="_blank" rel="noopener">טוקן GitHub עם הרשאת gist בלבד</a>
           (Expiration: No expiration), והדבק אותו כאן. אותו טוקן בכל מכשיר.</p>
         <label for="token">טוקן</label>
         <input id="token" type="password" autocomplete="off" placeholder="ghp_…">
         <div class="row"><button class="btn primary" data-action="connect">התחבר</button></div>`}
  </section>
  ${moodleCard()}
  ${mailCard()}
  ${shnatonCard()}
  ${panoptoCard()}
  <h3 class="settings-group">התראות ויומן</h3>
  <section class="card" id="push-card"><h2>🔔 התראות</h2><p class="help">טוען…</p></section>
  ${calendarCard()}
  ${badgeCard()}
  <h3 class="settings-group">תכנון</h3>
  ${homeCard()}
  ${readinessCard()}
  ${prayerCard()}
  <h3 class="settings-group">מתקדם</h3>
  <section class="card">
    <h2>סמסטר</h2>
    <select id="sem-select">${sems}</select>
    <p class="help">ההתקדמות נשמרת לכל סמסטר בנפרד. לסמסטר חדש מוסיפים קובץ ב-<code>semesters/</code>.</p>
  </section>
  <section class="card desktop-only">
    <h2>קיצורי מקלדת</h2>
    <p class="help">${SHORTCUTS_HELP} · ? הצגת הקיצורים</p>
  </section>
  <section class="card">
    <h2>גיבוי ידני</h2>
    <div class="row">
      <button class="btn" data-action="export">ייצוא לקובץ</button>
      <button class="btn" data-action="import">ייבוא מקובץ</button>
    </div>
    <input id="import-file" type="file" accept="application/json" hidden>
  </section>`;
}

// Wide windows (e.g. the app on a Mac) show to-do and tasks side by side.
const wideQuery = matchMedia('(min-width: 1000px)');
wideQuery.addEventListener('change', () => { if (!state.editing) render(); });
const isWide = () => wideQuery.matches;
// In two-column mode the tasks tab is merged into the to-do tab.
const shownTab = () => (isWide() && state.tab === 'tasks' ? 'todo' : state.tab);

// Number on the app icon (Dock on Mac, home-screen app on iPhone). What it counts is set
// in Settings (badge.js). Android doesn't support it; there the icon gets a dot while a
// notification is unread.
const BADGE_SUPPORTED = 'setAppBadge' in navigator;
function updateAppBadge(courses) {
  const { total } = badgeCount(state.sem, courses, state.progress, now());
  if (BADGE_SUPPORTED) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
  return total;
}

const BADGE_LABELS = {
  lessons: 'שיעורים להשלים',
  hw: 'מטלות להגשה',
  practice: 'תרגול עצמי פתוח',
  exams: 'בחינות קרובות',
  today: 'מפגשים שנשארו היום',
};

function badgePreview(courses) {
  const { total, parts } = badgeCount(state.sem, courses, state.progress, now());
  const detail = Object.entries(parts).map(([k, n]) => `${BADGE_LABELS[k]} ${n}`).join(' + ');
  return `כרגע: <b>${total}</b>${detail ? ` (${detail})` : ' — התג כבוי'}`;
}

function homeCard() {
  const days = homeDays(state.progress);
  return `<section class="card" id="home-card">
    <h2>🏠 ימים בבית</h2>
    <p class="help">בימים האלה צופים בהקלטות מהבית: השיעורים נשארים במערכת וב"להשלים" (עם ▶), אבל בלי תזכורת
      "שיעור בעוד 15 דק׳" ביומן, בלי "השיעור הבא" במק ובלי חלונות.</p>
    <div class="check-row"><span>בבית בימים:</span>
      ${['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳'].map((n, i) => `<label class="day-chip"><input type="checkbox" class="home-pref" data-day="${i}" ${days.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}
    </div>
  </section>`;
}

function prayerCard() {
  const p = prayerPrefs(state.progress);
  const toggle = `<label class="switch-row">
      <span><b>🙏 מנחה וערבית במערכת</b><br>
        <small>${p.enabled ? 'מוצג במערכת, בהתראת הבוקר וביומן' : 'כבוי — לא מופיע בשום מקום'}</small></span>
      <input type="checkbox" role="switch" class="switch prayer-pref" data-pref="enabled" ${p.enabled ? 'checked' : ''}
        aria-label="מנחה וערבית במערכת">
    </label>`;
  if (!p.enabled) return `<section class="card" id="prayer-card">${toggle}</section>`;

  const days = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳'];
  const courses = computeUnits(state.sem, now());
  const hint = [];
  const d = startOfDay(now());
  for (let i = 0; i < 7 && hint.length < 4; i++, d.setDate(d.getDate() + 1)) {
    const plan = planDay(state.sem, courses, new Date(d), p);
    if (plan.length) {
      hint.push(`יום ${DAY_LABELS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}: ${plan
        .map((x) => `${PRAYER_LABELS[x.prayer]} ${x.minyan.sunsetOffset != null ? '≈' : ''}${hm(x.start)} (${x.minyan.place})`).join(' · ')}`);
    }
  }
  return `<section class="card" id="prayer-card">
    ${toggle}
    <div class="check-row"><span>בלי תפילות בימים:</span>
      ${days.map((n, i) => `<label class="day-chip"><input type="checkbox" class="prayer-pref" data-pref="skip" data-day="${i}" ${p.skipDays.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}
    </div>
    ${hint.length ? `<p class="help"><b>השבוע:</b><br>${hint.map(esc).join('<br>')}</p>` : ''}
    <details><summary>איך נבחר המניין</summary>
      <p class="help">מנחה: מניין רגיל שמתאים למערכת שלך באותו יום (הפסקות בין שעות אקדמיות נחשבות פנויות, 5 דק׳ הליכה לכל כיוון). המניין הקצר רק אם אין מניין רגיל שמתאים.
        ערבית: רק במניין שאחרי השקיעה, ורק אם השיעור האחרון נגמר עד חצי שעה לפני המניין. מניין "15 דק׳ לפני השקיעה" מחושב לפי שקיעה בגבעת רם ומעוגל — השעה המדויקת בבית הכנסת.</p>
    </details>
  </section>`;
}

function badgeCard() {
  const p = badgePrefs(state.progress);
  const days = (name, value) => `<select class="badge-pref" data-pref="${name}">
      ${[1, 2, 3, 7, 14].map((n) => `<option value="${n}" ${n === value ? 'selected' : ''}>${n === 1 ? 'יום' : n + ' ימים'}</option>`).join('')}
    </select>`;
  const check = (name, label, extra = '') => `<label class="check-row">
      <input type="checkbox" class="badge-pref" data-pref="${name}" ${p[name] ? 'checked' : ''}>
      <span>${label}</span>${extra}
    </label>`;
  return `<section class="card" id="badge-card">
    <h2>🔢 מספר על אייקון האפליקציה</h2>
    ${check('lessons', 'הרצאות ותרגולים שהתקיימו ולא סימנתי')}
    ${check('hw', 'מטלות להגשה שמועדן בעוד', ' ' + days('hwDays', p.hwDays) + ' <span>או שעבר</span>')}
    ${check('practice', 'תרגול עצמי (לא נבדק) שעוד פתוח')}
    ${check('exams', 'בחינות ובחנים בעוד', ' ' + days('examDays', p.examDays))}
    ${check('today', 'מפגשים שנשארו היום (בכל הקבוצות)')}
    <p class="help" id="badge-preview">${badgePreview(computeUnits(state.sem, now()))}</p>
    <p class="help">${BADGE_SUPPORTED
      ? 'המספר מופיע על האייקון ב-Dock (מק) או במסך הבית (אייפון), ומתעדכן גם בהתראת הבוקר. ההגדרה מסונכרנת לכל המכשירים.'
      : 'הדפדפן הזה לא מציג מספר על האייקון. באנדרואיד מופיעה במקומו נקודה כשיש התראה שלא נקראה. ההגדרה עדיין משפיעה על המק ועל התראת הבוקר.'}</p>
  </section>`;
}

function applyTaskFilter() {
  const q = state.taskQuery.trim().toLowerCase();
  document.querySelectorAll('.task[data-search]').forEach((el) => {
    el.hidden = !!q && !el.dataset.search.includes(q);
  });
  document.querySelectorAll('.task-group').forEach((g) => {
    g.hidden = !!q && !g.querySelector('.task:not([hidden])');
  });
}

// ---------- "all sessions" sheet ----------
// Every session (all comparable groups) that teaches the same unit, in a bottom sheet.
function findUnit(courses, key) {
  for (const course of courses) {
    for (const type of course.types) {
      const unit = type.units.find((u) => u.key === key);
      if (unit) return { course, type, unit };
    }
  }
  return null;
}

// ---------- Panopto recordings (matched by the GitHub job, see recordings.js) ----------
const recordingsOf = (code) => state.progress[recKey(state.sem, code)]?.d || null;
const recIds = (recs, group, o) => (recs && o ? recs[sessionKey(group, o)] || null : null);

// The recording to watch for a unit: own group's, else the group that taught it first, else any.
function watchButton(c, u) {
  // a recording named for a cancelled session (e.g. last semester's lecture instead)
  const given = u.ownMissed?.url || (u.first?.missed && u.first.url);
  if (given && /^https:\/\//.test(given)) {
    return `<a class="watch" href="${esc(given)}" target="_blank" rel="noopener">▶ צפה בהקלטה</a>`;
  }
  const recs = recordingsOf(c.code);
  if (!recs || !state.sem.panopto) return '';
  const i = u.n - 1;
  const order = [...u.options].sort((a, b) => (b.group === u.mine) - (a.group === u.mine)
    || (b.group === u.first.group) - (a.group === u.first.group));
  for (const { group, occ } of order) {
    const ids = recIds(recs, group, occ[i]);
    if (ids) {
      const who = group === u.mine ? 'הקבוצה שלך' : group.lecturer || `קב׳ ${grp(group.code)}`;
      return `<a class="watch" href="${esc(viewerUrl(state.sem, ids[0][0]))}" target="_blank" rel="noopener" title="${esc(who)}">▶ צפה בהקלטה</a>`;
    }
  }
  return '';
}

// All sessions (every comparable group) of one unit → { count, html } of timetable-style rows.
function sessionRows(courses, key) {
  const found = findUnit(courses, key);
  if (!found) return { count: 0, html: '' };
  const { course: c, type, unit } = found;
  const t0 = now();
  const i = unit.n - 1;
  const recs = state.sem.panopto ? recordingsOf(c.code) : null;
  const sessions = type.options
    .map(({ group, occ }) => ({ group, o: occ[i] }))
    .filter((x) => x.o && !x.o.missed)
    .sort((a, b) => a.o.start - b.o.start || (b.group === type.mine) - (a.group === type.mine));
  const html = sessions.map(({ group, o }) => {
    const mine = group === type.mine;
    const live = o.start <= t0 && t0 < o.end;
    const past = o.end <= t0;
    const ids = recIds(recs, group, o);
    const pills = [
      mine ? '<span class="pill mine">הקבוצה שלך</span>' : '',
      live ? '<span class="pill live"><span class="live-dot" aria-hidden="true"></span>עכשיו</span>' : '',
      // with Panopto data: a link per recording; without it (e.g. a friend's copy): the old hint
      ids ? ids.map(([id], k) => `<a class="pill rec" href="${esc(viewerUrl(state.sem, id))}" target="_blank" rel="noopener">▶ הקלטה${ids.length > 1 ? ' ' + (k + 1) : ''}</a>`).join('')
        : past ? `<span class="pill">${recs ? 'התקיים · אין הקלטה עדיין' : 'התקיים · יש הקלטה'}</span>` : '',
    ].join('');
    return `<div class="slot ${mine ? 'mine' : ''} ${live ? 'live' : ''} ${past ? 'past' : ''}" ${courseStyle(c)}>
      <div class="slot-time">${hm(o.start)}<small>–${hm(o.end)}</small></div>
      <div class="slot-body">
        <div class="name">${fmt(o.start, false)}${durTag(o)}</div>
        <div class="meta">${group.lecturer ? esc(group.lecturer) + ' · ' : ''}קב׳ ${grp(group.code)}${roomText(o)}</div>
        ${pills ? `<div class="pills">${pills}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  // started: at least one group has begun (or finished) teaching it — only then can it be "done"
  return { count: sessions.length, html, started: sessions.some(({ o }) => o.start <= t0) };
}

// Bottom-of-item toggle that expands the unit's sessions inline.
function sessionsDropdown(courses, key) {
  const open = state.expanded.has(key);
  const { count, html } = open ? sessionRows(courses, key) : { count: 0, html: '' };
  const id = `sess-${key.replace(/[^\w-]/g, '-')}`;
  return `<button class="sessions-toggle ${open ? 'open' : ''}" data-action="toggle-sessions" data-key="${key}"
      aria-expanded="${open}" aria-controls="${id}">📅 ${open ? `${count} מועדים בכל הקבוצות` : 'מועדים בכל הקבוצות'}<span class="caret" aria-hidden="true"></span></button>
    ${open ? `<div class="sessions-inline" id="${id}">${html}</div>` : ''}`;
}

function sheetHtml(courses, key) {
  const found = findUnit(courses, key);
  if (!found) return '';
  const { course: c, type, unit } = found;
  const done = !!statusOf(key);
  const { count, html: rows, started } = sessionRows(courses, key);
  return `<div class="sheet-head" ${courseStyle(c)}>
      <div>
        <div class="sheet-title">${c.emoji} <bdi>${esc(c.short)}</bdi> · ${type.label} ${unit.n}</div>
        ${unit.topic ? `<div class="topic">${esc(unit.topic)}</div>` : ''}
        <div class="meta">${count} מועדים בכל הקבוצות${done ? ' · ✓ סימנת כבוצע' : ''}</div>
      </div>
      <button class="icon-btn sheet-close" data-action="sheet-close" aria-label="סגור">✕</button>
    </div>
    <div class="sheet-list">${rows || '<div class="empty">אין מועדים</div>'}</div>
    ${done
      ? `<div class="sheet-actions"><button class="link" data-action="sheet-undo" data-key="${key}">בטל סימון</button></div>`
      : started
        ? `<div class="sheet-actions"><button class="mini-done" data-action="sheet-done" data-key="${key}" data-label="${esc(`${c.short} · ${type.label} ${unit.n}`)}">✓ סיימתי</button></div>`
        : ''}`;
}

function sheetEl() {
  let d = document.getElementById('sheet');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'sheet';
    d.setAttribute('aria-label', 'כל המועדים');
    // Tap on the dimmed backdrop (outside the content) closes it.
    d.addEventListener('click', (e) => { if (e.target === d) closeSheet(); });
    d.addEventListener('close', () => { state.sheetKey = null; state.panel = null; });
    document.body.append(d);
  }
  return d;
}

function openSheet(key) {
  state.sheetKey = key;
  state.panel = null;
  const d = sheetEl();
  d.innerHTML = `<div class="sheet-inner">${sheetHtml(computeUnits(state.sem, now()), key)}</div>`;
  if (!d.open) d.showModal();
  d.querySelector('.sheet-close')?.focus();
}

function closeSheet() {
  const d = document.getElementById('sheet');
  if (d?.open) d.close();
  state.sheetKey = null;
}

// ---------- notification center (Moodle changes and course emails, written by the GitHub job) ----------
function inboxEntries() {
  const prefix = `${state.sem.id}/inbox/`;
  return Object.entries(state.progress)
    .filter(([k, v]) => k.startsWith(prefix) && v.d && !v.d.hidden)
    .map(([key, v]) => ({ key, ...v.d }))
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

function agoLabel(iso) {
  const min = Math.round((now() - new Date(iso)) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דק׳`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : `לפני ${h} שעות`;
  const d = Math.round(h / 24);
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`;
}

function inboxHtml(entries) {
  const courses = computeUnits(state.sem, now());
  const rows = entries.map((m) => {
    const c = courses.find((x) => x.code === m.course);
    return `<div class="inbox-item ${m.read ? '' : 'unread'}">
      <span class="inbox-icon" aria-hidden="true">${m.icon || '📥'}</span>
      <div class="inbox-body">
        <div class="inbox-text">${esc(m.text)}</div>
        <div class="meta">${c ? `<span class="course-tag colored" ${courseStyle(c)}>${c.emoji} <bdi>${esc(c.short)}</bdi></span> · ` : ''}${m.from ? `${esc(m.from)} · ` : ''}${agoLabel(m.at)}</div>
        ${m.body ? `<details class="inbox-mail"><summary>הצג הודעה</summary><div class="inbox-mail-body">${linkify(m.body)}</div></details>` : ''}
        ${/^https:\/\//.test(m.link || '') ? `<a class="inbox-link" href="${esc(m.link)}" target="_blank" rel="noopener">פתח במודל ›</a>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="sheet-head" style="--c: var(--accent)">
      <div>
        <div class="sheet-title">🔔 עדכונים</div>
        <div class="meta">שינויים בלוח השנה של המודל והודעות מהמייל</div>
      </div>
      <button class="icon-btn sheet-close" data-action="sheet-close" aria-label="סגור">✕</button>
    </div>
    <div class="sheet-list">${rows || '<div class="empty">אין עדכונים עדיין. כשמשהו ישתנה במודל — מטלה חדשה, מועד שזז או מטלה שנמחקה — או כשתגיע הודעה בקורס, זה יופיע כאן.</div>'}</div>
    <div class="sheet-actions">
      <button class="link" data-action="inbox-tasks">למשימות ›</button>
      ${rows ? '<button class="link inbox-clear" data-action="inbox-clear">נקה הכל</button>' : ''}
    </div>`;
}

// Escaped text with clickable http(s) links (course emails).
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 50 ? u.slice(0, 47) + '…' : u}</a>`);
}

function openInbox() {
  state.panel = 'inbox';
  state.sheetKey = null;
  const entries = inboxEntries();
  const d = sheetEl();
  d.innerHTML = `<div class="sheet-inner">${inboxHtml(entries)}</div>`;
  if (!d.open) d.showModal();
  // Seen now (still highlighted in this view); synced so the bell clears on every device.
  const unread = entries.filter((m) => !m.read);
  if (unread.length) {
    const t = Date.now();
    for (const m of unread) state.progress[m.key] = { s: 'set', d: { ...state.progress[m.key].d, read: true }, t };
    store.saveLocal(state.progress);
    updateInboxBadge();
    scheduleSync();
  }
}

function updateInboxBadge() {
  const n = inboxEntries().filter((m) => !m.read).length;
  const el = document.getElementById('inbox-count');
  if (el) el.textContent = n || '';
}

function render() {
  if (!state.sem) return;
  const courses = computeUnits(state.sem, now());
  examCache = null;
  renderBrandRing(courses);
  const wide = isWide();
  document.body.classList.toggle('wide', wide);
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === shownTab()));
  document.querySelector('.icon-btn[data-tab-link=settings]')?.classList.toggle('active', state.tab === 'settings');
  const todo = viewTodo(courses, { withSoon: !wide }); // always computed so the badges stay current
  const t0 = now();
  const soon = new Date(t0); soon.setDate(soon.getDate() + 3);
  const urgent = allTasks(courses).filter((t) => t.kind === 'hw' && !t.done && t.dueDate && t.dueDate <= soon).length;
  document.getElementById('task-count').textContent = urgent || '';
  updateAppBadge(courses);
  const main = document.getElementById('main');
  const searchFocused = document.activeElement?.id === 'task-search';
  if (shownTab() === 'todo' && wide) {
    main.innerHTML = `<div class="columns">
      <div class="col"><h2 class="col-title">שיעורים להשלים</h2>${todo}</div>
      <div class="col"><h2 class="col-title">משימות ${urgent ? `<span class="badge">${urgent}</span>` : ''}</h2>${viewTasks(courses)}</div>
    </div>`;
  } else if (state.tab === 'today') main.innerHTML = viewToday(courses);
  else if (state.tab === 'todo') main.innerHTML = todo;
  else if (state.tab === 'schedule') main.innerHTML = viewSchedule(courses);
  else if (state.tab === 'tasks') main.innerHTML = viewTasks(courses);
  else if (state.tab === 'courses') main.innerHTML = viewCourses(courses);
  else if (!document.getElementById('sem-select')) { main.innerHTML = viewSettings(); fillSettingsCards(); }
  applyTaskFilter();
  updateInboxBadge();
  if (state.panel === 'inbox' && document.getElementById('sheet')?.open) {
    document.querySelector('#sheet .sheet-inner').innerHTML = inboxHtml(inboxEntries());
  }
  if (state.sheetKey && document.getElementById('sheet')?.open) {
    document.querySelector('#sheet .sheet-inner').innerHTML = sheetHtml(courses, state.sheetKey);
  }
  if (searchFocused) {
    const input = document.getElementById('task-search');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
  renderChip();
}

// ---------- events ----------
function switchTab(tab) {
  state.tab = tab;
  state.editing = null;
  document.getElementById('main').innerHTML = '';
  render();
  window.scrollTo(0, 0);
}

document.querySelector('nav').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (tab) switchTab(tab);
});

document.body.addEventListener('click', async (e) => {
  const tabLink = e.target.closest('[data-tab-link]');
  if (tabLink) { switchTab(tabLink.dataset.tabLink); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  if (action === 'mark') {
    if (el.dataset.s === 'done') markDone([el.dataset.key], el.dataset.label || 'סומן כבוצע');
    else setStatus(el.dataset.key, el.dataset.s || null);
  }
  if (action === 'mark-all') {
    const c = computeUnits(state.sem, now()).find((x) => x.code === el.dataset.course);
    const keys = c.types.flatMap((ty) => ty.units).filter((u) => u.available && !statusOf(u.key)).map((u) => u.key);
    markDone(keys, `${keys.length} שיעורים ב${c.short} סומנו כבוצעו`);
  }
  if (action === 'toggle-task') setStatus(taskDoneKey(id), el.checked ? 'done' : null);
  if (action === 'new-task' || action === 'edit-task') {
    state.editing = action === 'new-task' ? 'new' : id;
    if (state.tab !== 'tasks') { state.tab = 'tasks'; window.scrollTo(0, 0); }
    render();
    document.querySelector('.task-form input[name=title]')?.focus();
  }
  if (action === 'cancel-edit') { state.editing = null; render(); if (reloadPending) reloadWhenSafe(); }
  if (action === 'delete-task') {
    if (!confirm('למחוק את המטלה?')) return;
    state.editing = null;
    put(taskDataKey(id), { s: 'set', d: { deleted: true } });
  }
  if (action === 'sync') runSync();
  if (action === 'cal-on' || action === 'cal-off') {
    el.disabled = true;
    try { await setCalendar(action === 'cal-on'); } catch (err) { toast('שגיאה: ' + err.message); }
    rerenderSettings();
  }
  if (action === 'gcal-script') {
    put(GCAL_SCRIPT_KEY, { s: 'set', d: { enabled: el.dataset.on === '1' } });
    rerenderSettings();
  }
  if (action === 'cal-copy') { await navigator.clipboard.writeText(el.dataset.url); toast('📋 הכתובת הועתקה'); }
  if (action === 'share-day') shareText('אפשרויות', shareDayText(new Date(Number(el.dataset.day))));
  if (action === 'share-tasks') shareText('מטלות', shareTasksText());
  if (action === 'share-guide') {
    const url = new URL('guide.html', location.href).href;
    try {
      if (navigator.share) await navigator.share({ title: 'הסמסטרון', text: 'אפליקציה למעקב אחרי הרצאות, תרגולים והגשות:', url });
      else { await navigator.clipboard.writeText(url); toast('📋 הקישור למדריך הועתק'); }
    } catch (err) { if (err.name !== 'AbortError') toast('לא הצלחתי לשתף'); }
  }
  if (action === 'dismiss-welcome') { localStorage.setItem('tracker.welcomed', '1'); render(); }
  if (action === 'horizon') { state.horizon = el.dataset.h; render(); }
  if (action === 'unit-info') openSheet(el.dataset.key);
  if (action === 'toggle-sessions') {
    const k = el.dataset.key;
    if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
    render();
  }
  if (action === 'sheet-close') closeSheet();
  if (action === 'inbox') openInbox();
  if (action === 'inbox-tasks') { closeSheet(); switchTab('tasks'); }
  if (action === 'inbox-clear') {
    const t = Date.now();
    for (const m of inboxEntries()) state.progress[m.key] = { s: 'set', d: { ...state.progress[m.key].d, read: true, hidden: true }, t };
    store.saveLocal(state.progress);
    render();
    scheduleSync();
  }
  if (action === 'sheet-done') {
    closeSheet(); // the sheet is in the top layer — close it so the undo toast is visible
    markDone([el.dataset.key], el.dataset.label || 'סומן כבוצע');
  }
  if (action === 'sheet-undo') setStatus(el.dataset.key, null);
  if (action === 'theme') {
    window.trackerTheme?.set(el.dataset.theme);
    document.querySelectorAll('.theme-pick button').forEach((b) => {
      const on = b.dataset.theme === el.dataset.theme;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
  }
  if (action === 'push-on' || action === 'push-off' || action === 'push-test') {
    el.disabled = true;
    try {
      await { 'push-on': pushOn, 'push-off': pushOff, 'push-test': pushTest }[action]();
    } catch (err) {
      alert('שגיאה: ' + err.message);
    }
    renderPushCard();
  }
  if (action === 'connect') {
    const token = document.getElementById('token').value.trim();
    if (!token) return;
    store.setToken(token);
    rerenderSettings();
    await runSync();
    rerenderSettings();
  }
  if (action === 'disconnect') {
    if (!confirm('לנתק את הסנכרון במכשיר הזה? ההתקדמות נשארת שמורה במכשיר ובענן.')) return;
    store.setToken('');
    state.sync = { status: 'off', msg: '' };
    rerenderSettings();
  }
  if (action === 'export') {
    const blob = new Blob([JSON.stringify(state.progress, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
  if (action === 'import') document.getElementById('import-file').click();
  if (action === 'import-ics') document.getElementById('ics-file').click();
});

document.body.addEventListener('submit', (e) => {
  const form = e.target.closest('.task-form');
  if (!form) return;
  e.preventDefault();
  const f = new FormData(form);
  const date = f.get('date');
  const time = f.get('time');
  const d = {
    course: f.get('course'),
    title: f.get('title').trim(),
    kind: f.get('kind'),
    note: f.get('note').trim(),
    due: date ? (time ? `${date}T${time}` : date) : '',
    url: /^https:\/\//.test(f.get('url').trim()) ? f.get('url').trim() : '',
  };
  const id = form.dataset.id === 'new' ? 'u' + Date.now().toString(36) : form.dataset.id;
  state.editing = null;
  put(taskDataKey(id), { s: 'set', d });
  if (reloadPending) reloadWhenSafe();
});

document.body.addEventListener('input', (e) => {
  if (e.target.id !== 'task-search') return;
  state.taskQuery = e.target.value;
  applyTaskFilter();
});

document.body.addEventListener('change', async (e) => {
  if (e.target.dataset.actionChange === 'readiness') {
    state.progress[READINESS_KEY] = { s: 'set', d: { enabled: e.target.checked }, t: Date.now() };
    store.saveLocal(state.progress);
    document.getElementById('readiness-card').outerHTML = readinessCard();
    scheduleSync();
    return;
  }
  if (e.target.classList.contains('home-pref')) {
    const day = Number(e.target.dataset.day);
    const days = homeDays(state.progress).filter((x) => x !== day);
    if (e.target.checked) days.push(day);
    state.progress[HOME_PREFS_KEY] = { s: 'set', d: { days: days.sort() }, t: Date.now() };
    store.saveLocal(state.progress);
    document.getElementById('prayer-card').outerHTML = prayerCard(); // home days change the minyan
    scheduleSync();
    return;
  }
  if (e.target.classList.contains('prayer-pref')) {
    const prefs = { ...prayerPrefs(state.progress) };
    if (e.target.dataset.pref === 'enabled') prefs.enabled = e.target.checked;
    else {
      const day = Number(e.target.dataset.day);
      prefs.skipDays = e.target.checked ? [...new Set([...prefs.skipDays, day])] : prefs.skipDays.filter((x) => x !== day);
    }
    delete prefs.homeDays; // derived from the home-days setting, not stored here
    state.progress[PRAYER_PREFS_KEY] = { s: 'set', d: prefs, t: Date.now() };
    store.saveLocal(state.progress);
    document.getElementById('prayer-card').outerHTML = prayerCard();
    scheduleSync();
    return;
  }
  if (e.target.classList.contains('badge-pref')) {
    const prefs = { ...badgePrefs(state.progress) };
    const name = e.target.dataset.pref;
    prefs[name] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    state.progress[PREFS_KEY] = { s: 'set', d: prefs, t: Date.now() };
    store.saveLocal(state.progress);
    const courses = computeUnits(state.sem, now());
    updateAppBadge(courses);
    document.getElementById('badge-preview').innerHTML = badgePreview(courses);
    scheduleSync();
    return;
  }
  if (e.target.id === 'sem-select') {
    localStorage.setItem(LS_SEMESTER, e.target.value);
    await loadSemester();
    rerenderSettings();
  }
  if (e.target.id === 'ics-file' && e.target.files[0]) {
    await importIcsFile(e.target.files[0]);
    e.target.value = '';
  }
  if (e.target.id === 'import-file' && e.target.files[0]) {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      state.progress = store.merge(state.progress, data);
      store.saveLocal(state.progress);
      alert('הגיבוי יובא בהצלחה');
      render();
      scheduleSync(0);
    } catch (err) {
      alert('קובץ לא תקין: ' + err.message);
    }
  }
});

// ---------- Moodle .ics import ----------
// Entry points: the Settings button, dropping a file on the window, opening an .ics with
// the installed app (file_handlers, Mac/Chrome) and Android's share menu (share_target).
// Bottom message; with { action: { label, run } } it gets a button (e.g. undo).
function toast(msg, { action, ms = 4000 } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.classList.remove('show');
      clearTimeout(toast.timer);
      action.run();
    }, { once: true });
    el.append(btn);
  }
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

// Mark lesson units done, with a few seconds to undo (restores the previous entries).
function markDone(keys, label) {
  const before = keys.map((k) => [k, state.progress[k]]);
  const owedBefore = backlog(state.sem, computeUnits(state.sem, now()), state.progress);
  const t = Date.now();
  for (const k of keys) state.progress[k] = { s: 'done', t };
  store.saveLocal(state.progress);
  render();
  scheduleSync();
  const courses = computeUnits(state.sem, now());
  const owedAfter = backlog(state.sem, courses, state.progress);
  const cleared = courses.filter((c) => owedBefore.byCourse[c.code]?.count && !owedAfter.byCourse[c.code]?.count);
  if (cleared.length) {
    const msg = owedAfter.total.count ? `🎉 ${cleared.map((c) => `${c.emoji} ${c.short}`).join(', ')} מעודכן!` : '🎉 הכל מעודכן!';
    label = `${label} · ${msg}`;
    celebrate(!owedAfter.total.count);
  }
  navigator.vibrate?.(12);
  toast(`✓ ${label}`, {
    ms: 6000,
    action: {
      label: '↶ בטל',
      run: () => {
        const t2 = Date.now();
        // Undo = a newer entry with the old status, so other devices pick it up too.
        for (const [k, prev] of before) state.progress[k] = { s: prev?.s ?? null, t: t2 };
        store.saveLocal(state.progress);
        render();
        scheduleSync();
      },
    },
  });
}

// A short burst of confetti (skipped for "reduce motion").
function celebrate(big) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  box.setAttribute('aria-hidden', 'true');
  const colors = ['#1f5fd1', '#fac775', '#16a34a', '#e11d48', '#8b5cf6', '#0d9488'];
  for (let i = 0; i < (big ? 70 : 36); i++) {
    const p = document.createElement('i');
    p.style.setProperty('--x', `${(Math.random() - 0.5) * 2}`);
    p.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
    p.style.setProperty('--d', `${0.9 + Math.random() * 0.8}s`);
    p.style.background = colors[i % colors.length];
    p.style.left = `${40 + Math.random() * 20}%`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1900);
}

// ---------- swipe a row sideways to mark it done (touch screens) ----------
const SWIPE_DONE = 90; // px
let swipe = null;
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const el = e.target.closest('[data-swipe-key]');
  if (!el || e.target.closest('button, a, input, select, summary, textarea')) return;
  swipe = { el, x: e.clientX, y: e.clientY, dx: 0, active: false };
}, { passive: true });
document.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerType !== 'touch') return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 12) { swipe = null; return; } // scrolling
    if (Math.abs(dx) < 12) return;
    swipe.active = true;
    swipe.el.classList.add('swiping');
  }
  swipe.dx = dx;
  swipe.el.style.setProperty('--dx', `${dx}px`);
  const ready = Math.abs(dx) > SWIPE_DONE;
  if (ready && !swipe.ready) navigator.vibrate?.(8);
  swipe.ready = ready;
  swipe.el.classList.toggle('swipe-ready', ready);
}, { passive: true });
function endSwipe() {
  if (!swipe) return;
  const { el, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  el.classList.remove('swiping', 'swipe-ready');
  if (Math.abs(dx) > SWIPE_DONE) {
    el.style.setProperty('--dx', `${Math.sign(dx) * 110}%`);
    el.classList.add('swiped');
    setTimeout(() => markDone([el.dataset.swipeKey], el.dataset.swipeLabel || ''), 180);
  } else {
    el.style.removeProperty('--dx');
  }
}
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);

async function importIcsFile(file) {
  try {
    const events = parseIcs(await file.text());
    if (!events.length) { toast('הקובץ לא נראה כמו ייצוא לוח שנה מהמודל.'); return; }
    const courses = computeUnits(state.sem, now());
    const all = mergeTasks(state.sem, courses, state.progress, now(), { includeHidden: true });
    const changes = icsTaskChanges(state.sem, events, all, { now: now() });
    const t = Date.now();
    let added = 0;
    let removed = 0;
    for (const { id, d } of changes) {
      const key = taskDataKey(id);
      if (d.title) added++;
      if (d.deleted) removed++;
      state.progress[key] = { s: 'set', d: { ...(state.progress[key]?.d || {}), ...d }, t };
    }
    store.saveLocal(state.progress);
    toast(changes.length
      ? `📥 נוספו ${added}, עודכנו ${changes.length - added - removed}${removed ? `, הוסרו ${removed} (נמחקו במודל)` : ''}.`
      : `📥 אין שום דבר חדש (${events.length} אירועים בקובץ).`);
    render();
    scheduleSync(0);
  } catch (err) {
    toast('לא הצלחתי לקרוא את הקובץ: ' + err.message);
  }
}

const isIcs = (f) => f && (/\.ics$/i.test(f.name) || f.type === 'text/calendar');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = [...(e.dataTransfer?.files || [])].find(isIcs);
  if (file) importIcsFile(file);
  else if (e.dataTransfer?.files?.length) toast('אפשר לגרור לכאן רק קובץ .ics מהמודל.');
});

// Opened via the OS ("Open with" / double-click) — needs file_handlers in the manifest.
async function handleLaunchedFiles() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async ({ files }) => {
    for (const handle of files || []) {
      const file = await handle.getFile();
      if (isIcs(file)) await importIcsFile(file);
    }
  });
}

// Shared from another Android app: sw.js stores the file and redirects to ?shared=ics.
async function handleSharedFile() {
  if (new URLSearchParams(location.search).get('shared') !== 'ics' || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  const res = await caches.match('shared-ics');
  if (!res) return;
  await caches.open('tracker-share').then((c) => c.delete('shared-ics'));
  await importIcsFile(new File([await res.blob()], 'shared.ics', { type: 'text/calendar' }));
}

// ---------- keyboard shortcuts ----------
const SHORTCUTS_HELP = '1–6 מעבר בין לשוניות · N מטלה חדשה · / חיפוש מטלות · S סנכרון · Esc ביטול';
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.slot.tappable')) {
    e.preventDefault();
    openSheet(e.target.dataset.key);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape') {
    if (typing && e.target.id === 'task-search') { state.taskQuery = ''; e.target.value = ''; applyTaskFilter(); e.target.blur(); return; }
    if (state.editing) { state.editing = null; render(); }
    return;
  }
  if (typing) return;
  const key = e.key.toLowerCase();
  const tabByKey = { 1: 'today', 2: 'todo', 3: 'schedule', 4: 'tasks', 5: 'courses', 6: 'settings' };
  if (tabByKey[key]) { e.preventDefault(); switchTab(tabByKey[key]); return; }
  if (key === 'n' || key === 'מ') {
    e.preventDefault();
    if (shownTab() !== 'todo' || !isWide()) state.tab = 'tasks';
    state.editing = 'new';
    render();
    document.querySelector('.task-form input[name=title]')?.focus();
  } else if (key === '/' || key === '.') {
    e.preventDefault();
    if (!document.getElementById('task-search')) switchTab('tasks');
    document.getElementById('task-search')?.focus();
  } else if (key === 's' || key === 'ד') {
    e.preventDefault();
    if (store.getToken()) { runSync(); toast('מסנכרן…'); } else toast('הסנכרון לא מחובר (הגדרות).');
  } else if (key === '?') {
    toast(SHORTCUTS_HELP);
  }
});

function rerenderSettings() {
  document.getElementById('main').innerHTML = viewSettings();
  render();
  fillSettingsCards();
}

// Settings cards whose content is fetched after the page is drawn — every redraw fills them.
function fillSettingsCards() {
  renderPushCard();
  renderOldGist();
}

// ---------- calendar subscription ----------
// calendar.ics in the sync gist (see calendar.js); the GitHub Action keeps it fresh too.
const CAL_PREFS_KEY = 'prefs/calendar';
const GCAL_SCRIPT_KEY = 'prefs/gcal-script'; // user confirmed the Apps Script companion is set up
const calendarEnabled = () => !!state.progress[CAL_PREFS_KEY]?.d?.enabled && !!store.getToken();

function calendarCard() {
  if (!store.getToken()) {
    return `<section class="card"><h2>📆 יומן (Google / Apple)</h2>
      <p class="help">כדי לקבל את המערכת והמטלות ביומן צריך קודם לחבר סנכרון.</p></section>`;
  }
  const url = store.calendarInfo().url;
  if (!state.progress[CAL_PREFS_KEY]?.d?.enabled || !url) {
    return `<section class="card"><h2>📆 יומן (Google / Apple)</h2>
      <p class="help">יומן חי עם השיעורים של הקבוצות שלך (כולל כיתות ושינויים), מועדי הגשה ובחינות.
        מקבלים ממנו ווידג׳ט יומן במסך הבית, תזכורות לפני כל שיעור ו-Siri.
        הכתובת לא רשומה בשום מקום, אבל מי שיש לו אותה יכול לראות את היומן.</p>
      <div class="row"><button class="btn primary" data-action="cal-on">הפעל יומן</button></div></section>`;
  }
  const webcal = url.replace(/^https:/, 'webcal:');
  const script = !!state.progress[GCAL_SCRIPT_KEY]?.d?.enabled;
  const scriptUrl = 'https://github.com/akivamprager/semester-tracker/blob/main/tools/google-apps-script.gs';
  return `<section class="card"><h2>📆 יומן (Google / Apple)</h2>
    <p class="help">קובץ היומן פעיל ✓ — מתעדכן בכל סנכרון ובכל ריצה של המשימה האוטומטית.</p>
    ${script
      ? `<div class="status-line ok">✓ <b>Google Calendar</b> מסונכרן כל שעה דרך הסקריפט — היומן "הסמסטרון", צבע לפי קורס, תזכורות: 15 דק׳ לפני שיעור; הגשה — יום ו-3 שעות לפני; בחינה — שבוע, יום ושעה לפני (בלי תזכורות בשבת).
          <button class="link" data-action="gcal-script" data-on="0">לא הגדרתי</button></div>`
      : `<details class="setup">
          <summary><b>Google Calendar שמתעדכן כל שעה</b> (מומלץ)</summary>
          <p class="help">Google קורא יומן-בקישור רק פעם ב-8–24 שעות. סקריפט קטן בחשבון Google שלך מעתיק את היומן כל שעה ליומן אמיתי,
            וגם מפעיל את התראת הבוקר בזמן (07:00–07:30):</p>
          <ol class="help">
            <li>script.google.com ← פרויקט חדש ← להדביק את <a href="${scriptUrl}" target="_blank" rel="noopener">הקוד הזה</a> ← שמירה.</li>
            <li>⚙️ Project Settings ← Script properties: <code>CALENDAR_URL</code> = הכתובת למטה,
              ו-<code>GITHUB_TOKEN</code> (לא חובה — רק להתראת הבוקר ולבדיקת המודל).</li>
            <li>לבחור <code>setup</code> ← Run ← לאשר הרשאות.</li>
            <li>ב-Google Calendar למחוק את היומן-בקישור הישן, כדי שלא יהיו כפילויות.</li>
          </ol>
          <div class="row"><button class="btn" data-action="gcal-script" data-on="1">✓ הגדרתי את הסקריפט</button></div>
        </details>`}
    <div class="row">
      <input type="text" readonly value="${esc(url)}" class="cal-url" dir="ltr">
      <button class="btn" data-action="cal-copy" data-url="${esc(url)}">העתק</button>
    </div>
    <details class="setup">
      <summary>הוספה כקישור (בלי סקריפט)</summary>
      <div class="row">
        <a class="btn" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}" target="_blank" rel="noopener">Google Calendar (מתעדכן לאט)</a>
        <a class="btn" href="${esc(webcal)}">Apple Calendar</a>
      </div>
      <p class="help"><b>Google:</b> מתעדכן רק פעם ב-8–24 שעות; תזכורות דרך "התראות כברירת מחדל" בהגדרות היומן.<br>
        <b>Apple:</b> בחלון ההרשמה להוריד את הסימון מ"הסר: התראות" ולבחור "רענון: כל שעה".</p>
    </details>
    <div class="row"><button class="btn danger" data-action="cal-off">כבה יומן</button></div>
  </section>`;
}

// Moodle: automatic check by the GitHub job (status written to status/moodle) + manual import.
function panoptoCard() {
  if (!state.sem.panopto) return '';
  const st = state.progress['status/panopto']?.d;
  if (!st) {
    return `<section class="card"><h2>🎬 הקלטות (Panopto)</h2>
      <p class="help">עדיין לא חובר. ההתחברות פעם אחת מהמק: <bdi>node tools/panopto-login.mjs</bdi>.</p></section>`;
  }
  const failed = st.error && (!st.at || st.errorAt > st.at);
  const stale = !failed && now() - new Date(st.at) > 8 * 3600e3;
  return `<section class="card"><h2>🎬 הקלטות (Panopto)</h2>
    <div class="status-line ${failed || stale ? 'warn' : 'ok'}">${failed
      ? `⚠️ <b>${st.error === 'expired' ? 'ההתחברות ל-Panopto פגה' : 'הבדיקה האחרונה נכשלה'}</b> (${agoLabel(st.errorAt)}).
         ${st.error === 'expired' ? 'צריך להתחבר מחדש מהמק: <bdi>node tools/panopto-login.mjs</bdi>.' : 'ננסה שוב בבדיקה הבאה.'}`
      : `${stale ? '⚠️' : '✓'} <b>מחובר</b> — נבדק לאחרונה ${agoLabel(st.at)} (${st.sessions} מפגשים מוקלטים).
         ליד כל שיעור להשלמה יש ▶ צפה בהקלטה, וב"מועדים בכל הקבוצות" — הקלטה לכל קבוצה.`}</div>
  </section>`;
}

function readinessCard() {
  const on = readinessOn(state.progress);
  return `<section class="card" id="readiness-card">
    <label class="switch-row">
      <span><b>📚 מוכנות לבחנים ולמבחנים</b><br>
        <small>${on ? 'ליד כל בוחן/מבחן קרוב: כמה מהשיעורים שבחומר כבר צפית, ומה חסר' : 'כבוי'}</small></span>
      <input type="checkbox" role="switch" class="switch" data-action-change="readiness" ${on ? 'checked' : ''} aria-label="מוכנות לבחנים">
    </label>
  </section>`;
}

function shnatonCard() {
  const st = state.progress['status/shnaton']?.d;
  if (!st) return '';
  const stale = now() - new Date(st.at) > 8 * 3600e3;
  return `<section class="card">
    <h2>🏫 מעקב שנתון</h2>
    <div class="status-line ${stale ? 'warn' : 'ok'}">${stale ? '⚠️' : '✓'} נבדק לאחרונה ${agoLabel(st.at)} (${st.courses} קורסים).
      שינוי בשעות, בכיתות, במרצים או במפגשים מגיע ל-🔔.</div>
  </section>`;
}

function mailCard() {
  const st = state.progress['status/mail']?.d;
  if (!st) {
    return `<section class="card">
      <h2>📢 הודעות מהמייל</h2>
      <p class="help">עדיין לא מחובר. הודעות מהמודל ומהאוניברסיטה שמגיעות ל-Gmail יכולות להופיע כאן ב-🔔 —
        ההגדרה בסקריפט של Google (<bdi>GIST_TOKEN</bdi> ואז <bdi>setup</bdi>), ההוראות בראש הקובץ <bdi>tools/google-apps-script.gs</bdi>.</p>
    </section>`;
  }
  const stale = now() - new Date(st.at) > 8 * 3600e3;
  return `<section class="card">
    <h2>📢 הודעות מהמייל</h2>
    <div class="status-line ${stale ? 'warn' : 'ok'}">${stale ? '⚠️' : '✓'} <b>מחובר</b> — נבדק לאחרונה ${agoLabel(st.at)}.
      הודעות מהמודל ומהקורסים שלך מגיעות ל-🔔 עם התראה; הודעות כלליות של האוניברסיטה נכנסות בשקט.
      ${stale ? '<br>לא נבדק כבר כמה שעות — לבדוק ב-script.google.com → Executions.' : ''}</div>
  </section>`;
}

function moodleCard() {
  const st = state.progress['status/moodle']?.d;
  const stale = st && now() - new Date(st.at) > 6 * 3600e3;
  return `<section class="card">
    <h2>📥 מודל</h2>
    ${st
      ? `<div class="status-line ${stale ? 'warn' : 'ok'}">${stale ? '⚠️' : '✓'} <b>סנכרון אוטומטי</b> — נבדק לאחרונה ${agoLabel(st.at)} (${st.events} אירועים).
          מטלות חדשות, מועדים שזזו ומטלות שנמחקו מתעדכנים לבד, ומופיעים ב-🔔.
          ${stale ? '<br>לא נבדק כבר כמה שעות — אם זה נמשך, ייתכן שהקישור למודל פג (צריך קישור חדש ב-GitHub secret).' : ''}</div>`
      : `<p class="help">אין עדיין סנכרון אוטומטי. אפשר לייבא ידנית:</p>`}
    <details class="setup" ${st ? '' : 'open'}>
      <summary>ייבוא ידני מקובץ</summary>
      <p class="help">במודל: לוח שנה → ייצוא לוח שנה (כל הקורסים, אירועים אחרונים וקרובים) → ייצוא. בחר כאן את קובץ ה-<bdi>.ics</bdi>
        שירד, או גרור אותו לחלון האפליקציה / שתף אותו לאפליקציה (אנדרואיד). מה שסימנת כבוצע נשאר.</p>
      <div class="row"><button class="btn" data-action="import-ics">בחר קובץ <bdi>.ics</bdi></button></div>
    </details>
    <input id="ics-file" type="file" accept=".ics,text/calendar" hidden>
  </section>`;
}

async function setCalendar(enabled) {
  state.progress[CAL_PREFS_KEY] = { s: 'set', d: { enabled }, t: Date.now() };
  store.saveLocal(state.progress);
  if (enabled) {
    await store.publishCalendar(buildCalendar(state.sem, state.progress));
  } else {
    // Remove the published file so the old URL stops showing anything.
    await store.publishCalendar('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//semester-tracker//HE\r\nEND:VCALENDAR\r\n');
  }
  await runSync();
}

// ---------- sharing (Web Share, falls back to the clipboard) ----------
async function shareText(title, text) {
  try {
    if (navigator.share) { await navigator.share({ title, text }); return; }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  await navigator.clipboard.writeText(text);
  toast('📋 הועתק — אפשר להדביק בוואטסאפ או בכל מקום');
}

function shareDayText(dayStart) {
  const courses = computeUnits(state.sem, now());
  const end = new Date(dayStart); end.setDate(end.getDate() + 1);
  const from = new Date(Math.max(+dayStart, +now()));
  const list = openSessions(courses, end).filter((x) => x.start >= dayStart || x.occ?.end > from);
  const d = new Date(dayStart);
  const lines = list.map((x) => x.prayer
    ? `🙏 ${PRAYER_LABELS[x.prayer.prayer]} ${hm(x.start)} · ${x.prayer.minyan.place}`
    : x.exam
    ? `📝 ${x.exam.title} (${x.course.short})${x.exam.due.includes('T') ? ' ' + hm(x.start) : ''}`
    : `${hm(x.occ.start)}–${hm(x.occ.end)} ${x.course.emoji} ${x.course.short} ${x.type.label} ${x.unit.n}`
      + ` · ${x.group.lecturer || 'קב׳ ' + x.group.code}${x.occ.room ? ' · ' + x.occ.room : ''}${x.mine ? ' (שלי)' : ''}`);
  return `אפשרויות ליום ${DAY_LABELS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}:\n${lines.join('\n')}`;
}

function shareTasksText() {
  const courses = computeUnits(state.sem, now());
  const week = new Date(now()); week.setDate(week.getDate() + 7);
  const list = allTasks(courses)
    .filter((t) => !t.done && t.dueDate && t.dueDate >= now() && t.dueDate <= week)
    .sort(byDue);
  const short = (code) => courses.find((c) => c.code === code)?.short || '';
  return `מטלות ובחינות לשבוע הקרוב:\n${list.map((t) =>
    `• ${t.kind === 'exam' ? '📝 ' : ''}${t.title} (${short(t.course)}) — ${fmt(t.dueDate, t.due.includes('T'))}`).join('\n')}`;
}

// ---------- morning notification ----------
// The GitHub Action (tools/morning.mjs) sends the summary via Web Push to every
// subscription saved in the sync gist. Needs sync connected and, on iPhone, the app
// opened from the home screen.
let pushConfig = null;

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function pushRegistration() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  return navigator.serviceWorker.getRegistration();
}

// After the move to two gists: the old one (whose address was shared as the calendar link and
// whose history still has the private files) must be deleted by hand.
async function renderOldGist() {
  const old = await store.oldGists();
  const el = document.getElementById('old-gist');
  if (!el) return;
  el.innerHTML = old.length ? `<section class="card">
      <h2>🔒 למחוק ${old.length === 1 ? 'את הגיסט הישן' : `${old.length} גיסטים ישנים`}</h2>
      <div class="status-line warn">⚠️ הנתונים הפרטיים (התקדמות, מיילים, התראות) עברו לגיסט פרטי חדש.
        הגיסט הישן עדיין קיים — כתובתו שותפה כקישור היומן, וההיסטוריה שלו כוללת את הנתונים. צריך למחוק אותו.</div>
      <p class="help">ב-GitHub: פתח את הקישור → <b>Delete</b> (מימין למעלה) → אשר. הכרטיס הזה ייעלם לבד.
        לפני כן: עדכן את קישור היומן החדש בסקריפט של Google ובאפליקציית המק (📆 יומן, למטה).</p>
      <div class="row">${old.map((g, i) => `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">פתח ${old.length > 1 ? `גיסט ${i + 1}` : 'את הגיסט הישן'} ↗</a>`).join('')}</div>
    </section>` : '';
}

async function renderPushCard() {
  const card = document.getElementById('push-card');
  if (!card) return;
  const reg = await pushRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  let body;
  if (!reg) {
    body = `<p class="help">ההתראות עובדות רק כשהאפליקציה פתוחה ממסך הבית. באייפד/אייפון: בספארי או בכרום ← שתף ← "הוסף למסך הבית", ולפתוח משם (iPadOS 16.4 ומעלה).</p>`;
  } else if (!pushConfig) {
    body = '<p class="help">ההתראות עוד לא הוגדרו בשרת (חסר push-config.json).</p>';
  } else if (!store.getToken()) {
    body = '<p class="help">כדי לקבל התראות צריך קודם לחבר סנכרון (למעלה).</p>';
  } else if (sub) {
    const st = state.progress['status/morning']?.d;
    const sentToday = st && dayDiff(new Date(st.at)) === 0;
    body = `<p class="help">פעיל במכשיר הזה ✓ — <b>סיכום בוקר</b> (07:00–07:30): השיעורים של היום, מה שנשאר להשלים ומטלות קרובות,
        ו<b>עדכונים מהמודל</b> כשמשהו משתנה (גם ב-🔔).</p>
      ${st ? `<div class="status-line ${sentToday ? 'ok' : ''}">${sentToday ? '✓' : '🕑'} סיכום הבוקר נשלח לאחרונה: ${sentToday ? 'היום' : fmt(new Date(st.at), false)} ב-${hm(new Date(st.at))}
        ${st.devices ? `ל-${st.devices} מכשירים` : ''}</div>` : ''}
      <div class="row">
        <button class="btn" data-action="push-test">הצג דוגמה</button>
        <button class="btn" data-action="push-off">כבה</button>
      </div>`;
  } else {
    body = `<p class="help">סיכום בוקר (07:00–07:30) ועדכונים מהמודל כהתראה בטלפון. ההפעלה היא לכל מכשיר בנפרד.</p>
      <div class="row"><button class="btn primary" data-action="push-on">הפעל התראת בוקר</button></div>`;
  }
  card.innerHTML = `<h2>🔔 התראות</h2>${body}`;
}

async function pushOn() {
  // Ask first: Safari (iPhone/iPad) only allows the prompt directly from the tap,
  // before any other await.
  const permission = await Notification.requestPermission();
  const reg = await pushRegistration();
  if (permission !== 'granted') {
    alert('לא ניתנה הרשאה להתראות. אפשר לשנות בהגדרות המכשיר.');
    return;
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToBytes(pushConfig.vapidPublicKey),
  });
  await store.addPushSubscription({ ...sub.toJSON(), label: deviceLabel(), added: new Date().toISOString().slice(0, 10) });
}

// "Android · Chrome (app)", "Mac · Chrome (app)", "iPad · Safari (app)" — so the morning
// job's log says which device got the notification.
function deviceLabel() {
  const ua = navigator.userAgent;
  // iPadOS Safari/Chrome identify as "Macintosh" — a touchscreen "Mac" is an iPad.
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = /Android/.test(ua) ? 'Android' : ipad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /Edg\/|EdgiOS/.test(ua) ? 'Edge' : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  const installed = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches ? ' (app)' : '';
  return [os, browser].filter(Boolean).join(' · ') + installed;
}

async function pushOff() {
  const reg = await pushRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await store.removePushSubscription(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

async function pushTest() {
  const reg = await pushRegistration();
  const s = dailySummary(state.sem, state.progress, now()) || { title: 'בוקר טוב!', body: 'אין היום שום דבר פתוח 🎉' };
  await reg.showNotification(s.title, {
    body: s.body, tag: 'morning', icon: 'icon-192.png', dir: 'rtl', lang: 'he',
    actions: [{ action: 'schedule', title: '📅 מערכת' }, { action: 'tasks', title: '✏️ משימות' }],
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.editing) render();
  runSync();
});
window.addEventListener('online', () => runSync());
// Newly finished lessons appear without reload (but don't wipe an open form).
setInterval(() => { if (!state.editing) render(); }, 60 * 1000);

// ---------- title bar (Window Controls Overlay) ----------
// With display_override "window-controls-overlay", Chrome lets the app draw in the title
// bar; the tabs move up there next to the window buttons.
function placeNav() {
  const wco = navigator.windowControlsOverlay;
  const inTitleBar = !!wco?.visible;
  document.body.classList.toggle('wco', inTitleBar);
  const nav = document.querySelector('nav');
  const header = document.querySelector('header');
  if (inTitleBar && nav.parentElement !== header) header.insertBefore(nav, header.querySelector('.header-actions'));
  if (!inTitleBar && nav.parentElement === header) header.after(nav);
}
navigator.windowControlsOverlay?.addEventListener('geometrychange', placeNav);
placeNav();

// ---------- boot ----------
async function loadSemester() {
  const id = localStorage.getItem(LS_SEMESTER) || state.index.default;
  const entry = state.index.semesters.find((s) => s.id === id) || state.index.semesters[0];
  const text = await (await fetch(`semesters/${entry.file}`, { cache: 'no-cache' })).text();
  state.semText = text;
  state.sem = JSON.parse(text);
  document.getElementById('title').textContent = state.sem.name;
}

// ---------- staying up to date without ⌘R ----------
// Data (semester file) is refreshed in place; new app code arrives as a new service worker,
// after which the page reloads at a safe moment, keeping the tab and scroll position.
let swReg = null;
let reloadPending = false;
const RESTORE_KEY = 'tracker.restore';

const busy = () => !!state.editing || !!document.activeElement?.closest?.('input, textarea, select');

async function refreshData() {
  try {
    // ?fresh: straight from the network (the service worker otherwise answers from its copy)
    const index = await (await fetch('semesters/index.json?fresh=1', { cache: 'no-cache' })).json();
    const id = localStorage.getItem(LS_SEMESTER) || index.default;
    const entry = index.semesters.find((x) => x.id === id) || index.semesters[0];
    const text = await (await fetch(`semesters/${entry.file}?fresh=1`, { cache: 'no-cache' })).text();
    state.index = index;
    if (text !== state.semText) {
      state.semText = text;
      state.sem = JSON.parse(text);
      document.getElementById('title').textContent = state.sem.name;
      if (!busy()) render();
    }
  } catch { /* offline: keep what we have */ }
}

function checkForUpdates() {
  if (!navigator.onLine) return;
  swReg?.update().catch(() => {});
  refreshData();
}

function reloadNow() {
  sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ tab: state.tab, horizon: state.horizon, y: scrollY }));
  location.reload();
}

// Called when a new version has taken over. Reload right away if nobody is looking,
// otherwise after a short notice — but never while typing or editing a task.
function reloadWhenSafe() {
  reloadPending = true;
  if (busy()) return; // retried on the next check / when editing ends
  if (document.visibilityState === 'hidden') { reloadNow(); return; }
  toast('🔄 מתעדכן לגרסה חדשה…', { ms: 1500 });
  setTimeout(() => (busy() ? null : reloadNow()), 1200);
}

function restoreAfterReload() {
  const saved = sessionStorage.getItem(RESTORE_KEY);
  if (!saved) return;
  sessionStorage.removeItem(RESTORE_KEY);
  try {
    const { tab, horizon, y } = JSON.parse(saved);
    if (TABS.includes(tab)) state.tab = tab;
    if (horizon) state.horizon = horizon;
    render();
    requestAnimationFrame(() => scrollTo(0, y || 0));
  } catch { /* ignore */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && reloadPending && !state.editing) reloadNow();
  if (document.visibilityState === 'visible') checkForUpdates();
});
window.addEventListener('focus', checkForUpdates);
window.addEventListener('online', checkForUpdates);
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (reloadPending) reloadWhenSafe();
  else checkForUpdates();
}, 5 * 60 * 1000);

async function boot() {
  state.index = await (await fetch('semesters/index.json', { cache: 'no-cache' })).json();
  pushConfig = await fetch('push-config.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  await loadSemester(); // the saved copy (instant); refreshData below brings any newer one
  render();
  restoreAfterReload();
  refreshData();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // When a new version takes over, reload (at a safe moment) so all files match.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloadPending) reloadWhenSafe();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => { swReg = reg; })
      .catch(() => {});
  }
  runSync();
  handleLaunchedFiles();
  handleSharedFile();
  if (new URLSearchParams(location.search).get('inbox')) openInbox();
}

boot().catch((e) => {
  document.getElementById('main').innerHTML = `<div class="empty">שגיאה בטעינה: ${esc(e.message)}</div>`;
});
