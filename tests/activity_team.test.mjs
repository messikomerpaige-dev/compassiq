// Call activity feed (warehouse keys, uploads, what reps receive) and the manager team view
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from './helpers/migrations.mjs';

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated;`;
const U = {
  team: '00000000-0000-0000-0000-000000000001', owner: '00000000-0000-0000-0000-0000000000a1',
  repN: '00000000-0000-0000-0000-0000000000a2', repS: '00000000-0000-0000-0000-0000000000a3',
  mgrN: '00000000-0000-0000-0000-0000000000a4', ownerB: '00000000-0000-0000-0000-0000000000b1',
};
let db, orgA;
async function as(uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${uid === 'service' ? 'service_role' : 'authenticated'}`);
    if (uid !== 'service') await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid })]);
    return (await tx.query(sql, params)).rows;
  });
}
const one = async (uid, sql, p) => Object.values((await as(uid, sql, p))[0])[0];
const hcp = (npi, territory, goal = 8) => ({ npi, territory, firstName: 'Dr', lastName: 'L' + npi, segment: 'A', callGoal: goal, city: 'X' });

before(async () => {
  db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(MIGRATIONS);
  for (const [k, id] of Object.entries(U)) await db.query('insert into auth.users values ($1, $2)', [id, k + '@x.test']);
  await db.query('insert into public.platform_admins values ($1)', [U.team]);
  orgA = await one(U.team, `select public.ciq_platform_create_org('A')`);
  const orgB = await one(U.team, `select public.ciq_platform_create_org('B')`);
  await as(U.team, `select public.ciq_platform_add_owner($1, $2, 'o@a', 'Olive')`, [orgA, U.owner]);
  await as(U.team, `select public.ciq_platform_add_owner($1, $2, 'o@b', 'Bo')`, [orgB, U.ownerB]);
  for (const [uid, rows] of [[U.owner, [hcp('111', 'North'), hcp('222', 'North'), hcp('333', 'North', 16), hcp('444', 'South')]], [U.ownerB, [hcp('111', 'West')]]]) {
    const pid = await one(uid, 'select public.ciq_publish_begin()');
    await as(uid, 'select public.ciq_publish_rows($1, $2::jsonb)', [pid, JSON.stringify(rows)]);
    await as(uid, 'select public.ciq_publish_finish($1)', [pid]);
  }
  const t = Object.fromEntries((await one(U.owner, 'select public.ciq_admin_overview()')).territories.map((x) => [x.name, x.id]));
  for (const [uid, role, name, terrs] of [[U.repN, 'rep', 'Rita', [t.North]], [U.repS, 'rep', 'Sam', [t.South]], [U.mgrN, 'manager', 'Max', [t.North]]]) {
    await as(U.owner, `select public.ciq_admin_add_member($1, $2, $3, $4, $5)`, [uid, uid + '@a', name, role, `{${terrs.join(',')}}`]);
  }
});

test('a warehouse key is stored as a hash, finds its company, and can be revoked', async () => {
  const id = await one(U.owner, `select public.ciq_admin_create_key('Snowflake nightly', 'hash-abc', 'ciq_…abcd')`);
  assert.equal(await one('service', `select public.ciq_key_org('hash-abc')`), orgA);
  assert.equal(await one('service', `select public.ciq_key_org('nope')`), null);
  const ov = await one(U.owner, 'select public.ciq_admin_activity_overview()');
  assert.equal(ov.keys[0].label, 'Snowflake nightly'); assert.ok(ov.keys[0].last_used_at);
  assert.equal(JSON.stringify(ov).includes('hash-abc'), false, 'hash never leaves the database');
  await assert.rejects(as(U.repN, `select public.ciq_admin_create_key('x', 'h2', 'x')`), /owners and admins/);
  await assert.rejects(as(U.repN, `select public.ciq_key_org('hash-abc')`), /permission denied/);
  await as(U.owner, 'select public.ciq_admin_revoke_key($1)', [id]);
  assert.equal(await one('service', `select public.ciq_key_org('hash-abc')`), null, 'revoked keys stop working');
});

test('warehouse loads keep completed calls, one per doctor per day', async () => {
  const res = await one('service', `select public.ciq_ingest_activity($1, '2026-10-13', $2::jsonb, 'warehouse', null)`, [orgA, JSON.stringify([
    { npi: '111', date: '2026-10-05', type: 'In-person', status: 'Submitted' },
    { npi: '111', date: '2026-10-05', type: 'Virtual' },                      // same day: one call
    { npi: '1-1-1', date: '2026-10-09' },                                     // NPI cleaned up
    { npi: '222', date: '2026-10-07', status: 'Planned' },                    // not a completed call
    { npi: '444', date: '2026-10-08' },
    { npi: '333', date: 'yesterday' },                                        // unreadable date
  ])]);
  assert.deepEqual(res, { rows: 3, through: '2026-10-13' });
  assert.deepEqual((await db.query(`select npi, call_date::text d from public.call_activity order by 1, 2`)).rows,
    [{ npi: '111', d: '2026-10-05' }, { npi: '111', d: '2026-10-09' }, { npi: '444', d: '2026-10-08' }]);
});

