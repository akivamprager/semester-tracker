import { computeUnits, mergeTasks, sessionsBetween, DAY_LABELS } from './schedule.js';
import { dailySummary } from './summary.js';
import { parseIcs, icsTaskChanges } from './ics.js';
import * as store from './sync.js';

const LS_SEMESTER = 'tracker.semester';

// ?tab=tasks etc. — used by the app-icon shortcuts (manifest.webmanifest).
const TABS = ['todo', 'schedule', 'tasks', 'courses', 'settings'];
const startTab = new URLSearchParams(location.search).get('tab');

const state = {
  tab: TABS.includes(startTab) ? startTab : 'todo',
  index: null,
  sem: null,
  progress: store.loadLocal(),
  sync: { status: 'idle', msg: '' },
  editing: null, // task id whose edit form is open ('new' for a new task)
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
  return `<div class="task ${t.done ? 'is-done' : ''} ${overdue ? 'overdue' : ''}" data-search="${esc(search)}">
    ${isExam
      ? '<span class="task-icon">📝</span>'
      : `<input type="checkbox" class="task-check" data-action="toggle-task" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}>`}
    <div class="task-body">
      <div class="name">${esc(t.title)} ${course ? `<span class="course-tag colored" ${courseStyle(course)}>${course.emoji} <bdi>${esc(course.short)}</bdi></span>` : ''}${t.kind === 'practice' ? ' <span class="course-tag">לא נבדק</span>' : ''}</div>
      <div class="meta when">${t.kind === 'practice' && t.dueDate ? 'יעד: ' : ''}${when}${t.estimated && t.kind !== 'practice' ? ' · <span class="est">משוער</span>' : ''}</div>
      ${t.note ? `<div class="meta">${esc(t.note)}</div>` : ''}
    </div>
    <button class="link" data-action="edit-task" data-id="${esc(t.id)}">✎</button>
  </div>`;
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
        <h2>${title} <small>${list.length}</small></h2>
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
  const cards = courses.map((c) => {
    const owed = c.types
      .flatMap((t) => t.units.map((u) => ({ ...u, label: t.label, mine: t.mine })))
      .filter((u) => u.available && !statusOf(u.key))
      .sort((a, b) => a.first.end - b.first.end);
    total += owed.length;
    const upcoming = c.types
      .map((t) => ({ t, u: t.units.find((u) => !u.available) }))
      .filter((x) => x.u);
    const next = upcoming
      .map(({ t, u }) => `${t.label} ${u.n}${u.topic ? ` (${esc(u.topic)})` : ''}: ${fmt(u.first.start)} · ${u.first.group.lecturer ? esc(u.first.group.lecturer) : 'קב׳ ' + grp(u.first.group.code)}${roomText(u.first)}`);
    if (!owed.length && !next.length) return null;
    // Courses with something to catch up on first (longest-waiting first),
    // then the rest by their next session.
    const sortKey = owed.length
      ? [0, owed[0].first.end]
      : [1, Math.min(...upcoming.map(({ u }) => u.first.start))];
    const rows = owed.map((u) => {
      const firstIsMine = u.first.group === u.mine;
      let where;
      if (firstIsMine) where = `התקיים בקבוצה שלך: ${fmt(u.first.start)}`;
      else {
        where = `התקיים לראשונה: ${fmt(u.first.start)} · ${esc(u.first.group.lecturer)} (קב׳ ${grp(u.first.group.code)})<br>`;
        where += u.own
          ? `בקבוצה שלך: ${fmt(u.own.start)}${u.own.end > t0 ? ` (עוד לא)${roomText(u.own)}` : ''}`
          : 'אין מפגש מקביל בקבוצה שלך (בגלל חג/ביטול)';
      }
      return `<div class="unit">
        <div class="name">${u.label} ${u.n}${u.topic ? ` · <span class="topic">${esc(u.topic)}</span>` : ''}</div>
        <div class="meta">${where}</div>
        <div class="actions">
          <button class="attend" data-action="mark" data-key="${u.key}" data-s="done">✓ סיימתי</button>
        </div>
      </div>`;
    }).join('');
    return { sortKey, html: `<section class="card course" ${courseStyle(c)}>
      <h2>${courseTitle(c)} <small>${owed.length ? owed.length + ' להשלים' : 'מעודכן ✓'}</small></h2>
      ${rows}
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
  const banner = total ? '' : '<div class="empty">אין שיעורים שמחכים לך 🎉</div>';
  return scheduleStrip(courses) + soonCard + banner + cards;
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
  return [...sessions, ...exams].sort((a, b) => a.start - b.start);
}

function horizonEnd() {
  const end = startOfDay(now());
  end.setDate(end.getDate() + (state.horizon === 'week' ? 7 : 2));
  return end;
}

function slotRow(x) {
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
    live ? '<span class="pill live">● עכשיו</span>' : '',
    !x.mine && own && own.start > x.occ.start ? `<span class="pill">בקבוצה שלך: ${fmt(own.start)}</span>` : '',
  ].join('');
  return `<div class="slot ${x.mine ? 'mine' : ''} ${live ? 'live' : ''}" ${courseStyle(c)}>
    <div class="slot-time">${hm(x.occ.start)}<small>–${hm(x.occ.end)}</small></div>
    <div class="slot-body">
      <div class="name">${c.emoji} <bdi>${esc(c.short)}</bdi> · ${x.type.label} ${x.unit.n}${x.unit.topic ? ` <span class="topic">${esc(x.unit.topic)}</span>` : ''}</div>
      <div class="meta">${x.group.lecturer ? esc(x.group.lecturer) + ' · ' : ''}קב׳ ${grp(x.group.code)}${roomText(x.occ)}</div>
      ${tags ? `<div class="pills">${tags}</div>` : ''}
    </div>
  </div>`;
}

function viewSchedule(courses) {
  const list = openSessions(courses, horizonEnd());
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
        <h2>${dayTitle(new Date(k))} <small>${items.filter((x) => !x.exam).length} מפגשים</small></h2>
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
  const list = openSessions(courses, end).filter((x) => !x.exam);
  const today = list.filter((x) => dayDiff(x.start) === 0);
  const tomorrow = list.filter((x) => dayDiff(x.start) === 1);
  if (!list.length) return '';
  const nextOne = list[0];
  const live = nextOne.occ.start <= now();
  return `<button class="strip" data-tab-link="schedule">
    <span>📅 היום: <b>${today.length}</b> אפשרויות · מחר: <b>${tomorrow.length}</b></span>
    <span class="strip-next">${live ? 'עכשיו' : 'הבא'}: ${nextOne.course.emoji} ${esc(nextOne.course.short)} ${nextOne.type.label} ${nextOne.unit.n} ${hm(nextOne.occ.start)}${nextOne.mine ? ' (שלך)' : ''} ‹</span>
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
    <h2>סמסטר</h2>
    <select id="sem-select">${sems}</select>
    <p class="help">ההתקדמות נשמרת לכל סמסטר בנפרד. לסמסטר חדש מוסיפים קובץ ב-<code>semesters/</code>.</p>
  </section>
  <section class="card">
    <h2>סנכרון בין מכשירים</h2>
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
  <section class="card" id="push-card"><h2>התראת בוקר</h2><p class="help">טוען…</p></section>
  <section class="card">
    <h2>ייבוא מטלות מהמודל</h2>
    <p class="help">במודל: לוח שנה → ייצוא לוח שנה (כל הקורסים, השבועות הקרובים) → ייצוא. בחר כאן את קובץ ה-<bdi>.ics</bdi>
      שירד. מטלות חדשות יתווספו ומועדים שהשתנו יתעדכנו — מה שסימנת כבוצע נשאר.</p>
    <div class="row"><button class="btn" data-action="import-ics">בחר קובץ <bdi>.ics</bdi></button></div>
    <p class="help">אפשר גם לגרור את הקובץ לחלון האפליקציה, לפתוח אותו ישירות עם האפליקציה (Mac), או לשתף אותו לאפליקציה (אנדרואיד).</p>
    <input id="ics-file" type="file" accept=".ics,text/calendar" hidden>
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

// Number on the app icon (Dock on Mac, launcher on Android): lessons to catch up on +
// homework due within 3 days or overdue.
function updateAppBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
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

function render() {
  if (!state.sem) return;
  const courses = computeUnits(state.sem, now());
  const wide = isWide();
  document.body.classList.toggle('wide', wide);
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === shownTab()));
  document.querySelector('.icon-btn[data-tab-link=settings]')?.classList.toggle('active', state.tab === 'settings');
  const todo = viewTodo(courses, { withSoon: !wide }); // always computed so the badges stay current
  const t0 = now();
  const soon = new Date(t0); soon.setDate(soon.getDate() + 3);
  const urgent = allTasks(courses).filter((t) => t.kind === 'hw' && !t.done && t.dueDate && t.dueDate <= soon).length;
  document.getElementById('task-count').textContent = urgent || '';
  updateAppBadge(state.owedCount + urgent);
  const main = document.getElementById('main');
  const searchFocused = document.activeElement?.id === 'task-search';
  if (shownTab() === 'todo' && wide) {
    main.innerHTML = `<div class="columns">
      <div class="col"><h2 class="col-title">שיעורים להשלים</h2>${todo}</div>
      <div class="col"><h2 class="col-title">משימות ${urgent ? `<span class="badge">${urgent}</span>` : ''}</h2>${viewTasks(courses)}</div>
    </div>`;
  } else if (state.tab === 'todo') main.innerHTML = todo;
  else if (state.tab === 'schedule') main.innerHTML = viewSchedule(courses);
  else if (state.tab === 'tasks') main.innerHTML = viewTasks(courses);
  else if (state.tab === 'courses') main.innerHTML = viewCourses(courses);
  else if (!document.getElementById('sem-select')) { main.innerHTML = viewSettings(); renderPushCard(); }
  applyTaskFilter();
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
  if (action === 'mark') setStatus(el.dataset.key, el.dataset.s || null);
  if (action === 'mark-all') {
    if (!confirm('לסמן את כל השיעורים שהתקיימו בקורס הזה כבוצעו?')) return;
    const c = computeUnits(state.sem, now()).find((x) => x.code === el.dataset.course);
    const t = Date.now();
    for (const ty of c.types) for (const u of ty.units) {
      if (u.available && !statusOf(u.key)) state.progress[u.key] = { s: 'done', t };
    }
    store.saveLocal(state.progress);
    render();
    scheduleSync();
  }
  if (action === 'toggle-task') setStatus(taskDoneKey(id), el.checked ? 'done' : null);
  if (action === 'new-task' || action === 'edit-task') {
    state.editing = action === 'new-task' ? 'new' : id;
    if (state.tab !== 'tasks') { state.tab = 'tasks'; window.scrollTo(0, 0); }
    render();
    document.querySelector('.task-form input[name=title]')?.focus();
  }
  if (action === 'cancel-edit') { state.editing = null; render(); }
  if (action === 'delete-task') {
    if (!confirm('למחוק את המטלה?')) return;
    state.editing = null;
    put(taskDataKey(id), { s: 'set', d: { deleted: true } });
  }
  if (action === 'sync') runSync();
  if (action === 'horizon') { state.horizon = el.dataset.h; render(); }
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
  };
  const id = form.dataset.id === 'new' ? 'u' + Date.now().toString(36) : form.dataset.id;
  state.editing = null;
  put(taskDataKey(id), { s: 'set', d });
});

