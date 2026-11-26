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

// Diagnose mode (⌥-click in the tracker): no video, just a report of what Panopto sends, saved
// as Downloads/הקלטות/_diagnose.json. Addresses are kept without their query (no signed tokens).
let report = null;
const bare = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u).split('?')[0]; } };
const note = (k, v) => { if (report) (report[k] ??= []).push(v); };

async function downloadRecording({ id, folder, name, screens, diagnose, low }) {
  if (!GUID.test(id || '')) throw new Error('bad-id');
  report = diagnose ? { id, at: new Date().toISOString(), screens } : null;
  let streams = [];
  try {
    streams = await viaDeliveryInfo(id, low ? 720 : Infinity);
  } catch (e) {
    note('deliveryInfoError', String(e.message || e));
    if (e.message === 'login' && !diagnose) throw e;
    console.warn('DeliveryInfo:', e);
  }
  if (diagnose) {
    try { note('viewerTab', (await viaViewerTab(id)).map((s) => ({ ...s, url: bare(s.url) }))); } catch (e) { note('viewerTabError', String(e.message || e)); }
    for (const s of streams) note('picked', { label: s.label, url: bare(s.url), bytes: await sizeOf(s.url) });
    const file = 'הקלטות/_diagnose.json';
    await chrome.downloads.download({ url: 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 1)), filename: file, conflictAction: 'overwrite' });
    report = null;
    return { ok: true, diagnosed: true, file };
  }
  if (!streams.length) streams = await viaViewerTab(id);
  if (!streams.length) throw new Error('no-streams');
  // Most lectures are only the board camera; the screen/slides stream only where it's used.
  if (!screens) streams = streams.filter((s) => !s.label || s.label === 'שמע');
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
async function viaDeliveryInfo(id, camMaxHeight = Infinity) {
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
  note('deliveryStreams', list.map((s) => ({ ...Object.fromEntries(Object.entries(s).filter(([k, v]) => typeof v !== 'object' || v === null)), StreamUrl: bare(s.StreamUrl || ''), StreamHttpUrl: bare(s.StreamHttpUrl || '') })));
  note('podcastStreams', (j.Delivery?.PodcastStreams || []).map((s) => ({ Tag: s.Tag, Name: s.Name, url: bare(s.StreamUrl || '') })));
  // Tags: DV = the main camera (the board, with the sound); OBJECT = extra screens. A lecture
  // can have two OBJECT streams: the slides (mostly still → very low bitrate) and a busier
  // capture we don't want. So: the camera, plus the lowest-bitrate OBJECT stream as the slides.
  const masters = [];
  for (const s of list) {
    const url = s.StreamUrl || s.StreamHttpUrl;
    if (!url || !/\.m3u8/i.test(url)) continue;
    masters.push({ tag: s.Tag, m: await readMaster(url) });
  }
  const out = [];
  const cam = masters.find((x) => x.tag === 'DV') || masters[0];
  if (cam) out.push(...await pick(cam.m, camMaxHeight, ''));
  const slides = masters.filter((x) => x !== cam && x.m.variants.length)
    .sort((a, b) => a.m.variants[0].avg - b.m.variants[0].avg)[0];
  if (slides) out.push(...await pick(slides.m, Infinity, 'מצגת'));
  return out;
}

// Camera quality: best (1080p, ~2.5 GB for a 110-minute lecture), or with ⌥-click in the
// tracker ("low") up to 720 → 540p, ~1 GB. Slides always come in their best quality (small).

async function readMaster(masterUrl) {
  const text = await getText(masterUrl);
  note('masterPlaylists', { url: bare(masterUrl), text: text.replace(/\?[^\s"]*/g, '') });
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/);
    if (!m) continue;
    const bw = +(m[1].match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || 0);
    variants.push({
      uri: lines[i + 1]?.trim(),
      bw,
      avg: +(m[1].match(/AVERAGE-BANDWIDTH=(\d+)/)?.[1] || bw),
      h: +(m[1].match(/RESOLUTION=\d+x(\d+)/)?.[1] || 0),
      audio: m[1].match(/AUDIO="([^"]+)"/)?.[1] || null,
    });
  }
  variants.sort((a, b) => b.bw - a.bw); // best first
  return { url: masterUrl, text, lines, variants };
}

// master → [{ url, label }]: the best variant up to maxHeight (+ its separate audio, if any).
async function pick(m, maxHeight, label) {
  const base = new URL(m.url);
  if (!m.variants.length) { const v = await wholeFile(m.url, m.text); return v ? [{ url: v, label }] : []; }
  const v = m.variants.find((x) => !x.h || x.h <= maxHeight) || m.variants[m.variants.length - 1];
  const out = [];
  const video = await wholeFile(resolve(v.uri, base));
  if (video) out.push({ url: video, label });
  if (v.audio) { // a separate audio track (then the video file is silent)
    const a = m.lines.find((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l) && l.includes(`GROUP-ID="${v.audio}"`));
    const uri = a?.match(/URI="([^"]+)"/)?.[1];
    if (uri) { const f = await wholeFile(resolve(uri, base)); if (f) out.push({ url: f, label: label ? `${label} - שמע` : 'שמע' }); }
  }
  return out;
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

async function sizeOf(url) {
  try { const r = await fetch(url, { method: 'HEAD', credentials: 'include' }); return +r.headers.get('content-length') || null; } catch { return null; }
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
  // can't tell the streams apart here: the first is the camera, the second the slides
  return [...found].slice(0, 2).map((url, i) => ({ url, label: i ? 'מצגת' : '' }));
}
