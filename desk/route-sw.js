// desk/route-sw.js — keeps the ROUTING TEST PAGE working with no signal (prototype 2026-10-11).
// Cache-first for the page and its libraries. County data (drive file, map file, road
// file) is NOT here: the page keeps those in IndexedDB after "Prepare".
var CACHE = 'route-proto-v1';
var SHELL = ['route-test.html', 'route.js', 'route-vendor/maplibre-gl.js', 'route-vendor/maplibre-gl.css', 'route-vendor/pmtiles.js', 'vendor/xlsx.full.min.js'];
['Noto Sans Regular', 'Noto Sans Medium'].forEach(function (f) { ['0-255', '256-511', '8192-8447'].forEach(function (r) { SHELL.push('route-vendor/fonts/' + f + '/' + r + '.pbf'); }); });
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(e.request).then(function (r) {
      if (r.ok && /\/desk\/(route|route-vendor|vendor)/.test(u.pathname)) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); }); }
      return r;
    });
  }));
});
