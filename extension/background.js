// הסמסטרון — one-tap Panopto downloads, for personal offline viewing.
// Same idea as the "Panopto Media Downloader" extension: Panopto streams each video as one
// fragmented .mp4 file (HLS with byte ranges), and that file's address downloads it whole.
// Instead of waiting for you to play the video, we ask Panopto for the streams directly
// (DeliveryInfo, with your normal Panopto login in Chrome), read the HLS playlists and download
// each stream: the camera/main video, and the screen/slides stream if there is one.
// If that doesn't work, we fall back to the extension's way: open the viewer in a hidden-away,
// muted tab, catch the fragmented.mp4 requests it makes, download them, close the tab.

const HOST = 'huji.cloud.panopto.eu';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'download') return false;
  downloadRecording(msg).then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true; // reply comes later
});

const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

async function downloadRecording({ id, folder, name, screens }) {
  if (!GUID.test(id || '')) throw new Error('bad-id');
  let streams = [];
  try {
    streams = await viaDeliveryInfo(id);
  } catch (e) {
    if (e.message === 'login') throw e;
    console.warn('DeliveryInfo:', e);
  }
  if (!streams.length) streams = await viaViewerTab(id);
  if (!streams.length) throw new Error('no-streams');
  // Most lectures are only the board camera; the screen/slides stream only where it's used.
  if (!screens) streams = streams.filter((s) => !s.label || s.label === 'שמע').slice(0, 2);
  const dir = (folder || 'הקלטות').split('/').map(clean).filter(Boolean).join('/');
  const base = clean(name) || id;
  for (const s of streams) {
    await chrome.downloads.download({
      url: s.url,
      filename: `${dir}/${base}${s.label ? ' - ' + s.label : ''}.mp4`,
      conflictAction: 'uniquify',
    });
  }
  return { ok: true, files: streams.length, folder: dir };
}

// ---------- 1. ask Panopto directly ----------
async function viaDeliveryInfo(id) {
  const res = await fetch(`https://${HOST}/Panopto/Pages/Viewer/DeliveryInfo.aspx`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ deliveryId: id, isEmbed: 'true', responseType: 'json' }),
  });
  if (!res.ok) throw new Error('DeliveryInfo ' + res.status);
  const j = await res.json();
  if (j.ErrorCode) throw new Error(/auth|log ?in|sign ?in|access/i.test(j.ErrorMessage || '') || j.ErrorCode === 1 ? 'login' : j.ErrorMessage || 'error ' + j.ErrorCode);
  const list = j.Delivery?.Streams || [];
  const out = [];
  let screens = 0;
  for (const s of list) {
    const label = s.Tag === 'DV' || list.length === 1 ? '' : (++screens > 1 ? `מסך ${screens}` : 'מסך');
    const url = s.StreamUrl || s.StreamHttpUrl;
    if (!url) continue;
    if (/\.mp4(\?|$)/i.test(url)) { out.push({ url, label }); continue; }
    if (/\.m3u8/i.test(url)) {
      const files = await fromHls(url);
      if (files.video) out.push({ url: files.video, label });
      if (files.audio) out.push({ url: files.audio, label: label ? `${label} - שמע` : 'שמע' });
    }
  }
  // the main video first
  return out.sort((a, b) => !!a.label - !!b.label);
}

const resolve = (uri, base) => {
  const u = new URL(uri, base);
  if (!u.search && base.search) u.search = base.search; // signed query carries over
  return u.href;
};
const getText = async (url) => {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`playlist ${r.status}`);
  return r.text();
};

// master.m3u8 → { video, audio } whole-file .mp4 addresses (best quality).
async function fromHls(masterUrl) {
  const base = new URL(masterUrl);
  const text = await getText(masterUrl);
  if (!text.includes('#EXT-X-STREAM-INF')) return { video: await wholeFile(masterUrl, text) };
  const lines = text.split(/\r?\n/);
  let best = null, bw = -1, audioGroup = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/);
    if (!m) continue;
    const b = +(m[1].match(/BANDWIDTH=(\d+)/)?.[1] || 0);
    if (b > bw) { bw = b; best = lines[i + 1]?.trim(); audioGroup = m[1].match(/AUDIO="([^"]+)"/)?.[1] || null; }
  }
  const out = {};
  if (best) { const v = resolve(best, base); out.video = await wholeFile(v); }
  if (audioGroup) { // a separate audio track (then the video file is silent)
    const a = lines.find((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l) && l.includes(`GROUP-ID="${audioGroup}"`));
    const uri = a?.match(/URI="([^"]+)"/)?.[1];
    if (uri) out.audio = await wholeFile(resolve(uri, base));
  }
  return out;
}

// A media playlist whose segments are byte ranges of one fragmented .mp4 → that file's address.
async function wholeFile(playlistUrl, text) {
  text ??= await getText(playlistUrl);
  const base = new URL(playlistUrl);
  const segs = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))];
  const map = text.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  if (segs.length === 1 && /\.mp4/i.test(segs[0])) return resolve(segs[0], base);
  if (!segs.length && map) return resolve(map, base);
  return null; // many separate segment files: not one downloadable file
}

// ---------- 2. fallback: the original extension's way ----------
async function viaViewerTab(id) {
  const tab = await chrome.tabs.create({ url: `https://${HOST}/Panopto/Pages/Viewer.aspx?id=${id}&autoplay=true`, active: false });
  await chrome.tabs.update(tab.id, { muted: true });
  const found = new Set();
  let loginPage = false;
  const onHeaders = (d) => {
    if (d.tabId === tab.id && d.url.includes('fragmented.mp4')) found.add(d.url.split('#')[0]);
  };
  chrome.webRequest.onHeadersReceived.addListener(onHeaders, { urls: ['https://*.panopto.eu/*', 'https://*.panopto.com/*', 'https://*.cloudfront.net/*'] });
  try {
    const started = Date.now();
    let firstAt = 0;
    while (Date.now() - started < 30000) {
      await new Promise((r) => setTimeout(r, 1000));
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) break;
      if (t.url && !t.url.includes(HOST)) { loginPage = true; break; } // sent to the HUJI login
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play().catch(() => {}); }) }).catch(() => {});
      if (found.size && !firstAt) firstAt = Date.now();
      if (firstAt && Date.now() - firstAt > 5000) break; // give the other streams a moment
    }
  } finally {
    chrome.webRequest.onHeadersReceived.removeListener(onHeaders);
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  if (!found.size && loginPage) throw new Error('login');
  return [...found].map((url, i) => ({ url, label: i ? (i > 1 ? `מסך ${i}` : 'מסך') : '' }));
}
