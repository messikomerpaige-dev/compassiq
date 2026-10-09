// Runs inside the hosted rep app (/app): who's signed in, sign out, and a periodic access check.
// If access is turned off while the app is open, CompassIQ data on the device is erased and the
// app is replaced by the /blocked page.
(function () {
  'use strict';
  if (window.__CIQ_STOP || !window.__CIQ_CLOUD) return;
  var me = window.__CIQ_CLOUD;
  var CHECK_MS = 5 * 60 * 1000;

  // The offline copy of the app and the person's doctors (see /sw.js)
  function clearOffline() {
    try {
      if (window.caches) return caches.keys().then(function (ks) {
        return Promise.all(ks.filter(function (k) { return /^ciq-(data|shell)/.test(k); }).map(function (k) { return caches.delete(k); }));
      }).catch(function () {});
    } catch (e) { /* caches blocked */ }
    return Promise.resolve();
  }
  function wipe() {
    [window.localStorage, window.sessionStorage].forEach(function (s) {
      try { Object.keys(s).forEach(function (k) { if (/^(tiq_|ciq_)/.test(k)) s.removeItem(k); }); } catch (e) { /* storage blocked */ }
    });
    clearOffline();
  }

  function signOut() {
    clearOffline().then(function () { return fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }); })
      .catch(function () {}).then(function () { location.replace('/'); });
  }

  var lastCheck = 0;
  function check() {
    lastCheck = Date.now();
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { location.replace('/?next=/app'); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (s && s.access && !s.access.active) { wipe(); clearOffline().then(function () { location.replace('/blocked'); }); }
      })
      .catch(function () { /* offline: try again later */ });
  }
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 60 * 1000) check();
  });

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

  function mount() {
    var box = el('div', 'ciq-acct');
    box.appendChild(el('div', 'ciq-acct-name', me.name || me.email));
    var where = me.territories.length === 1 ? me.territories[0]
      : me.territories.length ? me.territories.length + ' territories' : 'No territory assigned';
    box.appendChild(el('div', 'ciq-acct-sub', me.org + ' · ' + where));
    var links = el('div', 'ciq-acct-links');
    if (me.role === 'owner' || me.role === 'admin' || me.role === 'manager') {
      var tv = el('a', null, 'Team view'); tv.href = '/team'; links.appendChild(tv);
    }
    if (me.role === 'owner' || me.role === 'admin') {
      var a = el('a', null, 'Team & data'); a.href = '/admin'; links.appendChild(a);
    }
    var b = el('button', null, 'Sign out'); b.type = 'button'; b.addEventListener('click', signOut); links.appendChild(b);
    box.appendChild(links);
    var host = document.querySelector('.p3-sidebar-bottom');
    if (host) host.insertBefore(box, host.firstChild);
    else { box.classList.add('ciq-acct-float'); document.body.appendChild(box); }

    // ALL_HCPS is the app's own global (declared with let, so not on window)
    if (!me.territories.length || (typeof ALL_HCPS !== 'undefined' && Array.isArray(ALL_HCPS) && !ALL_HCPS.length)) {
      var note = el('div', 'ciq-empty-note', me.territories.length
        ? 'No doctors have been published for your territory yet. Ask your CompassIQ admin to publish the doctor file.'
        : 'You haven’t been given a territory yet. Ask your CompassIQ admin to assign one.');
      document.body.appendChild(note);
      setTimeout(function () { note.classList.add('show'); }, 50);
      note.addEventListener('click', function () { note.remove(); });
    }
  }

  // First-run welcome: the cloud already knows the rep's name and territory — fill them in
  function prefillWelcome() {
    var orig = window._obOpen;
    if (typeof orig !== 'function' || orig._ciq) return;
    window._obOpen = function () {
      var r = orig.apply(this, arguments);
      try {
        var name = document.getElementById('ob-rep'), sel = document.getElementById('ob-terr');
        if (name && !name.value && me.name) name.value = me.name;
        if (sel && !sel.value && sel.options.length === 2) {         // placeholder + their one territory
          sel.value = sel.options[1].value;
          if (typeof window._obCheck === 'function') window._obCheck();
          setTimeout(function () { var z = document.getElementById('ob-zip'); if (z) z.focus(); }, 120);
        }
      } catch (e) { /* welcome screen changed shape */ }
      return r;
    };
    window._obOpen._ciq = true;
    var ob = document.getElementById('ob');
    if (ob && ob.classList.contains('show')) window._obOpen();      // already showing: refill it
  }

  // No downloadable copies of the app: its data lives in CompassIQ, not in files
  function noFileBackups() {
    var off = function () {
      if (typeof showToast === 'function') showToast('Backups to a file are turned off — your doctors come from CompassIQ when you sign in');
    };
    window.saveBackupFile = off; window.saveToFile = off;
    ['p3-save', 'backup-btn'].forEach(function (id) { var b = document.getElementById(id); if (b) b.style.display = 'none'; });
  }

  // ── Plans and settings saved to the person's account (Phase 2) ───────────
  // Every save is uploaded (at most every 15 s, and when the app goes to the background), so a new
  // iPad or a reinstall picks up where they left off. The server sends it back on open when newer.
  var stateTimer = null, stateDirty = false, stateSending = false;
  function uploadState() {
    clearTimeout(stateTimer); stateTimer = null;
    if (!stateDirty || stateSending || !navigator.onLine) return;
    var body;
    try { body = JSON.stringify({ data: { T: TERRITORIES, A: ACTIVE_TERRITORY_ID } }); } catch (e) { return; }
    stateDirty = false; stateSending = true;
    fetch('/api/state', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (d) { try { localStorage.setItem('ciq_state_at', d.at); } catch (e) {} })
      .catch(function () { stateDirty = true; stateTimer = setTimeout(uploadState, 60000); })
      .then(function () { stateSending = false; });
  }
  function watchState() {
    var orig = window.saveState;
    if (typeof orig !== 'function' || orig._ciqState) return;
    window.saveState = function () {
      var r = orig.apply(this, arguments);
      stateDirty = true;
      if (!stateTimer) stateTimer = setTimeout(uploadState, 15000);
      return r;
    };
    window.saveState._ciqState = true;
    // Copy any other wrappers' flags (the sync module marks its wrapper too)
    if (orig._ciqSync) window.saveState._ciqSync = true;
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') uploadState(); });
    window.addEventListener('online', function () { if (stateDirty) uploadState(); });
    window.CIQState = { upload: function () { stateDirty = true; uploadState(); } };
  }

  // ── Moved to another territory by an admin ────────────────────────────
  function checkTerritoryMove() {
    if (me.role !== 'rep' || me.territories.length !== 1) return;
    var cur = '';
    try { cur = (TERRITORIES[ACTIVE_TERRITORY_ID] || {}).name || ''; } catch (e) { return; }
    var assigned = me.territories[0];
    if (!cur || cur === assigned || typeof window._obOpen !== 'function') return;
    window._obOpen(true);
    var lead = document.getElementById('ob-lead');
    if (lead) lead.textContent = 'Your admin moved you to ' + assigned + '. Confirm your home ZIP to load its doctors — your hours, home ZIP and time off stay the same.';
  }

  // ── Call activity from the data warehouse ───────────────────────────────
  // On open (and right after first-time setup), fetch this quarter's completed calls for the rep's
  // doctors. When they changed since last time, apply them; the plan then rebuilds itself from the
  // "calls through" date (see ciqRebuildFromActivity in the app).
  function quarterStartIso() {
    var d = new Date(), q = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
    return q.getFullYear() + '-' + String(q.getMonth() + 1).padStart(2, '0') + '-01';
  }
  function pullActivity() {
    if (!navigator.onLine || typeof window.applyActivityRows !== 'function') return;
    fetch('/api/activity?from=' + quarterStartIso(), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (!res || !Array.isArray(res.calls) || !res.calls.length || !res.asOf) return;
        if (typeof STATE === 'undefined' || !STATE.hcps || !STATE.hcps.length) return;     // not set up yet
        var sig = res.asOf + '|' + res.calls.length;
        if (STATE.actLiveSig === sig) return;                                              // nothing new
        var rows = [['NPI', 'Call_Date', 'Call_Type', 'Status']].concat(res.calls.map(function (c) { return [c.npi, c.date, c.type || '', c.status || '']; }));
        var r = window.applyActivityRows(rows, 'Data warehouse', 'live', res.asOf);
        if (r && r.ok) { STATE.actLiveSig = sig; saveState(); }
      })
      .catch(function () { /* offline: next time */ });
  }
  function pullAfterSetup() {
    var orig = window._obGo;
    if (typeof orig !== 'function' || orig._ciqPull) return;
    window._obGo = function () { var r = orig.apply(this, arguments); setTimeout(pullActivity, 1200); return r; };
    window._obGo._ciqPull = true;
  }
  window.CIQActivity = { pull: pullActivity };

  // ── Offline mode ────────────────────────────────────────────────────────
  // The service worker (/sw.js, registered by the app) keeps the app and these doctors on the
  // device. On the first open it isn't in charge yet, so ask it to fetch a copy once.
  function warmOffline() {
    if (!('serviceWorker' in navigator) || !navigator.onLine) return;
    var pages = Math.floor(((typeof ALL_HCPS !== 'undefined' && ALL_HCPS.length) || 0) / 2000) + 1;
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.active) reg.active.postMessage({ type: 'CIQ_WARM', pages: pages });
    }).catch(function () {});
  }
  function offlineBanner() {
    var bar = el('div', 'ciq-offline', 'Offline — your changes are kept on this device and sync when you’re back online.');
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
    function update() { bar.classList.toggle('show', !navigator.onLine); }
    window.addEventListener('online', update); window.addEventListener('offline', update);
    update();
  }

  function start() {
    mount(); prefillWelcome(); noFileBackups(); watchState(); pullAfterSetup(); offlineBanner();
    setTimeout(warmOffline, 4000);
    setTimeout(checkTerritoryMove, 600);
    setTimeout(pullActivity, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
