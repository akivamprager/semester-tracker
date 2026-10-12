// Progress storage: localStorage is the primary copy; a private GitHub Gist is
// the cloud copy shared between devices. Merge is per key, latest timestamp wins.
// Progress entry: { s: 'attended' | 'watched' | null, t: ms }  (null = un-checked tombstone)

const LS_PROGRESS = 'tracker.progress';
const LS_TOKEN = 'tracker.token';
const LS_GIST = 'tracker.gistId';
const GIST_DESC = 'semester-tracker-progress';
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

// Finds the progress gist (by description) or creates it.
async function gistId() {
  let id = localStorage.getItem(LS_GIST);
  if (id) return id;
  for (let page = 1; page < 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find((g) => g.description === GIST_DESC);
    if (found) { id = found.id; break; }
    if (list.length < 100) break;
  }
  if (!id) {
    const created = await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: GIST_DESC,
        public: false,
        files: { [GIST_FILE]: { content: '{}' } },
      }),
    });
    id = created.id;
  }
  localStorage.setItem(LS_GIST, id);
  return id;
}

async function pull(id) {
  const gist = await gh(`/gists/${id}`);
  const file = gist.files[GIST_FILE];
  if (!file) return {};
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return JSON.parse(content || '{}');
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
  const remote = await pull(id);
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
