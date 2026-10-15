// The service worker serves the app code from its cache, so every code change must ship a
// new CACHE name — otherwise devices keep the old code. CACHE = hash of all SHELL files.
// Run after changing any of them:  node tools/stamp-sw.mjs   (test/sw.test.mjs checks it)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const SW = new URL('sw.js', root);

export function shellFiles(swSource = readFileSync(SW, 'utf8')) {
  const list = swSource.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
}

// Hash of the shell files plus sw.js itself (without its CACHE line).
export function shellHash() {
  const sw = readFileSync(SW, 'utf8');
  const h = createHash('sha256');
  for (const f of shellFiles(sw)) h.update(f).update(readFileSync(new URL(f, root)));
  h.update(sw.replace(/const CACHE = '[^']*';/, ''));
  return h.digest('hex').slice(0, 8);
}

export const currentStamp = () => readFileSync(SW, 'utf8').match(/const CACHE = 'tracker-([^']*)';/)[1];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const hash = shellHash();
  const sw = readFileSync(SW, 'utf8');
  writeFileSync(SW, sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'tracker-${hash}';`));
  console.log(`sw.js CACHE = tracker-${hash}`);
}
