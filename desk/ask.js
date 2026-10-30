'use strict';
// ── ASK CLAUDE on the laptop (Dustin 10/26 night: option 1; look approved 9:05 PM ET) ─────────────────────────
// A round orange Claude button in the map's bottom-left corner. Tap it, ask out loud. The laptop says
// "Heard, give me a second." at once (restaurant rule), sends the question to the server (askClaude, signed in
// as this driver), shows + speaks the answer, and offers the one action (Load drive file / SHIP / Reopen N).
// Also two REAL status chips in the left panel: "New sheet ready" (live file rows vs the sheet loaded here) and
// "Safe to ship" (camera queue + today's closes). Loads after desk.html's own script; uses its globals.
(function(){
  if (typeof window === 'undefined' || !document.getElementById('map')) return;
  var ASK_URL = 'https://us-central1-lhv-field-log.cloudfunctions.net/askClaude';
  var AS = (function(){ try { return (new URLSearchParams(location.search).get('as') || '').toUpperCase(); } catch (e) { return ''; } })();

  // ── styles ──
  var css = document.createElement('style'); css.textContent = [
    '#askc-fab{position:absolute;left:10px;bottom:10px;z-index:900;width:58px;height:58px;border-radius:50%;border:3px solid #fff;background:#d97757;box-shadow:0 4px 14px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '#askc-fab:hover{transform:scale(1.06)} #askc-fab.on{box-shadow:0 0 0 8px rgba(217,119,87,.35),0 4px 14px rgba(0,0,0,.45)}',
    '#askc-pop{position:absolute;left:10px;bottom:78px;z-index:901;width:330px;max-width:calc(100% - 32px);background:#141a33;border:1px solid #d97757;border-radius:12px;padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.55);color:#e6eaf5;display:none}',
    '#askc-pop .askc-head{display:flex;align-items:center;font:800 13px system-ui;color:#f0b49c}',
    '#askc-pop .askc-head button{margin-left:auto;background:none;border:0;color:#8a93ad;font-size:15px;cursor:pointer}',
    '#askc-pop .askc-listen{margin:8px 0;padding:10px;border-radius:8px;background:#0f1430;border:1px dashed #3b4a8a;font:600 13px system-ui;color:#a9b4d6;text-align:center}',
    '#askc-pop .askc-listen.on{border:1px solid #d97757;color:#ffd2c2;animation:askcPulse 1s infinite} @keyframes askcPulse{50%{background:#2a1a14}}',
    '#askc-pop .askc-qa{background:#0f1430;border:1px solid #2a3350;border-radius:8px;padding:9px}',
    '#askc-pop .askc-qa .q{font:600 12px system-ui;color:#8a93ad} #askc-pop .askc-qa .a{margin-top:5px;font:600 14px/1.35 system-ui} #askc-pop .askc-qa .a b{color:#7fb0ff}',
    '#askc-pop .askc-qa .act{margin-top:8px;width:100%;border:0;border-radius:7px;padding:8px;background:#3b6cff;color:#fff;font:800 13px system-ui;cursor:pointer}',
    '#askc-pop .askc-qa .meta{margin-top:6px;font:500 10px system-ui;color:#5d6788}',
    '#askc-pop .askc-type{display:flex;gap:6px;margin:6px 0} #askc-pop .askc-type input{flex:1;min-width:0;border-radius:8px;border:1px solid #3a4680;background:#0f1428;color:#e6eaf5;padding:8px;font:600 13px system-ui} #askc-pop .askc-type button{border:0;border-radius:8px;padding:0 12px;background:#d97757;color:#fff;font:800 13px system-ui;cursor:pointer}',
    '#askc-pop .askc-try{font:500 11px system-ui;color:#8a93ad;margin-top:6px}',
    '#askc-chips{margin:6px 0} .askc-chip{border-radius:8px;padding:7px 9px;font:600 12.5px/1.3 system-ui;display:flex;align-items:center;gap:8px;margin:5px 0}',
    '.askc-chip.warn{background:#3a2e10;border:1px solid #b88a1a;color:#ffd77a} .askc-chip.ok{background:#0f2e1c;border:1px solid #2f8f55;color:#8ff0b5} .askc-chip.bad{background:#3a1414;border:1px solid #a33;color:#ffb3b3}',
    '.askc-chip button{margin-left:auto;border:0;border-radius:6px;padding:4px 9px;font:800 12px system-ui;background:#ffd77a;color:#2a1e00;cursor:pointer}',
    '#gpsbar{left:auto!important;right:12px!important;bottom:12px!important} #tilebar{bottom:56px!important}',
    '#mph{position:absolute!important;left:80px;bottom:12px;z-index:560}',
    '.leaflet-control-attribution{font-size:8px!important;opacity:.55;background:rgba(0,0,0,.35)!important;color:#ccc!important;max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .leaflet-control-attribution a{color:#ccc!important}'
  ].join('\n'); document.head.appendChild(css);

  // ── button + pop-up on the map ──
  var wrap = document.getElementById('mapwrap');
  var fab = document.createElement('button'); fab.id = 'askc-fab'; fab.title = 'Ask Claude';
  fab.innerHTML = '<svg viewBox="0 0 100 100" width="30" height="30" aria-hidden="true"><g fill="#fff"><path d="M50 6 L55 40 L50 50 L45 40Z"/><path d="M50 94 L45 60 L50 50 L55 60Z"/><path d="M6 50 L40 45 L50 50 L40 55Z"/><path d="M94 50 L60 55 L50 50 L60 45Z"/><path d="M19 19 L44 41 L50 50 L41 44Z"/><path d="M81 81 L56 59 L50 50 L59 56Z"/><path d="M81 19 L59 44 L50 50 L56 41Z"/><path d="M19 81 L41 56 L50 50 L44 59Z"/></g></svg>';
  var pop = document.createElement('div'); pop.id = 'askc-pop';
  pop.innerHTML = '<div class="askc-head"><span>Ask Claude</span><button id="askc-x" title="Close">✕</button></div>'
    + '<div id="askc-listen" class="askc-listen">Tap the Claude button and ask out loud.</div>'
    + '<div class="askc-type"><input id="askc-in" placeholder="…or type your question" autocomplete="off"><button id="askc-send">Ask</button></div><div id="askc-a"></div>'
    + '<div class="askc-try">Ask anything about your day: reload, safe to ship, what is left, a stuck parcel, the camera.</div>';
  wrap.appendChild(fab); wrap.appendChild(pop);
  try { var m = document.getElementById('mph'); if (m) wrap.appendChild(m); } catch (e) {}
  var chips = document.createElement('div'); chips.id = 'askc-chips';
  try { var nb = document.getElementById('nextbar'); nb.parentNode.insertBefore(chips, nb); } catch (e) {}

  var $ = function(id){ return document.getElementById(id); };
  // desk-p43: what the button did last, in the 30-s screen report (Mike 10/27: "isn't working", nothing reached the server)
  var st = window.__askState = { taps: 0, lastTap: 0, lastErr: '', lastSent: 0, lastOk: 0, typed: 0 };
  var say = function(text){ try { speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(String(text)); u.rate = 1.0; speechSynthesis.speak(u); } catch (e) {} };
  var open = function(){ pop.style.display = 'block'; };
  var close = function(){ pop.style.display = 'none'; try { speechSynthesis.cancel(); } catch (e) {} };
  $('askc-x').onclick = close;

  function render(q, answer, action, meta){
    var now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var btn = '';
    if (action === 'LOAD_DRIVE_FILE') btn = 'Get the newest sheet'; else if (action === 'SHIP') btn = 'SHIP'; else if (/^REOPEN:\d+$/.test(action || '')) btn = 'Reopen ' + action.slice(7);
    var html = String(answer).replace(/[&<>]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }).replace(/(\d[\d,]*)/g, '<b>$1</b>');
    $('askc-a').innerHTML = '<div class="askc-qa"><div class="q">You asked, ' + now + ': “' + String(q).replace(/[<>]/g, '') + '”</div><div class="a">' + html + '</div>'
      + (btn ? '<button class="act" id="askc-act">' + btn + '</button>' : '') + '<div class="meta">' + meta + '</div></div>';
    if (btn) $('askc-act').onclick = function(){ runAction(action); };
    say(answer);
  }
  function runAction(action){
    try {
      if (action === 'LOAD_DRIVE_FILE') { close(); (async function(){ try { var d = await DB.get('kv', 'day'); if (d) { d.sheetReadyAt = 0; await DB.put('kv', 'day', d); } } catch (e) {} if (window.deskAutoSheet) window.deskAutoSheet('ask'); toast('Getting the newest sheet — it loads by itself between parcels.', 4000); })(); }
      else if (action === 'SHIP') { close(); shipSession(); }
      else if (/^REOPEN:\d+$/.test(action || '')) { close(); select(String(action.slice(7))); setTimeout(function(){ actReopen(); }, 300); }
    } catch (e) { try { toast('Could not run that here: ' + (e && e.message || e), 4000); } catch (e2) {} }
  }
  function askServer(q){
    open();
    if (String(q || '').replace(/[^a-z0-9]/gi, '').length < 4) { $('askc-listen').textContent = 'Didn\'t catch a question. Tap the button and ask about your day.'; return; }   // nothing empty ever goes to the server
    var now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('askc-a').innerHTML = '<div class="askc-qa"><div class="q">You asked, ' + now + ': “' + String(q).replace(/[<>]/g, '') + '”</div><div class="a" style="color:#f0b49c">Heard, give me a second.</div></div>';
    say('Heard, give me a second.');
    if (navigator.onLine === false) { $('askc-a').querySelector('.a').textContent = 'Heard. No internet on the laptop right now — your question goes out the moment the signal is back.'; say('No signal right now. I will answer as soon as it is back.'); pending = q; return; }
    var user = (window.firebase && firebase.auth && firebase.auth().currentUser) || null;
    if (!user) { $('askc-a').querySelector('.a').textContent = 'Heard, give me a second. The laptop is still signing in; ask again in a moment.'; return; }
    var t0 = Date.now(), slow = setTimeout(function(){ var a = $('askc-a').querySelector('.a'); if (a) a.textContent = 'Still checking…'; say('Still checking.'); }, 10000);
    st.lastSent = Date.now();
    user.getIdToken().then(function(tok){
      return fetch(ASK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: tok, question: q, drv: AS || undefined }) });
    }).then(function(r){ return r.json(); }).then(function(j){
      clearTimeout(slow);
      if (!j || !j.ok) { render(q, 'Heard, give me a second.', null, 'Claude · the server did not answer (' + ((j && j.error) || 'no answer') + '); it comes back shortly'); return; }
      st.lastOk = Date.now(); st.lastErr = ''; if (askServer._triesBy) delete askServer._triesBy[q];   // this question's retries start over (audit r7)
      render(q, j.say, j.action, 'Claude · checked your laptop, camera and the live file · ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (AS ? ' · as ' + AS : ''));
    }).catch(function(e){ clearTimeout(slow); st.lastErr = 'send: ' + String(e && e.message || e).slice(0, 60); render(q, 'Heard, give me a second.', null, 'Claude · ' + String(e && e.message || e).slice(0, 80));
      // a question is never dropped (full audit #5): kept and sent again when the link answers — on 'online' or in 30 s, up to 3 times
      // only a NETWORK failure is re-sent (a server error already reached the office — no second answer); one copy in flight
      try { var _net = /fetch|network|failed to fetch|load failed|abort/i.test(String(e && e.message || e)) || navigator.onLine === false;
        if (_net && pending !== q) { pending = q; var _tm = (askServer._triesBy = askServer._triesBy || {}); var _tries = (_tm[q] = (_tm[q] || 0) + 1);   /* per question (audit r6) */
          if (_tries <= 3) setTimeout(function(){ if (pending === q) { pending = null; askServer(q); } }, 30000); } } catch (e2) {} });
  }
  // ── THE OFFICE ANSWER (Dustin 10/26): a HOLD question is picked up by the Field App Claude; its answer lands in
  // sessions/<D>/askReply and shows up (and is spoken) in this same box, so the driver never has to look elsewhere.
  var lastReplyAt = 0;
  // one handler for both paths (desk-p51): the listener and the 30-s ping's answer, which needs no live listener
  // (MT 10/28: the office's answers never showed while the laptop's listeners were stalled). Each answer shows once.
  // desk-p54 (MT 10/29 1:04 PM "whenever I refresh it goes back to pull up this older message"): sessions/<D>/askReply
  // stays on the server, and "shown once" lived only in memory, so every reload popped the 11:33 answer again. Now an
  // answer is marked seen on THIS laptop (localStorage askc_seen = the newest answer time shown here) the moment it
  // shows, and an answer older than 30 min never pops by itself. A reload never re-opens it.
  var REPLY_FRESH_MS = 30 * 60000, SEEN_KEY = 'askc_seen';
  var seenAt = function(){ try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) { return 0; } };
  var markSeen = function(at){ try { if (Number(at) > seenAt()) localStorage.setItem(SEEN_KEY, String(Number(at))); } catch (e) {} };
  function replyIn(v){ try { if (!v || !v.at) return; var at = Number(v.at);
    if (!(at > 0) || at <= lastReplyAt || at <= seenAt()) return; lastReplyAt = at;
    if (Date.now() - at > REPLY_FRESH_MS) { markSeen(at); st.replyOld = at; return; }   /* an old answer never pops by itself */
    markSeen(at);
    open(); render(v.q || 'your question', v.say || '', v.action || null, 'Claude · answered by the office'); st.replyAt = at; } catch (e) {} }
  window.__askReplyIn = replyIn;
  function watchReplies(){
    try { if (!window.link || !link.on || watchReplies.done) return; watchReplies.done = true;
      link.on('askReply', replyIn);
    } catch (e) {}
  }
  setInterval(watchReplies, 3000);
  var pending = null;
  window.addEventListener('online', function(){ if (pending) { var q = pending; pending = null; askServer(q); } });

  function listen(){
    open();
    var R = window.SpeechRecognition || window.webkitSpeechRecognition, L = $('askc-listen');
    st.taps++; st.lastTap = Date.now();
    var typeIt = function(why){ st.lastErr = why; L.className = 'askc-listen'; fab.classList.remove('on'); try { $('askc-in').focus(); } catch (e) {} };
    if (navigator.onLine === false) { L.textContent = 'No internet on the laptop right now, so I can\'t hear you. Type your question and it goes out the moment the signal is back.'; typeIt('offline'); return; }
    if (!R) { L.textContent = 'This laptop can\'t listen. Type your question below.'; typeIt('no-speech-api'); return; }
    var r = new R(); r.lang = 'en-US'; r.interimResults = true; r.maxAlternatives = 1;
    L.className = 'askc-listen on'; L.textContent = 'Listening…'; fab.classList.add('on');
    var done = false, heardAudio = false, heardSpeech = false;
    // 10/27 Mike: "Didn't catch that" every time, mic permission ON — the mic gave no sound and nothing recorded why.
    // Now the laptop reports WHICH case it was (no sound from the mic vs sound but no words), so the office can see it.
    r.onaudiostart = function(){ heardAudio = true; }; r.onspeechstart = function(){ heardSpeech = true; };
    r.onresult = function(e){ var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; L.textContent = '“' + t + '”'; if (e.results[e.results.length - 1].isFinal && !done) { done = true; askServer(t.trim()); } };
    r.onend = function(){ L.className = 'askc-listen'; fab.classList.remove('on');
      if (!done && /Listening/.test(L.textContent)) {
        L.textContent = heardAudio ? 'Didn\'t catch the words. Type your question below, or tap and ask again.' : 'The microphone sent no sound. Type your question below.';
        typeIt(heardAudio ? (heardSpeech ? 'speech-no-words' : 'audio-no-speech') : 'mic-no-sound'); } };
    r.onerror = function(ev){ var e = (ev && ev.error) || 'error'; L.textContent = e === 'not-allowed' ? 'The microphone is blocked on this laptop. Type your question below.' : e === 'network' ? 'No internet for listening right now. Type your question below — it goes out when the signal is back.' : 'Didn\'t catch that. Tap and ask again, or type it below.'; typeIt(e); };
    try { r.start(); } catch (e) { L.textContent = 'Type your question below.'; typeIt('start: ' + String(e && e.message || e).slice(0, 40)); }
  }
  window.askClaudeAsk = askServer;
  var sendTyped = function(){ var v = String($('askc-in').value || '').trim(); if (!v) return; $('askc-in').value = ''; st.typed++; askServer(v); };
  $('askc-send').onclick = sendTyped; $('askc-in').addEventListener('keydown', function(e){ if (e.key === 'Enter') sendTyped(); });   // typed question (console / tests / a future keyboard box)
  fab.onclick = function(){ if (pop.style.display === 'block' && $('askc-listen').className.indexOf('on') >= 0) return; listen(); };

  // ── REAL status chips (the "onboarding" Dustin liked): new sheet ready · safe to ship ──
  var liveRows = null, liveReadyAt = 0;
  function watchCounts(){
    try {
      if (!window.firebase || !firebase.database || !window.state || !state.job || !state.job.bucket) return;
      firebase.database().ref('counts').on('value', function(snap){
        var v = snap.val() || {}, rows = null, at = 0;
        Object.keys(v).forEach(function(k){ var c = v[k]; if (c && c.bucket === state.job.bucket && c.driveFileReady && c.driveFileRows) { rows = c.driveFileRows; at = Math.max(at, Number(c.readyAt || c.updatedAt || 0)); } });
        liveRows = rows; liveReadyAt = at; renderChips();
      });
    } catch (e) {}
  }
  function renderChips(){
    try {
      var out = '';
      var loaded = (window.state && state.seqs) ? state.seqs.length : 0;
      if (liveRows && loaded && liveRows !== loaded) out += '<div class="askc-chip ok">⟳ New sheet coming in — it loads by itself between parcels. Nothing to do.</div>';
      var cs = window._camSync || {}, pend = Number(cs.pending || 0), parked = Number(cs.parked || 0);
      var live = cs.at && (Date.now() - Number(cs.at)) < 3 * 60000;
      if (live && pend === 0 && parked === 0) out += '<div class="askc-chip ok">✓ Safe to ship: 0 uploading, every close has photos</div>';
      else if (live && pend > 0) out += '<div class="askc-chip warn">↑ ' + pend + ' photo' + (pend > 1 ? 's' : '') + ' still uploading — not yet safe to ship</div>';
      else if (live && parked > 0) out += '<div class="askc-chip bad">⚠ ' + parked + ' photo' + (parked > 1 ? 's' : '') + ' failed to upload — ask me before you ship</div>';
      chips.innerHTML = out;
      var lb = $('askc-load'); if (lb) lb.onclick = function(){ showStart(); };
    } catch (e) {}
  }
  var booted = false;
  setInterval(function(){ if (!booted && window.state && state.job && state.job.bucket) { booted = true; watchCounts(); } renderChips(); }, 5000);
})();
