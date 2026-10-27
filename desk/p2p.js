/* desk/p2p.js — DIRECT LINK laptop ⇄ camera (Dustin 2026-10-11: "build it so we can test").
 *
 * WHY: the camera's LOCK reached the laptop only through the internet (camera → server →
 * laptop). With no service, the laptop stood still. When the laptop and the camera phone are on the
 * SAME WIFI (a USB wifi router in the car, or the house wifi for the desk test), this opens
 * a direct line between the two pages over that wifi — no internet in the path:
 *   - it is SET UP through the server while there is signal (the offer/answer below);
 *   - once open it carries the camera's "now on N" (its LOCK) STRAIGHT to the laptop,
 *     so the laptop keeps following the camera with or without internet;
 *   - local addresses ONLY (no STUN/TURN servers): it never routes over the internet.
 * The server path keeps running beside it unchanged.
 * THE CAMERA LEADS, THE LAPTOP FOLLOWS (Dustin 10/15): the laptop never sends a parcel to
 * the camera (tap-to-camera was removed); laptop → camera carries only the heartbeat.
 * Status: the ⇄ chip on the top row — green = direct line open, grey = not.
 * Signalling paths: sessions/<DRV>/p2p/offer {id, sdp, ts} · sessions/<DRV>/p2p/answer {id, sdp, ts}
 *                   sessions/<DRV>/p2p/want {ts, why} — the camera asking for a new line
 *
 * DEAD ZONE (plan: fieldlog/_plans/DIRECT_LINE_DEADZONE.md). A line that FAILS can only be set
 * up again through the server, so: (1) the chip is green only while the camera's heartbeat
 * actually arrives down the line (13 s, the same rule as the 📷 chip), never on "open" alone;
 * (2) a failed line is dropped at once (10/11: Chrome called it failed 10 s after the camera
 * went quiet); (3) the moment the camera has signal again it writes p2p/want and a new
 * line is offered within seconds, instead of waiting for the 15 s retry.
 */
