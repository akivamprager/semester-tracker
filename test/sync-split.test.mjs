import test from 'node:test';
import assert from 'node:assert/strict';

// in-memory GitHub gists + localStorage
const gists = new Map();
let nextId = 1;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const view = (g) => ({ id: g.id, description: g.description, html_url: `https://gist.github.com/${g.id}`, owner: { login: 'me' },
  files: Object.fromEntries(Object.entries(g.files).map(([n, c]) => [n, { content: c, truncated: false }])) });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.pathname === '/gists' && (opts.method || 'GET') === 'GET') return json([...gists.values()].map(view));
  if (u.pathname === '/gists' && opts.method === 'POST') {
    const g = { id: `g${nextId++}`, description: body.description, files: Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content])) };
    gists.set(g.id, g);
    return json(view(g), 201);
  }
  const g = gists.get(u.pathname.split('/')[2]);
  if (!g) return json({ message: 'Not Found' }, 404);
  if (opts.method === 'PATCH') {
    if (body.description) g.description = body.description;
    for (const [n, f] of Object.entries(body.files || {})) g.files[n] = f.content;
  }
  return json(view(g));
};

const sync = await import('../sync.js');

test('an old combined gist is split: private files move, the old one is retired', async () => {
  gists.set('old', { id: 'old', description: sync.GIST_DESC, files: {
    'progress.json': JSON.stringify({ a: { s: 'done', t: 1 } }),
    'mail.json': '{"messages":[]}', 'push.json': '{"subs":[]}', 'calendar.ics': 'X', 'widget.json': '{}',
  } });
  sync.setToken('tok');
  localStorage.setItem('tracker.progress', JSON.stringify({ b: { s: 'done', t: 2 } }));

  const merged = await sync.sync();
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b']);
  const priv = [...gists.values()].find((g) => g.description === sync.GIST_DESC);
  assert.ok(priv && priv.id !== 'old');
  assert.deepEqual(Object.keys(priv.files).sort(), ['mail.json', 'progress.json', 'push.json']); // no calendar/widget
  assert.deepEqual(Object.keys(JSON.parse(priv.files['progress.json'])).sort(), ['a', 'b']);
  assert.equal(gists.get('old').description, sync.OLD_DESC);
  assert.deepEqual(await sync.oldGist(), { id: 'old', url: 'https://gist.github.com/old' });

  // calendar + widget go to a separate published gist
  const url = await sync.publishCalendar('BEGIN:VCALENDAR');
  await sync.publishWidget({ v: 1 }, '{"v":1}');
  const pub = [...gists.values()].find((g) => g.description === sync.PUBLISHED_DESC);
  assert.ok(pub && url.includes(`/${pub.id}/raw/calendar.ics`));
  assert.deepEqual(Object.keys(pub.files).sort(), ['calendar.ics', 'widget.json']);

  // once the user deletes the old gist, the reminder goes away
  gists.delete('old');
  assert.equal(await sync.oldGist(), null);
});

test('another device that still has the old gist cached finds the new one', async () => {
  const before = gists.size;
  localStorage.setItem('tracker.gistId', 'old-gone');
  gists.set('old-gone', { id: 'old-gone', description: sync.OLD_DESC, files: { 'progress.json': '{}' } });
  const merged = await sync.sync();
  assert.ok(merged.a && merged.b);
  assert.notEqual(localStorage.getItem('tracker.gistId'), 'old-gone');
  assert.equal(gists.size, before + 1); // no new private gist was created — it found the existing one
});
