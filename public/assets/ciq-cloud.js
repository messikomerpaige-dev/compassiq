// Runs inside the hosted rep app (/app): who's signed in, sign out, and a periodic access check.
// If access is turned off while the app is open, CompassIQ data on the device is erased and the
// app is replaced by the /blocked page.
(function () {
  'use strict';
  if (window.__CIQ_STOP || !window.__CIQ_CLOUD) return;
  var me = window.__CIQ_CLOUD;
  var CHECK_MS = 5 * 60 * 1000;

  function wipe() {
    [window.localStorage, window.sessionStorage].forEach(function (s) {
      try { Object.keys(s).forEach(function (k) { if (/^(tiq_|ciq_)/.test(k)) s.removeItem(k); }); } catch (e) { /* storage blocked */ }
    });
  }

  function signOut() {
    fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' })
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
        if (s && s.access && !s.access.active) { wipe(); location.replace('/blocked'); }
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

  function start() { mount(); prefillWelcome(); noFileBackups(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
