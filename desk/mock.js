/* ════════════════════════════════════════════════════════════════════════════
 * desk/mock.js — TEST HARNESS for desk.html (loaded ONLY with ?mock=<folder>)
 *
 *  MockServer  an in-memory stand-in for the RTDB session tree, persisted in this
 *              browser's localStorage so a reload keeps it (to test reload-offline).
 *  MockLink    the desk's link to it. "Offline" = the desk hears nothing and its
 *              writes never land — exactly what a dead hotspot looks like.
 *  MockCam     a fake camera phone: picks the next parcel, "shoots" it, uploads,
 *              then the "AI" rates it. It keeps working while the desk is offline,
 *              like the real camera phone on its own signal.
 *  MockGps     real NMEA sentences ($GPRMC/$GPGGA with checksums) fed through the
 *              SAME parser the USB puck uses, drifting toward the next parcel — or,
 *              with ?route=1 and a driver-started route, driving that route's roads
 *              (plus a "Wrong turn" button to test the reroute).
 *
 * Nothing here talks to Firebase or Dropbox. All AI text below is invented.
 * ════════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  var KEY = 'desk_mock_tree', ONK = 'desk_mock_online', DRV = 'RF';
  var T = {}; try { T = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { T = {}; }
  var online = localStorage.getItem(ONK) !== '0';
  var listeners = [];
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(T)); } catch (e) {} }
  function abs(p){ p = p || ''; return p.charAt(0) === '/' ? p.slice(1) : ('sessions/' + DRV + (p ? '/' + p : '')); }
  function parts(p){ return p.split('/').filter(Boolean); }
  function getAt(p){ var o = T; var ps = parts(p); for (var i = 0; i < ps.length; i++) { if (o == null || typeof o !== 'object') return null; o = o[ps[i]]; } return o === undefined ? null : o; }
  function setAt(p, v){
    var ps = parts(p), o = T;
    for (var i = 0; i < ps.length - 1; i++) { if (o[ps[i]] == null || typeof o[ps[i]] !== 'object') o[ps[i]] = {}; o = o[ps[i]]; }
    var last = ps[ps.length - 1];
    if (v === null || v === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
  }
  function update(p, obj){ Object.keys(obj).forEach(function(k){ setAt(abs(p) + '/' + k, obj[k]); }); save(); notify(); }
  function set(p, v){ setAt(abs(p), v); save(); notify(); }
  function notify(force){
    if (!online) return;
    listeners.forEach(function(L){ var v = getAt(L.path), j = JSON.stringify(v);
      if (force || j !== L.last) { L.last = j; try { L.fn(v == null ? null : JSON.parse(j)); } catch (e) { console.error(e); } } });
  }
  var MockServer = window.MockServer = { get: function(p){ return getAt(abs(p)); }, update: update, set: set,
    isOnline: function(){ return online; },
    setOnline: function(on){ online = !!on; localStorage.setItem(ONK, on ? '1' : '0');
      if (window.__mockLink) { window.__mockLink.connected = online; window.__mockLink._onChange && window.__mockLink._onChange(); }
      if (online) notify(true); renderPanel(); },
    reset: function(){ T = {}; save(); localStorage.removeItem(ONK); online = true; } };

  // ── the desk's link ──────────────────────────────────────────────────────
  window.MockLink = function(){
    var self = { kind: 'mock', connected: online };
    window.__mockLink = self;
    self.start = function(driver, onChange){ self._onChange = onChange; setTimeout(function(){ onChange(); notify(true); }, 50); };
    self.on = function(path, fn){ var L = { path: abs(path), fn: fn, last: undefined }; listeners.push(L);
      if (online) { var v = getAt(L.path); L.last = JSON.stringify(v); setTimeout(function(){ fn(v == null ? null : JSON.parse(L.last)); }, 0); } };
    self.update = function(path, obj){ if (!online) return new Promise(function(){}); return new Promise(function(res){ setTimeout(function(){ update(path, obj); res(); }, 120); }); };
    self.set = function(path, v){ if (!online) return new Promise(function(){}); return new Promise(function(res){ setTimeout(function(){ set(path, v); res(); }, 120); }); };
    self.once = function(path){ if (!online) return new Promise(function(){}); return Promise.resolve(getAt(abs(path))); };
    self.off = function(path){ var a = abs(path); for (var i = listeners.length - 1; i >= 0; i--) if (listeners[i].path === a) listeners.splice(i, 1); };   // like the live link (county switch without a reload)
    return self;
  };

  // ── the fake camera phone ────────────────────────────────────────────────
  var WHY = ['Single-story frame house; roof, siding and windows intact; yard kept.', 'Brick ranch in fair shape; some peeling trim, gutters sagging at one corner.',
    'Two-story frame house with worn siding and a patched roof section.', 'Small frame house; porch rotting, several windows cracked, roof sagging.',
    'Well-kept brick house; newer roof and windows.', 'Vacant lot, no structure visible; grass cut recently.'];
  var OCC = [['Lived-in: car in a used driveway, mail box clear.', 8], ['Some signs: tall grass, blinds down, no car.', 46], ['Mail piled at the door, overgrown driveway, empty interior visible.', 88],
    ['Lived-in: toys in the yard, trash bins out.', 5], ['Lockbox on the front door and the interior looks empty.', 93]];
  var timers = [], auto = null, lastSeq = 0;
  function today(){ return (window._lhvDate || function(){ return new Date().toISOString().slice(0,10); })(); }
  function rows(){ return ((window.state && state.seqs) || []).slice().sort(function(a,b){ return parseInt(a.seq,10) - parseInt(b.seq,10); }); }
  function bucket(){ return (window.state && state.job && state.job.bucket) || 'MOCK'; }
  function sync(patch){ var s = MockServer.get('sync') || { pending: 0, parked: 0, idb: 0, held: 0, bySeq: {} }; Object.assign(s, patch, { at: Date.now() }); MockServer.set('sync', s); }
  function beat(){ MockServer.update('', { hbCam: Date.now() }); sync({}); }
  setInterval(beat, 5000);
  function nextFree(){ var logs = MockServer.get('logs') || {}; var rs = rows();
    for (var i = 0; i < rs.length; i++) { var n = parseInt(rs[i].seq, 10); if (n > lastSeq && !logs[rs[i].seq]) return rs[i]; }
    for (var j = 0; j < rs.length; j++) if (!logs[rs[j].seq]) return rs[j]; return null; }
  function aiFor(n){ var w = WHY[n % WHY.length], o = OCC[n % OCC.length]; var rating = Math.round((1.2 + ((n * 37) % 300) / 100) * 100) / 100;
    var board = (n % 10 === 4) ? 'Y' : 'N';
    return { ok: true, version: 'mock', model: 'mock', at: Date.now(), rating: rating, ratingWhy: w, occPct: o[1], occWhy: o[0], occSigns: [],
      boarded: board, boardDesc: board === 'Y' ? 'Y: front door and 2 windows, plywood' : '', boardType: board === 'Y' ? 'makeshift' : 'none', fire: (n % 23 === 0) ? 'Y' : 'N' }; }
  // stage the life of one parcel: shoot → upload → AI rating
  function shoot(r, fast, at){
    if (!r) { toastSafe('Mock camera: nothing left to shoot'); return; }
    var seq = String(r.seq), n = parseInt(seq, 10), d = fast ? 0 : 1; lastSeq = n;
    MockServer.set('active', { seq: seq, ts: Date.now() });
    MockServer.set('photoCountsJob', bucket() + ' ' + today());
    var base = { seq: seq, parcelId: r.parcelId, bucket: bucket(), driveDate: today(), closed: true, closedAt: at || Date.now(), touched: true,
      unoccupied: 'N', boardedUp: 'N', burnedDown: 'N', driverGeo: { ts: Date.now(), lat: parseFloat(r.lat), lng: parseFloat(r.lng) } };
    if (n % 13 === 0) {        // driver said NVFR, no photos (house hidden behind trees)
      MockServer.update('logs/' + seq, Object.assign(base, { build: 'NVFR', unoccupied: 'NVFR', boardedUp: 'NVFR', burnedDown: 'NVFR', comment: 'NVFR', landUse: r.landUse || 'Residential', photoCount: 0 }));
      return;
    }
    if (n % 9 === 0) {         // closed with no photos and no NO PHOTOS call → a real Incomplete
      MockServer.update('logs/' + seq, Object.assign(base, { photoCount: 0 })); return;
    }
    var pics = 3 + (n % 3);
    MockServer.update('logs/' + seq, Object.assign(base, { photoCount: pics }));
    var s = MockServer.get('sync') || {}; var by = s.bySeq || {}; by[seq] = pics;
    sync({ pending: Number(s.pending || 0) + pics, bySeq: by, idb: Number(s.idb || 0) + pics });
    timers.push(setTimeout(function(){          // photos land in Dropbox
      MockServer.update('photoCounts', (function(o){ o[seq] = pics; return o; })({}));
      var s2 = MockServer.get('sync') || {}; var by2 = s2.bySeq || {}; delete by2[seq];
      sync({ pending: Math.max(0, Number(s2.pending || 0) - pics), bySeq: by2, idb: Math.max(0, Number(s2.idb || 0) - pics) });
    }, 3000 * d));
    timers.push(setTimeout(function(){          // the AI reads the photos (functions/assess.js in real life)
      var a = aiFor(n); MockServer.update('logs/' + seq, { aiAssess: a, build: a.rating, buildSource: 'ai' });
    }, 7000 * d));
  }
  function toastSafe(t){ try { toast(t, 2500); } catch (e) {} }
  // TAP-TO-CAMERA (2026-10-11): the mock camera answers a desk seqRequest the way
  // camera-beta.html does: skip the value present at load, a repeated nonce, one older
  // than 2 min or a seq off the list; otherwise lock it and echo 'active' {seq, ts}.
  // MockCam.echo = false keeps the camera silent (to see "Sent to camera…" hold).
  var _rqInit = false, _rqSeen = {};
  listeners.push({ path: abs('seqRequest'), last: undefined, fn: function(r){
    if (!_rqInit) { _rqInit = true; if (r && r.nonce) _rqSeen[r.nonce] = 1; return; }
    if (!r || !r.nonce || _rqSeen[r.nonce]) return; _rqSeen[r.nonce] = 1;
    if (Math.abs(Date.now() - Number(r.ts || 0)) > 120000 || MockCam.echo === false) return;
    // a BATCH/MULTI run ({seqs, mode}) arms on its FIRST seq and echoes that one, like the camera's _runPoint
    var want = (r.seqs && r.seqs.length) ? r.seqs : [r.seq];
    var found = want.map(function(sq){ var k = String(parseInt(sq, 10)); return rows().filter(function(x){ return String(parseInt(x.seq, 10)) === k; })[0]; });
    if (!found.length || found.some(function(x){ return !x; })) return;
    var row = found[0];
    timers.push(setTimeout(function(){ MockServer.set('active', { seq: String(row.seq), ts: Date.now() }); }, 700));
  } });
  var MockCam = window.MockCam = {
    echo: true,
    next: function(){ shoot(nextFree(), false); },
    shootSeq: function(seq){ var k = String(parseInt(seq, 10)); shoot(rows().filter(function(r){ return String(parseInt(r.seq, 10)) === k; })[0], false); },
    auto: function(on){ clearInterval(auto); auto = null; if (on) { MockCam.next(); auto = setInterval(MockCam.next, 9000); } renderPanel(); },
    seed: function(k){   // a realistic mid-morning: k parcels done, one rating, one uploading, one incomplete
      var rs = rows(); lastSeq = 0;
      for (var i = 0; i < k && i < rs.length; i++) shoot(rs[i], true, Date.now() - (k - i) * 7 * 60000);   // spread over the morning (mock: one close every 7 min) so the desk has a pace
      timers.push(setTimeout(function(){ var r1 = nextFree(); shoot(r1, false);
        timers.push(setTimeout(function(){ var r2 = nextFree(); shoot(r2, false); }, 3500)); }, 50));
    }
  };

  // ── the fake GPS puck: genuine NMEA through the real parser ───────────────
  var gpsT = null, cur = null;
  function ck(s){ var c = 0; for (var i = 0; i < s.length; i++) c ^= s.charCodeAt(i); return ('0' + c.toString(16).toUpperCase()).slice(-2); }
  function dm(v, deg){ var a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return (('00' + d).slice(-deg)) + ('0' + m.toFixed(4)).slice(-7); }
  function sentences(lat, lng, kn, course){
    var t = new Date(), hh = ('0' + t.getUTCHours()).slice(-2) + ('0' + t.getUTCMinutes()).slice(-2) + ('0' + t.getUTCSeconds()).slice(-2) + '.00';
    var dd = ('0' + t.getUTCDate()).slice(-2) + ('0' + (t.getUTCMonth() + 1)).slice(-2) + String(t.getUTCFullYear()).slice(-2);
    var rmc = 'GPRMC,' + hh + ',A,' + dm(lat, 2) + ',' + (lat < 0 ? 'S' : 'N') + ',' + dm(lng, 3) + ',' + (lng < 0 ? 'W' : 'E') + ',' + kn.toFixed(1) + ',' + course.toFixed(1) + ',' + dd + ',,,A';
    var gga = 'GPGGA,' + hh + ',' + dm(lat, 2) + ',' + (lat < 0 ? 'S' : 'N') + ',' + dm(lng, 3) + ',' + (lng < 0 ? 'W' : 'E') + ',1,09,0.9,285.0,M,-32.0,M,,';
    return ['$' + rmc + '*' + ck(rmc), '$' + gga + '*' + ck(gga)];
  }
  // With ?route=1 and a driver-started route, the puck DRIVES THE ROUTE's roads (so turns,
  // reroutes and arrival can be tested); "Wrong turn" leaves the route down a side road.
  // With no route it drifts straight toward NEXT as before (that is the mock puck only:
  // nothing here ever starts a route).
  var path = [], pathFor = null, detour = false;
  function rtView(){ var M = window.DeskRoute && DeskRoute._state; return M && M.target && M.view && M.view.routing ? M.view : null; }
  function emit(lat, lng, kn, course){ cur = [lat, lng]; sentences(lat, lng, kn, course).forEach(function(s){ MockGps.last = s; Gps.feedLine(s, 'GPS puck (mock NMEA)'); }); }
  function planAlong(coords){   // the rest of a route from where the puck is now, one fix per tick
    var R = window.LHVRoute, i0 = 0, bd = Infinity;
    coords.forEach(function(c, i){ var d = distM(cur, c); if (d < bd) { bd = d; i0 = i; } });
    var rest = [cur].concat(coords.slice(i0 + 1));
    path = R.simAlong(rest, MockGps.stepM / 0.44704, 1);
  }
  var MockGps = window.MockGps = {
    last: '', stepM: 22,   // metres per 1-second fix (22 m ≈ 49 mph); tests may raise it
    start: function(){
      if (gpsT) return; window.Gps.mock = true; try { stopGeo(); } catch (e) {}
      gpsT = setInterval(MockGps.tick, 1000);
      renderPanel();
    },
    tick: function(){
      var v = rtView();
      if (v && !cur) cur = [v.route.coords[0][0], v.route.coords[0][1]];
      if (path.length && (detour || (v && v.route === pathFor))) { var p = path.shift(); emit(p.lat, p.lng, p.mph / 1.15078, p.hdg); if (!path.length) detour = false; renderPanel(); return; }
      if (v && cur) { pathFor = v.route; detour = false; planAlong(v.route.coords); if (path.length) { var q = path.shift(); emit(q.lat, q.lng, q.mph / 1.15078, q.hdg); } renderPanel(); return; }
      path = []; pathFor = null;
      var nx = window.nextSeq && nextSeq(), r = nx && _rowFor(nx); if (!r) return;
      var tgt = [parseFloat(r.lat), parseFloat(r.lng)];
      if (!cur) cur = [tgt[0] - 0.006, tgt[1] - 0.004];
      var d = distM(cur, tgt), br = bearing(cur, tgt), stepM = Math.min(d, 22), kn = d > 15 ? 22 / 0.514 : 0;
      if (d > 1) { var t = stepM / d; cur = [cur[0] + (tgt[0] - cur[0]) * t, cur[1] + (tgt[1] - cur[1]) * t]; }
      emit(cur[0], cur[1], kn, br);
      renderPanel();
    },
    // put the puck somewhere (tests)
    place: function(lat, lng){ cur = [lat, lng]; path = []; pathFor = null; detour = false; },
    // leave the route: drive to a junction 600–2000 m away that is NOT on the route
    wrongTurn: function(){
      var M = window.DeskRoute && DeskRoute._state, v = rtView(), G = M && M.graph, R = window.LHVRoute;
      if (!v || !G || !cur) { toastSafe('Mock: start a route (Route here) first'); return false; }
      var cands = [];
      for (var i = 0; i < G.nV; i += 3) { var d = R.hav(cur[0], cur[1], G.lat[i], G.lng[i]);
        if (d > 600 && d < 2000 && R.progressOn(v.route.coords, G.lat[i], G.lng[i], G.P, 0).offM > 300) cands.push(i); }
      if (!cands.length) { toastSafe('Mock: no side road for a wrong turn here'); return false; }
      var j = cands[Math.floor(Math.random() * cands.length)], r = G.route(cur[0], cur[1], G.lat[j], G.lng[j], { maxSnapM: 2500 });
      if (!r) return false;
      path = R.simAlong(r.coords, MockGps.stepM / 0.44704, 1).slice(0, 40); detour = true;
      toastSafe('Mock: wrong turn — driving off the route'); return true;
    },
    stop: function(){ clearInterval(gpsT); gpsT = null; window.Gps.mock = false; renderPanel(); }
  };

  // ── the test panel (bottom of the map) ───────────────────────────────────
  function renderPanel(){
    var p = document.getElementById('mockpanel'); if (!p) return;
    document.getElementById('mk-link').textContent = online ? 'Link: ONLINE (click to drop)' : 'Link: OFFLINE (click to restore)';
    document.getElementById('mk-link').style.background = online ? '#173a2a' : '#4a1420';
    document.getElementById('mk-auto').textContent = auto ? 'Camera auto: ON' : 'Camera auto: off';
    document.getElementById('mk-gps').textContent = gpsT ? 'Mock NMEA: ON' : 'Mock NMEA: off';
    document.getElementById('mk-nmea').textContent = MockGps.last || '';
  }
  document.addEventListener('DOMContentLoaded', function(){
    var p = document.createElement('div'); p.id = 'mockpanel';
    p.style.cssText = 'position:absolute;z-index:600;left:50%;transform:translateX(-50%);bottom:26px;background:rgba(40,28,64,.95);border:1px solid #7a5cc0;border-radius:12px;padding:8px 10px;font:700 12px system-ui;color:#e8dcff;display:flex;flex-direction:column;gap:6px;max-width:520px';
    p.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span>MOCK TEST PANEL</span>' +
      '<button class="sbtn" id="mk-link"></button><button class="sbtn" id="mk-next">Camera: shoot next</button><button class="sbtn" id="mk-auto"></button>' +
      '<button class="sbtn" id="mk-seed">Seed morning</button><button class="sbtn" id="mk-gps"></button>' +
      (/[?&]route=1\b/.test(location.search) ? '<button class="sbtn" id="mk-wrong" title="The mock puck leaves the route down a side road">Wrong turn</button><button class="sbtn" id="mk-shoot" title="The mock camera shoots the parcel being routed to">Camera: shoot route target</button>' : '') +
      '<button class="sbtn" id="mk-reset">Reset</button></div>' +
      '<div id="mk-nmea" style="font:600 11px ui-monospace,Consolas,monospace;color:#bfa8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>';
    document.getElementById('mapwrap').appendChild(p);
    document.getElementById('mk-link').onclick = function(){ MockServer.setOnline(!online); };
    document.getElementById('mk-next').onclick = function(){ MockCam.next(); };
    document.getElementById('mk-auto').onclick = function(){ MockCam.auto(!auto); };
    document.getElementById('mk-seed').onclick = function(){ MockCam.seed(9); };
    document.getElementById('mk-gps').onclick = function(){ gpsT ? MockGps.stop() : MockGps.start(); };
    if (document.getElementById('mk-wrong')) {
      document.getElementById('mk-wrong').onclick = function(){ MockGps.wrongTurn(); };
      document.getElementById('mk-shoot').onclick = function(){ var M = window.DeskRoute && DeskRoute._state; if (M && M.target) MockCam.shootSeq(M.target); else toastSafe('Mock: no route running'); };
    }
    document.getElementById('mk-reset').onclick = function(){ timers.forEach(clearTimeout); MockCam.auto(false); MockServer.reset();
      indexedDB.deleteDatabase('lhv-desk'); localStorage.removeItem('desk_split'); setTimeout(function(){ location.reload(); }, 300); };
    renderPanel();
    // ?nopanel=1 (demo view, 10/21): hide the panel, start the mock puck and seed a morning so the desk looks like a live day
    if (/[?&]nopanel=1\b/.test(location.search)) { p.style.display = 'none'; setTimeout(function(){ try { MockCam.seed(9); } catch (e) {} try { MockGps.start(); } catch (e) {} }, 1500);
      // and open a FINISHED parcel's card (rated by the AI) so the demo shows a completed field card
      setTimeout(function(){ try { var done = Object.keys(state.logs).filter(function(k){ var l = state.logs[k]; return l && l.aiAssess && l.aiAssess.ok !== false && displayStatus(k) === 'complete'; });
        if (done.length) { _cameraSeq = null; select(done[done.length - 1], { pan: true }); } } catch (e) { console.warn(e); } }, 9000); }
  });
})();
