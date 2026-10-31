/* ════════════════════════════════════════════════════════════════════════════
 * desk/route.js — OFFLINE ROUTING for the laptop field log (prototype, 2026-10-11)
 *
 * Nothing in this file touches the network. Everything it needs is handed to it:
 *   • a county ROAD FILE  (<BUCKET>.roads.json, built ahead of time from OpenStreetMap,
 *     ODbL: "© OpenStreetMap contributors") — sits beside the drive file in Dropbox
 *   • the drive file rows (seq, street, city, lat, lng)
 *   • position fixes (the USB puck's NMEA sentences, or the phone/browser location)
 *
 * ROUTING IS ONLY EVER STARTED BY THE DRIVER (Dustin 2026-10-11: "I don't want auto
 * routing"). Every parcel card has a "Route here" button (key R). It routes to THAT
 * parcel only. The route ends when that parcel is shot, when Route here is pressed on
 * another parcel, or when the driver presses Stop (Esc). It never chains to the next
 * stop. There is no AUTO mode, no auto distance and no route-to-NEXT: "Next to drive"
 * is a display suggestion and never starts a route.
 *
 * What it does:
 *   Graph       snap a position to the nearest road, route A→B (A*, travel time),
 *               turn-by-turn steps ("Turn left onto Hanover Ridge Rd")
 *   Nav         the driver-facing brain: turn-by-turn to the ONE parcel the driver
 *               chose, off-route detection + reroute ("Turn around when safe").
 *               next() is the NEXT-to-drive suggestion for display only.
 *   Nmea        the puck parser (same checks as desk.html §10) + a sentence writer for
 *               the simulator
 *   Production  drive time along a list order + measured at-parcel time → hours,
 *               parcels per active hour, ahead/behind
 *   DeskRoute   (browser only, bottom of this file) plugs the above into desk.html
 *               through DeskAPI (desk.html §13): the Route here button, the route
 *               banner, the route line on the map.
 *
 * Works in the browser (window.LHVRoute, window.DeskRoute) and in Node (require) so the
 * same code builds the road file nightly and routes on the laptop.
 * ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LHVRoute = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── geometry ──────────────────────────────────────────────────────────────
  var R = 6371008.8, D2R = Math.PI / 180;
  function hav(a1, o1, a2, o2) {
    var dA = (a2 - a1) * D2R, dO = (o2 - o1) * D2R;
    var s = Math.sin(dA / 2) * Math.sin(dA / 2) + Math.cos(a1 * D2R) * Math.cos(a2 * D2R) * Math.sin(dO / 2) * Math.sin(dO / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a1, o1, a2, o2) {
    var y = Math.sin((o2 - o1) * D2R) * Math.cos(a2 * D2R);
    var x = Math.cos(a1 * D2R) * Math.sin(a2 * D2R) - Math.sin(a1 * D2R) * Math.cos(a2 * D2R) * Math.cos((o2 - o1) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var COMPASS_WORD = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  function compass(b) { return COMPASS[Math.round(b / 45) % 8]; }
  function compassWord(b) { return COMPASS_WORD[Math.round(b / 45) % 8]; }
  // local flat projection (metres) around a latitude — fine at county scale
  function proj(lat0) { var kx = Math.cos(lat0 * D2R) * 111320, ky = 110540; return { kx: kx, ky: ky }; }
  // closest point on segment p1-p2 to p (all [lat,lng]); returns {t, d, lat, lng}
  function segClosest(pLat, pLng, aLat, aLng, bLat, bLng, P) {
    var ax = 0, ay = 0, bx = (bLng - aLng) * P.kx, by = (bLat - aLat) * P.ky;
    var px = (pLng - aLng) * P.kx, py = (pLat - aLat) * P.ky;
    var L2 = bx * bx + by * by, t = L2 ? ((px - ax) * bx + (py - ay) * by) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var cx = bx * t, cy = by * t, dx = px - cx, dy = py - cy;
    return { t: t, d: Math.sqrt(dx * dx + dy * dy), lat: aLat + (bLat - aLat) * t, lng: aLng + (bLng - aLng) * t, side: bx * py - by * px };
  }
  function fmtDist(m, unit) {
    if (m == null || !isFinite(m)) return '—';
    var mi = m / 1609.344;
    if (mi >= 10) return mi.toFixed(0) + ' mi';
    if (mi >= 0.19) return mi.toFixed(1) + ' mi';
    return Math.round(m * 3.28084 / 10) * 10 + ' ft';
  }
  function fmtTime(s) {
    if (s == null || !isFinite(s)) return '—';
    if (s < 60) return '<1 min';
    var m = Math.round(s / 60); if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // ════════════════════════════════════════════════════════════════════════
  // ROAD FILE — built ahead of time (nightly / at drive-file time), never on the road
  // ════════════════════════════════════════════════════════════════════════
  // Input: one or more Overpass JSON responses (`way[highway…](bbox); out geom;`),
  // which carry each way's node ids (topology) and geometry. Output: a compact JSON:
  //   V: [lat*1e5, lng*1e5, …]            junction / end vertices
  //   E: [a, b, len_dm, cls, name, oneway, maxspeed_mph, g0, g1, …] (8 per edge)
  //   G: [dlat, dlng, …]                  intermediate points, delta-coded from a
  // Classes are OSM highway=*; speeds are NOT stored — they are a routing setting.
  var CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'];
  function parseMaxspeed(v) {
    if (!v) return 0; var m = String(v).match(/(\d+)\s*(mph)?/i); if (!m) return 0;
    var n = parseInt(m[1], 10); return m[2] ? n : Math.round(n / 1.609344);   // OSM default unit is km/h
  }
  function buildGraph(responses, meta) {
    var ways = {}, useCount = {}, ncoord = {};
    responses.forEach(function (r) {
      (r.elements || []).forEach(function (w) {
        if (w.type !== 'way' || !w.nodes || !w.geometry || ways[w.id]) return;
        if (CLASSES.indexOf((w.tags || {}).highway) < 0) return;
        ways[w.id] = w;
      });
    });
    Object.keys(ways).forEach(function (id) {
      var w = ways[id];
      w.nodes.forEach(function (n, i) {
        var g = w.geometry[i]; if (!g) return;
        ncoord[n] = g; useCount[n] = (useCount[n] || 0) + ((i === 0 || i === w.nodes.length - 1) ? 2 : 1);
      });
    });
    var vid = {}, V = [], E = [], G = [], names = [''], nameIx = { '': 0 };
    function vertex(n) {
      if (vid[n] !== undefined) return vid[n];
      var g = ncoord[n]; vid[n] = V.length / 2; V.push(Math.round(g.lat * 1e5), Math.round(g.lon * 1e5)); return vid[n];
    }
    Object.keys(ways).forEach(function (id) {
      var w = ways[id], t = w.tags || {}, cls = CLASSES.indexOf(t.highway);
      var nm = t.name || t.ref || '';
      if (nameIx[nm] === undefined) { nameIx[nm] = names.length; names.push(nm); }
      var ow = 0;
      if (t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' || t.highway === 'motorway') ow = 1;
      if (t.oneway === '-1' || t.oneway === 'reverse') ow = -1;
      if (t.oneway === 'no') ow = 0;
      var ms = parseMaxspeed(t.maxspeed);
      var start = 0;
      for (var i = 1; i < w.nodes.length; i++) {
        if (i < w.nodes.length - 1 && useCount[w.nodes[i]] < 2) continue;
        var a = vertex(w.nodes[start]), b = vertex(w.nodes[i]);
        var len = 0, g0 = G.length;
        var pl = Math.round(w.geometry[start].lat * 1e5), po = Math.round(w.geometry[start].lon * 1e5);
        for (var k = start + 1; k <= i; k++) {
          len += hav(w.geometry[k - 1].lat, w.geometry[k - 1].lon, w.geometry[k].lat, w.geometry[k].lon);
          if (k < i) { var la = Math.round(w.geometry[k].lat * 1e5), lo = Math.round(w.geometry[k].lon * 1e5); G.push(la - pl, lo - po); pl = la; po = lo; }
        }
        E.push(a, b, Math.round(len * 10), cls, nameIx[nm], ow, ms, g0);
        start = i;
      }
    });
    return { v: 1, kind: 'lhv-roads', built: (meta && meta.built) || new Date().toISOString(), bucket: (meta && meta.bucket) || '',
      source: (meta && meta.source) || 'OpenStreetMap via Overpass API', attribution: '© OpenStreetMap contributors (ODbL)',
      classes: CLASSES, names: names, V: V, E: E, G: G, GN: G.length };
  }

  // ════════════════════════════════════════════════════════════════════════
  // GRAPH — load a road file, snap, route, turn-by-turn
  // ════════════════════════════════════════════════════════════════════════
  // Starting speeds by road class (mph). These are a SETTING, not a measurement: the
  // routing code needs some number per class, and Production.calibrate() then scales
  // them by a factor measured from real lock-to-lock hops (see the report).
  var START_MPH = { motorway: 65, trunk: 55, primary: 55, secondary: 50, tertiary: 45, unclassified: 35, residential: 35,
    living_street: 15, service: 15, motorway_link: 40, trunk_link: 35, primary_link: 30, secondary_link: 30, tertiary_link: 30 };

  // CALIBRATION — measured, see the report (LHV_Routing_Audit_and_Plan.pdf §6).
  // factor: road-time multiplier fitted on Richie's Harrison 10/10 hops; perHopS: fixed
  // seconds per hop from the same fit; atParcelS: median first-to-last shutter time at a
  // parcel. Used by desk.html's Route here (factor only) and by route-test.html.
  var CALIB = { factor: 1.184, perHopS: 76, atParcelS: 3,
    basis: 'Richie, Harrison 10/10 + 10/11, 110 photo-clock hops: road time × 1.184 + 76 s per hop; 3 s median first-to-last shutter at a parcel. Day totals came within 9–14% of the photo clock; up to 29% off on a day the fit did not see.' };

  function Graph(j, opts) {
    opts = opts || {};
    this.j = j; this.names = j.names; this.classes = j.classes;
    var nV = j.V.length / 2, nE = j.E.length / 8; this.nV = nV; this.nE = nE;
    this.lat = new Float64Array(nV); this.lng = new Float64Array(nV);
    for (var i = 0; i < nV; i++) { this.lat[i] = j.V[2 * i] / 1e5; this.lng[i] = j.V[2 * i + 1] / 1e5; }
    // edge geometry, decoded once: geo[e] = Float64Array [lat,lng,…] including both ends
    this.geo = new Array(nE); this.len = new Float64Array(nE);
    for (var e = 0; e < nE; e++) {
      var o = e * 8, a = j.E[o], b = j.E[o + 1], g0 = j.E[o + 7], g1 = (e + 1 < nE) ? j.E[o + 15] : j.G.length;
      var pts = [this.lat[a], this.lng[a]], pl = j.V[2 * a], po = j.V[2 * a + 1];
      for (var k = g0; k < g1; k += 2) { pl += j.G[k]; po += j.G[k + 1]; pts.push(pl / 1e5, po / 1e5); }
      pts.push(this.lat[b], this.lng[b]);
      this.geo[e] = pts; this.len[e] = j.E[o + 2] / 10;
    }
    this.setSpeeds(opts.mph || START_MPH, opts.factor || 1);
    // adjacency (CSR): out[v] → list of (edge, dir) where dir 1 = a→b, -1 = b→a
    var deg = new Int32Array(nV + 1);
    for (e = 0; e < nE; e++) { var ow = j.E[e * 8 + 5]; if (ow >= 0) deg[j.E[e * 8]]++; if (ow <= 0) deg[j.E[e * 8 + 1]]++; }
    this.off = new Int32Array(nV + 1); for (i = 0; i < nV; i++) this.off[i + 1] = this.off[i] + deg[i];
    var fill = this.off.slice(0, nV); this.adjE = new Int32Array(this.off[nV]); this.adjD = new Int8Array(this.off[nV]);
    for (e = 0; e < nE; e++) {
      var oo = e * 8, ow2 = j.E[oo + 5];
      if (ow2 >= 0) { this.adjE[fill[j.E[oo]]] = e; this.adjD[fill[j.E[oo]]++] = 1; }
      if (ow2 <= 0) { this.adjE[fill[j.E[oo + 1]]] = e; this.adjD[fill[j.E[oo + 1]]++] = -1; }
    }
    // undirected degree, for "is this a real junction" in turn instructions
    this.deg = new Int32Array(nV); for (e = 0; e < nE; e++) { this.deg[j.E[e * 8]]++; this.deg[j.E[e * 8 + 1]]++; }
    // spatial grid of segments for snapping (cell ≈ 0.004°)
    this.cell = 0.004; this.grid = new Map();
    for (e = 0; e < nE; e++) {
      var p = this.geo[e];
      for (k = 0; k + 3 < p.length; k += 2) {
        var x0 = Math.floor(Math.min(p[k + 1], p[k + 3]) / this.cell), x1 = Math.floor(Math.max(p[k + 1], p[k + 3]) / this.cell);
        var y0 = Math.floor(Math.min(p[k], p[k + 2]) / this.cell), y1 = Math.floor(Math.max(p[k], p[k + 2]) / this.cell);
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
          var key = x * 100000 + y, arr = this.grid.get(key); if (!arr) this.grid.set(key, arr = []);
          arr.push(e, k >> 1);
        }
      }
    }
    // connected pieces of the road network; the biggest one is "the county". A parcel
    // that snaps to a stray piece (a driveway or lane OSM never joined up) is retried
    // against the main network so it still gets a route.
    var par = new Int32Array(nV); for (i = 0; i < nV; i++) par[i] = i;
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    for (e = 0; e < nE; e++) { var ra = find(j.E[e * 8]), rb = find(j.E[e * 8 + 1]); if (ra !== rb) par[ra] = rb; }
    var csize = {}, big = -1, bigN = 0; this.comp = new Int32Array(nV);
    for (i = 0; i < nV; i++) { var rt = find(i); this.comp[i] = rt; csize[rt] = (csize[rt] || 0) + 1; if (csize[rt] > bigN) { bigN = csize[rt]; big = rt; } }
    this.mainComp = big;
    var lat0 = nV ? this.lat[0] : 40; this.P = proj(lat0);
    this.maxMps = 0; for (var c in this.mps) if (this.mps[c] > this.maxMps) this.maxMps = this.mps[c];
  }
  Graph.prototype.setSpeeds = function (mph, factor) {
    this.mph = mph; this.factor = factor || 1; this.mps = {};
    for (var c in mph) this.mps[c] = mph[c] * 0.44704;
    this.cost = new Float64Array(this.nE);   // seconds per edge
    for (var e = 0; e < this.nE; e++) {
      var o = e * 8, cls = this.classes[this.j.E[o + 3]], ms = this.j.E[o + 6];
      var v = (ms ? Math.min(ms, mph[cls] || ms) : (mph[cls] || 25)) * 0.44704;
      this.cost[e] = this.len[e] / v * this.factor;
    }
    this.maxMps = 0; for (var c2 in this.mps) if (this.mps[c2] > this.maxMps) this.maxMps = this.mps[c2];
  };
  Graph.prototype.edgeName = function (e) { return this.names[this.j.E[e * 8 + 4]] || ''; };
  Graph.prototype.edgeClass = function (e) { return this.classes[this.j.E[e * 8 + 3]]; };
  // one-way: 1 = legal only a→b (the order of geo[e]), -1 = only b→a, 0 = both ways
  Graph.prototype.edgeOneway = function (e) { return this.j.E[e * 8 + 5] || 0; };
  // snap: nearest point on any road within maxM metres
  Graph.prototype.snap = function (lat, lng, maxM, mainOnly) {
    maxM = maxM || 1500;
    var cx = Math.floor(lng / this.cell), cy = Math.floor(lat / this.cell), best = null, seen = new Set();
    var rings = Math.ceil(maxM / (this.cell * 85000)) + 1;
    for (var r = 0; r <= rings; r++) {
      for (var x = cx - r; x <= cx + r; x++) for (var y = cy - r; y <= cy + r; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        var arr = this.grid.get(x * 100000 + y); if (!arr) continue;
        for (var i = 0; i < arr.length; i += 2) {
          var e = arr[i], s = arr[i + 1], key = e * 4096 + s; if (seen.has(key)) continue; seen.add(key);
          if (mainOnly && this.comp[this.j.E[e * 8]] !== this.mainComp) continue;
          var p = this.geo[e], c = segClosest(lat, lng, p[2 * s], p[2 * s + 1], p[2 * s + 2], p[2 * s + 3], this.P);
          if (!best || c.d < best.d) best = { e: e, s: s, t: c.t, d: c.d, lat: c.lat, lng: c.lng, side: c.side };
        }
      }
      if (best && best.d < (r) * this.cell * 85000) break;   // nothing in a farther ring can beat it
    }
    if (!best || best.d > maxM) return null;
    // distance from the edge's start vertex to the snapped point
    var p2 = this.geo[best.e], along = 0;
    for (var k = 0; k < best.s; k++) along += hav(p2[2 * k], p2[2 * k + 1], p2[2 * k + 2], p2[2 * k + 3]);
    along += best.t * hav(p2[2 * best.s], p2[2 * best.s + 1], p2[2 * best.s + 2], p2[2 * best.s + 3]);
    best.along = Math.min(along, this.len[best.e]);
    return best;
  };
  // binary heap keyed on f
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length; k.push(key); v.push(val);
    while (i > 0) { var p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) { var i = 0; while (true) { var l = 2 * i + 1, r = l + 1, m = i, mk = lk;
      if (l < n && k[l] < mk) { m = l; mk = k[l]; } if (r < n && k[r] < mk) { m = r; mk = k[r]; }
      if (m === i) break; k[i] = k[m]; v[i] = v[m]; i = m; } k[i] = lk; v[i] = lv; }
    return top;
  };
  Graph.prototype.size = function () { return this.k ? this.k.length : 0; };
  // route between two positions. Returns null when either end is off the road file.
  Graph.prototype.route = function (fLat, fLng, tLat, tLng, opt) {
    opt = opt || {};
    var r = this._route(fLat, fLng, tLat, tLng, opt);
    if (r || opt._retry) return r;
    // retry with both ends on the main road network
    return this._route(fLat, fLng, tLat, tLng, { maxSnapM: opt.maxSnapM, _retry: true,
      fromSnap: this.snap(fLat, fLng, opt.maxSnapM, true), toSnap: this.snap(tLat, tLng, opt.maxSnapM, true) });
  };
  Graph.prototype._route = function (fLat, fLng, tLat, tLng, opt) {
    var A = opt.fromSnap || this.snap(fLat, fLng, opt.maxSnapM), B = opt.toSnap || this.snap(tLat, tLng, opt.maxSnapM);
    if (!A || !B) return null;
    var j = this.j, self = this;
    function ow(e) { return j.E[e * 8 + 5]; }
    // the start point sits on edge A.e: it can leave toward b (cost (len-along)) or toward a (cost along)
    var nV = this.nV, dist = new Float64Array(nV).fill(Infinity), prevE = new Int32Array(nV).fill(-1), prevD = new Int8Array(nV), prevV = new Int32Array(nV).fill(-1);
    var heap = new Heap(), hs = 1 / this.maxMps;
    function h(v) { return hav(self.lat[v], self.lng[v], tLat, tLng) * hs; }
    var eA = A.e, cA = this.cost[eA], lA = this.len[eA] || 1, aA = j.E[eA * 8], bA = j.E[eA * 8 + 1];
    var START = -2;
    if (ow(eA) >= 0) { var c1 = cA * (1 - A.along / lA); if (c1 < dist[bA]) { dist[bA] = c1; prevE[bA] = eA; prevD[bA] = 1; prevV[bA] = START; heap.push(c1 + h(bA), bA); } }
    if (ow(eA) <= 0) { var c2 = cA * (A.along / lA); if (c2 < dist[aA]) { dist[aA] = c2; prevE[aA] = eA; prevD[aA] = -1; prevV[aA] = START; heap.push(c2 + h(aA), aA); } }
    // finishing: reach B.e's a (then forward along) or b (then backward)
    var eB = B.e, cB = this.cost[eB], lB = this.len[eB] || 1, aB = j.E[eB * 8], bB = j.E[eB * 8 + 1];
    var best = Infinity, bestEnd = null;
    // same edge, direct
    if (eA === eB) {
      var fw = B.along >= A.along;
      if ((fw && ow(eA) >= 0) || (!fw && ow(eA) <= 0)) { best = cA * Math.abs(B.along - A.along) / lA; bestEnd = 'direct'; }
    }
    var settled = new Uint8Array(nV);
    while (heap.k.length) {
      var top = heap.k[0], u = heap.pop();
      if (settled[u]) continue; settled[u] = 1;
      if (top >= best) break;
      if (u === aB && ow(eB) >= 0) { var cc = dist[u] + cB * (B.along / lB); if (cc < best) { best = cc; bestEnd = 'a'; } }
      if (u === bB && ow(eB) <= 0) { var cd = dist[u] + cB * (1 - B.along / lB); if (cd < best) { best = cd; bestEnd = 'b'; } }
      for (var i = this.off[u]; i < this.off[u + 1]; i++) {
        var e = this.adjE[i], d = this.adjD[i], w = d === 1 ? j.E[e * 8 + 1] : j.E[e * 8];
        var nd = dist[u] + this.cost[e];
        if (nd < dist[w]) { dist[w] = nd; prevE[w] = e; prevD[w] = d; prevV[w] = u; heap.push(nd + h(w), w); }
      }
    }
    if (bestEnd === null) return null;
    // rebuild: list of [edge, dir, fromFrac, toFrac]
    var legs = [];
    if (bestEnd === 'direct') legs.push([eA, B.along >= A.along ? 1 : -1, A.along / lA, B.along / lB]);
    else {
      var endV = bestEnd === 'a' ? aB : bB;
      legs.push([eB, bestEnd === 'a' ? 1 : -1, bestEnd === 'a' ? 0 : 1, B.along / lB]);
      var v = endV;
      while (v >= 0) {
        var pe = prevE[v], pd = prevD[v], pv = prevV[v];
        if (pv === START) { legs.push([pe, pd, A.along / lA, pd === 1 ? 1 : 0]); break; }
        legs.push([pe, pd, pd === 1 ? 0 : 1, pd === 1 ? 1 : 0]); v = pv;
      }
      legs.reverse();
    }
    return this._assemble(legs, A, B, best, tLat, tLng);
  };
  // slice an edge's geometry between fractions (by length), in travel direction
  Graph.prototype._slice = function (e, f0, f1) {
    var p = this.geo[e], L = this.len[e] || 1, out = [], segs = [], tot = 0;
    for (var k = 0; k + 3 < p.length; k += 2) { var s = hav(p[k], p[k + 1], p[k + 2], p[k + 3]); segs.push(s); tot += s; }
    var scale = tot ? L / tot : 1;
    function at(f) { var target = f * L, acc = 0; for (var i = 0; i < segs.length; i++) { var sl = segs[i] * scale; if (acc + sl >= target || i === segs.length - 1) { var t = sl ? Math.max(0, Math.min(1, (target - acc) / sl)) : 0; return { i: i, lat: p[2 * i] + (p[2 * i + 2] - p[2 * i]) * t, lng: p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * t }; } acc += sl; } return { i: 0, lat: p[0], lng: p[1] }; }
    var A = at(Math.min(f0, f1)), B = at(Math.max(f0, f1));
    out.push([A.lat, A.lng]); for (var i = A.i + 1; i <= B.i; i++) out.push([p[2 * i], p[2 * i + 1]]); out.push([B.lat, B.lng]);
    if (f1 < f0) out.reverse();
    return out;
  };
  Graph.prototype._assemble = function (legs, A, B, costS, tLat, tLng) {
    var coords = [], distM = 0, pieces = [];
    for (var i = 0; i < legs.length; i++) {
      var L = legs[i], e = L[0], pts = this._slice(e, L[2], L[3]), d = Math.abs(L[3] - L[2]) * this.len[e];
      if (d < 0.01 && legs.length > 1 && (i === 0 || i === legs.length - 1)) continue;
      pieces.push({ e: e, dir: L[1], pts: pts, d: d, name: this.edgeName(e), cls: this.edgeClass(e),
        endV: L[1] === 1 ? this.j.E[e * 8 + 1] : this.j.E[e * 8] });
      for (var k = (coords.length ? 1 : 0); k < pts.length; k++) coords.push(pts[k]);
      distM += d;
    }
    return { coords: coords, distM: distM, timeS: costS, steps: this._steps(pieces, B, tLat, tLng), from: A, to: B };
  };
  function turnWord(delta) {   // delta: -180..180, + = right
    var a = Math.abs(delta), side = delta > 0 ? 'right' : 'left';
    if (a < 25) return null; if (a < 50) return 'Slight ' + side; if (a < 135) return 'Turn ' + side;
    if (a < 170) return 'Sharp ' + side; return 'Make a U-turn';
  }
  function lastBearing(pts) { var n = pts.length; for (var i = n - 1; i > 0; i--) { if (hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) > 3) return bearing(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); } return bearing(pts[0][0], pts[0][1], pts[n - 1][0], pts[n - 1][1]); }
  function firstBearing(pts) { for (var i = 1; i < pts.length; i++) { if (hav(pts[0][0], pts[0][1], pts[i][0], pts[i][1]) > 3) return bearing(pts[0][0], pts[0][1], pts[i][0], pts[i][1]); } return 0; }
  // Steps: one per maneuver. A maneuver happens at a junction when the road name
  // changes or the path bends hard where another road meets it.
  Graph.prototype._steps = function (pieces, B, tLat, tLng) {
    var steps = [], self = this;
    if (!pieces.length) return [{ type: 'arrive', text: 'You are there', distM: 0, at: [tLat, tLng] }];
    var cur = { type: 'depart', name: pieces[0].name, text: 'Head ' + compassWord(firstBearing(pieces[0].pts)) + (pieces[0].name ? ' on ' + pieces[0].name : ''), distM: 0, at: pieces[0].pts[0], startIdx: 0 };
    var cum = 0;
    for (var i = 0; i < pieces.length; i++) {
      var pc = pieces[i];
      if (i > 0) {
        var prev = pieces[i - 1], inB = lastBearing(prev.pts), outB = firstBearing(pc.pts);
        var delta = ((outB - inB + 540) % 360) - 180, junction = self.deg[prev.endV] > 2;
        // a new road name only counts when it differs from the road the current
        // instruction is about (OSM splits one road into many pieces)
        var nameChange = !!pc.name && pc.name !== (cur.name || '');
        var tw = turnWord(delta);
        if (junction && ((nameChange && (tw || cur.name)) || (tw && Math.abs(delta) >= 50))) {
          steps.push(cur);
          var onto = pc.name ? ' onto ' + pc.name : (pc.cls === 'service' ? ' onto the service road' : ' onto the unnamed road');
          cur = { type: tw ? 'turn' : 'continue', delta: delta, name: pc.name, text: (tw || 'Continue') + onto, distM: 0, at: pc.pts[0], cumAt: cum };
        }
      }
      cur.distM += pc.d; cum += pc.d;
    }
    steps.push(cur);
    // tidy: a "Continue onto X" that is very short, or that flips back to a name we
    // were just on (one road carrying two names in OSM), folds into the step before
    var tidy = [];
    steps.forEach(function (s) {
      var p = tidy[tidy.length - 1], pp = tidy[tidy.length - 2];
      if (p && s.type === 'continue' && (s.distM < 150 || p.name === s.name || (pp && pp.name === s.name))) { p.distM += s.distM; return; }
      tidy.push(s);
    });
    steps = tidy;
    // arrival side: which side of the road the parcel sits on, relative to travel
    var lastP = pieces[pieces.length - 1].pts, n = lastP.length;
    var a = lastP[Math.max(0, n - 2)], b = lastP[n - 1];
    var P = this.P, bx = (b[1] - a[1]) * P.kx, by = (b[0] - a[0]) * P.ky, px = (tLng - a[1]) * P.kx, py = (tLat - a[0]) * P.ky;
    var cross = bx * py - by * px, offM = B ? B.d : 0;
    var side = offM < 4 ? '' : (cross > 0 ? ' on the left' : ' on the right');
    steps.push({ type: 'arrive', text: 'Arrive' + side, side: side.trim(), distM: 0, at: [b[0], b[1]], cumAt: cum });
    var c = 0; steps.forEach(function (s) { s.cumAt = c; c += s.distM; });
    return steps;
  };

  // ════════════════════════════════════════════════════════════════════════
  // NMEA — same checks as desk.html §10 (BU-353N5, $GPRMC/$GPGGA; GN* accepted)
  // ════════════════════════════════════════════════════════════════════════
  var Nmea = {
    checksumOk: function (line) {
      var m = /^\$([^*]+)\*([0-9A-Fa-f]{2})$/.exec(line); if (!m) return false;
      var c = 0; for (var i = 0; i < m[1].length; i++) c ^= m[1].charCodeAt(i); return c === parseInt(m[2], 16);
    },
    coord: function (v, h, degLen) { if (!v) return null; var d = parseInt(v.slice(0, degLen), 10), mi = parseFloat(v.slice(degLen)); var x = d + mi / 60; return (h === 'S' || h === 'W') ? -x : x; },
    // returns {lat,lng,spdMph,hdg,src} for a valid RMC, {lat,lng,fixQ,src} for GGA, else null
    parse: function (line) {
      line = String(line).trim(); if (!Nmea.checksumOk(line)) return null;
      var f = line.split('*')[0].split(','), t = f[0].slice(3);
      if (t === 'RMC') { if (f[2] !== 'A') return null; var la = Nmea.coord(f[3], f[4], 2), lo = Nmea.coord(f[5], f[6], 3); if (la == null || lo == null) return null;
        return { lat: la, lng: lo, spdMph: f[7] ? parseFloat(f[7]) * 1.15078 : null, hdg: f[8] ? parseFloat(f[8]) : null, src: 'RMC' }; }
      if (t === 'GGA') { if (!f[6] || f[6] === '0') return null; var la2 = Nmea.coord(f[2], f[3], 2), lo2 = Nmea.coord(f[4], f[5], 3); if (la2 == null || lo2 == null) return null;
        return { lat: la2, lng: lo2, fixQ: +f[6], src: 'GGA' }; }
      return null;
    },
    _ck: function (body) { var c = 0; for (var i = 0; i < body.length; i++) c ^= body.charCodeAt(i); return ('0' + c.toString(16).toUpperCase()).slice(-2); },
    _dm: function (v, degLen) { var a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return ('00' + d).slice(-degLen) + (m < 10 ? '0' : '') + m.toFixed(4); },
    rmc: function (lat, lng, mph, hdg, when) {
      var t = when || new Date(), hh = ('0' + t.getUTCHours()).slice(-2) + ('0' + t.getUTCMinutes()).slice(-2) + ('0' + t.getUTCSeconds()).slice(-2) + '.00';
      var dd = ('0' + t.getUTCDate()).slice(-2) + ('0' + (t.getUTCMonth() + 1)).slice(-2) + String(t.getUTCFullYear()).slice(-2);
      var body = 'GPRMC,' + hh + ',A,' + Nmea._dm(lat, 2) + ',' + (lat < 0 ? 'S' : 'N') + ',' + Nmea._dm(lng, 3) + ',' + (lng < 0 ? 'W' : 'E') + ',' + (mph / 1.15078).toFixed(1) + ',' + (hdg || 0).toFixed(1) + ',' + dd + ',,,A';
      return '$' + body + '*' + Nmea._ck(body);
    },
    gga: function (lat, lng, when) {
      var t = when || new Date(), hh = ('0' + t.getUTCHours()).slice(-2) + ('0' + t.getUTCMinutes()).slice(-2) + ('0' + t.getUTCSeconds()).slice(-2) + '.00';
      var body = 'GPGGA,' + hh + ',' + Nmea._dm(lat, 2) + ',' + (lat < 0 ? 'S' : 'N') + ',' + Nmea._dm(lng, 3) + ',' + (lng < 0 ? 'W' : 'E') + ',1,08,1.0,300.0,M,-34.0,M,,';
      return '$' + body + '*' + Nmea._ck(body);
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // NAV — turn-by-turn to the ONE parcel the driver chose ("Route here")
  // ════════════════════════════════════════════════════════════════════════
  // rows: [{seq, street, city, lat, lng}] — the drive file, never reordered here.
  // routeTo(seq) is the ONLY way a route starts, and only a driver's press calls it.
  // The route ends on stop(), on shot(<that seq>), or on routeTo(<another seq>); after
  // it ends there is no route until the driver presses Route here again.
  function Nav(graph, rows, opts) {
    opts = opts || {};
    this.g = graph; this.rows = rows.slice().sort(function (a, b) { return a.seq - b.seq; });
    this.bySeq = {}; var self = this; this.rows.forEach(function (r) { self.bySeq[String(r.seq)] = r; });
    this.driven = {}; this.lastShot = null; this.order = opts.order || 'seq';
    this.target = null;
    this.offRouteM = opts.offRouteM || 60; this.offRouteFixes = opts.offRouteFixes || 3;
    this.route = null; this.routeFor = null; this._off = 0; this.fix = null; this.reroutes = 0;
    this.snapCache = {};
  }
  // NEXT — DISPLAY ONLY ("Next to drive"); it never starts a route. The lowest undriven
  // seq after the last one shot, wrapping to the lowest undriven (= desk.html nextSeq()).
  Nav.prototype.next = function () {
    // PROPOSAL ONLY (order = 'nearest'): the closest unshot parcel to where the puck is.
    // Not the drive-file rule; there so the two can be compared on a real day.
    if (this.order === 'nearest' && this.fix) {
      var f = this.fix, bn = null, bd = Infinity, me = this;
      this.rows.forEach(function (r) { if (me.driven[String(r.seq)]) return; var d = hav(f.lat, f.lng, r.lat, r.lng); if (d < bd) { bd = d; bn = r; } });
      if (bn) return bn;
    }
    var after = this.lastShot != null ? +this.lastShot : -1, best = null, first = null, self = this;
    this.rows.forEach(function (r) { if (self.driven[String(r.seq)]) return; var n = +r.seq;
      if (first === null || n < first) first = n; if (n > after && (best === null || n < best)) best = n; });
    var v = best !== null ? best : first; return v === null ? null : this.bySeq[String(v)];
  };
  // the parcel was shot: a route to it ends here (returns true when it did)
  Nav.prototype.shot = function (seq) {
    seq = String(seq); this.driven[seq] = true; this.lastShot = seq;
    if (this.target === seq) { this.stop(); return true; }
    return false;
  };
  // the driver pressed Route here: route to THIS parcel (replaces any route running)
  Nav.prototype.routeTo = function (seq) {
    this.target = seq == null ? null : String(seq);
    this.route = null; this.routeFor = null; this._off = 0; this._lastIdx = 0; this.reroutes = 0;
  };
  Nav.prototype.stop = function () { this.routeTo(null); };
  // the nearest point of the county's main road network to a position far off it: the route
  // starts there. One pass over the junctions (tens of thousands), only when off the file.
  Nav.prototype._approach = function (f, t, tsnap) {
    var g = this.g, bv = -1, bd = Infinity;
    // join on a MAJOR road (interstate / US / state route): the nearest junction of any road
    // was a mountain back lane from Asheville when you would really come in on I-26
    if (!g._major) { g._major = new Uint8Array(g.nV);
      var MJ = { motorway: 1, trunk: 1, primary: 1, motorway_link: 1, trunk_link: 1, primary_link: 1 };
      for (var e = 0; e < g.nE; e++) if (MJ[g.edgeClass(e)]) { g._major[g.j.E[e * 8]] = 1; g._major[g.j.E[e * 8 + 1]] = 1; } }
    for (var pass = 0; pass < 2 && bv < 0; pass++)       // no major road at all → any road
      for (var v = 0; v < g.nV; v++) { if (g.comp[v] !== g.mainComp || (!pass && !g._major[v])) continue;
        var d = hav(f.lat, f.lng, g.lat[v], g.lng[v]); if (d < bd) { bd = d; bv = v; } }
    if (bv < 0) return null;
    // FAR off the county file (another state): the file cannot know which highway you will come
    // in on, so no guessed road route — a straight dashed line to the parcel; real turn-by-turn
    // starts by itself once you are on the county roads (re-checked every ~half mile).
    if (bd > 16000) {
      var sm = hav(f.lat, f.lng, t.lat, t.lng);
      return { coords: [], steps: [], distM: 0, timeS: 0, approach: { far: true, fromLat: f.lat, fromLng: f.lng, lat: t.lat, lng: t.lng, distM: sm, name: '' } };
    }
    var r = g.route(g.lat[bv], g.lng[bv], t.lat, t.lng, { toSnap: tsnap, maxSnapM: 2500 });
    if (!r) return null;
    var nm = ''; for (var i = 0; i < r.steps.length && !nm; i++) nm = r.steps[i].name || '';
    r.approach = { fromLat: f.lat, fromLng: f.lng, lat: g.lat[bv], lng: g.lng[bv], distM: bd, name: nm };
    return r;
  };
  Nav.prototype._targetSnap = function (r) {
    var k = String(r.seq); if (this.snapCache[k] === undefined) this.snapCache[k] = this.g ? this.g.snap(r.lat, r.lng, 2500) : null;
    return this.snapCache[k];
  };
  // feed a position: returns the view for the banner + map. No target = no route.
  Nav.prototype.update = function (fix) {
    this.fix = fix || this.fix; var f = this.fix, t = this.target ? this.bySeq[this.target] || null : null;
    var view = { target: t, seq: this.target, routing: false, reason: '' };
    if (!this.target) return view;
    if (!t) { view.reason = 'SEQ ' + this.target + ' has no map position.'; return view; }
    if (!f) { view.reason = 'Waiting for a GPS position.'; return view; }
    view.straightM = hav(f.lat, f.lng, t.lat, t.lng);
    view.bearing = bearing(f.lat, f.lng, t.lat, t.lng); view.compass = compass(view.bearing);
    if (f.hdg != null && isFinite(f.hdg) && (f.spdMph == null || f.spdMph > 3)) view.relBearing = ((view.bearing - f.hdg + 540) % 360) - 180;
    if (!this.g) { this.route = null; view.reason = 'No road file for this county.'; return view; }
    // (re)route when the target changed, there is no route, or we left it (wrong turn)
    var tsnap = this._targetSnap(t);
    if (!tsnap) { view.reason = 'This parcel is off the county road file.'; return view; }
    var need = !this.route || this.routeFor !== String(t.seq), prog = null;
    // FROM OUTSIDE THE COUNTY (approach): re-plan only after moving ~half a mile, so it
    // picks up real turn-by-turn the moment you reach the county roads
    if (!need && this.route.approach) need = hav(f.lat, f.lng, this.route.approach.fromLat, this.route.approach.fromLng) > 800;
    else if (!need) {
      prog = progressOn(this.route.coords, f.lat, f.lng, this.g.P, this._lastIdx || 0);
      if (prog.offM > this.offRouteM) { this._off++; if (this._off >= this.offRouteFixes) need = true; } else this._off = 0;
    }
    if (need) {
      var r = this.g.route(f.lat, f.lng, t.lat, t.lng, { toSnap: tsnap, maxSnapM: 2500 });
      // "a route is a route" (Dustin 10/11): off the county road file (another state, a
      // hotel over the line) → route from the nearest county road; a dashed line gets you there
      if (!r) r = this._approach(f, t, tsnap);
      if (this.route && this.routeFor === String(t.seq) && !(r && r.approach)) this.reroutes++;
      this.route = r; this.routeFor = String(t.seq); this._off = 0; this._lastIdx = 0;
      if (!r) { view.reason = 'No road route found from here.'; return view; }
      if (!r.approach) prog = progressOn(r.coords, f.lat, f.lng, this.g.P, 0);
    }
    if (this.route.approach) {
      var r1 = this.route, ap = r1.approach;
      view.routing = true; view.route = r1; view.approach = ap;
      view.remM = ap.distM + r1.distM; view.etaS = r1.timeS + ap.distM / (55 * 0.44704);
      view.step = ap.far ? { type: 'approach', text: 'Use your phone maps to reach the county. Turn-by-turn on the laptop starts by itself once you are on the county roads.' }
        : { type: 'approach', text: 'Get to ' + (ap.name || 'the county roads') + ' (dashed line; use your phone maps for that part). Turn-by-turn on the laptop starts there.' };
      view.stepInM = ap.distM; view.onRoad = ''; view.offM = ap.distM; view.reroutes = this.reroutes;
      view.arriveSide = (r1.steps[r1.steps.length - 1] || {}).side || '';
      return view;
    }
    this._lastIdx = prog.idx;
    var r2 = this.route, doneM = prog.alongM, remM = Math.max(0, r2.distM - doneM);
    view.routing = true; view.route = r2; view.remM = remM;
    view.etaS = r2.distM ? r2.timeS * (remM / r2.distM) : 0;
    // next maneuver after where we are
    var st = null; for (var i = 0; i < r2.steps.length; i++) { if (r2.steps[i].cumAt > doneM + 5) { st = r2.steps[i]; break; } }
    if (!st) st = r2.steps[r2.steps.length - 1];
    view.step = st; view.stepInM = Math.max(0, st.cumAt - doneM);
    // the turn AFTER this one, so the panel can show "then …" (Dustin 10/19)
    var stI = r2.steps.indexOf(st), nx = stI >= 0 ? r2.steps[stI + 1] : null;
    view.next = nx || null; view.nextGapM = nx ? Math.max(0, nx.cumAt - st.cumAt) : null;
    var cur = null; for (var k = r2.steps.length - 1; k >= 0; k--) { if (r2.steps[k].cumAt <= doneM + 5) { cur = r2.steps[k]; break; } }
    view.onRoad = cur ? cur.name : '';
    view.arriveSide = (r2.steps[r2.steps.length - 1] || {}).side || '';
    view.offM = prog.offM; view.reroutes = this.reroutes;
    // heading the wrong way along the route (e.g. right after a wrong turn): say so first
    var c0 = r2.coords[prog.idx], c1 = r2.coords[Math.min(r2.coords.length - 1, prog.idx + 1)];
    if (f.hdg != null && (f.spdMph == null || f.spdMph > 3) && c0 && c1 && hav(c0[0], c0[1], c1[0], c1[1]) > 2) {
      var dd = Math.abs(((bearing(c0[0], c0[1], c1[0], c1[1]) - f.hdg + 540) % 360) - 180);
      view.turnAround = dd > 120;
    }
    return view;
  };
  // where along a polyline is the position (searching forward from a hint)
  function progressOn(coords, lat, lng, P, hint) {
    var best = { d: Infinity, idx: 0, t: 0 }, cum = 0, cums = [0];
    for (var i = 1; i < coords.length; i++) { cum += hav(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); cums.push(cum); }
    for (i = Math.max(0, (hint || 0) - 5); i + 1 < coords.length; i++) {
      var c = segClosest(lat, lng, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1], P);
      if (c.d < best.d) best = { d: c.d, idx: i, t: c.t };
    }
    if (coords.length < 2) return { offM: coords.length ? hav(lat, lng, coords[0][0], coords[0][1]) : Infinity, alongM: 0, idx: 0 };
    return { offM: best.d, idx: best.idx, alongM: cums[best.idx] + best.t * (cums[best.idx + 1] - cums[best.idx]) };
  }

  // ════════════════════════════════════════════════════════════════════════
  // SIMULATOR — a fake puck that drives the routes and emits real NMEA
  // ════════════════════════════════════════════════════════════════════════
  // path: [[lat,lng],…]; mph: driving speed; returns an iterator of sentences, one
  // position per `stepS` seconds of simulated time.
  function simAlong(path, mph, stepS) {
    var mps = mph * 0.44704, out = [], i = 0, carry = 0, stepM = mps * (stepS || 1);
    if (!path || path.length < 2) return out;
    var pos = path[0], acc = 0;
    out.push({ lat: pos[0], lng: pos[1], hdg: bearing(path[0][0], path[0][1], path[1][0], path[1][1]), mph: mph });
    for (i = 1; i < path.length; i++) {
      var a = path[i - 1], b = path[i], L = hav(a[0], a[1], b[0], b[1]), hd = bearing(a[0], a[1], b[0], b[1]);
      var d = stepM - carry;
      while (d <= L) { var t = d / L; out.push({ lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, hdg: hd, mph: mph }); d += stepM; }
      carry = L - (d - stepM);
    }
    var z = path[path.length - 1]; out.push({ lat: z[0], lng: z[1], hdg: out[out.length - 1].hdg, mph: 0 });
    return out;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRODUCTION — route time + measured at-parcel time → hours and parcels/hour
  // ════════════════════════════════════════════════════════════════════════
  var Production = {
    // drive time + distance along an ORDER of rows (hop by hop), with the graph's speeds
    along: function (graph, rows) {
      var hops = [], tot = { distM: 0, timeS: 0, straightM: 0, missing: 0 };
      var snaps = rows.map(function (r) { return graph.snap(r.lat, r.lng, 2500); });
      for (var i = 1; i < rows.length; i++) {
        var a = rows[i - 1], b = rows[i], s = hav(a.lat, a.lng, b.lat, b.lng), r = null;
        if (snaps[i - 1] && snaps[i]) r = graph.route(a.lat, a.lng, b.lat, b.lng, { fromSnap: snaps[i - 1], toSnap: snaps[i] });
        hops.push({ from: a.seq, to: b.seq, straightM: s, distM: r ? r.distM : null, timeS: r ? r.timeS : null });
        tot.straightM += s; if (r) { tot.distM += r.distM; tot.timeS += r.timeS; } else tot.missing++;
      }
      tot.hops = hops; return tot;
    },
    // active-hours rule from functions/pace.js: consecutive gaps ≤ 20 min count
    activeH: function (times, gapMin) {
      var g = (gapMin || 20) * 60e3, t = times.slice().sort(function (a, b) { return a - b; }), act = 0;
      for (var i = 1; i < t.length; i++) { var d = t[i] - t[i - 1]; if (d <= g) act += d; }
      return act / 3600e3;
    },
    // hours to finish an order: road time + n × measured at-parcel minutes
    estimate: function (graph, rows, atParcelS) {
      var a = Production.along(graph, rows), driveH = a.timeS / 3600, dwellH = rows.length * atParcelS / 3600;
      return { parcels: rows.length, driveH: driveH, dwellH: dwellH, totalH: driveH + dwellH,
        perActiveH: (driveH + dwellH) ? rows.length / (driveH + dwellH) : null, distMi: a.distM / 1609.344, missing: a.missing, hops: a.hops };
    }
  };

  return { hav: hav, bearing: bearing, compass: compass, compassWord: compassWord, fmtDist: fmtDist, fmtTime: fmtTime,
    buildGraph: buildGraph, Graph: Graph, START_MPH: START_MPH, CALIB: CALIB, Nav: Nav, Nmea: Nmea, simAlong: simAlong, Production: Production,
    progressOn: progressOn };
});

/* ════════════════════════════════════════════════════════════════════════════
 * DESKROUTE — "Route here" for desk.html (browser only; Node never runs this part)
 *
 * desk.html loads this file with ?route=1 and calls DeskRoute.attach(DeskAPI)
 * (desk.html §13). With no module there is no button: the desk draws the Route here
 * button only after cardAction() is registered here.
 *
 *   • Every parcel card gets "↝ Route here" (key R). Pressing it routes to THAT parcel
 *     only. Nothing else ever starts a route: no AUTO, no auto distance, no route to
 *     NEXT. "Next to drive" stays a display suggestion.
 *   • The route ends by itself when that parcel is shot (its status leaves To drive, or
 *     the camera goes onto it), when Route here is pressed on another parcel (the target
 *     switches), or when the driver presses ■ Stop (or Esc). It never chains on.
 *   • A wrong turn reroutes to the same parcel ("Turn around when safe" first).
 *   • The road file is <BUCKET>.roads.json from the county folder, copied into the
 *     laptop by desk.html §7 and read only when Route here is pressed. None → the
 *     banner says "No road file for this county" and nothing else changes.
 * ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || !window.LHVRoute) return;
  var RT = window.LHVRoute;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function seqKey(s) { if (s == null || s === '') return null; var n = parseInt(s, 10); return isFinite(n) ? String(n) : String(s); }
  // ── TURN ARROWS (Dustin 10/19: "a little turn right button and then maybe a next turn
  // underneath that ... so it's not just words"). One arrow drawn straight up, rotated by the
  // kind of turn; a U-turn and the arrival get their own marks.
  function turnKind(step, back) {
    if (back) return 'uturn';
    if (!step) return 'straight';
    if (step.type === 'arrive') return 'arrive';
    var t = String(step.text || '');
    if (/U-turn/i.test(t)) return 'uturn';
    var m = t.match(/^(Sharp |Slight )?(?:Turn )?(left|right)\b/i) || t.match(/^(Sharp|Slight) (left|right)/i);
    if (m) return ((m[1] || '').trim().toLowerCase() ? (m[1] || '').trim().toLowerCase() + '-' : '') + m[2].toLowerCase();
    return 'straight';
  }
  var TURN_DEG = { straight: 0, 'slight-right': 45, right: 90, 'sharp-right': 135, 'slight-left': -45, left: -90, 'sharp-left': -135 };
  function turnIcon(kind, cls) {
    var body;
    if (kind === 'arrive') body = '<circle cx="24" cy="20" r="9" fill="none" stroke="currentColor" stroke-width="5"/><path d="M24 29 L24 42" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>';
    else if (kind === 'uturn') body = '<path d="M32 42 V20 a9 9 0 0 0 -18 0 V30" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M6 26 L14 36 L22 26" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>';
    else body = '<g transform="rotate(' + (TURN_DEG[kind] || 0) + ' 24 24)"><path d="M24 42 V10" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M12 21 L24 8 L36 21" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g>';
    return '<svg class="' + (cls || 'rt-ic') + '" viewBox="0 0 48 48" aria-hidden="true">' + body + '</svg>';
  }
  var CSS =
    // the NEXT TURN boxed in green and blinking (Dustin 10/19) — the line the driver must act on
    '.rt-mv{display:flex;align-items:center;gap:10px;margin-top:6px;padding:6px 8px;border:3px solid #2ecc8a;border-radius:12px;background:rgba(46,204,138,.10);animation:rtTurnBlink 1s ease-in-out infinite}' +
    '@keyframes rtTurnBlink{0%,100%{border-color:#2ecc8a;box-shadow:0 0 0 0 rgba(46,204,138,.0)}50%{border-color:rgba(46,204,138,.25);box-shadow:0 0 12px 2px rgba(46,204,138,.55)}}' +
    '.rt-mv.back{border-color:#ffb020;background:rgba(255,176,32,.10);animation:none}' +
    '.rt-mv .rt-ic{flex:0 0 auto;width:46px;height:46px;padding:4px;border-radius:10px;background:#1d3a6e;color:#fff}' +
    '.rt-mv.back .rt-ic{background:#5a3a10;color:#ffd08a}' +
    '.rt-mv .rt-turn{margin-top:0}' +
    '.rt-then{display:flex;align-items:center;gap:7px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.1);font:600 13.5px var(--font-display,system-ui);color:#c3c7da;overflow-wrap:anywhere}' +
    '.rt-then .rt-ic2{flex:0 0 auto;width:24px;height:24px;padding:2px;border-radius:6px;background:#2a3350;color:#dfe6ff}' +
    '.rt-then b{color:#8fc0ff;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.5px;white-space:nowrap;flex:0 0 auto}' +
    '.rt-k{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:600 13px var(--font-display,system-ui);letter-spacing:.6px;text-transform:uppercase;color:#8fc0ff}' +
    '.rt-k b{font-weight:700;color:#fff}' +
    '.rt-k .rt-stop{margin-left:auto;margin-right:24px;text-transform:none;letter-spacing:0;background:#4a1420;border:1.5px solid #e05555;color:#ffd0d0;border-radius:9px;padding:5px 10px;font:600 14px var(--font-display,system-ui)}' +
    '.rt-k .rt-stop:hover{background:#6a1a2c;color:#fff}' +
    '.rt-st{font:700 clamp(20px,2.1vw,30px)/1.12 var(--font-display,system-ui);color:#fff;margin-top:4px;overflow-wrap:anywhere}' +
    '.rt-ct{font:600 15px var(--font-display,system-ui);color:#d0d6e8;overflow-wrap:anywhere}' +
    '.rt-d{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-top:8px}' +
    '.rt-d .d{font:700 26px var(--font-display,system-ui);color:#fff}.rt-d .t{font:700 22px var(--font-display,system-ui);color:#2ecc8a}' +
    '.rt-d .s{font:600 12.5px var(--font-display,system-ui);color:#9a9eb6}' +
    '.rt-turn{margin-top:6px;font:600 clamp(17px,1.6vw,22px)/1.2 var(--font-display,system-ui);color:#9fc0ff;overflow-wrap:anywhere}' +
    '.rt-turn.back{color:#ffd08a}.rt-turn.msg{color:#ffd08a;font-size:17px}' +
    '.rt-n{margin-top:4px;font:600 12.5px var(--font-display,system-ui);color:#9a9eb6;overflow-wrap:anywhere}' +
    '.rt-n:empty{display:none}' +
    '.rt-close{margin-top:8px;background:#232635;border:1px solid rgba(255,255,255,.15);color:#f0f0f0;border-radius:9px;padding:6px 12px;font:600 13px var(--font-display,system-ui)}';

  function attach(api) {
    var L = window.L;
    var M = { bucket: null, graph: null, graphBucket: null, loading: null, nav: null, navBucket: null,
      target: null, raw: null, startStatus: null, lastCam: null, view: null, phase: '', msg: '', lines: null, fitted: false };
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

    function rows() { return api.rows(); }
    function rowFor(seq) { var k = seqKey(seq), out = null; rows().forEach(function (r) { if (seqKey(r.seq) === k) out = r; }); return out; }
    function fixOf(p) { return p ? { lat: p.lat, lng: p.lng, hdg: p.course == null ? null : p.course, spdMph: p.speedKn == null ? null : p.speedKn * 1.15078 } : null; }
    function bucketNow() { var j = api.job(); return j ? j.bucket : null; }

    // the road file + the parcel list as Nav needs them; built once per county, on the first press
    function ensureNav() {
      var b = bucketNow();
      if (M.nav && M.navBucket === b && M.graph) return Promise.resolve(M.nav);
      if (M.loading && M.loading.b === b) return M.loading.p;
      var p = Promise.resolve(api.roads()).then(function (j) {
        var g = null;
        if (j && j.kind === 'lhv-roads' && (!j.bucket || !b || j.bucket === b)) {
          try { g = new RT.Graph(j, { factor: RT.CALIB.factor }); } catch (e) { g = null; }
        }
        M.graph = g; M.graphBucket = b;
        if (g && L && api.map() && api.map().attributionControl) api.map().attributionControl.addAttribution('Roads © OpenStreetMap contributors');
        var rr = rows().map(function (r) { return { seq: seqKey(r.seq), street: r.street, city: r.city, zip: r.zip, lat: parseFloat(r.lat), lng: parseFloat(r.lng) }; })
          .filter(function (r) { return isFinite(r.lat) && isFinite(r.lng) && r.lat && r.lng; });
        M.nav = new RT.Nav(g, rr); M.navBucket = b; M.loading = null;
        return M.nav;
      }, function () { M.loading = null; M.graph = null; M.nav = null; return null; });
      M.loading = { b: b, p: p };
      return p;
    }

    // ── the driver pressed Route here ──
    function routeHere(seq, how) {
      var k = seqKey(seq), row = rowFor(k);
      if (!row) return;
      if (!api.latlng(row)) { api.toast('SEQ ' + k + ' has no map position, so there is nothing to route to', 4000); return; }
      if (M.target === k) { if (how === 'key') api.toast('Already routing to SEQ ' + k + ' · Esc stops', 2500); return; }
      M.target = k; M.raw = row.seq; M.bucket = bucketNow(); M.startStatus = api.status(row.seq); M.lastCam = seqKey(api.cameraSeq());
      M.view = null; M.fitted = false; M.phase = 'loading'; M.msg = ''; clearLine();
      if (M.nav) M.nav.stop();
      renderPanel(); api.refresh();
      // a tick so "Loading the road file…" paints before the graph is built
      setTimeout(function () {
        ensureNav().then(function (nav) {
          if (M.target !== k) return;                       // switched or stopped while loading
          if (!nav || !nav.g) {
            M.phase = 'msg'; M.msg = 'No road file for this county. Route here needs ' + (M.bucket || 'the county') + '.roads.json in the county folder (load the folder again once it is there). The map, pins and list work as before.';
            var r0 = row; M.target = null; M.msgRow = r0; renderPanel(); api.refresh();
            api.toast('No road file for this county', 4000); return;
          }
          M.phase = 'route'; nav.routeTo(k); update(fixOf(api.position()));
          api.refresh();
        });
      }, 30);
    }
    function stop(why) {
      if (!M.target && M.phase !== 'msg') return false;
      var was = M.target; M.target = null; M.phase = ''; M.msg = ''; M.view = null; M.msgRow = null;
      if (M.nav) M.nav.stop(); clearLine(); renderPanel(); api.refresh();
      if (was && why) api.toast(why, 3000);
      return true;
    }
    function update(fix) {
      if (!M.target || !M.nav || M.phase !== 'route') return;
      M.view = M.nav.update(fix || null);
      drawLine(); renderPanel();
    }

    // ── route line on the desk's Leaflet map ──
    function clearLine() { var m = api.map(); if (M.lines && m) { M.lines.forEach(function (l) { m.removeLayer(l); }); } M.lines = null; if (M.appr && m) m.removeLayer(M.appr); M.appr = null; }
    function drawLine() {
      var m = api.map(), v = M.view; if (!m || !L) return;
      if (!v || !v.routing || !v.route) { clearLine(); return; }
      var ll = v.route.coords;
      if (!M.lines) {
        M.lines = [L.polyline(ll, { color: '#0b2a8a', weight: 10, opacity: .9, interactive: false }).addTo(m),
          L.polyline(ll, { color: '#2f7bff', weight: 6, opacity: 1, interactive: false }).addTo(m)];
      } else if (M.lines[0]._rtRoute !== v.route) { M.lines.forEach(function (l) { l.setLatLngs(ll); }); }
      M.lines[0]._rtRoute = v.route;
      // off the county roads: a dashed line from you to where the route starts
      var ap = v.approach;
      if (ap) { var al = [[ap.fromLat, ap.fromLng], [ap.lat, ap.lng]];
        if (!M.appr) M.appr = L.polyline(al, { color: '#2f7bff', weight: 5, opacity: .95, dashArray: '10 10', interactive: false }).addTo(m); else M.appr.setLatLngs(al); }
      else if (M.appr) { m.removeLayer(M.appr); M.appr = null; }
      if (!M.fitted && ll.length > 1) {          // once per press: show the whole way there
        M.fitted = true;
        try { m.fitBounds(L.latLngBounds(ll), { paddingTopLeft: [70, 280], paddingBottomRight: [40, 150], maxZoom: 17 }); } catch (e) {}
      }
    }

    // ── the banner: SEQ + the full address in big type, distance, time, the next turn ──
    function renderPanel() {
      var body = null;
      if (!M.target && M.phase !== 'msg') { api.slot(false); return; }
      body = api.slot(true);
      var row = M.target ? rowFor(M.target) : M.msgRow, v = M.view, h = '';
      var seqTxt = M.target || (row && seqKey(row.seq)) || '';
      var addr = row ? (row.street || '(no address)') : '', ct = row ? [row.city, row.zip].filter(Boolean).join(' ') : '';
      h += '<div class="rt-k"><span>' + (M.phase === 'msg' ? 'Route here · ' : 'Routing to ▸ ') + '<b>SEQ ' + esc(seqTxt) + '</b></span>' +
        (M.phase === 'msg' ? '' : '<button class="rt-stop" data-rt="stop" title="Stop this route (Esc)">■ Stop <kbd>Esc</kbd></button>') + '</div>';
      h += '<div class="rt-st">' + esc(addr) + '</div>' + (ct ? '<div class="rt-ct">' + esc(ct) + '</div>' : '');
      if (M.phase === 'msg') {
        h += '<div class="rt-turn msg">' + esc(M.msg) + '</div><button class="rt-close" data-rt="close">Close</button>';
      } else if (M.phase === 'loading') {
        h += '<div class="rt-turn msg">Loading the road file…</div>';
      } else if (v && v.routing) {
        var s = v.step, txt = s.type === 'arrive' ? 'Arrive' + (v.arriveSide ? ' — parcel ' + v.arriveSide : '') : s.text;
        var turn = v.turnAround ? 'Turn around when safe — then ' + txt.charAt(0).toLowerCase() + txt.slice(1) + (v.stepInM > 30 ? ' in ' + RT.fmtDist(v.stepInM) : '')
          : (v.stepInM > 30 ? 'In ' + RT.fmtDist(v.stepInM) + ': ' : '') + txt;
        h += '<div class="rt-d"><span class="d">' + RT.fmtDist(v.remM) + '</span><span class="t">' + RT.fmtTime(v.etaS) + '</span><span class="s">' + (v.approach ? 'about · ' : 'by road · ') + RT.fmtDist(v.straightM) + ' straight</span></div>';
        h += '<div class="rt-mv' + (v.turnAround ? ' back' : '') + '">' + turnIcon(turnKind(s, v.turnAround)) + '<div class="rt-turn' + (v.turnAround ? ' back' : '') + '">' + esc(turn) + '</div></div>';
        if (v.next && !v.turnAround) {
          var nt = v.next.type === 'arrive' ? 'Arrive' + (v.arriveSide ? ' — parcel ' + v.arriveSide : '') : v.next.text;
          h += '<div class="rt-then"><b>Then</b>' + turnIcon(turnKind(v.next), 'rt-ic2') + '<span>' + esc(nt) + (v.nextGapM > 30 ? ' <span style="color:#9a9eb6">in ' + RT.fmtDist(v.nextGapM) + '</span>' : '') + '</span></div>';
        }
        h += '<div class="rt-n">' + esc((v.onRoad ? 'On ' + v.onRoad : '') + (v.reroutes ? (v.onRoad ? ' · ' : '') + 'rerouted ' + v.reroutes + '×' : '')) + '</div>';
        h += '<div class="rt-n">Roads © OpenStreetMap contributors</div>';
      } else {
        if (v && v.straightM != null) h += '<div class="rt-d"><span class="d">' + RT.fmtDist(v.straightM) + '</span><span class="t">' + esc(v.compass || '') + '</span><span class="s">straight line</span></div>';
        h += '<div class="rt-turn msg">' + esc((v && v.reason) || 'Waiting for a GPS position.') + '</div>';
      }
      if (body.getAttribute('data-h') !== h) { body.setAttribute('data-h', h); body.innerHTML = h; }
      if (!body._rtWired) {
        body._rtWired = true;
        body.addEventListener('click', function (e) {
          var b = e.target.closest('[data-rt]'); if (!b) return;
          if (b.getAttribute('data-rt') === 'stop') stop('Route stopped');
          if (b.getAttribute('data-rt') === 'close') stop();
        });
      }
    }

    // ── the button on every parcel card (desk.html draws it; this says what it does) ──
    api.cardAction({
      key: 'r',
      state: function (seq) {
        var k = seqKey(seq), row = rowFor(k), p = row && api.latlng(row);
        if (M.target === k) return { on: true, label: '■ Stop', kbd: 'Esc', title: 'Stop routing to SEQ ' + k + ' (Esc)' };
        return { label: '↝ Route', kbd: 'R', disabled: !p, title: p ? 'Turn-by-turn to this parcel only (R). Ends when it is shot.' : 'This parcel has no map position' };
      },
      press: function (seq, how) { var k = seqKey(seq); if (how === 'click' && M.target === k) stop('Route stopped'); else routeHere(seq, how); },
      escape: function () { return stop(M.target ? 'Route stopped' : ''); }
    });

    // ── every GPS fix: move along / reroute ──
    api.onPosition(function (p) { if (M.target && M.phase === 'route') update(fixOf(p)); });
    // ── every redraw: did the target get shot? did the county change? ──
    api.onRender(function () {
      if (!M.target) return;
      if (bucketNow() !== M.bucket) { stop('County changed — route stopped'); return; }
      var s = api.status(M.raw), cam = seqKey(api.cameraSeq());
      var shot = (M.startStatus === 'pending' && s !== 'pending') || (cam === M.target && M.lastCam !== M.target);
      M.lastCam = cam;
      if (shot) stop('SEQ ' + M.target + ' driven — route ended');
    });
    DeskRoute._state = M;   // test/inspection only
  }
  var DeskRoute = window.DeskRoute = { attach: attach };
})();
