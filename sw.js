// Network-first for everything (so schedule/app updates show up), cache as offline fallback.
// Requests revalidate with the server (cache: 'no-cache') instead of using the browser's
// HTTP cache, so the app never mixes a fresh index.html with a stale app.js.
const CACHE = 'tracker-v29';
const SHELL = ['./', 'index.html', 'guide.html', 'style.css', 'app.js', 'schedule.js', 'sync.js', 'summary.js', 'ics.js', 'badge.js', 'calendar.js', 'prayer.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'tracker-share').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Android share menu → manifest share_target: keep the file, open the app to import it.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const file = (await e.request.formData()).get('file');
      if (file) await (await caches.open('tracker-share')).put('shared-ics', new Response(file));
      return Response.redirect('./?shared=ics', 303);
    })());
    return;
  }
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

// Morning summary sent by the GitHub Action (tools/morning.mjs).
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'מעקב שיעורים', body: '' };
  if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
    self.navigator.setAppBadge(data.badge).catch(() => {});
  }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag || 'morning',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: 'rtl',
    lang: 'he',
    actions: [{ action: 'schedule', title: '📅 מערכת' }, { action: 'tasks', title: '✏️ משימות' }],
  }));
});

// Tap → open the app; action buttons open a specific tab.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.action ? `./?tab=${e.action}` : './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      if (e.action) await open.navigate(url).catch(() => {});
      return open.focus();
    }
    return self.clients.openWindow(url);
  })());
});
