// Network-first for everything (so schedule/app updates show up), cache as offline fallback.
// Requests revalidate with the server (cache: 'no-cache') instead of using the browser's
// HTTP cache, so the app never mixes a fresh index.html with a stale app.js.
const CACHE = 'tracker-v6';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'schedule.js', 'sync.js',
  'manifest.webmanifest', 'icon-192.png', 'semesters/index.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
