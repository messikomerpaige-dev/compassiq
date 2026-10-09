// public/sw.js (offline mode), run against stand-ins for the browser's Cache Storage and network
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://compassiq.test';
const DAY = 864e5;

function worker() {
  const stores = new Map();
  const keyOf = (k) => { const u = new URL(typeof k === 'string' ? k : k.url, ORIGIN); return u.origin === ORIGIN ? u.pathname + u.search : u.href; };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async match(k) { const r = m.get(keyOf(k)); return r ? r.clone() : undefined; },
        async put(k, r) { m.set(keyOf(k), r); },
        async delete(k) { return m.delete(keyOf(k)); },
        async keys() { return [...m.keys()]; },
      };
    },
    async delete(name) { return stores.delete(name); },
    async keys() { return [...stores.keys()]; },
  };
  const net = { online: true, respond: null };
  const fetch = async (req) => {
    if (!net.online) throw new TypeError('Failed to fetch');
    return net.respond(typeof req === 'string' ? new Request(new URL(req, ORIGIN)) : req);
  };
  const handlers = {};
  const self = { location: { origin: ORIGIN }, addEventListener: (t, f) => { handlers[t] = f; }, clients: { claim: async () => {} }, skipWaiting() {} };
  new Function('self', 'caches', 'fetch', CODE)(self, caches, fetch);
  async function get(path) {
    let p = null;
    handlers.fetch({ request: new Request(ORIGIN + path), respondWith: (x) => { p = x; } });
    return p ? p : 'network';
  }
  async function message(data) { let p; handlers.message({ data, waitUntil: (x) => { p = x; } }); await p; }
  return { stores, net, get, message, data: () => [...(stores.get('ciq-data') || new Map()).keys()] };
}
const js = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'application/javascript', ...headers } });

test('doctor data is kept for offline use, per person, and refused after 7 days offline', async (t) => {
  const w = worker();
  let user = 'u1';
  w.net.respond = (req) => js('/*' + user + ' ' + new URL(req.url).search + '*/', { 'x-ciq-cache': 'data', 'x-ciq-user': user });
  assert.match(await (await w.get('/api/app-data?page=0')).text(), /u1 \?page=0/);
  await w.get('/api/app-data?page=1');
  assert.deepEqual(w.data(), ['/api/app-data?page=0', '/api/app-data?page=1']);

  w.net.online = false;
  assert.match(await (await w.get('/api/app-data?page=1')).text(), /u1 \?page=1/, 'offline: the kept copy');

  // Someone else signs in on this iPad: the first person's pages are dropped
  w.net.online = true; user = 'u2';
  await w.get('/api/app-data?page=0');
  assert.deepEqual(w.data(), ['/api/app-data?page=0']);

  // A week later, still offline: refused and erased
  w.net.online = false;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 8 * DAY);
  const late = await (await w.get('/api/app-data?page=0')).text();
  assert.match(late, /__CIQ_STOP=true/);
  assert.match(late, /offline for more than 7 days/);
  assert.equal(w.stores.has('ciq-data'), false);
});

test('signed out or turned off: the server’s answer empties the offline copy', async () => {
  const w = worker();
  w.net.respond = () => js('ok', { 'x-ciq-cache': 'data', 'x-ciq-user': 'u1' });
  await w.get('/app');
  await w.get('/api/app-data?page=0');
  assert.ok(w.stores.get('ciq-data').size);
  w.net.respond = () => js("location.replace('/blocked')", { 'x-ciq-cache': 'clear' });
  await w.get('/api/app-data?page=0');
  assert.equal(w.stores.has('ciq-data'), false);
  assert.equal([...w.stores.keys()].some((k) => k.startsWith('ciq-shell')), false);
  // Error pages and unmarked responses are never kept
  w.net.respond = () => new Response('{"error":"x"}', { status: 500 });
  await w.get('/api/app-data?page=0');
  assert.equal(w.stores.has('ciq-data'), false);
  // The page can also ask (sign out)
  w.net.respond = () => js('ok', { 'x-ciq-cache': 'data', 'x-ciq-user': 'u1' });
  await w.get('/api/app-data?page=0');
  await w.message({ type: 'CIQ_CLEAR' });
  assert.equal(w.stores.has('ciq-data'), false);
});

test('the app page works offline; access checks and saving always use the network', async () => {
  const w = worker();
  w.net.respond = () => new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } });
  await w.get('/app');
  w.net.online = false;
  assert.equal(await (await w.get('/app')).text(), '<html>app</html>');
  for (const p of ['/api/session', '/api/sync', '/api/state', '/api/activity?from=2026-10-01', '/admin', '/team']) assert.equal(await w.get(p), 'network', p);
  const first = worker(); first.net.online = false;
  assert.match(await (await first.get('/api/app-data?page=0')).text(), /Connect to the internet to open CompassIQ on this device for the first time/);
});
