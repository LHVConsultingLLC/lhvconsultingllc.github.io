/* ════════════════════════════════════════════════════════════════════════════
 * desk/imagery.js — OFFLINE SHARP IMAGERY for the laptop field log (prototype, 2026-10-11)
 *
 * Drivers work where there is no signal. The county folder holds ONE imagery file,
 * <BUCKET>.imagery.pmtiles (built by tools/imagery_pack_build.py: USDA NAIP, public domain,
 * z17-z19 JPEG tiles near each parcel or along every road). When a county loads, the desk copies
 * a pack under 300 MB into IndexedDB as ONE blob (kv 'imagery:<BUCKET>'), so it is there with the
 * network off; a bigger pack is read in place from the Dropbox folder (see LOAD). After that only
 * the drive file (the dots) changes nightly.
 *
 * On Imagery, close in (z17+), the pack is drawn ABOVE the live NAIP layer (desk.html
 * _naip / NAIP_URL) and overzoomed from z19 to z20. The live layer is not even asked for a
 * tile the pack has; it is kept only where the pack has nothing (away from the parcels).
 *
 * The STREETS pack (<BUCKET>.streets.pmtiles, USGS Topo z10-z16 over the whole county, same
 * builder with --streets) is handled the same way: Streets mode draws it over the online Topo
 * tiles (which skip what it has) and overzooms 16 → 18; Imagery mode keeps it underneath, so
 * with no signal the map is never black.
 *
 * Plugs into desk.html with no changes there beyond loading this file:
 *   DeskAPI.onRender  → notices a county load, opens the saved pack, refreshes it from the
 *                       county folder (or the mock folder) when the file there changed
 *   setBase (Streets / Imagery / Grid) → wrapped: adds/removes/re-stacks the pack layers
 *   renderCacheStatus → one more line in "Saved on this laptop"
 * No file = nothing changes.
 *
 * SAVED IN CHROME (desk-p53, Dustin 10/28: "load all the aerial imagery into the build"). Every county pack
 * (imagery 1.7-7 GB, streets) is copied from the folder into Chrome's own storage (the Origin Private File
 * System, navigator.storage.getDirectory()/packs/<BUCKET>.<kind>.pmtiles) by a background Worker that streams
 * 8 MB pieces through a sync access handle (never the whole file in memory). Tiles are then read from that
 * copy: no Dropbox, no folder permission, no network. Today's county and the next scheduled one; only while
 * the map is idle (not moving, no parcel open on the camera, no SHIP or photo upload running); resumable
 * (the copy's own size is where it continues); checked (size + header + directory + sample tiles against
 * the folder file) before the map switches to it; removed once the county is off today's and tomorrow's
 * schedule. Until a copy is complete the pack is read in place from the folder exactly as before.
 * ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var API = window.DeskAPI;
  if (!API || !window.L) return;

  // ── PMTiles v3 reader (a whole directory index in memory; tiles sliced from the blob) ──
  function pow2(n) { return Math.pow(2, n); }
  function zxyId(z, x, y) {   // Hilbert tile id; arithmetic, not bitwise (ids pass 2^32 at z17)
    var acc = (pow2(2 * z) - 1) / 3, a = z - 1;
    while (a >= 0) {
      var s = 1 << a, rx = (s & x) ? 1 : 0, ry = (s & y) ? 1 : 0;
      acc += ((3 * rx) ^ ry) * pow2(a) * pow2(a);
      if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } var t = x; x = y; y = t; }
      a--;
    }
    return acc;
  }
  function gunzip(buf) { return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }
  function parseDir(buf) {
    var b = new Uint8Array(buf), p = 0;
    function rv() { var n = 0, m = 1, c; do { c = b[p++]; n += (c & 0x7f) * m; m *= 128; } while (c >= 0x80); return n; }
    var n = rv(), ids = [], runs = [], lens = [], offs = [], last = 0, i;
    for (i = 0; i < n; i++) { last += rv(); ids.push(last); }
    for (i = 0; i < n; i++) runs.push(rv());
    for (i = 0; i < n; i++) lens.push(rv());
    for (i = 0; i < n; i++) { var v = rv(); offs.push(v === 0 && i > 0 ? offs[i - 1] + lens[i - 1] : v - 1); }
    return ids.map(function (id, k) { return [id, runs[k], lens[k], offs[k]]; });
  }
  async function openPack(blob) {
    var H = new DataView(await blob.slice(0, 127).arrayBuffer());
    var magic = String.fromCharCode.apply(null, new Uint8Array(H.buffer, 0, 7));
    if (magic !== 'PMTiles' || H.getUint8(7) !== 3) throw new Error('not a PMTiles v3 file');
    var u64 = function (o) { return H.getUint32(o, true) + H.getUint32(o + 4, true) * 4294967296; };
    var rdo = u64(8), rdl = u64(16), mo = u64(24), ml = u64(32), ldo = u64(40), tdo = u64(56);
    var gz = H.getUint8(97) === 2, rd = function (o, l) { return blob.slice(o, o + l).arrayBuffer().then(function (b) { return gz ? gunzip(b) : b; }); };
    var idx = new Map();
    async function walk(entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e[1] === 0) await walk(parseDir(await rd(ldo + e[3], e[2])));
        else for (var k = 0; k < e[1]; k++) idx.set(e[0] + k, [tdo + e[3], e[2]]);
      }
    }
    await walk(parseDir(await rd(rdo, rdl)));
    var meta = {}; try { meta = JSON.parse(new TextDecoder().decode(await rd(mo, ml))); } catch (e) {}
    // desk-p52: the tile format is in the header (PMTiles v3 tile_type, byte 99): 2 png, 3 jpeg, 4 webp, 5 avif. The new
    // county packs are WebP with z19 dropped (maxZ 18); the older ones JPEG to z19. Each tile is handed to the browser with
    // its own type, and a view past the pack's own top zoom is drawn by enlarging that zoom's tile (maxNativeZoom = maxZ).
    var TT = { 2: 'image/png', 3: 'image/jpeg', 4: 'image/webp', 5: 'image/avif' }, tt = H.getUint8(99);
    return { blob: blob, idx: idx, meta: meta, minZ: H.getUint8(100), maxZ: H.getUint8(101), tileType: tt, mime: TT[tt] || 'image/jpeg' };
  }

  // ── STATE: two packs per county, the same file format ──
  //   imagery  <BUCKET>.imagery.pmtiles  NAIP z17-z19 near the parcels  → above the live NAIP layer
  //   streets  <BUCKET>.streets.pmtiles  USGS Topo z10-z16, whole county → Streets mode (above the
  //            online tiles, which skip what it has); Imagery mode (underneath everything: what shows
  //            where the online imagery cannot load, far out or past the parcels)
  var P = {
    imagery: { file: '.imagery.pmtiles', key: 'imagery:', label: 'Imagery', pk: null, layer: null, saving: false },
    streets: { file: '.streets.pmtiles', key: 'streets:', label: 'Streets map', pk: null, layer: null, saving: false }
  };
  var _bucket = null, _patched = {};
  function has(K, z, x, y) {     // the pack draws this square (native, or overzoomed from its top zoom)
    var pk = K.pk; if (!pk || z < pk.minZ) return false;
    while (z > pk.maxZ) { z--; x = Math.floor(x / 2); y = Math.floor(y / 2); }
    return pk.idx.has(zxyId(z, x, y));
  }
  function emptyTile(done) { var d = document.createElement('div'); setTimeout(function () { done(null, d); }, 0); return d; }

  // ── THE LAYER: tiles straight out of the saved blob ──
  // ZOOMED OUT A STEP OR TWO (Dustin 10/19: "imagery was loaded by folder so it should show up live
  // regardless without the black"). The pack starts at z17; at z15-16 a tile is drawn from its
  // 4 / 16 saved z17 squares on a canvas, so the folder's imagery shows there with no signal.
  var UNDER = 2;
  function underTile(pk, c, done) {
    var n = Math.pow(2, pk.minZ - c.z), cv = document.createElement('canvas'); cv.width = cv.height = 256;
    var g = cv.getContext('2d'), sz = 256 / n, want = [], left;
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) { var r = pk.idx.get(zxyId(pk.minZ, c.x * n + i, c.y * n + j)); if (r) want.push([i, j, r]); }
    if (!want.length) return emptyTile(done);
    left = want.length;
    want.forEach(function (w) {
      var img = new Image(), url = URL.createObjectURL(pk.blob.slice(w[2][0], w[2][0] + w[2][1], pk.mime || 'image/jpeg'));
      img.onload = function () { try { g.drawImage(img, w[0] * sz, w[1] * sz, sz, sz); } catch (e) {} URL.revokeObjectURL(url); if (--left === 0) done(null, cv); };
      img.onerror = function () { URL.revokeObjectURL(url); if (--left === 0) done(null, cv); };
      img.src = url;
    });
    return cv;
  }
  var PackLayer = L.GridLayer.extend({
    createTile: function (c, done) {
      var pk = this._pk;
      if (pk && this._under && c.z < pk.minZ) return underTile(pk, c, done);
      var r = pk && pk.idx.get(zxyId(c.z, c.x, c.y));
      if (!r) return emptyTile(done);               // nothing here: the layer below shows
      var img = document.createElement('img'); img.alt = ''; img.setAttribute('role', 'presentation');
      var url = URL.createObjectURL(pk.blob.slice(r[0], r[0] + r[1], pk.mime || 'image/jpeg'));
      img.onload = function () { URL.revokeObjectURL(url); done(null, img); };
      img.onerror = function () { URL.revokeObjectURL(url); done(new Error('pack tile'), img); staleTile(pk === P.imagery.pk ? P.imagery : P.streets); OP.tileErr++; };
      img.src = url;
      return img;
    }
  });
  function layerFor(K, map, opts) {   // one layer per pack: its native zooms are the pack's own
    if (K.pk && (!K.layer || K.layer._pk !== K.pk)) {
      if (K.layer && map.hasLayer(K.layer)) map.removeLayer(K.layer);
      var _u = K === P.imagery;   // the imagery pack also draws a step or two out (UNDER)
      K.layer = new PackLayer(Object.assign({ minZoom: _u ? Math.max(0, K.pk.minZ - UNDER) : K.pk.minZ, maxNativeZoom: K.pk.maxZ, maxZoom: 20 }, opts));
      K.layer._pk = K.pk; K.layer._under = _u;
      // a pack tile counts as a map picture: the desk's "no tiles → coordinate grid" check stays quiet
      K.layer.on('tileload', function () { try { window._tileOk++; window.gridCheck(); } catch (e) {} });
    }
    if (!K.pk && K.layer && map.hasLayer(K.layer)) map.removeLayer(K.layer);
    return K.pk ? K.layer : null;
  }
  function skipWhatPackHas(live, K) {   // the online layer is not even asked for a square the pack draws
    if (!live || _patched[K.key] === live) return;
    _patched[K.key] = live; var orig = live.createTile;
    live.createTile = function (c, done) { return has(K, c.z, c.x, c.y) ? emptyTile(done) : orig.call(this, c, done); };
  }
  function ensureLayer() {
    var map = API.map(), naip = window._naip, base = window._base, topo = window.baseLayers && window.baseLayers.topo;
    if (!map || !naip) return;
    // IMAGERY pack: on with the live NAIP layer (the Imagery choice), above it
    var li = layerFor(P.imagery, map, { zIndex: 5, attribution: 'USDA NAIP (saved on this laptop)' });
    skipWhatPackHas(naip, P.imagery);
    var wantI = !!li && map.hasLayer(naip);
    if (li && wantI !== map.hasLayer(li)) wantI ? li.addTo(map) : map.removeLayer(li);
    // STREETS pack: Streets → above the online Topo; Imagery → underneath everything; Grid only → off
    var ls = layerFor(P.streets, map, { zIndex: 0, attribution: 'USGS The National Map (saved on this laptop)' });
    skipWhatPackHas(topo, P.streets);
    if (ls) {
      // Imagery: BELOW the online imagery (z -1; the online layers have no z-index, and a 0 painted
      // over them by DOM order: Dustin 10/11 'imagery is just showing only streets')
      var z = base === 'topo' ? 2 : -1, on = base === 'topo' || base === 'img';
      if (ls.options.zIndex !== z) ls.setZIndex(z);
      if (on !== map.hasLayer(ls)) on ? ls.addTo(map) : map.removeLayer(ls);
    }
  }
  // the Imagery / Streets / Grid choice (buttons, M key) goes through setBase()
  var _origSetBase = window.setBase;
  if (typeof _origSetBase === 'function') window.setBase = function () { var r = _origSetBase.apply(this, arguments); ensureLayer(); return r; };

  async function usePack(K, bucket, blob) {
    var p = await openPack(blob);
    if (_bucket !== bucket) return;
    K.pk = p; ensureLayer();
    if (K === P.imagery && window._naip) window._naip.redraw();
    if (K === P.streets && window.baseLayers && window.baseLayers.topo) window.baseLayers.topo.redraw();
    refreshStatus();
  }

  // ── LOAD ──
  // Small packs (under BIG) are copied into IndexedDB as one blob: there with no signal, whatever
  // happens to the folder. BIG packs (a whole-county road corridor is GBs) are NEVER copied: the
  // desk reads them IN PLACE from the laptop's Dropbox folder with File.slice range reads (header +
  // directory once, then each tile's bytes), keeping the folder handle the way the drive file does.
  // Where the file is looked for: the county folder the driver opened, then the _IMAGERY folder
  // (<_IMAGERY>/<BUCKET>/<BUCKET>.imagery.pmtiles; picked once from "Saved on this laptop").
  // The mock (?mock=) fetches from the mock folder and always copies.
  var BIG = 300 * 1024 * 1024;
  async function granted(h) { try { return (await h.queryPermission({ mode: 'read' })) === 'granted'; } catch (e) { return false; } }
  async function folderHandle(bucket, K) {   // → FileSystemFileHandle or null (no folder, no permission, no file)
    var name = bucket + K.file, dir = null, root = null;
    try { dir = await DB.get('kv', 'dirHandle'); } catch (e) {}
    if (dir && dir.name === bucket && await granted(dir)) { try { return await dir.getFileHandle(name); } catch (e) {} }
    try { root = await DB.get('kv', 'imageryRoot'); } catch (e) {}
    if (root && await granted(root)) {
      var sub = null;
      if (root.name === bucket) sub = root; else { try { sub = await root.getDirectoryHandle(bucket); } catch (e) {} }
      if (sub) { try { return await sub.getFileHandle(name); } catch (e) {} }
    }
    return null;
  }
  async function sourceFile(bucket, K) {   // → { size, mod, get() → Blob, handle? } or null
    var name = bucket + K.file;
    if (_testSrc[name]) { var tf = _testSrc[name];   /* harness only: a File stands in for the folder file */
      return { size: tf.size, mod: String(tf.lastModified), handle: { test: 1 }, file: tf, get: function () { return Promise.resolve(tf); } }; }
    if (window.__DESK_MOCK) {
      var url = window.__DESK_MOCK.replace(/\/+$/, '') + '/' + name;
      var h = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!h.ok) return netSource(bucket, K);   /* harness: the server path stands in when the mock folder lacks the file */
      return { size: Number(h.headers.get('content-length')) || 0, mod: h.headers.get('last-modified') || '',
        get: function () { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }); } };
    }
    var fh = await folderHandle(bucket, K); if (!fh) return netSource(bucket, K);
    var f = await fh.getFile();
    // reading the bytes now brings an online-only Dropbox file down while there is signal
    return { size: f.size, mod: String(f.lastModified), handle: fh, file: f,
      get: function () { return f.arrayBuffer().then(function (b) { return new Blob([b], { type: 'application/vnd.pmtiles' }); }); } };
  }
  // ── FROM THE SERVER (desk-p54, 10/29: RF sat at 0% on Richland with "no folder") ──
  // Chrome only lets the page read the ONE Dropbox folder the driver once picked (and, after a reload, only after a tap):
  // never its parent, never the next county's folder. So when no folder holds the pack, the server (driveSheet, kind
  // 'pack') hands a Dropbox temporary link (4 h, HTTP Range) and the background copy streams the pack straight into
  // Chrome's own storage. No folder, no tap. Only for that copy: a pack is never drawn from the network.
  var NET = {};   // file name → { at, r } (a link is kept 3 h; a failure is asked again after 2 min)
  async function packLink(bucket, K) {
    var kind = K === P.imagery ? 'imagery' : 'streets';
    if (window._deskPackLink) return window._deskPackLink(bucket, kind);   /* tests only */
    var fb = window.firebase, user = fb && fb.auth && fb.auth().currentUser; if (!user) return { err: 'not signed in' };
    var as = ''; try { as = (new URLSearchParams(location.search).get('as') || '').toUpperCase(); } catch (e) {}
    var ac = window.AbortController ? new AbortController() : null, tm = setTimeout(function () { try { ac && ac.abort(); } catch (e) {} }, 30000);
    try {
      var body = { idToken: await user.getIdToken(), bucket: bucket, kind: 'pack', pack: kind }; if (as) body.drv = as;
      var r = await fetch('https://us-central1-lhv-field-log.cloudfunctions.net/driveSheet', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ac ? ac.signal : undefined });
      var j = await r.json(); return j && j.ok ? j : { err: (j && j.error) || ('HTTP ' + r.status) };
    } finally { clearTimeout(tm); }
  }
  async function netSource(bucket, K) {
    if (!OP.ok || window.__DESK_MOCK && !window._deskPackLink || navigator.onLine === false) return null;
    var name = bucket + K.file, c = NET[name];
    if (!c || Date.now() - c.at > (c.r && c.r.link ? 3 * 3600e3 : 120000)) {
      var r = null; try { r = await packLink(bucket, K); } catch (e) { r = { err: String((e && e.message) || e).slice(0, 60) }; }
      c = NET[name] = { at: Date.now(), r: r || { err: 'no answer' } };
    }
    var x = c.r;
    if (!x || !x.link || !x.size) { NET[name].why = x && x.missing ? 'not on the server' : ((x && x.err) || 'no link'); return null; }
    return { size: Number(x.size), mod: 'dbx:' + (x.hash || x.rev || ''), net: true, url: x.link, from: x.name || '',
      read: function (a, b) { return netRead(bucket, K, a, b); } };
  }
  async function netRead(bucket, K, a, b) {   // bytes [a, b) of the server's pack; one fresh link if the old one has run out
    for (var t = 0; t < 2; t++) {
      var c = NET[bucket + K.file], u = c && c.r && c.r.link;
      if (u) { try { var r = await fetch(u, { headers: { Range: 'bytes=' + a + '-' + (b - 1) }, cache: 'no-store' });
        if (r.status === 206 || (r.status === 200 && a === 0)) { var buf = await r.arrayBuffer(); return buf.byteLength > b - a ? buf.slice(0, b - a) : buf; } } catch (e) {} }
      delete NET[bucket + K.file]; await netSource(bucket, K);
    }
    throw new Error('server read');
  }
  function srcRead(src, a, b) { return src.file ? src.file.slice(a, b).arrayBuffer() : src.read(a, b); }
  async function readInPlace(K, bucket, src) {   // BIG: open the File itself; IndexedDB keeps only a note
    await usePack(K, bucket, src.file);
    if (K.pk) { K.pk.handle = src.handle; K.pk.inPlace = true; }
    try { await DB.put('kv', K.key + bucket, { inPlace: true, size: src.size, mod: src.mod, at: Date.now() }); } catch (e) {}
    refreshStatus();
  }
  async function loadPack(bucket, K) {
    K.pk = null; K.needsFolder = false; ensureLayer();
    // 1. the copy saved in Chrome (desk-p53): complete and checked = drawn from here, nothing else needed
    try { var of = await opDone(bucket + K.file); if (of) { await usePack(K, bucket, of); if (K.pk && _bucket === bucket) { K.pk.opfs = true; refreshStatus(); } } } catch (e) { K.pk = null; console.warn('chrome copy unreadable', e); }
    var rec = null;
    if (!K.pk) { try { rec = await DB.get('kv', K.key + bucket); } catch (e) {}
      if (rec && rec.blob) { try { await usePack(K, bucket, rec.blob); } catch (e) { console.warn('saved ' + K.key + ' pack unreadable', e); rec = null; } } }
    var src = null; try { src = await sourceFile(bucket, K); } catch (e) {}   // no signal / no folder: keep the saved copy
    if (K.pk && K.pk.opfs) { if (src && (src.file || src.net)) copySoon(); return; }   // the copier notices a newer folder file itself
    if (src && src.net) { copySoon(); return; }   /* desk-p54: only the server has it: Chrome's copy is made from there (live imagery meanwhile) */
    if (!src) { if (rec && rec.inPlace) { K.needsFolder = true; refreshStatus(); } return; }
    // a folder file: read in place until Chrome's copy is complete (a small one too, when the copy is possible)
    if (src.handle && (src.size > BIG || (OP.ok && !(rec && rec.blob)))) {
      try { await readInPlace(K, bucket, src); } catch (e) { console.warn(K.key + ' pack not readable in place', e); }
      if (OP.ok && src.file) copySoon();
      return;
    }
    if (OP.ok && src.file) { copySoon(); return; }   /* an older whole-blob copy keeps drawing until Chrome's copy replaces it */
    if (rec && rec.blob && rec.size === src.size && rec.mod === src.mod) return;
    K.saving = true; refreshStatus();
    try {
      var blob = await src.get();
      await openPack(blob);   // check it before replacing a good saved copy
      await DB.put('kv', K.key + bucket, { blob: blob, size: src.size, mod: src.mod, at: Date.now() });
      // read back the STORED blob, so what is drawn is what survives a restart
      var back = await DB.get('kv', K.key + bucket);
      if (_bucket === bucket) await usePack(K, bucket, back.blob);
    } catch (e) { console.warn(K.key + ' pack not saved', e); API.toast(K.label + ' file not saved: ' + (e.message || e), 5000); }
    K.saving = false; refreshStatus();
  }
  // A file read in place goes stale when Dropbox replaces it (a newer pack): reopen it once.
  var _reopenAt = 0;
  function staleTile(K) {
    if (!K.pk || !(K.pk.inPlace || K.pk.opfs) || Date.now() - _reopenAt < 30000) return;
    _reopenAt = Date.now(); if (_bucket) loadPack(_bucket, K);
  }
  function loadCounty(bucket) {
    _bucket = bucket; refreshStatus();
    loadPack(bucket, P.streets);   // the small one first: the whole county's map
    loadPack(bucket, P.imagery);
  }
  // ── SAVED IN CHROME: the background copy (desk-p53) ──────────────────────────────────────────────────────
  // OP.st[<file name>] = { total, copied, done, ms, msFolder, wait, err } is what the office sees (deskPacks + the
  // 30-s screen report's offlineReady). IndexedDB kv 'opfs:<file name>' = { sig, total, done, at } says whether the
  // copy in Chrome is complete and checked; only a done copy is ever drawn.
  var _testSrc = {};
  /* desk-p52 fix: createSyncAccessHandle exists only INSIDE a worker (Chrome never shows it on the page's own
     FileSystemFileHandle), so testing for it here turned the copy off everywhere. The worker reports if it is missing. */
  var OP = { ok: !!(navigator.storage && navigator.storage.getDirectory && window.Worker && window.FileSystemFileHandle) && !window.LOOK,
    st: {}, busy: false, w: null, persist: null, est: null, tileErr: 0, lowAt: 0, kick: 0, testFree: null };
  var RESERVE = 1.5 * 1024 * 1024 * 1024;   // always leave this much of Chrome's allowance free
  async function opDir() { var r = await navigator.storage.getDirectory(); return r.getDirectoryHandle('packs', { create: true }); }
  async function opMeta(name) { try { return (await DB.get('kv', 'opfs:' + name)) || null; } catch (e) { return null; } }
  async function opDone(name) {   // → the complete, checked copy as a File, or null
    if (!OP.ok) return null;
    var m = await opMeta(name); if (!m || !m.done) return null;
    try { var f = await (await (await opDir()).getFileHandle(name)).getFile(); if (f.size === m.total) return f; } catch (e) {}
    try { await DB.put('kv', 'opfs:' + name, Object.assign({}, m, { done: false })); } catch (e) {}   // gone or short: copy again
    return null;
  }
  // THE WORKER: one file at a time, 8 MB pieces, written in place at their offset (so a stop resumes from the
  // copy's own size). 'pause' stops it between pieces; 'gap' sets the rest between pieces (0 when the map is idle).
  var WSRC = [
    'var stop = {}, gap = {};',
    '/* desk-p54: one 8 MB piece of the server\'s pack by HTTP Range; a dropped piece is asked again (4 tries), a refused link ends the copy */',
    'async function piece(url, a, b) {',
    '  for (var t = 0; ; t++) {',
    '    var r = null;',
    '    try { r = await fetch(url, { headers: { Range: "bytes=" + a + "-" + (b - 1) }, cache: "no-store" }); } catch (e) { r = null; }',
    '    if (r && (r.status === 206 || (r.status === 200 && a === 0))) {',
    '      try { var u = new Uint8Array(await r.arrayBuffer()); if (u.length >= b - a) return u.length > b - a ? u.subarray(0, b - a) : u; } catch (e) {}',
    '    } else if (r && r.status >= 400 && r.status < 500) throw new Error("link HTTP " + r.status);',
    '    if (t >= 3) throw new Error("network: piece at " + a + " failed 4 times");',
    '    await new Promise(function (res) { setTimeout(res, 2000 * Math.pow(2, t)); });',
    '  }',
    '}',
    'onmessage = async function (e) { var m = e.data;',
    '  if (m.op === "pause") { stop[m.name] = 1; return; }',
    '  if (m.op === "gap") { gap[m.name] = m.gap; return; }',
    '  if (m.op !== "copy") return;',
    '  stop[m.name] = 0; gap[m.name] = m.gap || 0;',
    '  var h = null, pos = 0, last = 0;',
    '  try {',
    '    var root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle("packs", { create: true });',
    '    var fh = await dir.getFileHandle(m.name, { create: true });',
    '    h = await fh.createSyncAccessHandle();',
    '    var size = m.file ? m.file.size : m.size;',
    '    pos = h.getSize();',
    '    if (m.fresh || pos > size) { h.truncate(0); pos = 0; }',
    '    else pos = Math.max(0, pos - 16777216);',
    '    postMessage({ name: m.name, pos: pos });',
    '    while (pos < size) {',
    '      if (stop[m.name]) break;',
    '      var end = Math.min(size, pos + 8388608), buf = m.file ? new Uint8Array(await m.file.slice(pos, end).arrayBuffer()) : await piece(m.url, pos, end);',
    '      if (!buf.length) throw new Error("short read");',
    '      var n = h.write(buf, { at: pos });',
    '      if (n !== buf.length) throw new Error("short write");',
    '      pos += n;',
    '      if (Date.now() - last > 1000) { h.flush(); last = Date.now(); postMessage({ name: m.name, pos: pos }); }',
    '      if (gap[m.name]) await new Promise(function (r) { setTimeout(r, gap[m.name]); });',
    '    }',
    '    h.flush(); h.close(); h = null;',
    '    postMessage({ name: m.name, pos: pos, end: true, done: pos >= size });',
    '  } catch (err) {',
    '    try { if (h) { h.flush(); pos = h.getSize(); h.close(); } } catch (x) {}',
    '    postMessage({ name: m.name, pos: pos, end: true, err: String((err && err.name) || "Error") + ": " + String((err && err.message) || err).slice(0, 120) });',
    '  }',
    '};'
  ].join('\n');
  var _wait = {};
  function worker() {
    if (OP.w) return OP.w;
    OP.w = new Worker(URL.createObjectURL(new Blob([WSRC], { type: 'application/javascript' })));
    OP.w.onmessage = function (e) { var d = e.data || {}, st = OP.st[d.name]; if (st) st.copied = d.pos;
      if (d.end && _wait[d.name]) { var r = _wait[d.name]; delete _wait[d.name]; r(d); } };
    OP.w.onerror = function (e) { Object.keys(_wait).forEach(function (k) { var r = _wait[k]; delete _wait[k]; r({ end: true, err: 'worker: ' + ((e && e.message) || 'error') }); }); OP.w = null; };
    return OP.w;
  }
  // WHEN: only while the map is idle. Moving, a parcel open on the camera, a SHIP running, or the camera's photos
  // still uploading (while the camera is checking in) = paused. With no camera in the last 10 minutes (parked, end
  // of day, overnight) it copies at full speed; between parcels on a driving day it copies slowly, so the map stays quick.
  function camRecent() { return Date.now() - Math.max(Number(window._hbHeardAt || 0), Number(window._camHbSeenAt || 0)) < 10 * 60000; }
  function idleNow() { try {
    if (window.LOOK || window._camOpen) return false;
    var G = window.Gps; if (G && G.pos && G.fixAt && Date.now() - G.fixAt < 60000 && Number(G.speedKn || 0) * 1.1508 >= 3) return false;
    var sb = document.getElementById('ship-btn'); if (sb && sb.disabled) return false;
    var cs = window._camSync; if (camRecent() && cs && Number(cs.pending || 0) > 0) return false;
    return true; } catch (e) { return false; } }
  function gapNow() { return camRecent() ? 250 : 0; }
  function nextOf(cur) { try { var s = window._todaySched && window._todaySched(); if (!s) return '';
    var t = (s.today || []).map(function (c) { return c.bucket; }), i = t.indexOf(cur);
    if (i >= 0 && t[i + 1]) return t[i + 1]; if (i < 0 && t.length && t[0] !== cur) return t[0];
    return ((s.tomorrow || [])[0] || {}).bucket || ''; } catch (e) { return ''; } }
  function wanted() { var out = []; if (_bucket) out.push(_bucket); var n = _bucket ? nextOf(_bucket) : ''; if (n && n !== _bucket) out.push(n); return out; }
  async function freeBytes() {
    if (OP.testFree != null) return OP.testFree;
    try { var e = await navigator.storage.estimate(); OP.est = { quota: e.quota, usage: e.usage }; return Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch (x) { return 0; }
  }
  var _wl = null;
  async function wakeOn() { try { if (!_wl && navigator.wakeLock && document.visibilityState === 'visible') { _wl = await navigator.wakeLock.request('screen'); _wl.addEventListener('release', function () { _wl = null; }); } } catch (e) {} }
  function wakeOff() { try { if (_wl) _wl.release(); } catch (e) {} _wl = null; }
  async function sampleMs(file, pk) {   // one tile's read time from this file (the middle of the pack)
    try { var ks = Array.from(pk.idx.keys()), r = pk.idx.get(ks[Math.floor(ks.length / 2)]); if (!r) return null;
      var t0 = performance.now(); await file.slice(r[0], r[0] + r[1]).arrayBuffer(); return Math.round((performance.now() - t0) * 10) / 10; } catch (e) { return null; }
  }
  async function verify(name, src) {   // size + header + directory + 6 tiles byte for byte against the folder file
    var f = await (await (await opDir()).getFileHandle(name)).getFile();
    if (f.size !== src.size) throw new Error('size ' + f.size + ' ≠ ' + src.size);
    var pk = await openPack(f), ks = Array.from(pk.idx.keys());
    if (!ks.length) throw new Error('no tiles');
    for (var i = 0; i < 6; i++) {
      var r = pk.idx.get(ks[Math.floor(i * (ks.length - 1) / 5)]);
      var a = new Uint8Array(await f.slice(r[0], r[0] + r[1]).arrayBuffer()), b = new Uint8Array(await srcRead(src, r[0], r[0] + r[1]));
      if (a.length !== b.length) throw new Error('tile length');
      for (var j = 0; j < a.length; j += 97) if (a[j] !== b[j]) throw new Error('tile bytes');
      if (a[a.length - 1] !== b[b.length - 1]) throw new Error('tile end');
    }
    return { file: f, pk: pk, tiles: ks.length };
  }
  async function copyOne(bucket, K, src) {
    var name = bucket + K.file, st = OP.st[name], sig = src.size + ':' + src.mod, m = await opMeta(name);
    var fresh = !(m && m.sig === sig && !m.done);
    var have = 0; if (!fresh) { try { have = (await (await (await opDir()).getFileHandle(name)).getFile()).size; } catch (e) { fresh = true; } }
    var need = src.size - (fresh ? 0 : have), free = await freeBytes();
    st.freeGB = Math.round(free / 1e8) / 10;
    if (free < need + RESERVE) { st.wait = 'low disk'; OP.lowAt = Date.now(); return false; }
    if (OP.persist == null && navigator.storage.persist) { try { OP.persist = await navigator.storage.persist(); } catch (e) { OP.persist = false; } }
    if (fresh) {
      // a newer folder file: the old copy stops being drawn first (the folder file is read in place meanwhile)
      if (K.pk && K.pk.opfs && _bucket === bucket) { K.pk = null; ensureLayer(); try { await readInPlace(K, bucket, src); } catch (e) {} }
      await DB.put('kv', 'opfs:' + name, { sig: sig, total: src.size, done: false, at: Date.now(), via: src.net ? 'server' : 'folder' });
    }
    st.wait = ''; st.err = ''; st.copied = fresh ? 0 : have; st.copying = true; st.t0 = st.t0 || Date.now();
    var t0 = Date.now(), w = worker(), gap = src.net ? netGap() : gapNow();
    var res = new Promise(function (r) { _wait[name] = r; });
    st.via = src.net ? 'server' : 'folder';
    w.postMessage({ op: 'copy', name: name, file: src.file || null, url: src.net ? src.url : null, size: src.size, fresh: fresh, gap: gap });
    wakeOn();
    var watch = setInterval(function () {
      if (!idleNow()) { w.postMessage({ op: 'pause', name: name }); return; }
      var g = src.net ? netGap() : gapNow(); if (g !== gap) { gap = g; w.postMessage({ op: 'gap', name: name, gap: g }); }
    }, 2000);
    var d = await res; clearInterval(watch); st.copying = false; wakeOff();
    st.secs = (st.secs || 0) + Math.round((Date.now() - t0) / 1000);
    if (d.err) {
      st.err = d.err;
      if (/^Error: (link|network)/.test(d.err)) { delete NET[name]; st.wait = 'asks the server again'; }   /* desk-p54: an old link: a new one on the next tick, the copy resumes where it stopped */
      if (/Quota|space|NoModification|short write/i.test(d.err)) {   // the disk filled during the copy: give the space back, keep reading in place
        if (/Quota|space|short write/i.test(d.err)) { try { await (await opDir()).removeEntry(name); } catch (e) {} try { await DB.del('kv', 'opfs:' + name); } catch (e) {} st.copied = 0; st.wait = 'low disk'; OP.lowAt = Date.now(); }
      }
      return false;
    }
    if (!d.done) { st.wait = 'waits for idle'; return false; }
    try {
      var v = await verify(name, src);
      await DB.put('kv', 'opfs:' + name, { sig: sig, total: src.size, done: true, at: Date.now(), tiles: v.tiles, secs: st.secs, via: src.net ? 'server' : 'folder', from: src.from || '' });
      st.done = true; st.copied = src.size; st.total = src.size; st.err = '';
      st.ms = await sampleMs(v.file, v.pk); st.msFolder = src.file ? await sampleMs(src.file, v.pk) : null;
      // the whole-blob copy an older build kept in IndexedDB is no longer needed
      try { var old = await DB.get('kv', K.key + bucket); if (old && old.blob) await DB.del('kv', K.key + bucket); } catch (e) {}
      if (_bucket === bucket) { K.pk = null; await usePack(K, bucket, v.file); if (K.pk) K.pk.opfs = true; refreshStatus(); }
      return true;
    } catch (e) {
      st.err = 'check failed: ' + ((e && e.message) || e); st.done = false;
      /* desk-p54: the server could not be reached for the check (signal gone, old link): the copy stays; the next tick re-reads
         its last 16 MB and checks again. Only a real mismatch throws the copy away. */
      if (/server read/.test(String(e && e.message))) { delete NET[name]; st.wait = 'asks the server again'; return false; }
      try { await DB.put('kv', 'opfs:' + name, { sig: sig, total: src.size, done: false, at: Date.now() }); } catch (x) {}
      try { await (await opDir()).removeEntry(name); } catch (x) {}   // copy it again from the start next time
      return false;
    }
  }
  // REMOVE what is no longer needed: a county off today's AND tomorrow's schedule (and not open on the map).
  // With no schedule on this laptop nothing is removed.
  async function cleanup() {
    var s = null; try { s = window._todaySched && window._todaySched(); } catch (e) {}
    if (!s) return;
    var keep = {}; wanted().forEach(function (b) { keep[b] = 1; });
    (s.today || []).concat(s.tomorrow || []).forEach(function (c) { if (c && c.bucket) keep[c.bucket] = 1; });
    try { var dir = await opDir();
      for await (var ent of dir.keys()) {
        var b = String(ent).replace(/\.(imagery|streets)\.pmtiles$/, ''); if (keep[b] || b === ent) continue;
        if (OP.st[ent] && OP.st[ent].copying) continue;
        try { await dir.removeEntry(ent); await DB.del('kv', 'opfs:' + ent); delete OP.st[ent]; } catch (e) {}
      } } catch (e) {}
  }
  // desk-p54: is the copy already in Chrome still the one to keep? Same file = yes. A copy made by the other route (folder
  // vs server) of the same size = yes (not copied twice). The county ON THE MAP is never torn down for a server file:
  // its copy keeps drawing (a newer server pack is copied once that county is no longer on the map).
  function keepDone(m, src, sig, b) {
    if (!sig || m.sig === sig) return true;
    if (src && src.net && b === _bucket) return true;
    return !!src && m.total === src.size && (m.via || 'folder') !== (src.net ? 'server' : 'folder');
  }
  // a server copy runs over whatever internet the laptop has (often the driver's hotspot): on a driving day (camera checked
  // in during the last 10 minutes) it goes only between parcels like any copy, and slower (1 s rest per 8 MB piece);
  // parked, after the drive and overnight at full speed
  function netGap() { return camRecent() ? 1000 : 0; }
  async function copyTick() {
    if (!OP.ok || OP.busy) return;
    OP.busy = true;
    try {
      await cleanup();
      var list = []; wanted().forEach(function (b) { list.push([b, P.streets], [b, P.imagery]); });   // the small one first
      Object.keys(OP.st).forEach(function (n) { if (!list.some(function (x) { return x[0] + x[1].file === n; })) delete OP.st[n]; });
      for (var i = 0; i < list.length; i++) {
        var b = list[i][0], K = list[i][1], name = b + K.file, st = OP.st[name] = OP.st[name] || { copied: 0, total: 0 };
        var src = null; try { src = await sourceFile(b, K); } catch (e) {}
        var m = await opMeta(name), sig = src && (src.file || src.net) ? src.size + ':' + src.mod : '';
        if (m && m.done && keepDone(m, src, sig, b) && await opDone(name)) {   // complete (with no folder, the copy is all there is)
          st.done = true; st.total = st.copied = m.total; st.wait = ''; st.err = '';
          if (st.ms == null && b === _bucket && K.pk && K.pk.opfs) st.ms = await sampleMs(K.pk.blob, K.pk);
          continue;
        }
        st.done = false;
        if (!src || !(src.file || src.net)) { var nw = (NET[name] && NET[name].why) ? ' · server: ' + NET[name].why : '';
          st.wait = window.__DESK_MOCK && !window._deskPackLink ? 'mock' : (m ? 'folder needs a tap' : 'no folder') + nw; st.total = st.total || (m && m.total) || 0; continue; }
        st.via = src.net ? 'server' : 'folder';
        st.total = src.size;
        if (st.copied == null || (!st.copied && m && m.sig === sig)) { try { st.copied = (await (await (await opDir()).getFileHandle(name)).getFile()).size; } catch (e) { st.copied = 0; } }
        if (st.wait === 'low disk' && Date.now() - OP.lowAt < 10 * 60000) break;
        if (!idleNow()) { st.wait = 'waits for idle'; break; }
        var ok = await copyOne(b, K, src);
        if (!ok) break;   // paused, low disk or an error: try again on the next tick
      }
    } catch (e) { console.warn('chrome copy', e); }
    OP.busy = false; refreshStatus();
  }
  function copySoon() { if (!OP.ok) return; clearTimeout(OP.kick); OP.kick = setTimeout(copyTick, 3000); }
  if (OP.ok) setInterval(copyTick, 30000);
  function gb(n) { return (Math.round((n || 0) / 1e7) / 100) + 'G'; }
  function opLine(name) {   // short, for the office: 'chrome ✓ 5.16G 1.2ms (folder 40ms)' / 'chrome 1.20/5.16G waits for idle'
    var s = OP.st[name]; if (!OP.ok) return null; if (!s) return 'chrome: not checked yet';
    if (s.done) return 'chrome ✓ ' + gb(s.total) + (s.ms != null ? ' ' + s.ms + 'ms' : '') + (s.msFolder != null ? ' (folder ' + s.msFolder + 'ms)' : '') + (s.secs ? ' ' + s.secs + 's' : '');
    return 'chrome ' + gb(s.copied) + '/' + gb(s.total) + (s.copying ? ' copying' : '') + (s.wait ? ' ' + s.wait : '') + (s.wait === 'low disk' && s.freeGB != null ? ' ' + s.freeGB + 'G free' : '') + (s.err ? ' ' + String(s.err).slice(0, 50) : '');
  }
  function storeLine() { if (!OP.ok) return 'chrome copy: not supported'; var e = OP.est || {};
    return 'persist ' + (OP.persist == null ? '?' : OP.persist ? 'yes' : 'no') + ' · used ' + gb(e.usage) + ' of ' + gb(e.quota) + (OP.tileErr ? ' · tile errors ' + OP.tileErr : ''); }

  // "Saved on this laptop" link: pick the _IMAGERY folder once (or allow it again after a restart)
  var _picking = false;
  async function pickImageryFolder() {
    var root = null; try { root = await DB.get('kv', 'imageryRoot'); } catch (e) {}
    try {
      if (root && (await root.requestPermission({ mode: 'read' })) === 'granted') { if (_bucket) loadCounty(_bucket); return; }
      if (!window.showDirectoryPicker || _picking) return;      // one folder window at a time (10/16)
      _picking = true;
      try { root = await window.showDirectoryPicker({ id: 'lhv-imagery', mode: 'read' }); } finally { _picking = false; }
      await DB.put('kv', 'imageryRoot', root);
      if (_bucket) loadCounty(_bucket);
    } catch (e) { if (!e || e.name !== 'AbortError') API.toast(/already active/i.test(String(e && e.message)) ? 'A folder window is already open: look behind Chrome, or quit Chrome (Cmd+Q) and reopen the desk in one tab.' : 'Imagery folder not opened: ' + ((e && e.message) || e), 6000); }
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('#img-folder'); if (!t) return;
    e.preventDefault(); pickImageryFolder();
  });

  // ── "Saved on this laptop" ──
  function captureText(m) {
    var a = m.capture_from, b = m.capture_to;
    if (!a) return m.naip_year || '?';
    if (!b || b === a) return a;
    return a + '–' + (b.slice(0, 4) === a.slice(0, 4) ? b.slice(5) : b);   // YYYY-MM-DD–MM-DD
  }
  function statusLines() {
    var I = P.imagery, S = P.streets;
    var where = function (K) { if (!K.pk || !K.pk.inPlace) return '';
      /* a quiet note while Chrome's own copy is being made (desk-p53); nothing to do */
      var st = OP.st[(_bucket || '') + K.file], pc = st && st.total ? Math.floor(st.copied * 100 / st.total) : 0;
      return ' · read from the Dropbox folder' + (pc > 0 && pc < 100 ? ' · saving to this laptop ' + pc + '%' : ''); };
    var s = S.saving ? 'Streets map: saving for no signal…' : S.pk ? (S.pk.opfs ? 'Streets map saved on this laptop ✓ (whole county)' : 'Streets map saved for no signal ✓ (whole county' + where(S) + ')') : 'no streets map file';
    var i = I.saving ? 'Imagery: saving for no signal…' : I.pk ? (I.pk.opfs ? 'Aerials saved on this laptop ✓ (capture ' + esc(captureText(I.pk.meta || {})) + ')' : 'Imagery saved for no signal ✓ (capture ' + esc(captureText(I.pk.meta || {})) + where(I) + ')') : 'no imagery file';
    var out = s + '<br>' + i;
    if (!window.__DESK_MOCK && window.showDirectoryPicker && (!I.pk || !S.pk || I.needsFolder || S.needsFolder))
      out += '<br><a href="#" id="img-folder" style="color:var(--sky)">' + (I.needsFolder || S.needsFolder ? 'Allow the _IMAGERY folder again' : 'Choose the _IMAGERY folder…') + '</a>';
    return out;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function addLine() {
    var el = document.getElementById('prep-st'); if (!el || !el.innerHTML) return;
    var old = document.getElementById('prep-img'); if (old) old.remove();
    // under the desk's "list … · outlines" line, above its grey note
    var s = document.createElement('span'); s.id = 'prep-img'; s.innerHTML = '<br>' + statusLines();
    var second = el.querySelectorAll('br')[1];
    if (second) el.insertBefore(s, second); else el.appendChild(s);
    // the desk's grey note says map pictures exist only where the driver looked; with a streets pack that is no longer so
    var note = el.lastElementChild;
    if (P.streets.pk && note && note !== s && note.tagName === 'SPAN')
      note.textContent = 'With no signal: the Streets map works across the county; sharp imagery ' +
        (P.imagery.pk && /corridor/.test((P.imagery.pk.meta || {}).input_kind || '') ? 'along every road' : 'near each parcel') +
        (P.imagery.pk ? '' : ' once its file is here') + '; pins, aerials and the GPS dot always';
  }
  var _origStatus = window.renderCacheStatus;
  if (typeof _origStatus === 'function') {
    window.renderCacheStatus = function () { return Promise.resolve(_origStatus.apply(this, arguments)).then(addLine); };
  }
  function refreshStatus() { try { window.renderCacheStatus(); } catch (e) {} reportPacks(); }
  setInterval(reportPacks, 60000);   // also once a minute, so a laptop that came online later still reports
  // WHAT THIS LAPTOP HAS OPEN, written to the session (10/19) so it can be checked without the
  // driver reading the screen. Throttled; never throws.
  var _repAt = 0, _repSig = '';
  function reportPacks() {
    try {
      var I = P.imagery, S = P.streets, o = { build: window.DESK_BUILD || '', bucket: _bucket || '',
        imagery: { open: !!I.pk, inPlace: !!(I.pk && I.pk.inPlace), opfs: !!(I.pk && I.pk.opfs), needsFolder: !!I.needsFolder, minZ: I.pk ? I.pk.minZ : null, maxZ: I.pk ? I.pk.maxZ : null, type: I.pk ? I.pk.tileType : null },
        streets: { open: !!S.pk, inPlace: !!(S.pk && S.pk.inPlace), opfs: !!(S.pk && S.pk.opfs), needsFolder: !!S.needsFolder, saving: !!S.saving },
        chrome: OP.ok ? { store: storeLine(), packs: (function () { var o = {}; Object.keys(OP.st).forEach(function (n) { var x = OP.st[n];
          o[n.replace(/\./g, '_')] = { copied: x.copied || 0, total: x.total || 0, done: !!x.done, ms: x.ms == null ? null : x.ms, msFolder: x.msFolder == null ? null : x.msFolder,
            secs: x.secs || 0, wait: x.wait || '', err: x.err || '', via: x.via || '' }; }); return o; })() } : { store: storeLine() },
        speed: window.SpeedLim ? { loaded: window.SpeedLim.loaded(), segs: window.SpeedLim.count() } : null };
      var sig = JSON.stringify(o); if (sig === _repSig && Date.now() - _repAt < 300000) return;
      if (Date.now() - _repAt < 20000 && sig !== _repSig && _repSig) return;   /* a copy in progress: at most every 20 s */
      if (!(window.link && window.link.connected)) return;   // not sent = not remembered: the next tick retries (10/19)
      _repSig = sig; _repAt = Date.now(); o.at = Date.now();
      window.link.set('deskPacks', o).catch(function () { _repSig = ''; });
    } catch (e) {}
  }
  // AFTER A RELOAD CHROME FORGETS THE FOLDER PERMISSION, so a pack read in place from the folder
  // silently stops drawing. The first tap or click on the page (a user gesture, which Chrome needs)
  // asks for the folder again and reopens the packs. Chrome may offer "Allow on every visit".
  var _regrantBusy = false;
  document.addEventListener('pointerdown', async function () {
    if (_regrantBusy || !_bucket || !(P.imagery.needsFolder || P.streets.needsFolder)) return;
    _regrantBusy = true;
    try {
      var ok = false;
      for (var k of ['dirHandle', 'imageryRoot']) {
        var h = null; try { h = await DB.get('kv', k); } catch (e) {}
        if (h && !(await granted(h))) { try { if ((await h.requestPermission({ mode: 'read' })) === 'granted') ok = true; } catch (e) {} }
        else if (h) ok = true;
      }
      if (ok) { loadCounty(_bucket); API.toast('Saved imagery reopened from the folder', 3000); }
    } finally { setTimeout(function () { _regrantBusy = false; }, 5000); }
  }, true);

  // ── HOOK ──
  function tick() {
    var j = API.job(), b = j && j.bucket;
    ensureLayer();
    if (b && b !== _bucket) loadCounty(b);
  }
  API.onRender(tick);
  tick();
  window.DeskImagery = {
    pack: function () { return P.imagery.pk; }, streets: function () { return P.streets.pk; },
    has: function (z, x, y) { return has(P.imagery, z, x, y); }, reload: function () { if (_bucket) loadCounty(_bucket); },
    reloadStreets: function () { if (_bucket) loadPack(_bucket, P.streets); },
    // TEST ONLY: read a File (e.g. from an <input type=file>) in place, exactly as a BIG pack from the folder
    // desk-p53: Chrome's own copy. opfsLine/storeLine feed the 30-s screen report (offlineReady)
    opfsLine: function (B, kind) { var K = P[kind]; return K ? opLine(B + K.file) : null; },
    storeLine: storeLine, opfs: function () { return { ok: OP.ok, st: OP.st, persist: OP.persist, est: OP.est, tileErr: OP.tileErr }; },
    copyNow: function () { return copyTick(); },
    // TEST ONLY: a File stands in for the folder file; a free-space figure stands in for the disk's
    _testSource: function (kind, bucket, file) { _testSrc[bucket + P[kind].file] = file; },
    _testFree: function (n) { OP.testFree = n; },
    _netForget: function () { NET = {}; },
    _readInPlace: function (kind, file) { var K = P[kind]; return readInPlace(K, _bucket, { file: file, size: file.size, mod: String(file.lastModified), handle: null }); }
  };
})();
