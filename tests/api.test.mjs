// Server endpoints, end to end against the fake Supabase (real database functions in PGlite)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase, mockReq, mockRes, cookiesFrom } from './helpers/fake-supabase.mjs';
import { setClientFactory } from '../api/_lib/ciq.js';
import session from '../api/session.js';
import admin from '../api/admin.js';
import platform from '../api/platform.js';
import appData from '../api/app-data.js';

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

let fake;
const people = {};   // name → { id, cookie }

async function call(h, { method = 'GET', query = {}, body, cookie = '', origin } = {}) {
  const res = mockRes();
  await h(mockReq({ method, query, body, cookie, origin }), res);
  return res;
}
async function ok(h, opts) {
  const res = await call(h, opts);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res;
}
// Signs in through the real flow: Supabase password sign-in → POST /api/session
async function signIn(email, password) {
  const { data, error } = await fake.signInWithPassword(email, password);
  assert.ifError(error);
  const res = await ok(session, { method: 'POST', body: data.session });
  return cookiesFrom(res);
}
// Accept an invite: the emailed link carries tokens → POST /api/session → set password
async function acceptInvite(email, password) {
  const inv = fake.state.invites.find((i) => i.email === email);
  assert.ok(inv, 'invite sent to ' + email);
  const res = await ok(session, { method: 'POST', body: fake.issue(inv.id) });
  await ok(session, { method: 'POST', body: { action: 'password', password }, cookie: cookiesFrom(res) });
  return { id: inv.id, cookie: await signIn(email, password) };
}
const hcp = (npi, territory) => ({ npi, territory, firstName: 'Dr', lastName: 'L' + npi, zip5: '19103', zip4: '19103', segment: 'A', callGoal: 8 });
async function publishAs(cookie, rows) {
  const { body: { publish_id } } = await ok(admin, { method: 'POST', body: { action: 'publish_begin' }, cookie });
  for (let i = 0; i < rows.length; i += 1000) {
    await ok(admin, { method: 'POST', body: { action: 'publish_rows', publish_id, rows: rows.slice(i, i + 1000) }, cookie });
  }
  return (await ok(admin, { method: 'POST', body: { action: 'publish_finish', publish_id }, cookie })).body;
}
// Run the /api/app-data scripts like the browser would; returns { cloud, data, redirect }
async function loadApp(cookie) {
  const win = { __CIQ_DATA: undefined }, store = new Map([['tiq_territories', '{"old":1}']]);
  let redirect = null, page = 0, halted = false;
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  };
  Object.defineProperty(localStorage, 'keys', { value: () => [...store.keys()] });
  for (;;) {
    const res = await call(appData, { query: { page: String(page) }, cookie });
    assert.equal(res.getHeader('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(res.getHeader('cache-control'), 'no-store');
    let next = null;
    const sandbox = {
      window: win, localStorage: new Proxy(localStorage, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }),
      sessionStorage: { removeItem() {} }, Object: { keys: (o) => (o.keys ? o.keys() : Object.keys(o)) },
      location: { pathname: '/app', replace: (u) => { redirect = u; } },
      document: { write: (s) => { if (/^<script/.test(s)) next = s; else halted = true; } }, encodeURIComponent,
    };
    new Function(...Object.keys(sandbox), res.body.replace(/\bwindow\.__CIQ_/g, 'window.__CIQ_'))(...Object.values(sandbox));
    if (!next) break;
    assert.match(next, new RegExp(`/api/app-data\\?page=${page + 1}`));
    page++;
  }
  if (redirect) assert.ok(halted, 'the app shell is halted when leaving');
  return { cloud: win.__CIQ_CLOUD, data: win.__CIQ_DATA, redirect, store };
}

before(async () => {
  fake = await createFakeSupabase();
  setClientFactory(fake.factory);
  // You (the CompassIQ team) — created in the Supabase dashboard, then added as a platform admin
  const pid = await fake.createUser('team@compassiq.test', 'team-password-1');
  await fake.db.query('insert into public.platform_admins (user_id) values ($1)', [pid]);
  people.team = { id: pid, cookie: await signIn('team@compassiq.test', 'team-password-1') };
});

test('the sign-in page gets the public Supabase settings', async () => {
  const res = await ok(session, { query: { config: '1' } });
  assert.deepEqual(res.body, { url: 'http://supabase.test', anonKey: 'anon-key' });
});

