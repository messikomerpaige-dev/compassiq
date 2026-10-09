// Database access rules, run against an in-memory Postgres (PGlite) with a stand-in for
// Supabase's auth schema. Each check runs as the `authenticated` role with a given user id,
// the same way Supabase evaluates row level security for a signed-in request.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS as MIGRATION } from './helpers/migrations.mjs';

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

const U = {
  platform: '00000000-0000-0000-0000-000000000001',
  ownerA:   '00000000-0000-0000-0000-0000000000a1',
  adminA:   '00000000-0000-0000-0000-0000000000a2',
  mgrA:     '00000000-0000-0000-0000-0000000000a3',
  rep1:     '00000000-0000-0000-0000-0000000000a4',
  rep2:     '00000000-0000-0000-0000-0000000000a5',
  ownerB:   '00000000-0000-0000-0000-0000000000b1',
  repB:     '00000000-0000-0000-0000-0000000000b2',
  stranger: '00000000-0000-0000-0000-0000000000ff',
};

let db;

// Run SQL as a signed-in user (or anon when userId is null); returns rows
async function as(userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${userId ? 'authenticated' : 'anon'}`);
    if (userId) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })]);
    return (await tx.query(sql, params)).rows;
  });
}
const one = async (userId, sql, params) => Object.values((await as(userId, sql, params))[0])[0];
async function rejects(promise, pattern) {
  await assert.rejects(promise, (e) => { assert.match(String(e.message), pattern); return true; });
}

const hcp = (npi, territory, extra = {}) => ({ npi, territory, firstName: 'Dr', lastName: 'N' + npi, zip5: '19103', segment: 'A', callGoal: 8, ...extra });
async function publish(userId, rows) {
  const pid = await one(userId, `select public.ciq_publish_begin()`);
  await as(userId, `select public.ciq_publish_rows($1, $2::jsonb)`, [pid, JSON.stringify(rows)]);
  return { pid, result: await one(userId, `select public.ciq_publish_finish($1)`, [pid]) };
}
const territoryId = async (userId, name) =>
  (await one(userId, `select public.ciq_admin_overview()`)).territories.find((t) => t.name === name).id;

before(async () => {
  db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(MIGRATION);
  for (const [k, id] of Object.entries(U)) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, k + '@x.test']);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [U.platform]);

  // CompassIQ team creates two client companies with owners
  const orgA = await one(U.platform, `select public.ciq_platform_create_org('Acme Pharma')`);
  const orgB = await one(U.platform, `select public.ciq_platform_create_org('Beta Bio')`);
  await as(U.platform, `select public.ciq_platform_add_owner($1, $2, 'ownerA@x.test', 'Owner A')`, [orgA, U.ownerA]);
  await as(U.platform, `select public.ciq_platform_add_owner($1, $2, 'ownerB@x.test', 'Owner B')`, [orgB, U.ownerB]);

  // Owner A adds an admin; data published for two territories
  await as(U.ownerA, `select public.ciq_admin_add_member($1, 'adminA@x.test', 'Admin A', 'admin', '{}')`, [U.adminA]);
  await publish(U.adminA, [hcp('1000000001', 'North'), hcp('1000000002', 'North'), hcp('1000000003', 'South')]);
  const north = await territoryId(U.adminA, 'North'), south = await territoryId(U.adminA, 'South');
  await as(U.adminA, `select public.ciq_admin_add_member($1, 'mgr@x.test', 'Manager', 'manager', $2)`, [U.mgrA, `{${north},${south}}`]);
  await as(U.adminA, `select public.ciq_admin_add_member($1, 'rep1@x.test', 'Rep One', 'rep', $2)`, [U.rep1, `{${north}}`]);
  await as(U.adminA, `select public.ciq_admin_add_member($1, 'rep2@x.test', 'Rep Two', 'rep', $2)`, [U.rep2, `{${south}}`]);

  // Company B
  await publish(U.ownerB, [hcp('2000000001', 'West')]);
  const west = await territoryId(U.ownerB, 'West');
  await as(U.ownerB, `select public.ciq_admin_add_member($1, 'repB@x.test', 'Rep B', 'rep', $2)`, [U.repB, `{${west}}`]);
});

test('a rep sees only their own territory', async () => {
  const rows = await as(U.rep1, `select data from public.ciq_app_hcps()`);
  assert.deepEqual(rows.map((r) => r.data.npi).sort(), ['1000000001', '1000000002']);
  assert.ok(rows.every((r) => r.data.territory === 'North'));
  const direct = await as(U.rep1, `select npi from public.hcps`);
  assert.equal(direct.length, 2, 'direct table reads are filtered the same way');
  assert.deepEqual((await as(U.rep1, `select name from public.territories`)).map((r) => r.name), ['North']);
});

test('a manager sees their territories; an admin sees the whole company', async () => {
  assert.equal((await as(U.mgrA, `select * from public.ciq_app_hcps()`)).length, 3);
  assert.equal((await as(U.adminA, `select * from public.ciq_app_hcps()`)).length, 3);
});

test('companies never see each other', async () => {
  assert.deepEqual((await as(U.repB, `select data from public.ciq_app_hcps()`)).map((r) => r.data.npi), ['2000000001']);
  assert.equal((await as(U.ownerA, `select * from public.hcps where org_id <> (select org_id from public.members where user_id = auth.uid())`)).length, 0);
  assert.equal((await as(U.ownerA, `select * from public.organizations`)).length, 1);
  assert.equal((await as(U.ownerA, `select * from public.members where email like '%B@x.test'`)).length, 0);
});

test('people outside any company, and anonymous visitors, see nothing', async () => {
  assert.equal((await as(U.stranger, `select * from public.ciq_app_hcps()`)).length, 0);
  assert.equal((await one(U.stranger, `select public.ciq_my_access()`)).active, false);
  await rejects(as(null, `select * from public.hcps`), /permission denied/);
  await rejects(as(null, `select public.ciq_my_access()`), /permission denied/);
});

test('reps see their own membership but not other people', async () => {
  const rows = await as(U.rep1, `select email from public.members`);
  assert.deepEqual(rows.map((r) => r.email), ['rep1@x.test']);
  const access = await one(U.rep1, `select public.ciq_my_access()`);
  assert.equal(access.active, true);
  assert.equal(access.member.role, 'rep');
  assert.deepEqual(access.territories.map((t) => t.name), ['North']);
});

test('nobody writes tables directly; reps cannot use admin or platform functions', async () => {
  await rejects(as(U.adminA, `insert into public.hcps (org_id, territory_id, publish_id, data) select org_id, id, gen_random_uuid(), '{}' from public.territories limit 1`), /permission denied|row-level security/);
  await rejects(as(U.rep1, `update public.members set role = 'owner'`), /permission denied/);
  await rejects(as(U.rep1, `select public.ciq_admin_overview()`), /owners and admins/);
  await rejects(as(U.rep1, `select public.ciq_publish_begin()`), /owners and admins/);
  await rejects(as(U.ownerA, `select public.ciq_platform_orgs()`), /CompassIQ team only/);
  await rejects(as(U.ownerA, `select public.ciq_platform_set_status(gen_random_uuid(), 'suspended')`), /CompassIQ team only/);
  await rejects(as(U.adminA, `select public.ciq_set_member_territories(gen_random_uuid(), gen_random_uuid(), '{}')`), /permission denied/);
});

test('only owners add or change owners and admins; a company keeps an owner', async () => {
  await rejects(as(U.adminA, `select public.ciq_admin_add_member($1, 'x@x.test', 'X', 'admin', '{}')`, [U.stranger]), /Only an owner/);
  await rejects(as(U.adminA, `select public.ciq_admin_update_member($1, 'admin')`, [U.rep1]), /Only an owner/);
  await rejects(as(U.adminA, `select public.ciq_admin_update_member($1, null, null, 'disabled')`, [U.ownerA]), /Only an owner/);
  await rejects(as(U.ownerA, `select public.ciq_admin_update_member($1, null, null, 'disabled')`, [U.ownerA]), /yourself/);
  await rejects(as(U.adminA, `select public.ciq_admin_update_member($1, null, null, 'disabled')`, [U.adminA]), /yourself/);
});

test('people and territories cannot cross companies', async () => {
  await rejects(as(U.adminA, `select public.ciq_admin_add_member($1, 'repB@x.test', 'Rep B', 'rep', '{}')`, [U.repB]), /another company/);
  const west = await territoryId(U.ownerB, 'West');
  await rejects(as(U.adminA, `select public.ciq_admin_update_member($1, null, $2)`, [U.rep1, `{${west}}`]), /not in this company/);
  await rejects(as(U.adminA, `select public.ciq_admin_update_member($1, 'manager')`, [U.repB]), /No such person/);
});

test('disabling a person cuts off their data immediately; re-enabling restores it', async () => {
  assert.equal(await one(U.adminA, `select public.ciq_admin_update_member($1, null, null, 'disabled')`, [U.rep2]), 'disabled');
  assert.equal((await as(U.rep2, `select * from public.ciq_app_hcps()`)).length, 0);
  assert.equal((await one(U.rep2, `select public.ciq_my_access()`)).active, false);
  await as(U.adminA, `select public.ciq_admin_update_member($1, null, null, 'active')`, [U.rep2]);
  assert.equal((await as(U.rep2, `select * from public.ciq_app_hcps()`)).length, 1);
});

test('suspending a company cuts off everyone in it, admins included', async () => {
  const orgA = await one(U.ownerA, `select org_id from public.members where user_id = auth.uid()`);
  assert.equal(await one(U.platform, `select public.ciq_platform_set_status($1, 'suspended')`, [orgA]), 5, 'people affected');
  for (const u of [U.ownerA, U.adminA, U.mgrA, U.rep1]) {
    assert.equal((await as(u, `select * from public.ciq_app_hcps()`)).length, 0);
    assert.equal((await as(u, `select * from public.territories`)).length, 0);
  }
  await rejects(as(U.ownerA, `select public.ciq_admin_overview()`), /owners and admins/);
  assert.equal((await as(U.repB, `select * from public.ciq_app_hcps()`)).length, 1, 'other companies unaffected');
  await as(U.platform, `select public.ciq_platform_set_status($1, 'active')`, [orgA]);
  assert.equal((await as(U.rep1, `select * from public.ciq_app_hcps()`)).length, 2);
});

test('a new publish stays hidden until it finishes, then replaces the old data', async () => {
  const pid = await one(U.adminA, `select public.ciq_publish_begin()`);
  await as(U.adminA, `select public.ciq_publish_rows($1, $2::jsonb)`, [pid, JSON.stringify([hcp('1000000009', 'North', { trend: 'new' })])]);
  assert.deepEqual((await as(U.rep1, `select data from public.ciq_app_hcps()`)).map((r) => r.data.npi).sort(), ['1000000001', '1000000002'], 'old data still showing mid-publish');
  const res = await one(U.adminA, `select public.ciq_publish_finish($1)`, [pid]);
  assert.deepEqual(res, { hcp_count: 1, territory_count: 1 });
  const rows = await as(U.rep1, `select data from public.ciq_app_hcps()`);
  assert.deepEqual(rows.map((r) => [r.data.npi, r.data.trend]), [['1000000009', 'new']]);
  assert.equal((await as(U.rep2, `select * from public.ciq_app_hcps()`)).length, 0, 'South had no doctors in this publish');
  await rejects(as(U.adminA, `select public.ciq_publish_rows($1, '[]'::jsonb)`, [pid]), /no longer open/);
  const ov = await one(U.adminA, `select public.ciq_admin_overview()`);
  assert.equal(ov.last_publish.hcp_count, 1);
});

test('publishing rejects rows without a territory and empty publishes', async () => {
  const pid = await one(U.adminA, `select public.ciq_publish_begin()`);
  await rejects(as(U.adminA, `select public.ciq_publish_rows($1, $2::jsonb)`, [pid, JSON.stringify([{ npi: '1' }])]), /needs a territory/);
  await rejects(as(U.adminA, `select public.ciq_publish_finish($1)`, [pid]), /Nothing was published/);
  // An abandoned publish never shows up
  await one(U.adminA, `select public.ciq_publish_begin()`);
  assert.equal((await as(U.rep1, `select * from public.ciq_app_hcps()`)).length, 1);
});

test('the CompassIQ team lists companies with counts', async () => {
  const orgs = await one(U.platform, `select public.ciq_platform_orgs()`);
  assert.deepEqual(orgs.map((o) => o.name), ['Acme Pharma', 'Beta Bio']);
  assert.deepEqual(orgs[1].owners, ['ownerb@x.test']);
  assert.equal(orgs[1].hcps, 1);
});
