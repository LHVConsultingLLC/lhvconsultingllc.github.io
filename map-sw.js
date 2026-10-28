// MAP OFFLINE COPY (10/27). The map must open every time: weak hotspot, no signal, or a new build.
// - The map page: try the live page for 4 s; if it does not arrive, open the NEWEST copy this laptop saved
//   (one copy per file, overwritten on every good load). No signal at all: the saved copy.
// - Map code + libraries: served from the laptop's copy at once, refreshed from the internet in the background.
// - Activation does nothing slow (a slow activation froze page loads on Mike's laptop 10/27).
const C = 'map-v1';
const SHELL = ['/map.html', '/desk/vendor/leaflet.css', '/desk/vendor/leaflet.js', '/desk/vendor/xlsx.full.min.js',
  '/desk/imagery.js', '/desk/roadlabels.js', '/desk/ask.js', '/desk/route.js', '/desk/p2p.js'];
const LIBS = ['https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => { const c = await caches.open(C);
    await Promise.all(SHELL.map((u) => fetch(u, { cache: 'no-cache' }).then((r) => r.ok && c.put(u, r)).catch(() => {})));
    await Promise.all(LIBS.map((u) => fetch(u, { mode: 'cors' }).then((r) => r.ok && c.put(u, r)).catch(() => {}))); })());
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
// desk/*.js carry ?b=<build>: the build is part of the key, so a new build never runs last build's script (audit #6)
const key = (u) => { const x = new URL(u); return x.origin === self.location.origin ? x.pathname + (/^\/desk\//.test(x.pathname) ? x.search : '') : x.href; };
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (/firebaseio|googleapis\.com|cloudfunctions|identitytoolkit|dropbox/.test(u.host)) return;   // live data: never touched
  if (/build-desk\.txt$/.test(u.pathname)) return;   // the build number is always asked of the site, never a saved copy (audit #6)
  const k = key(req.url);
  const isPage = req.mode === 'navigate';
  const isOurs = u.origin === self.location.origin || LIBS.includes(u.href);
  if (!isOurs) return;
  if (isPage) {
    e.respondWith((async () => {
      const c = await caches.open(C);
      const live = fetch(req.url, { cache: 'no-cache' }).then(async (r) => { if (r && r.ok) await c.put(k, r.clone()); return r; });
      e.waitUntil(live.then(() => {}, () => {}));   // 10/27: keep the helper alive until the new page is saved, so a slow link still gets the new build on the next load
      try { return await Promise.race([live, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]); }
      catch (err) { const hit = await c.match(k); if (hit) return hit; return live; }
    })());
    return;
  }
  e.respondWith((async () => {   // code + libraries: laptop copy now, refresh in the background
    const c = await caches.open(C); const hit = await c.match(k);
    const live = fetch(req).then((r) => { if (r && r.ok) c.put(k, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(live); return hit; }
    const r = await live; return r || new Response('', { status: 504 });
  })());
});