test('reps receive only their doctors’ calls, plus visits marked done in the app', async () => {
  await one(U.repN, `select public.ciq_sync($1::jsonb, '[]'::jsonb)`, [JSON.stringify([{ date: '2026-10-08', npi: '222', status: 'done' }])]);
  const a = await one(U.repN, `select public.ciq_my_activity('2026-10-01')`);
  assert.equal(a.through, '2026-10-13'); assert.equal(a.asOf, '2026-10-13');
  assert.deepEqual(a.calls.map((c) => c.npi + '@' + c.date).sort(), ['111@2026-10-05', '111@2026-10-09', '222@2026-10-08']);
  const s = await one(U.repS, `select public.ciq_my_activity('2026-10-01')`);
  assert.deepEqual(s.calls.map((c) => c.npi), ['444']);
  assert.equal((await as(U.repS, 'select * from public.call_activity')).length, 1, 'direct reads are limited the same way');
  assert.deepEqual((await one(U.ownerB, `select public.ciq_my_activity('2026-10-01')`)).calls, [], 'other companies see nothing');
});

test('admins can upload calls; reps cannot', async () => {
  const res = await one(U.owner, `select public.ciq_admin_load_activity(null, $1::jsonb)`, [JSON.stringify([{ npi: '333', date: '2026-10-14' }])]);
  assert.deepEqual(res, { rows: 1, through: '2026-10-14' });
  await assert.rejects(as(U.repN, `select public.ciq_admin_load_activity(null, '[]'::jsonb)`), /owners and admins/);
  const ov = await one(U.owner, 'select public.ciq_admin_activity_overview()');
  assert.deepEqual(ov.loads.map((l) => [l.through, l.rows, l.source]), [['2026-10-14', 1, 'upload'], ['2026-10-13', 3, 'warehouse']]);
});

test('team view: managers see their reps’ progress and week; reps cannot open it', async () => {
  await one(U.repN, `select public.ciq_save_state($1::jsonb)`, [JSON.stringify({ A: 't1', T: { t1: { name: 'North', data: { plan: [
    { date: '2026-10-12', callNum: 1, callStart: '9:00 AM', name: 'Dr L111', npi: '111', city: 'X' },
    { date: '2026-10-12', callNum: 2, callStart: '9:40 AM', name: 'Dr L222', npi: '222', city: 'X' },
    { date: '2026-10-20', callNum: 1, callStart: '9:00 AM', name: 'Dr L333', npi: '333', city: 'X' },
  ] } } } })]);
  await one(U.repN, `select public.ciq_sync($1::jsonb, '[]'::jsonb)`, [JSON.stringify([{ date: '2026-10-12', npi: '222', status: 'missed', reason: 'Office closed' }])]);
  const team = await one(U.mgrN, `select public.ciq_team_overview('2026-10-12', '2026-10-01', '2026-12-31')`);
  assert.deepEqual(team.map((r) => r.name), ['Rita'], 'only reps in the manager’s territories');
  const r = team[0];
  // Goals: 111 and 222 → 2 each, 333 (16/yr) → 4 = 8. Calls: 111 ×2, 222 ×1 (done in app), 333 ×1 (upload)
  assert.deepEqual([r.doctors, r.goal, r.calls, r.done, r.reached, r.missed], [3, 8, 4, 4, 3, 1]);
  assert.deepEqual(r.week.map((v) => [v.date, v.name, v.outcome]), [['2026-10-12', 'Dr L111', null], ['2026-10-12', 'Dr L222', 'missed']]);
  assert.equal(r.plan_calls, 3);
  assert.equal(r.missed_list[0].reason, 'Office closed');
  assert.deepEqual(r.unreached, []);
  assert.deepEqual((await one(U.owner, `select public.ciq_team_overview('2026-10-12', '2026-10-01', '2026-12-31')`)).map((x) => x.name), ['Rita', 'Sam']);
  await assert.rejects(as(U.repN, `select public.ciq_team_overview('2026-10-12', '2026-10-01', '2026-12-31')`), /managers and admins/);
  assert.deepEqual(await one(U.ownerB, `select public.ciq_team_overview('2026-10-12', '2026-10-01', '2026-12-31')`), []);
});
