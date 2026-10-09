// Shared helpers for the CompassIQ web pages (sign-in, admin, platform)
(function () {
  'use strict';

  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const r = await fetch(path, init);
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || ('Request failed (' + r.status + ')'));
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // Erase CompassIQ data kept in this browser (plans, settings, cached doctors)
  function wipeLocal() {
    [window.localStorage, window.sessionStorage].forEach(function (s) {
      try { Object.keys(s).forEach(function (k) { if (/^(tiq_|ciq_)/.test(k)) s.removeItem(k); }); } catch (e) { /* storage blocked */ }
    });
  }

  async function signOut() {
    try { await api('/api/session', { method: 'DELETE' }); } catch (e) { /* already signed out */ }
    location.replace('/');
  }

  // Tiny DOM builder: h('td', { class: 'num' }, 'text', child) — text is always set as text
  function h(tag, attrs) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function ([k, v]) {
      if (v === undefined || v === null || v === false) return;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (let i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).forEach(function (c) {
        if (c === undefined || c === null || c === false) return;
        el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    }
    return el;
  }

  function showMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (text ? ' show ' + (kind || 'err') : '');
  }

  // Only same-site paths are allowed as a post-sign-in destination
  function safeNext(v) {
    return typeof v === 'string' && /^\/(?!\/)[\w\-/.?=&%]*$/.test(v) ? v : null;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  window.CIQ = { api, wipeLocal, signOut, h, showMsg, safeNext, fmtDate };
})();
