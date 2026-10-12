import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage + fake GitHub Gist API.
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
const gists = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = url.replace('https://api.github.com', '');
  const ok = (body) => ({ ok: true, json: async () => body, text: async () => '' });
  if (path.startsWith('/gists?')) return ok(gists);
  if (path === '/gists' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    const g = { id: 'g1', description: b.description, files: { 'progress.json': { content: b.files['progress.json'].content } } };
    gists.push(g);
    return ok(g);
  }
  const g = gists.find((x) => path === `/gists/${x.id}`);
  if (opts.method === 'PATCH') {
    g.files['progress.json'].content = JSON.parse(opts.body).files['progress.json'].content;
  }
  return ok(g);
};

const store = await import('../sync.js');

test('merge keeps the newest entry per key, including un-check tombstones', () => {
  const a = { x: { s: 'attended', t: 1 }, y: { s: 'watched', t: 5 } };
  const b = { x: { s: null, t: 2 }, y: { s: 'attended', t: 3 }, z: { s: 'watched', t: 1 } };
  assert.deepEqual(store.merge(a, b), { x: { s: null, t: 2 }, y: { s: 'watched', t: 5 }, z: { s: 'watched', t: 1 } });
});

test('two devices converge through the gist', async () => {
  // device A
  store.setToken('tok');
  store.saveLocal({ k1: { s: 'attended', t: 10 } });
  await store.sync();
  assert.equal(gists.length, 1);
  // device B: fresh storage, same token, finds the existing gist
  ls.clear();
  store.setToken('tok');
  store.saveLocal({ k2: { s: 'watched', t: 20 } });
  const merged = await store.sync();
  assert.equal(gists.length, 1);
  assert.deepEqual(Object.keys(merged).sort(), ['k1', 'k2']);
  assert.deepEqual(Object.keys(JSON.parse(gists[0].files['progress.json'].content)).sort(), ['k1', 'k2']);
});