test('sessions live in HttpOnly cookies and refresh themselves', async () => {
  const { data } = await fake.signInWithPassword('team@compassiq.test', 'team-password-1');
  const res = await ok(session, { method: 'POST', body: data.session });
  const cookies = [].concat(res.getHeader('set-cookie'));
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((c) => /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Path=\//.test(c)));
  let cookie = cookiesFrom(res);
  const me = await ok(session, { cookie });
  assert.equal(me.body.home, '/platform');
  // Access token expires → the refresh token gets a new one
  fake.state.access.delete(data.session.access_token);
  const again = await ok(session, { cookie });
  assert.ok(again.getHeader('set-cookie'), 'new cookies issued');
  cookie = cookiesFrom(again, cookie);
  await ok(session, { cookie });
  // Sign out invalidates and clears
  const out = await ok(session, { method: 'DELETE', cookie });
  assert.equal((await call(session, { cookie: cookiesFrom(out, cookie) })).statusCode, 401);
});

test('bad tokens and cross-site posts are refused', async () => {
  assert.equal((await call(session, { method: 'POST', body: { access_token: 'nope', refresh_token: 'nope' } })).statusCode, 401);
  assert.equal((await call(session)).statusCode, 401);
  const res = await call(admin, { method: 'POST', body: { action: 'publish_begin' }, cookie: people.team.cookie, origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Cross-site/);
});

test('only the CompassIQ team can create and suspend companies', async () => {
  const create = await ok(platform, { method: 'POST', cookie: people.team.cookie,
    body: { action: 'create', name: 'Acme Pharma', owner_email: 'Owner@Acme.test', owner_name: 'Olive Owner' } });
  assert.equal(create.body.existing, false);
  assert.equal(fake.state.invites.at(-1).redirectTo, 'http://localhost:3000/set-password');
  people.owner = await acceptInvite('owner@acme.test', 'owner-password-1');
  assert.equal((await ok(session, { cookie: people.owner.cookie })).body.home, '/admin');
  assert.equal((await call(platform, { cookie: people.owner.cookie })).statusCode, 403);
  const orgs = (await ok(platform, { cookie: people.team.cookie })).body;
  assert.deepEqual(orgs.map((o) => [o.name, o.owners]), [['Acme Pharma', ['owner@acme.test']]]);
});

test('passwords need 10+ characters', async () => {
  const res = await call(session, { method: 'POST', body: { action: 'password', password: 'short' }, cookie: people.owner.cookie });
  assert.equal(res.statusCode, 400);
});

test('owners publish doctors and invite reps; each rep receives only their territory', async () => {
  const rows = [...Array.from({ length: 2500 }, (_, i) => hcp(String(1000000000 + i), 'North')), hcp('2000000001', 'South')];
  assert.deepEqual(await publishAs(people.owner.cookie, rows), { hcp_count: 2501, territory_count: 2 });
  const ov = (await ok(admin, { cookie: people.owner.cookie })).body;
  const north = ov.territories.find((t) => t.name === 'North').id, south = ov.territories.find((t) => t.name === 'South').id;
  await ok(admin, { method: 'POST', cookie: people.owner.cookie, body: { action: 'invite', email: 'rep1@acme.test', full_name: 'Rita Rep', role: 'rep', territory_ids: [north] } });
  await ok(admin, { method: 'POST', cookie: people.owner.cookie, body: { action: 'invite', email: 'rep2@acme.test', full_name: 'Sam Rep', role: 'rep', territory_ids: [south] } });
  people.rep1 = await acceptInvite('rep1@acme.test', 'rep1-password-1');
  people.rep2 = await acceptInvite('rep2@acme.test', 'rep2-password-1');

  const a = await loadApp(people.rep1.cookie);
  assert.equal(a.redirect, null);
  assert.equal(a.data.length, 2500, 'two pages chained');
  assert.ok(a.data.every((h) => h.territory === 'North'));
  assert.deepEqual(a.cloud, { userId: people.rep1.id, email: 'rep1@acme.test', name: 'Rita Rep', role: 'rep', org: 'Acme Pharma', territories: ['North'] });
  assert.equal(a.store.get('tiq_territories'), undefined, 'a previous person’s data on this browser is erased');
  assert.equal(a.store.get('ciq_owner'), people.rep1.id);

  const b = await loadApp(people.rep2.cookie);
  assert.deepEqual(b.data.map((h) => h.npi), ['2000000001']);
  assert.equal((await call(admin, { cookie: people.rep1.cookie })).statusCode, 403, 'reps cannot use admin endpoints');
});

test('invites are checked before any email goes out', async () => {
  const sent = fake.state.invites.length;
  const ov = (await ok(admin, { cookie: people.owner.cookie })).body;
  const north = ov.territories.find((t) => t.name === 'North').id;
  await ok(admin, { method: 'POST', cookie: people.owner.cookie, body: { action: 'invite', email: 'ada@acme.test', full_name: 'Ada Admin', role: 'admin', territory_ids: [] } });
  people.admin = await acceptInvite('ada@acme.test', 'admin-password-1');
  const tries = [
    [{ email: 'x@acme.test', role: 'admin' }, 403],                                       // admins can't add admins
    [{ email: 'x@acme.test', role: 'rep', territory_ids: [] }, 400],                       // a rep needs one territory
    [{ email: 'x@acme.test', role: 'rep', territory_ids: [crypto.randomUUID()] }, 400],    // not this company's territory
    [{ email: 'rep1@acme.test', role: 'rep', territory_ids: [north] }, 409],               // already on the team
    [{ email: 'not-an-email', role: 'rep', territory_ids: [north] }, 400],
  ];
  for (const [b, status] of tries) {
    const res = await call(admin, { method: 'POST', cookie: people.admin.cookie, body: { action: 'invite', ...b } });
    assert.equal(res.statusCode, status, JSON.stringify(b) + ' → ' + JSON.stringify(res.body));
  }
  assert.equal(fake.state.invites.length, sent + 1, 'only the valid admin invite sent an email');
});

test('turning a person off blocks their app and erases its local data; turning on restores', async () => {
  await ok(admin, { method: 'POST', cookie: people.admin.cookie, body: { action: 'update', user_id: people.rep1.id, status: 'disabled' } });
  const app = await loadApp(people.rep1.cookie);
  assert.equal(app.redirect, '/blocked');
  assert.equal(app.data, undefined, 'no doctors sent');
  assert.equal(app.store.get('tiq_territories'), undefined, 'local data erased');
  assert.equal((await ok(session, { cookie: people.rep1.cookie })).body.home, '/blocked', 'open apps see it at their next check');
  // Signing in again lands on the blocked page too
  const fresh = await signIn('rep1@acme.test', 'rep1-password-1');
  assert.equal((await ok(session, { cookie: fresh })).body.home, '/blocked');

  await ok(admin, { method: 'POST', cookie: people.admin.cookie, body: { action: 'update', user_id: people.rep1.id, status: 'active' } });
  assert.equal((await loadApp(people.rep1.cookie)).data.length, 2500);
});

test('signed-out visitors are sent to sign in without erasing anything', async () => {
  const app = await loadApp('');
  assert.match(app.redirect, /^\/\?next=/);
  assert.equal(app.store.get('tiq_territories'), '{"old":1}');
});

test('suspending a company blocks everyone in it; reactivating restores the active ones', async () => {
  const orgId = (await ok(platform, { cookie: people.team.cookie })).body[0].id;
  await ok(admin, { method: 'POST', cookie: people.owner.cookie, body: { action: 'update', user_id: people.rep2.id, status: 'disabled' } });
  const res = await ok(platform, { method: 'POST', cookie: people.team.cookie, body: { action: 'status', org_id: orgId, status: 'suspended' } });
  assert.equal(res.body.people, 3, 'owner, admin and rep1 (rep2 was already off)');
  for (const p of ['owner', 'admin', 'rep1']) {
    assert.equal((await ok(session, { cookie: people[p].cookie })).body.home, '/blocked', p);
    assert.equal((await loadApp(people[p].cookie)).redirect, '/blocked', p);
  }
  assert.equal((await call(admin, { cookie: people.owner.cookie })).statusCode, 403, 'admin pages refuse too');
  await ok(platform, { method: 'POST', cookie: people.team.cookie, body: { action: 'status', org_id: orgId, status: 'active' } });
  assert.equal((await loadApp(people.rep1.cookie)).data.length, 2500);
  assert.equal((await loadApp(people.rep2.cookie)).redirect, '/blocked', 'people turned off by their company stay off');
});
