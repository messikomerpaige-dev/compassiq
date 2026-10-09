// Runs inside the hosted admin tool (/admin/tool). Replaces the tool's local sign-in with the
// real CompassIQ login, and makes "Publish" send the doctor data to the cloud (in chunks)
// instead of downloading a rep file.
(function () {
  'use strict';
  var CHUNK = 1000;

  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  // Only owners and admins may use the tool
  api('/api/session').then(function (s) {
    var m = s.access && s.access.member;
    if (!s.access.active || !m || (m.role !== 'owner' && m.role !== 'admin')) { location.replace(s.home || '/'); return; }
    window.__CIQ_ADMIN = s;
    ready(s);
  }).catch(function (e) {
    location.replace(e.status === 401 ? '/?next=/admin/tool' : '/');
  });

  function ready(s) {
    function go() {
      try { sessionStorage.setItem('ciq_admin_ok', '1'); } catch (e) { /* storage blocked */ }
      var cred = document.querySelector('#agx .agx-links details');      // the old local sign-in settings
      if (cred) cred.remove();
      var links = document.querySelector('#agx .agx-links');
      if (links && !document.getElementById('ciq-team-link')) {
        var a = document.createElement('a'); a.id = 'ciq-team-link'; a.className = 'agx-link'; a.href = '/admin';
        a.textContent = '← Team & territories'; links.insertBefore(a, links.firstChild);
      }
      var lead = document.querySelector('#agx-publish .lead');
      if (lead) lead.textContent = 'Signed in as ' + s.email + ' · ' + s.access.org.name + '. Load your doctor file, then publish it to your reps.';
      if (typeof window._agxShow === 'function') window._agxShow('agx-publish');
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }

  var TREND_KEYS = ['trend', 'trendL13w', 'trendPrior', 'trendPct', 'trendNote'];

  // Same contract as the tool's own _ciqDoPublish: resolves { ok, name, count, territories, trends }
  window._ciqDoPublish = function (includeTrends) {
    if (typeof closeModal === 'function') { try { closeModal(); } catch (e) { /* no modal open */ } }
    var toast = typeof showToast === 'function' ? showToast : function () {};
    var all = (typeof ALL_HCPS !== 'undefined' && Array.isArray(ALL_HCPS)) ? ALL_HCPS : [];
    if (!all.length) { toast('⚠ Load an HCP data file first'); return Promise.resolve({ ok: false, error: 'Load an HCP data file first' }); }
    var missing = all.filter(function (h) { return !String(h.territory || '').trim(); }).length;
    if (missing) {
      var msg = missing.toLocaleString() + ' doctors have no territory — fix the file and load it again';
      toast('⚠ ' + msg); return Promise.resolve({ ok: false, error: msg });
    }
    var rows = all.map(function (h) {
      var o = Object.assign({}, h);
      if (!includeTrends) TREND_KEYS.forEach(function (k) { delete o[k]; });
      return o;
    });
    var publishId, sent = 0;
    toast('Publishing ' + rows.length.toLocaleString() + ' doctors…');
    return api('/api/admin', { action: 'publish_begin' }).then(function (r) {
      publishId = r.publish_id;
      var chain = Promise.resolve();
      for (var i = 0; i < rows.length; i += CHUNK) {
        (function (chunk) {
          chain = chain.then(function () {
            return api('/api/admin', { action: 'publish_rows', publish_id: publishId, rows: chunk }).then(function () {
              sent += chunk.length;
              if (rows.length > CHUNK) toast('Publishing… ' + Math.round(sent / rows.length * 100) + '%');
            });
          });
        })(rows.slice(i, i + CHUNK));
      }
      return chain;
    }).then(function () {
      return api('/api/admin', { action: 'publish_finish', publish_id: publishId });
    }).then(function (res) {
      var st = document.getElementById('publish-status');
      if (st) st.textContent = 'Published ' + new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        + ' · ' + res.hcp_count.toLocaleString() + ' HCPs to reps';
      toast('✓ Published ' + res.hcp_count.toLocaleString() + ' doctors across ' + res.territory_count + ' territories');
      return { ok: true, name: 'CompassIQ', count: res.hcp_count, territories: res.territory_count,
        trends: includeTrends ? rows.filter(function (h) { return h.trend; }).length : 0 };
    }).catch(function (e) {
      toast('⚠ Publish failed: ' + e.message + ' — nothing changed for reps');
      return { ok: false, error: e.message };
    });
  };
})();
