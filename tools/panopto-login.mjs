// One-time Panopto login — run on your Mac from the tracker folder:
//   node tools/panopto-login.mjs
// 1. Asks for the Panopto address, Client ID and Client Secret (the secret is not shown).
// 2. Opens the Panopto login page in your browser; after you log in (the usual HUJI login),
//    Panopto sends your browser to http://localhost:9127/callback, where this script waits.
// 3. Trades that one-time code for a long-lived refresh token.
// 4. Saves: GitHub secrets PANOPTO_CLIENT_ID, PANOPTO_CLIENT_SECRET, PANOPTO_KEY, and the
//    refresh token *encrypted with PANOPTO_KEY* in the sync gist (panopto-token.json) — the
//    job replaces it there whenever Panopto issues a new one. Nothing secret is printed.
// 5. Test: lists the Panopto folders/recordings found for this semester's courses into
//    tools/panopto-sample.local.json (not committed; no secrets in it).
// Needs the GitHub CLI (gh) logged in.
import http from 'node:http';
import readline from 'node:readline';
import { randomBytes, createCipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'akivamprager/semester-tracker';
const GIST_DESC = 'semester-tracker-progress';
const PORT = 9127;
const REDIRECT = `http://localhost:${PORT}/callback`;

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// Waits for the browser to come back to http://localhost:9127/callback?code=…
function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const servers = [];
    const done = (fn) => { servers.forEach((s) => s.close()); fn(); };
    const handler = (req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
        res.end('<h2 dir="rtl">משהו השתבש — חזור לטרמינל.</h2>');
        done(() => reject(new Error(`Login failed: ${url.searchParams.get('error') || 'no code / wrong state'}`)));
        return;
      }
      res.end('<h2 dir="rtl">✓ התחברת. אפשר לסגור את הלשונית ולחזור לטרמינל.</h2>');
      done(() => resolve(url.searchParams.get('code')));
    };
    // Browsers may resolve "localhost" to either address — listen on both.
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(handler);
      s.on('error', () => {}); // e.g. no IPv6
      s.listen(PORT, host);
      servers.push(s);
    }
  });
}

function encrypt(text, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'inherit'] });

// ---- 1. details ----
const host = (await ask('Panopto address (as in the browser, e.g. huji.cloud.panopto.eu): '))
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const clientId = await ask('Client ID: ');
const clientSecret = await ask('Client Secret (hidden while typing/pasting): ', true);
if (!host || !clientId || !clientSecret) throw new Error('Missing details.');

// ---- 2. browser login ----
const state = randomBytes(16).toString('hex');
const authUrl = `https://${host}/Panopto/oauth2/connect/authorize?${new URLSearchParams({
  client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid api offline_access', state,
})}`;
const codePromise = waitForCode(state);
console.log('\nOpening the Panopto login in your browser. If it does not open, copy this link:\n' + authUrl + '\n');
try { execFileSync('open', [authUrl]); } catch { /* the link above */ }
const code = await codePromise;

// ---- 3. code → tokens ----
// Servers differ in how they expect the client credentials; try the common ways in turn
// (a rejected client does not use up the one-time code).
const basic = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
const form = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT };
const attempts = [
  { name: 'basic', headers: { Authorization: basic(clientId, clientSecret) }, body: form },
  { name: 'post', headers: {}, body: { ...form, client_id: clientId, client_secret: clientSecret } },
  { name: 'basic-encoded', headers: { Authorization: basic(encodeURIComponent(clientId), encodeURIComponent(clientSecret)) }, body: form },
];
let res;
let tok = {};
for (const a of attempts) {
  res = await fetch(`https://${host}/Panopto/oauth2/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...a.headers },
    body: new URLSearchParams(a.body),
  });
  tok = await res.json().catch(() => ({}));
  console.log(`  token request (${a.name}): ${res.status}${tok.error ? ' ' + tok.error : ''}`);
  if (tok.error !== 'invalid_client') break;
}
if (!res.ok || !tok.access_token) {
  throw new Error(`Token request failed (${res.status}): ${tok.error || ''} ${tok.error_description || ''}`
    + (tok.error === 'invalid_client' ? `\nThe Client ID / Secret were not accepted (the secret you pasted is ${clientSecret.length} characters). `
      + 'Check the secret in Panopto, or create a new API client, and run again.' : ''));
}
console.log(`✓ Logged in. Refresh token: ${tok.refresh_token ? 'yes' : 'NO (offline access not allowed — tell Claude)'}`);

// ---- 4. save ----
if (tok.refresh_token) {
  const key = randomBytes(32);
  gh(['secret', 'set', 'PANOPTO_CLIENT_ID', '--repo', REPO], clientId);
  gh(['secret', 'set', 'PANOPTO_CLIENT_SECRET', '--repo', REPO], clientSecret);
  gh(['secret', 'set', 'PANOPTO_KEY', '--repo', REPO], key.toString('base64'));
  const gists = JSON.parse(gh(['api', '/gists?per_page=100']));
  const gist = gists.find((g) => g.description === GIST_DESC);
  if (!gist) throw new Error('Sync gist not found.');
  const file = { host, token: encrypt(tok.refresh_token, key), savedAt: new Date().toISOString() };
  gh(['api', '--method', 'PATCH', `/gists/${gist.id}`, '--input', '-'],
    JSON.stringify({ files: { 'panopto-token.json': { content: JSON.stringify(file) } } }));
  console.log('✓ Saved: GitHub secrets PANOPTO_CLIENT_ID / _SECRET / _KEY + encrypted token in the sync gist.');
}

// ---- 5. test: what does Panopto show for this semester's courses? ----
const api = async (path) => {
  const r = await fetch(`https://${host}/Panopto/api/v1${path}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  return r.ok ? r.json() : { error: r.status, text: (await r.text()).slice(0, 300) };
};
const index = JSON.parse(readFileSync(new URL('../semesters/index.json', import.meta.url)));
const entry = index.semesters.find((s) => s.id === index.default) || index.semesters[0];
const sem = JSON.parse(readFileSync(new URL(`../semesters/${entry.file}`, import.meta.url)));
const sample = { host, checkedAt: new Date().toISOString(), courses: {} };
for (const course of sem.courses) {
  const found = await api(`/folders/search?searchQuery=${encodeURIComponent(course.code)}&pageNumber=0`);
  const folders = found.Results || [];
  sample.courses[course.code] = found.error ? found : await Promise.all(folders.slice(0, 6).map(async (f) => {
    const s = await api(`/folders/${f.Id}/sessions?pageNumber=0&sortField=CreatedDate&sortOrder=Desc`);
    return {
      id: f.Id,
      name: f.Name,
      parent: f.ParentFolder?.Name || '',
      sessions: s.error ? s : (s.Results || []).slice(0, 15).map((x) => ({
        id: x.Id, name: x.Name, start: x.StartTime, duration: x.Duration, viewer: x.Urls?.ViewerUrl,
      })),
    };
  }));
  console.log(`  ${course.code}: ${found.error ? 'error ' + found.error : folders.length + ' folder(s)'}`);
}
writeFileSync(new URL('./panopto-sample.local.json', import.meta.url), JSON.stringify(sample, null, 1));
console.log('\n✓ Test results in tools/panopto-sample.local.json — tell Claude it is there.');
