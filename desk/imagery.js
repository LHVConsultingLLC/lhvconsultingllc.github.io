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
    return { blob: blob, idx: idx, meta: meta, minZ: H.getUint8(100), maxZ: H.getUint8(101) };
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
      var img = new Image(), url = URL.createObjectURL(pk.blob.slice(w[2][0], w[2][0] + w[2][1], 'image/jpeg'));
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
      var url = URL.createObjectURL(pk.blob.slice(r[0], r[0] + r[1], 'image/jpeg'));
      img.onload = function () { URL.revokeObjectURL(url); done(null, img); };
      img.onerror = function () { URL.revokeObjectURL(url); done(new Error('pack tile'), img); staleTile(pk === P.imagery.pk ? P.imagery : P.streets); };
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
    if (window.__DESK_MOCK) {
      var url = window.__DESK_MOCK.replace(/\/+$/, '') + '/' + name;
      var h = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!h.ok) return null;
      return { size: Number(h.headers.get('content-length')) || 0, mod: h.headers.get('last-modified') || '',
        get: function () { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }); } };
    }
    var fh = await folderHandle(bucket, K); if (!fh) return null;
    var f = await fh.getFile();
    // reading the bytes now brings an online-only Dropbox file down while there is signal
    return { size: f.size, mod: String(f.lastModified), handle: fh, file: f,
      get: function () { return f.arrayBuffer().then(function (b) { return new Blob([b], { type: 'application/vnd.pmtiles' }); }); } };
  }
  async function readInPlace(K, bucket, src) {   // BIG: open the File itself; IndexedDB keeps only a note
    await usePack(K, bucket, src.file);
    if (K.pk) { K.pk.handle = src.handle; K.pk.inPlace = true; }
    try { await DB.put('kv', K.key + bucket, { inPlace: true, size: src.size, mod: src.mod, at: Date.now() }); } catch (e) {}
    refreshStatus();
  }
  async function loadPack(bucket, K) {
    K.pk = null; K.needsFolder = false; ensureLayer();
    var rec = null; try { rec = await DB.get('kv', K.key + bucket); } catch (e) {}
    if (rec && rec.blob) { try { await usePack(K, bucket, rec.blob); } catch (e) { console.warn('saved ' + K.key + ' pack unreadable', e); rec = null; } }
    var src = null; try { src = await sourceFile(bucket, K); } catch (e) {}   // no signal / no folder: keep the saved copy
    if (!src) { if (rec && rec.inPlace) { K.needsFolder = true; refreshStatus(); } return; }
    if (src.handle && src.size > BIG) {
      try { await readInPlace(K, bucket, src); } catch (e) { console.warn(K.key + ' pack not readable in place', e); }
      return;
    }
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
    if (!K.pk || !K.pk.inPlace || Date.now() - _reopenAt < 30000) return;
    _reopenAt = Date.now(); if (_bucket) loadPack(_bucket, K);
  }
  function loadCounty(bucket) {
    _bucket = bucket; refreshStatus();
    loadPack(bucket, P.streets);   // the small one first: the whole county's map
    loadPack(bucket, P.imagery);
  }
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
    var where = function (K) { return K.pk && K.pk.inPlace ? ' · read from the Dropbox folder' : ''; };
    var s = S.saving ? 'Streets map: saving for no signal…' : S.pk ? 'Streets map saved for no signal ✓ (whole county' + where(S) + ')' : 'no streets map file';
    var i = I.saving ? 'Imagery: saving for no signal…' : I.pk ? 'Imagery saved for no signal ✓ (capture ' + esc(captureText(I.pk.meta || {})) + where(I) + ')' : 'no imagery file';
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
        imagery: { open: !!I.pk, inPlace: !!(I.pk && I.pk.inPlace), needsFolder: !!I.needsFolder, minZ: I.pk ? I.pk.minZ : null },
        streets: { open: !!S.pk, inPlace: !!(S.pk && S.pk.inPlace), needsFolder: !!S.needsFolder, saving: !!S.saving },
        speed: window.SpeedLim ? { loaded: window.SpeedLim.loaded(), segs: window.SpeedLim.count() } : null };
      var sig = JSON.stringify(o); if (sig === _repSig && Date.now() - _repAt < 300000) return;
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
    _readInPlace: function (kind, file) { var K = P[kind]; return readInPlace(K, _bucket, { file: file, size: file.size, mod: String(file.lastModified), handle: null }); }
  };
})();
