// Progress storage: localStorage is the primary copy; a private GitHub Gist is
// the cloud copy shared between devices. Merge is per key, latest timestamp wins.
// Progress entry: { s: 'attended' | 'watched' | null, t: ms }  (null = un-checked tombstone)
//
// Two gists. A "secret" gist is readable by anyone who has its address, and so are all of
// its files and their history — so what is meant to be shared lives apart:
//   private   (GIST_DESC):      progress, push subscriptions, emails, Moodle snapshot, tokens.
//                               Its address is never shown or handed out.
//   published (PUBLISHED_DESC): calendar.ics and widget.json only — the calendar link given to
//                               Google Calendar / the Mac app points here.
// Older versions kept everything in one gist; sync() moves the private files to a new private
// gist once and renames the old one (OLD_DESC), which the user then deletes (it was shared).

const LS_PROGRESS = 'tracker.progress';
const LS_TOKEN = 'tracker.token';
const LS_GIST = 'tracker.gistId';
const LS_PUBLISHED = 'tracker.publishedGistId';
export const GIST_DESC = 'semester-tracker-progress';
export const PUBLISHED_DESC = 'semester-tracker-published';
export const OLD_DESC = 'semester-tracker-progress (old — delete me)';
export const PUBLISHED_DUP_DESC = 'semester-tracker-published (duplicate — delete me)';
export const PUBLISHED_FILES = ['calendar.ics', 'widget.json'];
const GIST_FILE = 'progress.json';
const PUSH_FILE = 'push.json';
const API = 'https://api.github.com';

export function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(LS_PROGRESS)) || {};
  } catch {
    return {};
  }
}

export function saveLocal(progress) {
  localStorage.setItem(LS_PROGRESS, JSON.stringify(progress));
}

export function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (!out[k] || v.t > out[k].t) out[k] = v;
  }
  return out;
}

export const getToken = () => localStorage.getItem(LS_TOKEN) || '';
export function setToken(token) {
  if (token) localStorage.setItem(LS_TOKEN, token.trim());
  else localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_GIST);
  localStorage.removeItem(LS_PUBLISHED);
}

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// All gists with this description, oldest first — when a race between two devices left two,
// everyone (app, job, script, Mac app) agrees on the oldest.
async function listGists(description) {
  const out = [];
  for (let page = 1; page < 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    out.push(...list.filter((g) => g.description === description));
    if (list.length < 100) break;
  }
  return out.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

const createGist = (description, files) => gh('/gists', {
  method: 'POST',
  body: JSON.stringify({ description, public: false, files }),
});

const fileText = async (f) => (f.truncated ? (await fetch(f.raw_url)).text() : f.content);
const isCombined = (g) => Object.keys(g.files || {}).some((f) => PUBLISHED_FILES.includes(f));

// Renamed so nothing picks it up again; ⚙️ lists it (from GitHub) until the user deletes it.
async function retire(g, description = OLD_DESC) {
  await gh(`/gists/${g.id}`, { method: 'PATCH', body: JSON.stringify({ description }) });
}

// Folds a duplicate private gist into the chosen one (progress per key, push subscriptions and
// emails by id); other files keep the chosen gist's copy.
function mergeFile(name, ours, theirs) {
  if (ours == null) return theirs;
  try {
    const a = JSON.parse(ours);
    const b = JSON.parse(theirs);
    if (name === GIST_FILE) return JSON.stringify(merge(a, b));
    if (name === PUSH_FILE) {
      const subs = [...(a.subs || [])];
      for (const sub of b.subs || []) if (!subs.some((x) => x.endpoint === sub.endpoint)) subs.push(sub);
      return JSON.stringify({ ...b, ...a, subs }, null, 1);
    }
    if (name === 'mail.json') {
      const messages = [...(a.messages || [])];
      for (const m of b.messages || []) if (!messages.some((x) => x.id === m.id)) messages.push(m);
      return JSON.stringify({ ...a, messages: messages.sort((x, y) => x.date.localeCompare(y.date)) }, null, 1);
    }
  } catch { /* not JSON: keep ours */ }
  return ours;
}

async function absorb(targetId, dup) {
  const target = await gh(`/gists/${targetId}`);
  const files = {};
  for (const [name, f] of Object.entries(dup.files)) {
    if (PUBLISHED_FILES.includes(name)) continue;
    const ours = target.files[name] ? await fileText(target.files[name]) : null;
    const merged = mergeFile(name, ours, await fileText(f));
    if (merged !== ours) files[name] = { content: merged };
  }
  if (Object.keys(files).length) await gh(`/gists/${targetId}`, { method: 'PATCH', body: JSON.stringify({ files }) });
}

// The private gist: checked once per app start (a remembered id may belong to an old combined
// gist, or to a duplicate from a race); then the remembered id is used.
let privateChecked = false;
async function gistId() {
  const cached = localStorage.getItem(LS_GIST);
  if (cached && privateChecked) return cached;
  const all = await listGists(GIST_DESC);
  const split = all.filter((g) => !isCombined(g));
  const combined = all.filter(isCombined);
  let id;
  let leftovers;
  if (split.length) {
    id = split[0].id;
    leftovers = [...split.slice(1), ...combined];
  } else if (combined.length) {
    id = await splitOldGist(await gh(`/gists/${combined[0].id}`));
    leftovers = combined.slice(1);
  } else {
    id = (await createGist(GIST_DESC, { [GIST_FILE]: { content: '{}' } })).id;
    leftovers = [];
  }
  for (const g of leftovers) {
    await absorb(id, await gh(`/gists/${g.id}`));
    await retire(g);
  }
  localStorage.setItem(LS_GIST, id);
  privateChecked = true;
  return id;
}

// Old layout → a new private gist with the private files; the old gist is retired and kept
// until the user deletes it (its address was shared as the calendar link, and its history
// still holds the private files).
async function splitOldGist(old) {
  const files = {};
  for (const [name, f] of Object.entries(old.files)) {
    if (!PUBLISHED_FILES.includes(name)) files[name] = { content: await fileText(f) };
  }
  if (!files[GIST_FILE]) files[GIST_FILE] = { content: '{}' };
  const created = await createGist(GIST_DESC, files);
  await retire(old);
  localStorage.removeItem(LS_CAL); // the calendar moves to the published gist (new address)
  localStorage.removeItem(LS_WIDGET);
  return created.id;
}

// The gist for calendar.ics / widget.json: the oldest with its description (created when first
// needed); extras from a race are renamed (they hold only published data).
let publishedChecked = false;
async function publishedGist() {
  const cached = localStorage.getItem(LS_PUBLISHED);
  if (cached && publishedChecked) return gh(`/gists/${cached}`);
  const all = await listGists(PUBLISHED_DESC);
  const gist = all.length ? await gh(`/gists/${all[0].id}`)
    : await createGist(PUBLISHED_DESC, { 'calendar.ics': { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' } });
  for (const g of all.slice(1)) await retire(g, PUBLISHED_DUP_DESC);
  localStorage.setItem(LS_PUBLISHED, gist.id);
  publishedChecked = true;
  return gist;
}

// Retired gists that still exist (⚙️ asks to delete them) — read from GitHub, so every device
// shows the same list.
export async function oldGists() {
  if (!getToken()) return [];
  try {
    const all = [...await listGists(OLD_DESC), ...await listGists(PUBLISHED_DUP_DESC)];
    return all.map((g) => ({ id: g.id, url: g.html_url || `https://gist.github.com/${g.id}` }));
  } catch { return []; } // offline: ask next time
}

async function pull(id) {
  const gist = await gh(`/gists/${id}`);
  // renamed by another device's split → look up the private gist again
  if (gist.description !== GIST_DESC) throw Object.assign(new Error('gist moved'), { moved: true });
  const file = gist.files[GIST_FILE];
  if (!file) return {};
  return JSON.parse((await fileText(file)) || '{}');
}

async function push(id, progress) {
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(progress) } } }),
  });
}

