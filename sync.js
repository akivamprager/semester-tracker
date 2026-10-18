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
const LS_OLD = 'tracker.oldGist'; // { id, url } of the retired combined gist, until deleted
export const GIST_DESC = 'semester-tracker-progress';
export const PUBLISHED_DESC = 'semester-tracker-published';
export const OLD_DESC = 'semester-tracker-progress (old — delete me)';
export const PUBLISHED_FILES = ['calendar.ics', 'widget.json'];
const GIST_FILE = 'progress.json';
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

async function findGist(description) {
  for (let page = 1; page < 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find((g) => g.description === description);
    if (found) return found;
    if (list.length < 100) break;
  }
  return null;
}

const createGist = (description, files) => gh('/gists', {
  method: 'POST',
  body: JSON.stringify({ description, public: false, files }),
});

const fileText = async (f) => (f.truncated ? (await fetch(f.raw_url)).text() : f.content);

// Finds the private gist (by description) or creates it; moves an old combined gist apart.
async function gistId() {
  let id = localStorage.getItem(LS_GIST);
  if (id) return id;
  const found = await findGist(GIST_DESC);
  if (found && Object.keys(found.files).some((f) => PUBLISHED_FILES.includes(f))) {
    id = await splitOldGist(await gh(`/gists/${found.id}`));
  } else {
    id = found?.id || (await createGist(GIST_DESC, { [GIST_FILE]: { content: '{}' } })).id;
  }
  localStorage.setItem(LS_GIST, id);
  return id;
}

// Old layout → a new private gist with the private files; the old gist is renamed so that no
// device, job or script picks it up again, and kept until the user deletes it (its address
// was shared as the calendar link, and its history still holds the private files).
async function splitOldGist(old) {
  const files = {};
  for (const [name, f] of Object.entries(old.files)) {
    if (!PUBLISHED_FILES.includes(name)) files[name] = { content: await fileText(f) };
  }
  if (!files[GIST_FILE]) files[GIST_FILE] = { content: '{}' };
  const created = await createGist(GIST_DESC, files);
  await gh(`/gists/${old.id}`, { method: 'PATCH', body: JSON.stringify({ description: OLD_DESC }) });
  localStorage.setItem(LS_OLD, JSON.stringify({ id: old.id, url: old.html_url }));
  localStorage.removeItem(LS_CAL); // the calendar moves to the published gist (new address)
  localStorage.removeItem(LS_WIDGET);
  return created.id;
}

// The gist for calendar.ics / widget.json (found by description, created when first needed).
async function publishedGist() {
  const cached = localStorage.getItem(LS_PUBLISHED);
  if (cached) return gh(`/gists/${cached}`);
  let gist = await findGist(PUBLISHED_DESC);
  gist = gist ? await gh(`/gists/${gist.id}`)
    : await createGist(PUBLISHED_DESC, { 'calendar.ics': { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' } });
  localStorage.setItem(LS_PUBLISHED, gist.id);
  return gist;
}

// The retired combined gist, while it still exists (Settings asks to delete it).
export async function oldGist() {
  const old = JSON.parse(localStorage.getItem(LS_OLD) || 'null');
  if (!old || !getToken()) return null;
  try {
    await gh(`/gists/${old.id}`);
    return old;
  } catch (e) {
    if (/GitHub 404/.test(e.message)) localStorage.removeItem(LS_OLD); // deleted ✓
    return /GitHub 404/.test(e.message) ? null : old;
  }
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
const PUSH_FILE = 'push.json';

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
