// MAP OFFLINE COPY (10/27). The map must open every time: weak hotspot, no signal, or a new build.
// - The map page: try the live page for 4 s; if it does not arrive, open the NEWEST copy this laptop saved
//   (one copy per file, overwritten on every good load). No signal at all: the saved copy.
// - Map code + libraries: served from the laptop's copy at once, refreshed from the internet in the background.
// - Activation does nothing slow (a slow activation froze page loads on Mike's laptop 10/27).
// sw2 (10/28, Mike's laptop reopened last night's p44 all morning, even after reloads): the page is fetched past every
// cache (a unique ?swb= + no-store) and a failed save can never throw away a page that arrived, so the live page that
// lands after the 4-s wait IS the saved copy for the next open; its build-keyed scripts are saved with it. The open map
// is told a newer build landed and moves onto it at its own next idle moment (the desk's idle rule: never mid-parcel,
// never mid-SHIP). This helper never reloads a page itself (desk-p51 harness: a reload from inside activation froze the
// page — the 10/27 "frozen helper" hang). Every fallback reports to the office (deskPing SWDG).
// desk-p51 (10/28 PM, Ohio: counties with no service for hours): with no signal ANY page of this site opens the saved
// map — a reload, the bare address (Chrome's Home button), a new tab, the map's own self-update — never Chrome's error page.
const C = 'map-v1';
const V = 'sw2';
const SHELL = ['/map.html', '/desk/vendor/leaflet.css', '/desk/vendor/leaflet.js', '/desk/vendor/xlsx.full.min.js',
  '/desk/imagery.js', '/desk/roadlabels.js', '/desk/ask.js', '/desk/route.js', '/desk/p2p.js'];
const BUILD_KEYED = ['/desk/imagery.js', '/desk/roadlabels.js', '/desk/ask.js', '/desk/route.js'];
const LIBS = ['https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js'];
const PING = 'https://us-central1-lhv-field-log.cloudfunctions.net/deskPing';
const diag = (stage, err) => { try { fetch(PING, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ drv: 'SWDG', stage, build: V,
  err: (String(err || '') + ' · ' + String(self.navigator && self.navigator.userAgent || '').replace(/^.*?\(/, '(')).slice(0, 190) }) }).catch(() => {}); } catch (e) {} };
const bust = (u) => u + (u.indexOf('?') < 0 ? '?' : '&') + 'swb=' + Date.now();
const fresh = async (u) => { const r = await fetch(bust(u), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; };
const save = async (c, k, r) => { try { await c.put(k, r); return true; } catch (e) { diag('put-fail', e && (e.name + ': ' + e.message)); return false; } };
const buildOf = async (r) => { try { const m = /DESK_BUILD\s*=\s*'([^']+)'/.exec(await r.text()); return m ? m[1] : ''; } catch (e) { return ''; } };
// a new build's own scripts (desk/*.js?b=<build>) saved with its page, so its first open on a slow link is not script by script
const saveScripts = async (c, b) => { if (!b) return; await Promise.all(BUILD_KEYED.map(async (p) => { const k = p + '?b=' + b;
  if (await c.match(k)) return; try { const r = await fresh(p); await save(c, k, r); } catch (e) {} })); };
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => { const c = await caches.open(C);
    const old = await c.match('/map.html'); const oldB = old ? await buildOf(old) : '';
    await Promise.all(SHELL.map((u) => fresh(u).then(async (r) => {
      if (u === '/map.html') { const nb = await buildOf(r.clone()); if (nb && nb !== oldB) diag('install', oldB + '>' + nb); await saveScripts(c, nb); }
      await save(c, u, r); }).catch((err) => diag('install', u + ' ' + (err && err.message)))));
    await Promise.all(LIBS.map((u) => fetch(u, { mode: 'cors' }).then((r) => r.ok && save(c, u, r)).catch(() => {}))); })());
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'refresh-shell') e.waitUntil((async () => { const c = await caches.open(C);
  await Promise.all(SHELL.filter((u) => u !== '/map.html').map((u) => fresh(u).then((r) => save(c, u, r)).catch(() => {}))); })()); });
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
    const cid = e.resultingClientId || '';
    e.respondWith((async () => {
      const c = await caches.open(C);
      // the live page, past every cache; a save that fails never costs us the page that arrived
      const live = fresh(u.origin + u.pathname).then(async (r) => { await save(c, k, r.clone()); return r; });
      let usedSaved = '';
      e.waitUntil(live.then(async (r) => {
        const nb = await buildOf(r.clone()); await saveScripts(c, nb);
        // slow link: the map opened on the saved copy and a newer build just landed: tell that map (it moves at its own idle moment)
        if (!usedSaved || !cid || !nb || nb === usedSaved) return;
        diag('newer', usedSaved + '>' + nb + ' (slow page landed)');
        const cl = await self.clients.get(cid); if (cl) cl.postMessage({ type: 'map-newer', build: nb });
      }, () => {}));
      try { return await Promise.race([live, new Promise((_, rej) => setTimeout(() => rej(new Error('slow 4 s')), 4000))]); }
      catch (err) { const hit = await c.match(k);
        if (hit) { usedSaved = await buildOf(hit.clone()); diag('page-saved', (err && err.message) + ' online=' + self.navigator.onLine + ' saved=' + usedSaved); return hit; }
        /* NO SIGNAL FOR HOURS (Dustin 10/28: "some counties hell be out of service for hours"): any other page of this site
           (the bare address from Chrome's Home button, a new tab, an old link) opens the saved map, never Chrome's offline page */
        if (u.pathname !== '/map.html' && (await c.match('/map.html'))) { diag('page-saved', 'redirect ' + u.pathname + ' -> saved map'); return Response.redirect(u.origin + '/map.html' + u.search, 302); }
        return live; }
    })());
    return;
  }
  e.respondWith((async () => {   // code + libraries: laptop copy now, refresh in the background
    const c = await caches.open(C); const hit = await c.match(k);
    const live = fetch(req).then((r) => { if (r && r.ok) save(c, k, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(live); return hit; }
    const r = await live; return r || new Response('', { status: 504 });
  })());
});