// Pull, merge into local, push back if the cloud copy is missing anything.
// Returns the merged progress.
export async function sync() {
  if (!getToken()) return loadLocal();
  let id;
  try {
    id = await gistId();
  } catch (e) {
    localStorage.removeItem(LS_GIST);
    throw e;
  }
  let remote;
  try {
    remote = await pull(id);
  } catch (e) {
    if (!e.moved) throw e;
    localStorage.removeItem(LS_GIST);
    id = await gistId();
    remote = await pull(id);
  }
  // Re-read local only now, so check-offs made during the request aren't lost.
  const merged = merge(loadLocal(), remote);
  saveLocal(merged);
  const changed = Object.entries(merged).some(
    ([k, v]) => !remote[k] || remote[k].t !== v.t,
  );
  if (changed) await push(id, merged);
  return merged;
}

// Push subscriptions (one per device) live in their own gist file so the morning
// GitHub Action can find them: { subs: [PushSubscriptionJSON], lastSent: 'YYYY-MM-DD' }.

async function readPush(id) {
  const gist = await gh(`/gists/${id}`);
  const file = gist.files[PUSH_FILE];
  return file ? JSON.parse(file.content || '{}') : {};
}

async function writePush(id, data) {
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [PUSH_FILE]: { content: JSON.stringify(data, null, 1) } } }),
  });
}

export async function addPushSubscription(sub) {
  const id = await gistId();
  const data = await readPush(id);
  data.subs = (data.subs || []).filter((s) => s.endpoint !== sub.endpoint);
  data.subs.push(sub);
  await writePush(id, data);
}

export async function removePushSubscription(endpoint) {
  const id = await gistId();
  const data = await readPush(id);
  data.subs = (data.subs || []).filter((s) => s.endpoint !== endpoint);
  await writePush(id, data);
}

// Subscription calendar: calendar.ics in the published gist. Its "raw" URL without a revision
// always serves the latest version, so calendar apps can subscribe to it.
const LS_CAL = 'tracker.calendar'; // { url, published } — last uploaded content, to skip no-op uploads

export function calendarInfo() {
  try { return JSON.parse(localStorage.getItem(LS_CAL)) || {}; } catch { return {}; }
}

export async function publishCalendar(content, fileName = 'calendar.ics') {
  const info = calendarInfo();
  const pub = localStorage.getItem(LS_PUBLISHED);
  if (info.url && pub && info.url.includes(`/${pub}/`) && info.published === content) return info.url;
  const gist = await publishedGist();
  if (gist.files[fileName]?.content !== content) {
    await gh(`/gists/${gist.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ files: { [fileName]: { content } } }),
    });
  }
  const url = `https://gist.githubusercontent.com/${gist.owner.login}/${gist.id}/raw/${fileName}`;
  localStorage.setItem(LS_CAL, JSON.stringify({ url, published: content }));
  return url;
}

// Summary for the Mac menu bar app / widget (widget.js). Uploaded only when it changed.
const LS_WIDGET = 'tracker.widget';
export async function publishWidget(data, content) {
  const key = JSON.stringify(data);
  if (localStorage.getItem(LS_WIDGET) === key) return;
  const gist = await publishedGist();
  await gh(`/gists/${gist.id}`, { method: 'PATCH', body: JSON.stringify({ files: { 'widget.json': { content } } }) });
  localStorage.setItem(LS_WIDGET, key);
}
