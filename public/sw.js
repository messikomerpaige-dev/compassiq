// CompassIQ offline mode: service worker for the rep app, registered with scope /app, so it only
// sees the app page and the requests it makes (other pages never go through it).
//
// - /app and the rep's doctors (/api/app-data) come from the network when there is one, and are
//   kept on the device so the app still opens without a connection. Doctor data kept offline is
//   refused after 7 days without signing in online (access might have been turned off since).
// - The app's own files come from the network too (kept for offline); its libraries (cdnjs etc.)
//   have versioned URLs, so they are served from the cache once fetched.
// - Everything else (access checks, saving) always goes to the network.
// - The cache is emptied when the server says the person is signed out or turned off, and when the
//   page asks (sign out, /blocked).
// Plans, outcomes and preferences made offline are kept by the app and sent when back online.
'use strict';
const VERSION = '2026-10-11';
const SHELL = 'ciq-shell-' + VERSION;      // /app and /assets
const DATA = 'ciq-data';                    // the signed-in person's doctors
const LIBS = 'ciq-libs-1';                  // third-party libraries (versioned URLs)
const MAX_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;
const NETWORK_WAIT_MS = 10000;
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => { /* waits until the app asks (update toast) or nothing older is running */ });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL, DATA, LIBS];
    for (const k of await caches.keys()) if (k.startsWith('ciq-') && !keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function clearPrivate() { await caches.delete(DATA); await caches.delete(SHELL); }

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'CIQ_CLEAR') event.waitUntil(clearPrivate());
  if (msg.type === 'CIQ_WARM') event.waitUntil(warm(Math.max(1, Math.min(200, msg.pages | 0))));
});

// After the first online open (before this worker controlled the page), fill the cache once
async function warm(pages) {
  const data = await caches.open(DATA);
  if (await data.match('/api/app-data?page=0')) return;
  try {
    const shell = await caches.open(SHELL);
    const app = await fetch('/app', { credentials: 'same-origin' });
    if (app.ok) await shell.put('/app', app);
    for (let p = 0; p < pages; p++) {
      const r = await fetch('/api/app-data?page=' + p, { credentials: 'same-origin', cache: 'no-store' });
      if (!(await keepData(r.clone(), '/api/app-data?page=' + p))) break;
    }
  } catch (e) { /* offline: next time */ }
}

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

// Stores a doctor-data response when the server marked it as one; empties the cache when the
// server says the person is signed out or turned off. Returns true when stored.
async function keepData(res, key) {
  const mark = res.headers.get('x-ciq-cache');
  if (mark === 'clear') { await clearPrivate(); return false; }
  if (!res.ok || mark !== 'data') return false;
  const cache = await caches.open(DATA);
  // Someone else signed in on this device: drop the previous person's copy first
  const prev = await cache.match('/api/app-data?page=0');
  if (prev && prev.headers.get('x-ciq-user') !== res.headers.get('x-ciq-user')) {
    for (const k of await cache.keys()) await cache.delete(k);
  }
  const headers = new Headers(res.headers);
  headers.set('x-ciq-saved', String(Date.now()));
  await cache.put(key, new Response(await res.blob(), { status: 200, headers }));
  return true;
}

function script(code) {
  return new Response(code, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } });
}
function offlineNotice(text) {
  const box = '<div style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:420px;margin:18vh auto;padding:24px;text-align:center;">'
    + '<h2 style="margin:0 0 8px;">CompassIQ</h2><p>' + text + '</p>'
    + '<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:9px;border:0;background:#6d4aff;color:#fff;">Try again</button></div>';
  return script('window.__CIQ_STOP=true;document.write(' + JSON.stringify(box + '<plaintext hidden>') + ');');
}

async function appData(request) {
  const url = new URL(request.url);
  const key = '/api/app-data?page=' + (parseInt(url.searchParams.get('page') || '0', 10) || 0);
  const net = fetch(request);
  try {
    const res = await Promise.race([net, timeout(NETWORK_WAIT_MS)]);
    await keepData(res.clone(), key);
    return res;
  } catch (e) {
    const hit = await (await caches.open(DATA)).match(key);
    if (!hit) return offlineNotice('You’re offline. Connect to the internet to open CompassIQ on this device for the first time.');
    if (Date.now() - Number(hit.headers.get('x-ciq-saved') || 0) > MAX_OFFLINE_MS) {
      await caches.delete(DATA);
      return offlineNotice('You’ve been offline for more than 7 days. Connect to the internet and sign in to keep using CompassIQ.');
    }
    return hit;
  }
}

async function appShell(request) {
  try {
    const res = await Promise.race([fetch(request), timeout(NETWORK_WAIT_MS)]);
    if (res.ok && !res.redirected) await (await caches.open(SHELL)).put('/app', res.clone());
    return res;
  } catch (e) {
    const hit = await (await caches.open(SHELL)).match('/app');
    return hit || new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CompassIQ</title>'
      + '<p style="font:16px -apple-system,system-ui,sans-serif;text-align:center;margin-top:20vh;">You’re offline. Connect to the internet to open CompassIQ.</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

// The app's own small files: always the latest from the network, the kept copy when offline
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(request), timeout(NETWORK_WAIT_MS)]);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(request)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname === '/app' || url.pathname === '/app/') return event.respondWith(appShell(req));
    if (url.pathname === '/api/app-data') return event.respondWith(appData(req));
    if (url.pathname.startsWith('/assets/') || /^\/(icon\.svg|apple-touch-icon\.png|manifest\.webmanifest)$/.test(url.pathname)) {
      return event.respondWith(networkFirst(req, SHELL));
    }
    return;                                  // session checks and saving: network only
  }
  if (LIB_HOSTS.includes(url.hostname)) {
    // Libraries change only with their URL: cache first, network if missing
    return event.respondWith(caches.open(LIBS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }))));
  }
});
