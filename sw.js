// App code (the SHELL files) is served straight from this version's cache, so the app opens
// instantly even on a weak connection. Every code change ships a new sw.js (CACHE is a hash
// of the shell files — run `node tools/stamp-sw.mjs`; a test checks it), which the browser
// installs in the background; the app then reloads at a safe moment (app.js reloadWhenSafe).
// A whole version is cached at once, so a fresh index.html never meets a stale app.js.
// Data (semesters/*.json, push-config.json): the saved copy right away, refreshed from the
// network in the background; requests with ?fresh go to the network first (refreshData).
const CACHE = 'tracker-d65dc872';
const SHELL = ['./', 'index.html', 'guide.html', 'guide.js', 'theme.js', 'style.css', 'app.js', 'schedule.js', 'sync.js', 'summary.js', 'ics.js', 'badge.js', 'calendar.js', 'prayer.js', 'moodle.js', 'recordings.js', 'widget.js', 'insights.js',
  'manifest.webmanifest', 'icon-192.png', 'semesters/index.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const k of await caches.keys()) {
      if (k === CACHE || k === 'tracker-share') continue;
      // keep the saved data (semester files etc.) so the first start after an update is instant too
      const old = await caches.open(k);
      for (const req of await old.keys()) {
        if (/\.json$/.test(new URL(req.url).pathname) && !(await cache.match(req))) {
          await cache.put(req, await old.match(req));
        }
      }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
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
  // Icons/images: leave them to the browser. iOS fetches apple-touch-icons for "Add to Home
  // Screen" itself; intercepting them (and failing) made iPadOS fall back to a letter icon.
  if (/\.(png|jpe?g|svg|ico|webp)$/i.test(url.pathname)) return;
  const path = url.pathname.replace(/^.*\//, '') || './';
  const key = url.origin + url.pathname; // cache entries without the query string
  const network = async () => {
    // A fresh GET by URL — WebKit rejects fetch(request, init) for some request modes.
    const res = await fetch(new Request(key, { cache: 'no-cache', credentials: 'same-origin' }));
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  };
  const cached = () => caches.open(CACHE).then((c) => c.match(key));
  if (/\.json$/.test(path)) {
    e.respondWith((async () => {
      if (url.searchParams.has('fresh')) {
        try { return await network(); } catch { return (await cached()) || Response.error(); }
      }
      const hit = await cached();
      const update = network().catch(() => null);
      if (hit) { e.waitUntil(update); return hit; }
      return (await update) || Response.error();
    })());
    return;
  }
  // App shell (pages, scripts, styles): this version's copy; anything missing from the network.
  e.respondWith((async () => {
    const hit = await cached();
    if (hit) return hit;
    try { return await network(); } catch { return (await caches.match(e.request, { ignoreSearch: true })) || fetch(e.request); }
  })());
});

// Morning summary sent by the GitHub Action (tools/morning.mjs).
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'הסמסטרון', body: '' };
  if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
    self.navigator.setAppBadge(data.badge).catch(() => {});
  }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag || 'morning',
    icon: 'icon-192.png',
    badge: 'badge-96.png', // Android status bar: white shape on transparent
    dir: 'rtl',
    lang: 'he',
    data: { url: data.url || null },
    actions: data.tag === 'moodle'
      ? [{ action: 'tasks', title: '✏️ משימות' }]
      : [{ action: 'schedule', title: '📅 מערכת' }, { action: 'tasks', title: '✏️ משימות' }],
  }));
});

// Tap → open the app; action buttons open a specific tab.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.action ? `./?tab=${e.action}` : e.notification.data?.url || './';
  const url = new URL(target, self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      if (target !== './') await open.navigate(url).catch(() => {});
      return open.focus();
    }
    return self.clients.openWindow(url);
  })());
});
