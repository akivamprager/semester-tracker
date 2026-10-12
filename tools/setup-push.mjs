// One-time setup for the morning notification. Generates a VAPID key pair, writes the
// public key to push-config.json (committed, used by the app) and stores the private key
// as the repo secret VAPID_PRIVATE_KEY via `gh` — the private key is never printed.
// Usage (from the tracker folder): node tools/setup-push.mjs
import { createECDH } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
execFileSync('gh', ['secret', 'set', 'VAPID_PRIVATE_KEY'], {
  input: b64url(Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()]).subarray(-32)),
  stdio: ['pipe', 'inherit', 'inherit'],
});
writeFileSync(
  new URL('../push-config.json', import.meta.url),
  JSON.stringify({ vapidPublicKey: b64url(ecdh.getPublicKey()) }, null, 1) + '\n',
);
console.log('Done: VAPID_PRIVATE_KEY secret set, push-config.json written. Commit and push it.');