(function () {
  'use strict';
  var pc = null, dc = null, offerId = null, lastTry = 0, wired = false, upSince = 0;
  var HB_OK = 13000, lastHb = 0, camWl = null;   // camWl: does the camera hold its screen-on lock (from its heartbeat)
  function isOpen() { return !!(dc && dc.readyState === 'open'); }
  function live() { return isOpen() && Date.now() - Math.max(lastHb, upSince) < HB_OK; }

  function chip() {
    var c = document.getElementById('p2p-pill');
    if (!c) { var row = document.querySelector('#log .topbar .pillrow'); if (!row) return null;
      c = document.createElement('span'); c.id = 'p2p-pill'; c.className = 'pill ico'; c.textContent = '⇄'; row.appendChild(c); }
    return c;
  }
  function render() {
    var c = chip(); if (!c) return; var up = live();
    c.className = 'pill ico ' + (up ? 'ok' : 'warn'); c.style.opacity = up ? '1' : '.55';
    c.textContent = '⇄';
    c.title = up ? 'Direct line to the camera is OPEN — the laptop follows the camera with or without internet'
        + (camWl === false ? ' · camera screen may turn itself off (screen-on lock refused)' : '')
      : (isOpen() ? 'Direct line is not answering — waiting for the camera'
        : 'No direct line to the camera — the laptop follows it through the server; the line comes back when there is signal');
  }
  function send(o) { if (isOpen()) { try { dc.send(JSON.stringify(o)); return true; } catch (e) {} } return false; }

  function onMsg(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    lastHb = Date.now();                              // anything down the line proves it is alive
    if (m.wl != null) camWl = !!m.wl;
    if (m.t === 'active' && m.seq != null) {          // the camera's lock, straight back (same as the 'active' echo)
      var s = String(m.seq), changed = s !== window._cameraSeq; window._cameraSeq = s;
      try { if (changed && window._followCam) window.select(s, { pan: true, from: 'camera' }); } catch (e) {}
      try { window.renderAll(); } catch (e) {}
    } else if (m.t === 'hb') {
      window._camHbSeenAt = Date.now(); try { window.renderLink(); } catch (e) {}
    }
  }
  function close() { try { if (dc) dc.close(); } catch (e) {} try { if (pc) pc.close(); } catch (e) {} pc = null; dc = null; render(); }

  function gathered(p) {   // local addresses only: gathering finishes in well under a second
    return new Promise(function (res) {
      if (p.iceGatheringState === 'complete') return res();
      var t = setTimeout(res, 2500);
      p.addEventListener('icegatheringstatechange', function () { if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  function offer() {
    var L = window.link; if (!L || !L.ready || !L.connected) return;
    lastTry = Date.now(); close();
    offerId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    var myId = offerId;
    pc = new RTCPeerConnection({ iceServers: [] });
    dc = pc.createDataChannel('lhv', { ordered: true });
    dc.onopen = function () { upSince = Date.now(); lastHb = 0; render(); try { window.toast('⇄ Direct line to the camera is open', 2500); } catch (e) {} };
    dc.onclose = function () { render(); };
    dc.onmessage = onMsg;
    pc.onconnectionstatechange = function () {
      if (offerId !== myId || !pc) return;
      var st = pc.connectionState; diag(myId, 'conn ' + st);
      // 'disconnected' can still come back by itself; 'failed' never does — drop it so a new line can be offered
      if (st === 'failed') { close(); try { window.toast('⇄ Direct line lost — it comes back when there is signal', 3500); } catch (e) {} }
      else if (st === 'closed') render();
    };
    pc.oniceconnectionstatechange = function () { diag(myId, 'ice ' + (pc && pc.iceConnectionState)); if (pc && /failed|disconnected/.test(pc.iceConnectionState)) pairs(myId); };
    pc.onicecandidateerror = function (e) { diag(myId, 'candErr ' + (e.errorCode || '') + ' ' + (e.errorText || '')); };
    setTimeout(function () { if (offerId === myId && pc) pairs(myId); }, 9000);
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { return gathered(pc); }).then(function () {
      if (offerId !== myId || !pc) return;
      _diag = []; diag(myId, 'offer sent');
      return L.set('p2p/offer', { id: myId, sdp: pc.localDescription.sdp, ts: Date.now() });
    }).catch(function () {});
  }
  // DIAGNOSTICS (10/11 desk test: setup exchanged, line never opened): each step → sessions/<DRV>/p2p/diagL
  var _diag = [];
  function diag(id, msg) { _diag.push(Math.round((Date.now() % 600000) / 100) / 10 + 's ' + msg); if (_diag.length > 40) _diag.shift();
    try { window.link.set('p2p/diagL', { id: id, ua: navigator.userAgent.slice(0, 80), steps: _diag.slice(), ts: Date.now() }); } catch (e) {} }
  function pairs(id) { if (!pc) return; pc.getStats().then(function (st) { var out = [];
    st.forEach(function (r) { if (r.type === 'candidate-pair') out.push(r.state + ' nom=' + !!r.nominated + ' req=' + (r.requestsSent || 0) + '/' + (r.responsesReceived || 0) + ' in=' + (r.requestsReceived || 0));
      if (r.type === 'remote-candidate' || r.type === 'local-candidate') out.push(r.type.slice(0, 6) + ' ' + (r.address || r.ip || '?') + ':' + r.port + ' ' + r.candidateType); });
    diag(id, 'stats ' + out.join(' ; ')); }).catch(function () {}); }
  function wire() {
    var L = window.link; if (wired || !L || !L.on) return; wired = true;
    L.on('p2p/answer', function (a) {
      if (!a || a.id !== offerId || !pc || pc.signalingState !== 'have-local-offer') return;
      diag(a.id, 'answer received'); pc.setRemoteDescription({ type: 'answer', sdp: a.sdp }).then(function () { diag(a.id, 'answer applied'); }).catch(function (e) { diag(a.id, 'answer FAILED ' + (e && e.message)); });
    });
    // the camera asking for a line (it lost one, reloaded, or just got signal back): offer at once.
    // The want itself proves the camera is alive. 120 s = the camera's own limit on an old offer.
    L.on('p2p/want', function (w) {
      if (!w || !w.ts || Math.abs(Date.now() - Number(w.ts)) > 120000 || live()) return;
      if (Date.now() - lastTry < 4000) return;          // an offer just went out; it answers that one
      offer();
    });
  }
  // keep a line open: (re)offer while there is signal, the camera is alive, and no line is answering
  setInterval(function () {
    var L = window.link; render(); if (!L || !L.ready) return; wire();
    var camAlive = window._camHbSeenAt && Date.now() - window._camHbSeenAt < 30000;
    if (!live() && L.connected && camAlive && Date.now() - lastTry > 15000) offer();
  }, 3000);
  setInterval(function () { send({ t: 'hb', at: Date.now() }); }, 5000);

  window.DeskP2P = { state: function () { return { open: isOpen(), live: live(), lastHb: lastHb, camWl: camWl, since: upSince, pc: pc && pc.connectionState }; } };
})();
