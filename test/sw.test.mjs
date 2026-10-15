import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { shellFiles, shellHash, currentStamp } from '../tools/stamp-sw.mjs';

test('sw.js lists only existing files', () => {
  for (const f of shellFiles()) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
});

test('sw.js CACHE matches the app code (run: node tools/stamp-sw.mjs)', () => {
  assert.equal(currentStamp(), shellHash());
});
