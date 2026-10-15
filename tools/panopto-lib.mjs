// Panopto API for the morning job (node only). The refresh token lives encrypted
// (AES-256-GCM, key = GitHub secret PANOPTO_KEY) in the sync gist file panopto-token.json,
// written by tools/panopto-login.mjs; Panopto may hand out a new one on every refresh.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const TOKEN_FILE = 'panopto-token.json';

export function encrypt(text, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

export function decrypt(b64, key) {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// refresh token → { access_token, refresh_token? }. Throws 'expired' when Panopto refuses it.
export async function refreshToken(host, refresh, clientId, clientSecret) {
  const res = await fetch(`https://${host}/Panopto/oauth2/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  const tok = await res.json().catch(() => ({}));
  if (tok.error === 'invalid_grant') throw new Error('expired');
  if (!res.ok || !tok.access_token) throw new Error(`token ${res.status} ${tok.error || ''}`);
  return tok;
}

// All sessions of a folder that started on/after `since` (YYYY-MM-DD), newest first.
export async function folderSessions(host, accessToken, folderId, since) {
  const out = [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`https://${host}/Panopto/api/v1/folders/${folderId}/sessions?`
      + `pageNumber=${page}&sortField=CreatedDate&sortOrder=Desc`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`folder ${res.status}`);
    const results = (await res.json()).Results || [];
    out.push(...results);
    if (!results.length || results.every((s) => (s.StartTime || '') < since)) break;
  }
  return out.filter((s) => (s.StartTime || '') >= since);
}
