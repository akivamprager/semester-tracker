import { computeUnits, builtinTasks, parseDue, DAY_LABELS } from './schedule.js';
import * as store from './sync.js';

const LS_SEMESTER = 'tracker.semester';
const STATUS_LABELS = { attended: '✓ השתתפתי', watched: '▶ צפיתי בהקלטה' };

const state = {
  tab: 'todo',
  index: null,
  sem: null,
  progress: store.loadLocal(),
  sync: { status: 'idle', msg: '' },
  editing: null, // task id whose edit form is open ('new' for a new task)
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

function allTasks(courses) {
  const prefix = `${state.sem.id}/taskdata/`;
  const byId = new Map(builtinTasks(state.sem, courses).map((t) => [t.id, t]));
  for (const [k, v] of Object.entries(state.progress)) {
    if (!k.startsWith(prefix) || !v.d) continue;
    const id = k.slice(prefix.length);
    const base = byId.get(id) || { id, kind: 'hw', user: true };
    byId.set(id, { ...base, ...v.d, estimated: v.d.due !== undefined ? false : base.estimated });
  }
  return [...byId.values()]
    .map((t) => ({ ...t, dueDate: parseDue(t.due), done: statusOf(taskDoneKey(t.id)) === 'done' }))
    .filter((t) => !t.deleted && (t.done || !t.showFrom || t.showFrom <= now()));
}

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
  return `<div class="task ${t.done ? 'is-done' : ''} ${overdue ? 'overdue' : ''}">
    ${isExam
      ? '<span class="task-icon">📝</span>'
      : `<input type="checkbox" class="task-check" data-action="toggle-task" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}>`}
    <div class="task-body">
      <div class="name">${esc(t.title)} <span class="course-tag"><bdi>${esc(course?.short || '')}</bdi></span>${t.kind === 'practice' ? ' <span class="course-tag">לא נבדק</span>' : ''}</div>
      <div class="meta when">${t.kind === 'practice' && t.dueDate ? 'יעד: ' : ''}${when}${t.estimated && t.kind !== 'practice' ? ' · <span class="est">משוער</span>' : ''}</div>
      ${t.note ? `<div class="meta">${esc(t.note)}</div>` : ''}
    </div>
    <button class="link" data-action="edit-task" data-id="${esc(t.id)}">✎</button>
  </div>`;
}

