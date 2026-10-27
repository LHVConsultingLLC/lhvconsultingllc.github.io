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
      }).catch(function () {});
    }
    return null;
  }

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

  function makeLayer(G, arrowsOnly) {
    var L = window.L;
    var RL = L.GridLayer.extend({
      createTile: function (c) {
        var cv = document.createElement('canvas'), sz = this.getTileSize(); cv.width = sz.x; cv.height = sz.y;
        var ctx = cv.getContext('2d'), map = this._map, z = c.z, ox = c.x * sz.x, oy = c.y * sz.y;
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
        if (arrowsOnly) { if (z >= 15) drawArrows(ctx, G, paths, z); return cv; }
        var w = function (cls) { return (WIDTH[cls] || 2) * (z >= 17 ? 1.3 : 1); };
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        paths.forEach(function (p) { ctx.beginPath(); p.pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
          ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = w(p.cls) + 2; ctx.stroke(); });
        paths.forEach(function (p) { ctx.beginPath(); p.pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
          ctx.strokeStyle = MAJOR[p.cls] ? 'rgba(255,214,120,.92)' : 'rgba(255,255,255,.85)'; ctx.lineWidth = w(p.cls); ctx.stroke(); });
        if (z >= 15) {   // names: the longest piece of each street whose whole label fits inside this tile
          ctx.font = '700 ' + (z >= 17 ? 13 : 11.5) + 'px -apple-system,Segoe UI,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          var best = {}, tw = {};
          paths.forEach(function (p) { var nm = G.edgeName(p.e); if (!nm) return;
            if (tw[nm] == null) tw[nm] = ctx.measureText(nm).width;
            for (var k = 0; k + 1 < p.pts.length; k++) { var a = p.pts[k], b = p.pts[k + 1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              var len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < Math.min(tw[nm] * 0.6, 60)) continue;
              var ang = Math.atan2(b[1] - a[1], b[0] - a[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
              var hx = Math.abs(Math.cos(ang)) * tw[nm] / 2 + 8, hy = Math.abs(Math.sin(ang)) * tw[nm] / 2 + 8;
              if (mx - hx < 0 || my - hy < 0 || mx + hx > sz.x || my + hy > sz.y) continue;   // would be cut at the tile edge
              if (!best[nm] || len > best[nm].len) best[nm] = { len: len, ang: ang, mx: mx, my: my }; } });
          Object.keys(best).forEach(function (nm) { var s = best[nm];
            ctx.save(); ctx.translate(s.mx, s.my); ctx.rotate(s.ang);
            ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(nm, 0, 0); ctx.fillStyle = '#fff'; ctx.fillText(nm, 0, 0); ctx.restore(); });
          drawArrows(ctx, G, paths, z);
        }
        return cv;
      }
    });
    return new RL({ zIndex: arrowsOnly ? 9 : 8, maxZoom: 20, attribution: arrowsOnly ? 'One-way streets © OpenStreetMap contributors' : 'Roads © OpenStreetMap contributors' });
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