document.body.addEventListener('input', (e) => {
  if (e.target.id !== 'task-search') return;
  state.taskQuery = e.target.value;
  applyTaskFilter();
});

document.body.addEventListener('change', async (e) => {
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
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 4000);
}

async function importIcsFile(file) {
  try {
    const events = parseIcs(await file.text());
    if (!events.length) { toast('הקובץ לא נראה כמו ייצוא לוח שנה מהמודל.'); return; }
    const courses = computeUnits(state.sem, now());
    const all = mergeTasks(state.sem, courses, state.progress, now(), { includeHidden: true });
    const changes = icsTaskChanges(state.sem, events, all);
    const t = Date.now();
    let added = 0;
    for (const { id, d } of changes) {
      const key = taskDataKey(id);
      if (d.title) added++;
      state.progress[key] = { s: 'set', d: { ...(state.progress[key]?.d || {}), ...d }, t };
    }
    store.saveLocal(state.progress);
    toast(changes.length
      ? `📥 נוספו ${added} מטלות, עודכנו ${changes.length - added} מועדים.`
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
const SHORTCUTS_HELP = '1–5 מעבר בין לשוניות · N מטלה חדשה · / חיפוש מטלות · S סנכרון · Esc ביטול';
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape') {
    if (typing && e.target.id === 'task-search') { state.taskQuery = ''; e.target.value = ''; applyTaskFilter(); e.target.blur(); return; }
    if (state.editing) { state.editing = null; render(); }
    return;
  }
  if (typing) return;
  const key = e.key.toLowerCase();
  const tabByKey = { 1: 'todo', 2: 'schedule', 3: 'tasks', 4: 'courses', 5: 'settings' };
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
  renderPushCard();
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

async function renderPushCard() {
  const card = document.getElementById('push-card');
  if (!card) return;
  const reg = await pushRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  let body;
  if (!reg) {
    body = `<p class="help">ההתראות עובדות רק כשהאפליקציה פתוחה ממסך הבית (באייפון: שתף → הוסף למסך הבית, ולפתוח משם).</p>`;
  } else if (!pushConfig) {
    body = '<p class="help">ההתראות עוד לא הוגדרו בשרת (חסר push-config.json).</p>';
  } else if (!store.getToken()) {
    body = '<p class="help">כדי לקבל התראות צריך קודם לחבר סנכרון (למעלה).</p>';
  } else if (sub) {
    body = `<p class="help">פעיל ✓ — כל בוקר בסביבות 07:00 תגיע התראה עם השיעורים של היום, מה שנשאר להשלים ומטלות קרובות.</p>
      <div class="row">
        <button class="btn" data-action="push-test">הצג דוגמה</button>
        <button class="btn" data-action="push-off">כבה</button>
      </div>`;
  } else {
    body = `<p class="help">כל בוקר בסביבות 07:00: השיעורים של היום, מה שנשאר להשלים ומטלות קרובות.</p>
      <div class="row"><button class="btn primary" data-action="push-on">הפעל התראת בוקר</button></div>`;
  }
  card.innerHTML = `<h2>התראת בוקר</h2>${body}`;
}

async function pushOn() {
  const reg = await pushRegistration();
  if ((await Notification.requestPermission()) !== 'granted') {
    alert('לא ניתנה הרשאה להתראות. אפשר לשנות בהגדרות המכשיר.');
    return;
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToBytes(pushConfig.vapidPublicKey),
  });
  await store.addPushSubscription(sub.toJSON());
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
  await reg.showNotification(s.title, { body: s.body, tag: 'morning', icon: 'icon-192.png', dir: 'rtl', lang: 'he' });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.editing) render();
  runSync();
});
window.addEventListener('online', () => runSync());
// Newly finished lessons appear without reload (but don't wipe an open form).
setInterval(() => { if (!state.editing) render(); }, 60 * 1000);

// ---------- boot ----------
async function loadSemester() {
  const id = localStorage.getItem(LS_SEMESTER) || state.index.default;
  const entry = state.index.semesters.find((s) => s.id === id) || state.index.semesters[0];
  state.sem = await (await fetch(`semesters/${entry.file}`, { cache: 'no-cache' })).json();
  document.getElementById('title').textContent = state.sem.name;
}

async function boot() {
  state.index = await (await fetch('semesters/index.json', { cache: 'no-cache' })).json();
  pushConfig = await fetch('push-config.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  await loadSemester();
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // When a new version takes over, reload once so all files come from the same version.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded && !state.editing) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
  runSync();
  handleLaunchedFiles();
  handleSharedFile();
}

boot().catch((e) => {
  document.getElementById('main').innerHTML = `<div class="empty">שגיאה בטעינה: ${esc(e.message)}</div>`;
});
