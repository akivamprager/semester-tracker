import { computeUnits, DAY_LABELS } from './schedule.js';
import * as store from './sync.js';

const LS_SEMESTER = 'tracker.semester';
const STATUS_LABELS = { attended: '✓ השתתפתי', watched: '▶ צפיתי בהקלטה' };

const state = {
  tab: 'todo',
  index: null,
  sem: null,
  progress: store.loadLocal(),
  sync: { status: 'idle', msg: '' },
};

// ?now=2026-11-20T12:00 overrides the current time (for testing).
const nowParam = new URLSearchParams(location.search).get('now');
const now = () => (nowParam ? new Date(nowParam) : new Date());

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmt(d) {
  const today = new Date(now()); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const rel = { 0: 'היום', '-1': 'אתמול', 1: 'מחר' }[diff];
  const hm = d.toTimeString().slice(0, 5);
  const date = `${d.getDate()}.${d.getMonth() + 1}`;
  return `${rel ? rel + ', ' : ''}יום ${DAY_LABELS[d.getDay()]} ${date} ${hm}`;
}

// Group codes like "2-01" must stay left-to-right inside Hebrew text.
const grp = (code) => `<bdi dir="ltr">${esc(code)}</bdi>`;

const statusOf = (key) => state.progress[key]?.s || null;

function setStatus(key, s) {
  state.progress[key] = { s, t: Date.now() };
  store.saveLocal(state.progress);
  render();
  scheduleSync();
}

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
  render();
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
function viewTodo(courses) {
  let total = 0;
  const cards = courses.map((c) => {
    const owed = c.types
      .flatMap((t) => t.units.map((u) => ({ ...u, label: t.label, mine: t.mine })))
      .filter((u) => u.available && !statusOf(u.key))
      .sort((a, b) => a.first.end - b.first.end);
    total += owed.length;
    const next = c.types
      .map((t) => ({ t, u: t.units.find((u) => !u.available) }))
      .filter((x) => x.u)
      .map(({ t, u }) => `${t.label} ${u.n}: ${fmt(u.first.start)} (${u.first.group.lecturer ? esc(u.first.group.lecturer) : 'קב׳ ' + grp(u.first.group.code)})`);
    if (!owed.length && !next.length) return '';
    const rows = owed.map((u) => {
      const firstIsMine = u.first.group === u.mine;
      const where = firstIsMine
        ? `התקיים בקבוצה שלך: ${fmt(u.first.start)}`
        : `התקיים לראשונה: ${fmt(u.first.start)} · ${esc(u.first.group.lecturer)} (קב׳ ${grp(u.first.group.code)})<br>בקבוצה שלך: ${fmt(u.own.start)}${u.own.end > now() ? ' (עוד לא)' : ''}`;
      return `<div class="unit">
        <div class="name">${u.label} ${u.n}</div>
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
  return banner + cards;
}

function viewDone(courses) {
  const cards = courses.map((c) => {
    const units = c.types.flatMap((t) => t.units.map((u) => ({ ...u, label: t.label })));
    const avail = units.filter((u) => u.available).length;
    const done = units.filter((u) => statusOf(u.key)).sort((a, b) => b.first.end - a.first.end);
    const pct = avail ? Math.round((done.length / avail) * 100) : 0;
    return `<section class="card">
      <h2><bdi>${esc(c.short)}</bdi> <small>${done.length} / ${avail} שהתקיימו · ${units.length} בסמסטר</small></h2>
      <div class="progress"><div style="width:${Math.min(pct, 100)}%"></div></div>
      ${done.map((u) => `<div class="done-row">
        <span>${u.label} ${u.n} · ${STATUS_LABELS[statusOf(u.key)]}</span>
        <button class="link" data-action="mark" data-key="${u.key}" data-s="">בטל</button>
      </div>`).join('')}
    </section>`;
  }).join('');
  return cards;
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
  const todo = viewTodo(courses); // always computed so the badge stays current
  const main = document.getElementById('main');
  if (state.tab === 'todo') main.innerHTML = todo;
  else if (state.tab === 'done') main.innerHTML = viewDone(courses);
  else if (!document.getElementById('sem-select')) main.innerHTML = viewSettings();
  renderChip();
}

// ---------- events ----------
document.querySelector('nav').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  document.getElementById('main').innerHTML = '';
  render();
  window.scrollTo(0, 0);
});

document.body.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;
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
  if (document.visibilityState === 'visible') { render(); runSync(); }
});
window.addEventListener('online', () => runSync());
setInterval(render, 60 * 1000); // newly finished lessons appear without reload

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
