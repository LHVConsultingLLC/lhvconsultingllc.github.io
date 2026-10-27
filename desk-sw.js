/* ── DESK OFFLINE SHELL + MAP TILE CACHE (prototype, 2026-10-11) ──────────────
 * Registered by desk.html with scope './desk', so it controls ONLY desk.html and
 * desk/* — never index.html or camera.html (those keep sw.js). It has to live in
 * docs/ (not docs/desk/) because a worker cannot control a page above its folder.
 *
 * Same rule as sw.js: the NETWORK WINS whenever it answers within 5 s; the cache
 * is only the dead-zone fallback, so a deploy is never hidden from an online laptop.
 * Exceptions, cache-first because they never change:
 *   - pinned Firebase SDK URLs (needed to reopen the desk with no signal)
 *   - USGS National Map tiles + USGS NAIP close-in imagery (both public domain)
 * KILL SWITCH: localStorage.desk_sw_off = '1', then unregister in DevTools.
 */
const V = 'desk-v7';   // v6 (10/27): also removes any desk page another worker saved (sw.js held desk-p27)   // v5 (10/27): drops every shell copy saved under a query-string key (Mike's laptop served desk-p27 from 10/20)
const SHELL = 'desk-shell-' + V, LIBS = 'desk-libs-' + V, TILES = 'desk-tiles';   // tiles survive version bumps
const SHELL_URLS = ['desk.html', 'desk/vendor/leaflet.js', 'desk/vendor/leaflet.css', 'desk/vendor/xlsx.full.min.js'];
const LIB_URLS = [
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try { const c = await caches.open(SHELL); await Promise.all(SHELL_URLS.map((u) => c.add(u).catch(() => {}))); } catch (err) {}
    try { const c = await caches.open(LIBS); await Promise.all(LIB_URLS.map((u) => c.add(new Request(u, { mode: 'cors' })).catch(() => {}))); } catch (err) {}
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('desk-') && ![SHELL, LIBS, TILES].includes(k)).map((k) => caches.delete(k)));
    // any desk page saved in the camera worker's SMALL shell cache goes too — never awaited here: activation holds
    // every page load until it finishes, and walking a big cache froze Mike's reload (10/27 10:2x AM). Only the
    // 'lhv-shell-' cache (a few files) is touched, in the background.
    setTimeout(async () => { try { for (const k of keys.filter((x) => x.startsWith('lhv-shell-'))) { const c = await caches.open(k);
      for (const r of await c.keys()) { const pth = new URL(r.url).pathname; if (/\/desk(\.html|-askpreview\.html)?$|\/desk\//.test(pth)) await c.delete(r); } } } catch (e2) {} }, 0);
    await self.clients.claim();
  })());
});
// THE OFFLINE COPY IS ALWAYS THE LATEST (Dustin 10/11 "it has the old build up"): Shift+reload and
// Ctrl+F5 BYPASS this worker, so the saved copy was only refreshed on a plain reload. The page now
// asks for a refresh on every load with signal; the worker re-fetches the shell and the desk modules.
const REFRESH_URLS = SHELL_URLS.concat(['desk/route.js', 'desk/imagery.js', 'desk/roadlabels.js', 'desk/p2p.js', 'desk/ask.js']);
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'refresh-shell') return;
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(REFRESH_URLS.map(async (u) => { try { const r = await fetch(u, { cache: 'no-cache' }); if (r && r.ok) { const k = new URL(u, self.registration.scope); await c.put(k.origin + k.pathname, r); } } catch (err) {} }));
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/firebaseio|googleapis|dropboxapi|dropbox\.com|cloudfunctions|identitytoolkit/.test(url.host)) return;   // live data: never touched
  if (url.host === 'basemap.nationalmap.gov' || (url.host === 'imagery.nationalmap.gov' && /USGSNAIPPlus\/ImageServer\/exportImage/.test(url.pathname))) {   // NAIP: public domain, close-in imagery
    e.respondWith((async () => {
      const c = await caches.open(TILES); const hit = await c.match(req.url);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req.url, res.clone()); return res; }
      catch (err) { return new Response('', { status: 504 }); }   // no tile: the page falls back to its coordinate grid
    })());
    return;
  }
  if (LIB_URLS.includes(url.href)) {
    e.respondWith((async () => { const hit = await caches.match(req); if (hit) return hit;
      const res = await fetch(req); if (res && res.ok) { const c = await caches.open(LIBS); c.put(req, res.clone()); } return res; })());
    return;
  }
  if (url.origin === self.location.origin) {
    // ── ONE SAVED COPY PER FILE, ALWAYS THE NEWEST (10/27) ──────────────────────────────────────────
    // The copy was saved under the FULL url (desk.html?as=MT&t=…) and the dead-zone fallback matched with
    // ignoreSearch — which returns the OLDEST of the matching entries. Mike reloaded on a slow link at 8:2x AM
    // and got desk-p27 from 10/20 (no Claude button, no speed report). Now the key is the path alone: every
    // save overwrites the one copy, and the fallback can only ever hand back the newest.
    const key = url.origin + url.pathname;
    e.respondWith((async () => {
      // revalidate with the server every time (GitHub Pages sends max-age=600, so a plain fetch
      // could hand back a 10-minute-old desk.html after a deploy, Dustin's laptop 10/11)
      const live = fetch(new Request(req, { cache: 'no-cache' })).then(async (res) => { if (res && res.ok) { const c = await caches.open(SHELL); c.put(key, res.clone()); } return res; });
      try { return await Promise.race([live, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 5000))]); }
      catch (err) { const c = await caches.open(SHELL); const hit = await c.match(key); if (hit) return hit; return live; }
    })());
  }
});
