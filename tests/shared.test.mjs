// Phase 2: doctor preferences and addresses shared across a company, visit outcomes, saved plans
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from './helpers/migrations.mjs';

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;`;
const U = {
  team: '00000000-0000-0000-0000-000000000001', owner: '00000000-0000-0000-0000-0000000000a1',
  repN: '00000000-0000-0000-0000-0000000000a2', repN2: '00000000-0000-0000-0000-0000000000a3',
  repS: '00000000-0000-0000-0000-0000000000a4', mgr: '00000000-0000-0000-0000-0000000000a5',
  ownerB: '00000000-0000-0000-0000-0000000000b1',
};
let db;
async function as(uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid })]);
    return (await tx.query(sql, params)).rows;
  });
}
const one = async (uid, sql, p) => Object.values((await as(uid, sql, p))[0])[0];
const appHcps = async (uid) => Object.fromEntries((await as(uid, 'select data from public.ciq_app_hcps()')).map((r) => [r.data.npi, r.data]));
const sync = (uid, outcomes, prefs) => one(uid, 'select public.ciq_sync($1::jsonb, $2::jsonb)', [JSON.stringify(outcomes), JSON.stringify(prefs)]);
const hcp = (npi, territory) => ({ npi, territory, firstName: 'Dr', lastName: npi, address: '1 Old Rd', city: 'Oldtown', state: 'PA', zip5: '19103', zip4: '19103' });
const HOURS = [{ day: 'mon', available: false }];

before(async () => {
  db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(MIGRATIONS);
  for (const [k, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, k + '@x.test']);
  await db.query('insert into public.platform_admins values ($1)', [U.team]);
  const orgA = await one(U.team, `select public.ciq_platform_create_org('A')`), orgB = await one(U.team, `select public.ciq_platform_create_org('B')`);
  await as(U.team, `select public.ciq_platform_add_owner($1, $2, 'o@a', 'O')`, [orgA, U.owner]);
  await as(U.team, `select public.ciq_platform_add_owner($1, $2, 'o@b', 'O')`, [orgB, U.ownerB]);
  for (const [uid, rows] of [[U.owner, [hcp('111', 'North'), hcp('222', 'North'), hcp('333', 'South')]], [U.ownerB, [hcp('111', 'West')]]]) {
    const pid = await one(uid, 'select public.ciq_publish_begin()');
    await as(uid, 'select public.ciq_publish_rows($1, $2::jsonb)', [pid, JSON.stringify(rows)]);
    await as(uid, 'select public.ciq_publish_finish($1)', [pid]);
  }
  const t = Object.fromEntries((await one(U.owner, 'select public.ciq_admin_overview()')).territories.map((x) => [x.name, x.id]));
  for (const [uid, role, terrs] of [[U.repN, 'rep', [t.North]], [U.repN2, 'rep', [t.North]], [U.repS, 'rep', [t.South]], [U.mgr, 'manager', [t.North, t.South]]]) {
    await as(U.owner, `select public.ciq_admin_add_member($1, $2, '', $3, $4)`, [uid, uid + '@a', role, `{${terrs.join(',')}}`]);
  }
});

test('a doctor’s preferences and corrected address reach everyone who sees that doctor', async () => {
  const res = await sync(U.repN, [], [
    { npi: '111', daySchedule: HOURS, doNotCall: false, byAppointmentOnly: true,
      address: { address: '9 New St', city: 'Newtown', state: 'PA', zip5: '18104', zip4: '18104' } },
  ]);
  assert.deepEqual(res, { outcomes: 0, prefs: 1 });
  for (const uid of [U.repN2, U.mgr, U.owner]) {
    const d = (await appHcps(uid))['111'];
    assert.equal(d.address, '9 New St'); assert.equal(d.zip5, '18104'); assert.equal(d.addrEdited, true);
    assert.equal(d.byAppointmentOnly, true); assert.deepEqual(d.daySchedule, HOURS); assert.ok(d.prefsAt);
  }
  assert.equal((await appHcps(U.repN))['222'].address, '1 Old Rd', 'other doctors unchanged');
  // Another company with the same NPI is unaffected
  assert.equal((await appHcps(U.ownerB))['111'].address, '1 Old Rd');
});

test('later edits win; an edit without an address keeps the corrected address', async () => {
  await sync(U.repN2, [], [{ npi: '111', daySchedule: null, doNotCall: true, byAppointmentOnly: false, address: null }]);
  const d = (await appHcps(U.repN))['111'];
  assert.equal(d.doNotCall, true); assert.equal(d.byAppointmentOnly, false);
  assert.equal(d.address, '9 New St', 'address kept');
});

test('nobody can change doctors outside their territories', async () => {
  const res = await sync(U.repS, [{ date: '2026-10-14', npi: '111', status: 'done' }], [{ npi: '111', doNotCall: false, address: { address: 'Hijack', zip5: '00000' } }]);
  assert.deepEqual(res, { outcomes: 0, prefs: 0 });
  assert.equal((await appHcps(U.repN))['111'].address, '9 New St');
  assert.equal((await as(U.repS, 'select * from public.hcp_prefs')).length, 0, 'and cannot read them');
  assert.equal((await as(U.ownerB, 'select * from public.hcp_prefs')).length, 0, 'other companies cannot read them');
});

test('visit outcomes: saved per person; managers see their territories’; clearing removes', async () => {
  await sync(U.repN, [{ date: '2026-10-14', npi: '111', status: 'done' }, { date: '2026-10-14', npi: '222', status: 'missed', reason: 'Closed' },
    { date: 'bad', npi: '111', status: 'done' }, { date: '2026-10-15', npi: '111', status: 'weird' }], []);
  await sync(U.repS, [{ date: '2026-10-14', npi: '333', status: 'done' }], []);
  assert.equal((await as(U.repN, 'select * from public.visit_outcomes')).length, 2);
  assert.equal((await as(U.repN2, 'select * from public.visit_outcomes')).length, 0, 'reps only see their own');
  assert.equal((await as(U.mgr, 'select * from public.visit_outcomes')).length, 3);
  assert.equal((await as(U.ownerB, 'select * from public.visit_outcomes')).length, 0);
  await sync(U.repN, [{ date: '2026-10-14', npi: '222', status: 'cleared' }], []);
  assert.deepEqual((await as(U.repN, 'select npi, status from public.visit_outcomes')).map((r) => r.npi), ['111']);
});

test('each person’s plan is saved privately and returned only when newer', async () => {
  const at = await one(U.repN, `select public.ciq_save_state('{"T":{"x":1},"A":"x"}'::jsonb)`);
  assert.ok(at);
  assert.deepEqual((await one(U.repN, 'select public.ciq_my_state(null)')).data, { T: { x: 1 }, A: 'x' });
  assert.equal((await one(U.repN, 'select public.ciq_my_state($1)', [at])).data, undefined, 'up to date: no data sent');
  assert.equal(await one(U.repN2, 'select public.ciq_my_state(null)'), null, 'nothing saved for someone else');
  assert.equal((await as(U.owner, 'select * from public.rep_state')).length, 0, 'not even admins read it');
  await assert.rejects(as(U.repN, `select public.ciq_save_state('[]'::jsonb)`), /missing or too large/);
});

test('turned-off people can no longer sync or read', async () => {
  await as(U.owner, `select public.ciq_admin_update_member($1, null, null, 'disabled')`, [U.repN2]);
  await assert.rejects(sync(U.repN2, [], []), /access is turned off/);
  assert.equal(await one(U.repN2, 'select public.ciq_my_state(null)'), null);
  assert.equal((await as(U.repN2, 'select * from public.ciq_app_hcps()')).length, 0);
  await as(U.owner, `select public.ciq_admin_update_member($1, null, null, 'active')`, [U.repN2]);
});