function taskForm(t, courses) {
  const [date, time] = (t.due || '').split('T');
  const opts = courses
    .map((c) => `<option value="${c.code}" ${c.code === t.course ? 'selected' : ''}>${esc(c.short)}</option>`)
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
    ${state.editing === 'new'
      ? `<section class="card">${taskForm({ id: 'new', course: courses[0]?.code, title: '', kind: 'hw' }, courses)}</section>`
      : '<button class="btn primary add-btn" data-action="new-task">+ מטלה חדשה</button>'}
    ${groups.filter(([, list]) => list.length).map(([title, list]) => `
      <section class="card">
        <h2>${title} <small>${list.length}</small></h2>
        ${list.map(row).join('')}
      </section>`).join('')}
    ${done.length ? `<section class="card"><details><summary>הושלמו (${done.length})</summary>${done.map(row).join('')}</details></section>` : ''}
    <p class="help">מועדי ההגשה של תרגילי הבית מתפרסמים במודל — הוסף אותם כאן (או ערוך עם ✎). מועדים "משוערים" חושבו לפי נהלי הקורס.</p>`;
}

function viewTodo(courses) {
  let total = 0;
  const t0 = now();
  const week = new Date(t0); week.setDate(week.getDate() + 7);
  const soon = allTasks(courses)
    .filter((t) => !t.done && t.dueDate && t.dueDate <= week && (t.kind !== 'exam' || t.dueDate >= t0))
    .sort(byDue);
  const soonCard = soon.length ? `<section class="card soon">
      <h2>מטלות ובחינות קרובות <button class="link" data-tab-link="tasks">לכל המשימות</button></h2>
      ${soon.map((t) => taskRow(t, courses)).join('')}
    </section>` : '';
  const cards = courses.map((c) => {
    const owed = c.types
      .flatMap((t) => t.units.map((u) => ({ ...u, label: t.label, mine: t.mine })))
      .filter((u) => u.available && !statusOf(u.key))
      .sort((a, b) => a.first.end - b.first.end);
    total += owed.length;
    const next = c.types
      .map((t) => ({ t, u: t.units.find((u) => !u.available) }))
      .filter((x) => x.u)
      .map(({ t, u }) => `${t.label} ${u.n}${u.topic ? ` (${esc(u.topic)})` : ''}: ${fmt(u.first.start)} · ${u.first.group.lecturer ? esc(u.first.group.lecturer) : 'קב׳ ' + grp(u.first.group.code)}`);
    if (!owed.length && !next.length) return '';
    const rows = owed.map((u) => {
      const firstIsMine = u.first.group === u.mine;
      let where;
      if (firstIsMine) where = `התקיים בקבוצה שלך: ${fmt(u.first.start)}`;
      else {
        where = `התקיים לראשונה: ${fmt(u.first.start)} · ${esc(u.first.group.lecturer)} (קב׳ ${grp(u.first.group.code)})<br>`;
        where += u.own
          ? `בקבוצה שלך: ${fmt(u.own.start)}${u.own.end > t0 ? ' (עוד לא)' : ''}`
          : 'אין מפגש מקביל בקבוצה שלך (בגלל חג/ביטול)';
      }
      return `<div class="unit">
        <div class="name">${u.label} ${u.n}${u.topic ? ` · <span class="topic">${esc(u.topic)}</span>` : ''}</div>
        <div class="meta">${where}</div>
        <div class="actions">
          <button class="attend" data-action="mark" data-key="${u.key}" data-s="attended">✓ השתתפתי</button>
          <button class="watch" data-action="mark" data-key="${u.key}" data-s="watched">▶ צפיתי בהקלטה</button>
        </div>
      </div>`;
    }).join('');
    return `<section class="card">
      <h2><bdi>${esc(c.short)}</bdi> <small>${owed.length ? owed.length + ' להשלים' : 'מעודכן ✓'}</small></h2>
      ${rows}
      ${next.length ? `<div class="upcoming">הבא: ${next.join('<br>הבא: ')}</div>` : ''}
      ${owed.length > 1 ? `<button class="link" data-action="mark-all" data-course="${c.code}">סמן הכל כ"השתתפתי"</button>` : ''}
    </section>`;
  }).join('');
  document.getElementById('todo-count').textContent = total || '';
  const banner = total ? '' : '<div class="empty">אין שיעורים שמחכים לך 🎉</div>';
  return soonCard + banner + cards;
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
    return `<section class="card">
      <h2><bdi>${esc(c.short)}</bdi> <small>${done.length} / ${avail} שהתקיימו · ${units.length} בסמסטר</small></h2>
      <div class="progress"><div style="width:${Math.min(pct, 100)}%"></div></div>
      ${exams.length ? `<div class="meta">${exams.map((t) => `📝 ${esc(t.title)}: ${t.dueDate ? fmt(t.dueDate, t.due.includes('T')) : 'טרם נקבע'}`).join('<br>')}</div>` : ''}
      ${c.info.length ? `<details><summary>נהלים ומידע</summary><ul class="info">${c.info.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}
      ${syllabus.map((t) => `<details><summary>נושאי ${t.label === 'הרצאה' ? 'ההרצאות' : 'התרגולים'}</summary>
        <ol class="syllabus">${t.units.map((u) => `<li class="${statusOf(u.key) ? 'done' : u.available ? 'owed' : ''}">${esc(u.topic || '—')}${statusOf(u.key) ? ' ✓' : ''}</li>`).join('')}</ol>
      </details>`).join('')}
      ${done.length ? `<details><summary>סימנתי (${done.length})</summary>
        ${done.sort((a, b) => b.first.end - a.first.end).map((u) => `<div class="done-row">
          <span>${u.label} ${u.n} · ${STATUS_LABELS[statusOf(u.key)]}</span>
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
  <section class="card">
    <h2>גיבוי ידני</h2>
    <div class="row">
      <button class="btn" data-action="export">ייצוא לקובץ</button>
      <button class="btn" data-action="import">ייבוא מקובץ</button>
    </div>
    <input id="import-file" type="file" accept="application/json" hidden>
  </section>`;
}

function render() {
  if (!state.sem) return;
  const courses = computeUnits(state.sem, now());
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const todo = viewTodo(courses); // always computed so the badges stay current
  const t0 = now();
  const soon = new Date(t0); soon.setDate(soon.getDate() + 3);
  const urgent = allTasks(courses).filter((t) => t.kind === 'hw' && !t.done && t.dueDate && t.dueDate <= soon).length;
  document.getElementById('task-count').textContent = urgent || '';
  const main = document.getElementById('main');
  if (state.tab === 'todo') main.innerHTML = todo;
  else if (state.tab === 'tasks') main.innerHTML = viewTasks(courses);
  else if (state.tab === 'courses') main.innerHTML = viewCourses(courses);
  else if (!document.getElementById('sem-select')) main.innerHTML = viewSettings();
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
    if (!confirm('לסמן את כל השיעורים שהתקיימו בקורס הזה כ"השתתפתי"?')) return;
    const c = computeUnits(state.sem, now()).find((x) => x.code === el.dataset.course);
    const t = Date.now();
    for (const ty of c.types) for (const u of ty.units) {
      if (u.available && !statusOf(u.key)) state.progress[u.key] = { s: 'attended', t };
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

document.body.addEventListener('change', async (e) => {
  if (e.target.id === 'sem-select') {
    localStorage.setItem(LS_SEMESTER, e.target.value);
    await loadSemester();
    rerenderSettings();
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

function rerenderSettings() {
  document.getElementById('main').innerHTML = viewSettings();
  render();
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
  await loadSemester();
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js');
  }
  runSync();
}

boot().catch((e) => {
  document.getElementById('main').innerHTML = `<div class="empty">שגיאה בטעינה: ${esc(e.message)}</div>`;
});
