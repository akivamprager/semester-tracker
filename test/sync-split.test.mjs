import test from 'node:test';
import assert from 'node:assert/strict';

// in-memory GitHub gists + localStorage
let gists;
let clock;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const reset = () => { gists = new Map(); clock = 0; store.clear(); };
const add = (id, description, files) => gists.set(id, { id, description, files, created_at: `2026-10-${String(10 + clock++).padStart(2, '0')}` });
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const view = (g) => ({ id: g.id, description: g.description, created_at: g.created_at, html_url: `https://gist.github.com/${g.id}`,
  owner: { login: 'me' }, files: Object.fromEntries(Object.entries(g.files).map(([n, c]) => [n, { content: c, truncated: false }])) });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.pathname === '/gists' && (opts.method || 'GET') === 'GET') return json([...gists.values()].reverse().map(view)); // newest first, like GitHub
  if (u.pathname === '/gists' && opts.method === 'POST') {
    const id = `new${clock}`;
    add(id, body.description, Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content])));
    return json(view(gists.get(id)), 201);
  }
  const g = gists.get(u.pathname.split('/')[2]);
  if (!g) return json({ message: 'Not Found' }, 404);
  if (opts.method === 'PATCH') {
    if (body.description) g.description = body.description;
    for (const [n, f] of Object.entries(body.files || {})) g.files[n] = f.content;
  }
  return json(view(g));
};

const fresh = async () => import(`../sync.js?${Math.random()}`); // a new app start (module state reset)
const byDesc = (d) => [...gists.values()].filter((g) => g.description === d);

test('a device that remembers the old combined gist splits it on the next start', async () => {
  reset();
  add('old', 'semester-tracker-progress', {
    'progress.json': JSON.stringify({ a: { s: 'done', t: 1 } }),
    'mail.json': '{"messages":[]}', 'push.json': '{"subs":[]}', 'calendar.ics': 'X', 'widget.json': '{}',
  });
  store.set('tracker.token', 'tok');
  store.set('tracker.gistId', 'old'); // ← remembered from before the update
  store.set('tracker.progress', JSON.stringify({ b: { s: 'done', t: 2 } }));
  const sync = await fresh();

  const merged = await sync.sync();
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b']);
  const [priv] = byDesc(sync.GIST_DESC);
  assert.ok(priv && priv.id !== 'old');
  assert.deepEqual(Object.keys(priv.files).sort(), ['mail.json', 'progress.json', 'push.json']);
  assert.equal(gists.get('old').description, sync.OLD_DESC);
  assert.deepEqual((await sync.oldGists()).map((g) => g.id), ['old']);
  gists.delete('old');
  assert.deepEqual(await sync.oldGists(), []);
});

test('two published gists from a race: the oldest is used, the other retired', async () => {
  reset();
  add('priv', 'semester-tracker-progress', { 'progress.json': '{}' });
  add('pubA', 'semester-tracker-published', { 'calendar.ics': 'A' });
  add('pubB', 'semester-tracker-published', { 'calendar.ics': 'B' });
  store.set('tracker.token', 'tok');
  store.set('tracker.publishedGistId', 'pubB'); // this device had created the newer one
  const sync = await fresh();
  const url = await sync.publishCalendar('NEW');
  assert.ok(url.includes('/pubA/'));
  assert.equal(gists.get('pubA').files['calendar.ics'], 'NEW');
  assert.equal(gists.get('pubB').description, sync.PUBLISHED_DUP_DESC);
});

test('two private gists from a race are merged into the oldest', async () => {
  reset();
  add('p1', 'semester-tracker-progress', { 'progress.json': JSON.stringify({ a: { s: 'done', t: 1 } }), 'push.json': JSON.stringify({ subs: [{ endpoint: 'e1' }] }) });
  add('p2', 'semester-tracker-progress', { 'progress.json': JSON.stringify({ b: { s: 'done', t: 2 } }), 'push.json': JSON.stringify({ subs: [{ endpoint: 'e2' }] }) });
  store.set('tracker.token', 'tok');
  store.set('tracker.gistId', 'p2');
  const sync = await fresh();
  const merged = await sync.sync();
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b']);
  assert.equal(store.get('tracker.gistId'), 'p1');
  assert.deepEqual(JSON.parse(gists.get('p1').files['push.json']).subs.map((s) => s.endpoint), ['e1', 'e2']);
  assert.equal(gists.get('p2').description, sync.OLD_DESC);
});
