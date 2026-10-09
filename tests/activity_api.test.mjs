// /api/activity (data warehouse in, rep apps out) and the admin key/upload actions
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase, mockReq, mockRes, cookiesFrom } from './helpers/fake-supabase.mjs';
import { setClientFactory } from '../api/_lib/ciq.js';
import { normalizeCalls, normDate } from '../api/_lib/activity.js';
import session from '../api/session.js';
import admin from '../api/admin.js';
import activity from '../api/activity.js';

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

let fake, owner, rep, key;
async function call(h, { method = 'GET', query = {}, body, cookie = '', headers = {} } = {}) {
  const res = mockRes(), req = mockReq({ method, query, body, cookie });
  Object.assign(req.headers, headers);
  await h(req, res);
  return res;
}
async function signIn(id) {
  const res = mockRes();
  await session(mockReq({ method: 'POST', body: fake.issue(id) }), res);
  return cookiesFrom(res);
}
const warehouse = (body, headers = {}, query = {}) => call(activity, { method: 'POST', body, headers: { authorization: 'Bearer ' + key, ...headers }, query });

before(async () => {
  fake = await createFakeSupabase();
  setClientFactory(fake.factory);
  const team = await fake.createUser('team@x.test', 'pw');
  await fake.db.query('insert into public.platform_admins values ($1)', [team]);
  const ownerId = await fake.createUser('owner@x.test', 'pw'), repId = await fake.createUser('rep@x.test', 'pw');
  const as = (uid, sql, p) => fake.db.transaction(async (tx) => {
    await tx.query('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid })]);
    return (await tx.query(sql, p)).rows;
  });
  const org = (await as(team, `select public.ciq_platform_create_org('Acme') v`))[0].v;
  await as(team, `select public.ciq_platform_add_owner($1, $2, 'owner@x.test', 'O')`, [org, ownerId]);
  const pid = (await as(ownerId, 'select public.ciq_publish_begin() v'))[0].v;
  await as(ownerId, 'select public.ciq_publish_rows($1, $2::jsonb)', [pid, JSON.stringify(['111', '222', '333'].map((npi) => ({ npi, territory: 'North' })))]);
  await as(ownerId, 'select public.ciq_publish_finish($1)', [pid]);
  const t = (await as(ownerId, 'select id from public.territories'))[0].id;
  await as(ownerId, `select public.ciq_admin_add_member($1, 'rep@x.test', 'R', 'rep', $2)`, [repId, `{${t}}`]);
  owner = await signIn(ownerId); rep = await signIn(repId);
});

test('dates and columns in the basic format are read loosely and safely', () => {
  assert.deepEqual(['2026-10-05', '10/5/2026', '10/05/26', '2026-02-31', 'soon', ''].map(normDate), ['2026-10-05', '2026-10-05', '2026-10-05', null, null, null]);
  const { calls, skipped } = normalizeCalls('NPI,Call Date,Call Type,Status\r\n111,10/5/2026,"In-person, lunch",Submitted\n,2026-10-06,,\n222,2026-02-31,,\n');
  assert.deepEqual(calls, [{ npi: '111', date: '2026-10-05', type: 'In-person, lunch', status: 'Submitted' }]);
  assert.equal(skipped, 2);
});

test('an admin creates a warehouse key; it is shown once', async () => {
  const res = await call(admin, { method: 'POST', cookie: owner, body: { action: 'create_key', label: 'Nightly' } });
  assert.equal(res.statusCode, 200);
  key = res.body.key;
  assert.match(key, /^ciq_live_[\w-]{32}$/);
  const ov = await call(admin, { method: 'POST', cookie: owner, body: { action: 'activity_overview' } });
  assert.equal(ov.body.keys[0].hint, 'ciq_live_…' + key.slice(-4));
  assert.equal(JSON.stringify(ov.body).includes(key), false);
  assert.equal((await call(admin, { method: 'POST', cookie: rep, body: { action: 'create_key' } })).statusCode, 403);
});

test('the warehouse sends CSV or JSON with its key', async () => {
  let res = await warehouse('NPI,Call_Date,Call_Type,Status\n111,2026-10-05,In-person,Submitted\n222,2026-10-06,In-person,Planned\n', { 'content-type': 'text/csv' }, { through: '2026-10-07' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { rows: 1, through: '2026-10-07', skipped: 0 });
  res = await warehouse({ through: '2026-10-12', calls: [{ NPI: '222', 'Call Date': '10/9/2026' }, { npi: '999', date: '2026-10-09' }] });
  assert.deepEqual(res.body, { rows: 2, through: '2026-10-12', skipped: 0 });
});

test('bad or missing keys are refused', async () => {
  assert.equal((await call(activity, { method: 'POST', body: { calls: [] } })).statusCode, 401);
  assert.equal((await warehouse({ calls: [{ npi: '1', date: '2026-10-01' }] }, { authorization: 'Bearer ciq_live_wrong' })).statusCode, 401);
  assert.equal((await warehouse({ calls: [{ npi: '', date: 'x' }] })).statusCode, 400);
});

test('admins can upload calls from a sheet', async () => {
  const res = await call(admin, { method: 'POST', cookie: owner, body: { action: 'load_activity', calls: [{ NPI: '333', Date: '2026-10-13', Type: 'Virtual' }, { NPI: '', Date: '' }] } });
  assert.deepEqual(res.body, { rows: 1, through: '2026-10-13', skipped: 1 });
});

test('a rep’s app receives its doctors’ calls with the "calls through" date', async () => {
  const res = await call(activity, { cookie: rep, query: { from: '2026-10-01' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.asOf, '2026-10-13');
  assert.deepEqual(res.body.calls.map((c) => c.npi + '@' + c.date).sort(), ['111@2026-10-05', '222@2026-10-09', '333@2026-10-13']);
  assert.equal((await call(activity, {})).statusCode, 401, 'signed out');
});

test('a revoked key stops working', async () => {
  const ov = await call(admin, { method: 'POST', cookie: owner, body: { action: 'activity_overview' } });
  await call(admin, { method: 'POST', cookie: owner, body: { action: 'revoke_key', id: ov.body.keys[0].id } });
  assert.equal((await warehouse({ calls: [{ npi: '111', date: '2026-10-14' }] })).statusCode, 401);
});

test('team view: weeks run Monday–Sunday inside their calendar quarter; reps are turned away', async () => {
  const { weekAndQuarter } = await import('../api/team.js');
  assert.deepEqual(weekAndQuarter('2026-10-01'), { weekStart: '2026-09-28', quarter: { start: '2026-07-01', end: '2026-09-30' } });
  assert.deepEqual(weekAndQuarter('2026-10-18'), { weekStart: '2026-10-12', quarter: { start: '2026-10-01', end: '2026-12-31' } });
  const team = (await import('../api/team.js')).default;
  const res = await call(team, { cookie: owner, query: { week: '2026-10-14' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.weekStart, '2026-10-12');
  assert.deepEqual(res.body.reps.map((r) => [r.name, r.calls, r.reached, r.doctors]), [['R', 3, 3, 3]]);
  assert.equal((await call(team, { cookie: rep })).statusCode, 403);
  assert.equal((await call(team, {})).statusCode, 401);
});

test('CSV sent as text/csv is read from the request stream (Vercel leaves req.body unset for it)', async () => {
  const ov = await call(admin, { method: 'POST', cookie: owner, body: { action: 'create_key', label: 'Stream' } });
  const { Readable } = await import('node:stream');
  const req = Object.assign(Readable.from([Buffer.from('NPI,Call_Date\n333,2026-10-15\n')]),
    mockReq({ method: 'POST', query: { through: '2026-10-15' } }));
  Object.assign(req.headers, { authorization: 'Bearer ' + ov.body.key, 'content-type': 'text/csv' });
  const res = mockRes();
  await activity(req, res);
  assert.deepEqual(res.body, { rows: 1, through: '2026-10-15', skipped: 0 });
});
