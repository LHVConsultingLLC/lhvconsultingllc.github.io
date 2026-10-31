/* desk/roadlabels.js — STREETS ON IMAGERY (Dustin 2026-10-11: "i need both").
 *
 * In Imagery mode the laptop draws the county's roads and street names over the photos,
 * straight from the county ROAD FILE (<BUCKET>.roads.json, OpenStreetMap, the same file
 * Route here uses). Nothing is downloaded: it works with no signal, exactly like routing.
 * Drawn per map tile on a canvas, so it stays fast with tens of thousands of road pieces.
 *   lines: every road (major roads only when zoomed far out)
 *   names: from zoom 15 in, one label per street per tile, along the road
 *   ONE-WAY arrows (Dustin 2026-10-17: "have one ways listed"): from zoom 15 in, arrows
 *   along every one-way street pointing the legal direction (OSM oneway / roundabouts /
 *   motorways — the same flag Route already obeys). Imagery mode draws them on the road
 *   lines; Streets mode gets an arrows-only layer over the saved street map.
 * © OpenStreetMap contributors (ODbL) — credited in the map's attribution.
 */
(function () {
  'use strict';
  var layer = null, layerGraph = null, arrows = null, arrowsGraph = null;
  var MAJOR = { motorway: 1, trunk: 1, primary: 1, secondary: 1, motorway_link: 1, trunk_link: 1, primary_link: 1 };
  var WIDTH = { motorway: 4, trunk: 3.6, primary: 3.2, secondary: 2.8, tertiary: 2.4 };

  // the county's road graph: Route's own if it is already built, else built here once per county
  var own = null, ownBucket = null, loadingFor = null;
  function bucketNow() { var j = window.DeskAPI && window.DeskAPI.job(); return j ? j.bucket : null; }
  function graph() {
    var b = bucketNow(); if (!b) return null;
    var M = window.DeskRoute && window.DeskRoute._state;
    if (M && M.graph && M.graphBucket === b) return M.graph;
    if (own && ownBucket === b) return own;
    if (loadingFor !== b && window.LHVRoute && window.DeskAPI && (window._base === 'img' || window._base === 'topo')) {
      loadingFor = b;
      Promise.resolve(window.DeskAPI.roads()).then(function (j) {
        if (j && j.kind === 'lhv-roads' && (!j.bucket || j.bucket === b)) { own = new window.LHVRoute.Graph(j, {}); ownBucket = b; sync(); }
        else retryLater(b);
      }).catch(function () { retryLater(b); });
    }
    return null;
  }

  // desk-p52: no road file yet (it is still being saved to this laptop): ask again in 30 s, never give up for the day
  function retryLater(b) { setTimeout(function () { if (loadingFor === b && ownBucket !== b) loadingFor = null; }, 30000); }

  // arrows every ~110 px along a one-way piece, pointing the legal direction
  function drawArrows(ctx, G, paths, z) {
    var gap = 110, sz = z >= 17 ? 7 : 6;
    paths.forEach(function (p) {
      var ow = (G.j && G.j.E) ? (G.j.E[p.e * 8 + 5] || 0) : 0; if (!ow) return;   // read directly: route.js may be an older cached copy
      var pts = ow > 0 ? p.pts : p.pts.slice().reverse();
      var next = gap / 2, run = 0;
      for (var k = 0; k + 1 < pts.length; k++) {
        var a = pts[k], b = pts[k + 1], seg = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!seg) continue;
        while (run + seg >= next) {
          var t = (next - run) / seg, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
          ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
          ctx.beginPath(); ctx.moveTo(sz, 0); ctx.lineTo(-sz, -sz * 0.75); ctx.lineTo(-sz * 0.45, 0); ctx.lineTo(-sz, sz * 0.75); ctx.closePath();
          ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.stroke(); ctx.fillStyle = '#ffd400'; ctx.fill();
          ctx.restore();
          next += gap;
        }
        run += seg;
      }
    });
  }

  // STREET NAMES (desk-p52; Dustin 10/28: "why arent street names on the map" / "if drivers are operating on non imagery
  // for some reason, then they need street names as well"). The USGS street map has NO street names at any zoom (checked
  // 10/28: Canton z15/z16 tiles carry only town names and route shields), so both bases get them from the county road
  // file, offline: Imagery = white text, dark halo; Streets = dark text, white halo. From z14 (driving zooms). One label
  // per street per tile, on the longest nearly straight run of that street that fits inside the tile (pieces of one
  // road that keep the same heading are joined, so a block-long street gets its name, not only a long straight one).
  var NAMES_Z = 14;
  // the way the drive file writes addresses ("4136 Vernon Ave Nw"): Avenue -> Ave, Northwest -> NW, ...
  var ABBR = { avenue: 'Ave', street: 'St', road: 'Rd', drive: 'Dr', boulevard: 'Blvd', lane: 'Ln', court: 'Ct', place: 'Pl',
    circle: 'Cir', parkway: 'Pkwy', highway: 'Hwy', terrace: 'Ter', trail: 'Trl', square: 'Sq', pike: 'Pike', way: 'Way' };
  var DIRS = { north: 'N', south: 'S', east: 'E', west: 'W', northwest: 'NW', northeast: 'NE', southwest: 'SW', southeast: 'SE' };
  var _short = {};
  function shortName(nm) {
    if (!nm) return ''; if (_short[nm] != null) return _short[nm];
    var w = String(nm).split(/\s+/), n = w.length;
    var out = w.map(function (x, i) { var k = x.toLowerCase();
      if (DIRS[k] && (i === 0 || i === n - 1) && n > 2) return DIRS[k];
      if (ABBR[k] && i > 0 && (i === n - 1 || (i === n - 2 && DIRS[w[n - 1].toLowerCase()]))) return ABBR[k];
      return x; }).join(' ');
    return (_short[nm] = out);
  }
  function drawNames(ctx, G, paths, z, sz, onImagery) {
    var fs = z >= 17 ? 13.5 : z >= 15 ? 12.5 : 11.5;
    ctx.font = '700 ' + fs + 'px Inter,-apple-system,"Segoe UI",system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // the road file is split at every crossing, so a street is many short pieces: join each name's pieces end to end
    // (same point, same heading within ~20 degrees) into straight runs, then label the runs
    var byName = {};
    paths.forEach(function (p) {
      var nm = shortName(G.edgeName(p.e)); if (!nm || p.pts.length < 2) return;
      if (z < 15 && !MAJOR[p.cls] && p.cls !== 'tertiary' && p.cls !== 'residential' && p.cls !== 'unclassified') return;
      var L = byName[nm] || (byName[nm] = []);
      for (var k = 0; k + 1 < p.pts.length; k++) { var a = p.pts[k], b = p.pts[k + 1]; if (a[0] !== b[0] || a[1] !== b[1]) L.push([a, b]); }
    });
    var key = function (q) { return Math.round(q[0]) + ',' + Math.round(q[1]); };
    var hd = function (a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]); };
    var near = function (x, y) { var d = Math.abs(x - y); if (d > Math.PI) d = 2 * Math.PI - d; return d <= 0.35; };
    var cand = [];
    Object.keys(byName).forEach(function (nm) {
      var segs = byName[nm], adj = {}, used = [], tw = ctx.measureText(nm).width;
      segs.forEach(function (sg, i) { [key(sg[0]), key(sg[1])].forEach(function (k) { (adj[k] = adj[k] || []).push(i); }); });
      var grow = function (pts, atEnd) {   // keep adding the piece that carries on straight from this end
        for (var guard = 0; guard < 400; guard++) {
          var tip = atEnd ? pts[pts.length - 1] : pts[0], prev = atEnd ? pts[pts.length - 2] : pts[1], h = hd(prev, tip), nx = null;
          (adj[key(tip)] || []).some(function (j) { if (used[j]) return false; var sg = segs[j], o = key(sg[0]) === key(tip) ? sg[1] : sg[0];
            if (!near(hd(tip, o), h)) return false; used[j] = 1; nx = o; return true; });
          if (!nx) return; if (atEnd) pts.push(nx); else pts.unshift(nx);
        }
      };
      for (var i = 0; i < segs.length; i++) {
        if (used[i]) continue; used[i] = 1;
        var pts = [segs[i][0], segs[i][1]]; grow(pts, true); grow(pts, false);
        var A = pts[0], B = pts[pts.length - 1], ang = hd(A, B);
        if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
        var hx = Math.abs(Math.cos(ang)) * tw / 2 + 6, hy = Math.abs(Math.sin(ang)) * tw / 2 + 7;
        // the part of this straight run that lies inside the tile (inset so the whole label fits): Liang-Barsky
        var x0 = A[0], y0 = A[1], dx = B[0] - x0, dy = B[1] - y0, t0 = 0, t1 = 1, ok = true;
        [[-dx, x0 - hx], [dx, sz.x - hx - x0], [-dy, y0 - hy], [dy, sz.y - hy - y0]].forEach(function (c) {
          if (!ok) return; var pp = c[0], qq = c[1];
          if (pp === 0) { if (qq < 0) ok = false; return; }
          var r = qq / pp; if (pp < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else { if (r < t0) ok = false; else if (r < t1) t1 = r; } });
        if (!ok) continue;
        // t0..t1 = where the label's centre may sit (the whole label inside the tile); it sits nearest the run's middle
        // and needs half its width of road on either side
        var full = Math.hypot(dx, dy), tm = Math.max(t0, Math.min(t1, 0.5)), half = tw / 2 + 3;
        if (tm * full < half || (1 - tm) * full < half) continue;
        cand.push({ nm: nm, len: full, ang: ang, mx: x0 + dx * tm, my: y0 + dy * tm, hx: hx, hy: hy });
      }
    });
    // longest runs first; one label per street per tile; never on top of another label
    cand.sort(function (a, b) { return b.len - a.len; });
    var done = {}, boxes = [];
    ctx.lineJoin = 'round';
    cand.forEach(function (c) {
      if (done[c.nm]) return;
      if (boxes.some(function (q) { return Math.abs(q.mx - c.mx) < q.hx + c.hx - 4 && Math.abs(q.my - c.my) < q.hy + c.hy - 4; })) return;
      done[c.nm] = 1; boxes.push(c);
      ctx.save(); ctx.translate(c.mx, c.my); ctx.rotate(c.ang);
      ctx.lineWidth = onImagery ? 3.5 : 3.2; ctx.strokeStyle = onImagery ? 'rgba(0,0,0,.88)' : 'rgba(255,255,255,.95)'; ctx.strokeText(c.nm, 0, 0);
      ctx.fillStyle = onImagery ? '#fff' : '#1b2233'; ctx.fillText(c.nm, 0, 0); ctx.restore();
    });
  }

  function makeLayer(G, arrowsOnly) {
    var L = window.L;
    var RL = L.GridLayer.extend({
      // desk-p52: each tile is drawn in its own task after Leaflet asks for it, never inside a zoom or pan frame
      createTile: function (c, done) {
        var cv = document.createElement('canvas'), sz = this.getTileSize(), self = this; cv.width = sz.x; cv.height = sz.y;
        setTimeout(function () { var e = null; try { self._draw(cv, c, sz); } catch (x) { e = x; } done(null, cv); }, 0);
        return cv;
      },
      _draw: function (cv, c, sz) {
        var ctx = cv.getContext('2d'), map = this._map, z = c.z, ox = c.x * sz.x, oy = c.y * sz.y;
        if (!map) return cv;
        var nw = map.unproject([ox, oy], z), se = map.unproject([ox + sz.x, oy + sz.y], z);
        var cell = G.cell, x0 = Math.floor(nw.lng / cell) - 1, x1 = Math.floor(se.lng / cell) + 1,
            y0 = Math.floor(se.lat / cell) - 1, y1 = Math.floor(nw.lat / cell) + 1;
        if ((x1 - x0) * (y1 - y0) > 4000) return cv;          // far out: nothing useful to draw
        var seen = {}, edges = [];
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
          var arr = G.grid.get(x * 100000 + y); if (!arr) continue;
          for (var i = 0; i < arr.length; i += 2) { var e = arr[i]; if (!seen[e]) { seen[e] = 1; edges.push(e); } }
        }
        var pt = function (lat, lng) { var p = map.project([lat, lng], z); return [p.x - ox, p.y - oy]; };
        var paths = [];
        edges.forEach(function (e) {
          var cls = G.edgeClass(e) || ''; if (z < 14 && !MAJOR[cls]) return;
          var g = G.geo[e], pts = []; for (var k = 0; k < g.length; k += 2) pts.push(pt(g[k], g[k + 1]));
          paths.push({ e: e, cls: cls, pts: pts });
        });
        if (!arrowsOnly) {
          var w = function (cls) { return (WIDTH[cls] || 2) * (z >= 17 ? 1.3 : 1); };
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          paths.forEach(function (p) { ctx.beginPath(); p.pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
            ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = w(p.cls) + 2; ctx.stroke(); });
          paths.forEach(function (p) { ctx.beginPath(); p.pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
            ctx.strokeStyle = MAJOR[p.cls] ? 'rgba(255,214,120,.92)' : 'rgba(255,255,255,.85)'; ctx.lineWidth = w(p.cls); ctx.stroke(); });
        }
        if (z >= NAMES_Z) drawNames(ctx, G, paths, z, sz, !arrowsOnly);
        if (z >= 15) drawArrows(ctx, G, paths, z);
        return cv;
      }
    });
    return new RL({ zIndex: arrowsOnly ? 9 : 8, maxZoom: 20, attribution: arrowsOnly ? 'Street names, one-way streets © OpenStreetMap contributors' : 'Roads © OpenStreetMap contributors' });
  }

  function sync() {
    var map = window.map, G = graph(); if (!map || !window.L) return;
    var want = !!G && window._base === 'img';
    if (layer && layerGraph !== G) { if (map.hasLayer(layer)) map.removeLayer(layer); layer = null; }
    if (want && !layer) { layer = makeLayer(G); layerGraph = G; }
    if (layer && want !== map.hasLayer(layer)) want ? layer.addTo(map) : map.removeLayer(layer);
    // Streets mode: one-way arrows only, over the saved street map
    var wantA = !!G && window._base === 'topo';
    if (arrows && arrowsGraph !== G) { if (map.hasLayer(arrows)) map.removeLayer(arrows); arrows = null; }
    if (wantA && !arrows) { arrows = makeLayer(G, true); arrowsGraph = G; }
    if (arrows && wantA !== map.hasLayer(arrows)) wantA ? arrows.addTo(map) : map.removeLayer(arrows);
  }
  var _orig = window.setBase;
  if (typeof _orig === 'function') window.setBase = function () { var r = _orig.apply(this, arguments); try { sync(); } catch (e) {} return r; };
  setInterval(function () { try { sync(); } catch (e) {} }, 2000);   // picks up the road file when the county loads
})();
