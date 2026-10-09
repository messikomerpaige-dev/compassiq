// Browser test of the whole Phase 1 flow, against the local server + fake Supabase.
// Run: npm run test:e2e   (needs Playwright's Chromium)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createFakeSupabase } from '../helpers/fake-supabase.mjs';
import { startServer, SUPABASE_JS_STUB } from '../helpers/dev-server.mjs';
import { setClientFactory } from '../../api/_lib/ciq.js';

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

let fake, server, base, browser;
const pwUpdates = [];
const ids = {};

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });   // iPad landscape
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ contentType: 'application/javascript', body: SUPABASE_JS_STUB }));
  await ctx.route(/^https:\/\/(cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com|server\.arcgisonline\.com)\//, (r) => r.abort());
  // Supabase's own "update my password" endpoint (the set-password page calls it directly)
  await ctx.route('http://supabase.test/auth/v1/user', async (r) => {
    const token = (r.request().headers().authorization || '').replace(/^Bearer /, '');
    const id = fake.state.access.get(token);
    if (!id || r.request().method() !== 'PUT') return r.fulfill({ status: 401, contentType: 'application/json', body: '{"msg":"invalid JWT"}' });
    fake.state.passwords.set(id, JSON.parse(r.request().postData()).password);
    pwUpdates.push(id);
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ id }) });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}
async function signIn(page, email, password, landing) {
  await page.goto(base + '/');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#go');
  await page.waitForURL(base + landing, { timeout: 30000 });
}
const hcp = (npi, territory, zip = '19103') => ({ npi, territory, firstName: 'Dr', lastName: 'E' + npi, address: npi.slice(-3) + ' Main St',
  city: 'Philadelphia', state: 'PA', zip5: zip, zip4: zip, segment: 'ABCD'[Number(npi) % 4], callGoal: 8 });

before(async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: new URL('../..', import.meta.url) });
  fake = await createFakeSupabase();
  setClientFactory(fake.factory);
  server = await startServer(fake);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  // Seed: CompassIQ team member, one company with an owner (as created via /platform)
  ids.team = await fake.createUser('team@compassiq.test', 'team-password-1');
  await fake.db.query('insert into public.platform_admins (user_id) values ($1)', [ids.team]);
});
after(async () => { await browser?.close(); server?.close(); });

test('the CompassIQ team adds a company; the owner accepts the invite', async () => {
  const page = await newPage();
  await signIn(page, 'team@compassiq.test', 'team-password-1', '/platform');
  await page.click('#new-open');
  await page.fill('#n-name', 'Acme Pharma');
  await page.fill('#n-owner', 'owner@acme.test');
  await page.fill('#n-owner-name', 'Olive Owner');
  await page.click('#new-save');
  await page.waitForSelector('#orgs tr:has-text("Acme Pharma")');
  assert.match(await page.textContent('#page-msg'), /Invite sent/);

  // Owner opens the emailed link (tokens in the URL hash) and sets a password
  const inv = fake.state.invites.find((i) => i.email === 'owner@acme.test');
  ids.owner = inv.id;
  const s = fake.issue(inv.id);
  const owner = await newPage();
  await owner.goto(`${inv.redirectTo.replace('http://localhost:3000', base)}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&type=invite`);
  await owner.waitForSelector('#form:not([hidden])');
  assert.equal(new URL(owner.url()).hash, '', 'tokens removed from the address bar');
  assert.match(await owner.textContent('#title'), /Welcome/);
  await owner.fill('#pw', 'owner-password-1');
  await owner.fill('#pw2', 'owner-password-1');
  await owner.click('#go');
  await owner.waitForURL(base + '/admin');
  assert.deepEqual(pwUpdates, [inv.id], 'password saved with Supabase using the link’s sign-in');
  await owner.waitForSelector('#last-publish:has-text("No doctor data published yet")');
  assert.deepEqual(page.errors.concat(owner.errors), []);
});

test('the owner publishes doctor data from the admin tool', async () => {
  const page = await newPage();
  await signIn(page, 'owner@acme.test', 'owner-password-1', '/admin');
  await page.click('a[href="/admin/tool"]');
  await page.waitForURL(base + '/admin/tool');
  await page.waitForSelector('#agx-publish.on', { timeout: 30000 });           // local sign-in step skipped
  assert.equal(await page.$('#agx .agx-links details'), null, 'old local sign-in settings removed');
  // Load a doctor file through the tool's own import path
  await page.evaluate((rows) => { finishImport(rows, 'test'); _agxRefresh(); },
    [...Array.from({ length: 30 }, (_, i) => hcp(String(1000000100 + i), 'North')),
     ...Array.from({ length: 12 }, (_, i) => hcp(String(1000000200 + i), 'South', '19087'))]);
  assert.equal(await page.textContent('#agx-go'), 'Publish to reps');
  await page.click('#agx-go');
  await page.waitForSelector('#agx-done.on', { timeout: 30000 });
  assert.match(await page.textContent('#agx-done-msg'), /42 HCPs/);
  assert.match(await page.textContent('#agx-done'), /next time they open CompassIQ/);
  await page.goto(base + '/admin');
  await page.waitForSelector('#territories tr:has-text("North")');
  assert.match(await page.textContent('#stats'), /42\s*doctors/);
  assert.deepEqual(page.errors, []);
});

test('the owner invites reps and a manager', async () => {
  const page = await newPage();
  await signIn(page, 'owner@acme.test', 'owner-password-1', '/admin');
  await page.waitForSelector('#territories tr:has-text("South")');
  for (const [email, name, role, terrs] of [['rep1@acme.test', 'Rita Rep', 'rep', ['North']], ['rep2@acme.test', 'Sam Rep', 'rep', ['South']],
    ['mgr@acme.test', 'Max Manager', 'manager', ['North', 'South']]]) {
    await page.click('#invite-open');
    await page.fill('#p-email', email);
    await page.fill('#p-name', name);
    await page.selectOption('#p-role', role);
    for (const t of terrs) await page.check(`#p-terrs label:has-text("${t}") input`);
    await page.click('#person-save');
    await page.waitForSelector(`#people tr:has-text("${name}")`);
  }
  // A rep needs exactly one territory
  await page.click('#invite-open');
  await page.fill('#p-email', 'nope@acme.test');
  await page.click('#person-save');
  assert.match(await page.textContent('#person-msg'), /Pick the rep’s territory/);
  await page.click('#person-cancel');
  for (const email of ['rep1@acme.test', 'rep2@acme.test', 'mgr@acme.test']) {
    const inv = fake.state.invites.find((i) => i.email === email);
    ids[email] = inv.id;
    await fake.db.query('select 1');   // keep the fake's db warm
    fake.state.passwords.set(inv.id, email.split('@')[0] + '-password-1');
  }
  assert.deepEqual(page.errors, []);
});

test('a rep gets only their territory, and can build a plan', async () => {
  const page = await newPage();
  // Leftovers from someone else on this iPad must not survive
  await page.goto(base + '/blocked.html');
  await page.evaluate(() => localStorage.setItem('tiq_territories', JSON.stringify({ other: { name: 'Someone else' } })));
  await signIn(page, 'rep1@acme.test', 'rep1-password-1', '/app');
  await page.waitForFunction(() => typeof generateQuarter === 'function' && document.querySelector('.ciq-acct'), null, { timeout: 60000 });
  const r = await page.evaluate(() => ({
    all: ALL_HCPS.length, terrs: [...new Set(ALL_HCPS.map((h) => h.territory))],
    acct: document.querySelector('.ciq-acct').innerText, owner: localStorage.getItem('ciq_owner'),
    leftover: (localStorage.getItem('tiq_territories') || '').includes('Someone else'),
    storedHcps: localStorage.getItem('tiq_all_hcps'),
  }));
  assert.equal(r.all, 30);
  assert.deepEqual(r.terrs, ['North']);
  assert.match(r.acct, /Rita Rep[\s\S]*Acme Pharma · North[\s\S]*Sign out/);
  assert.equal(r.owner, ids['rep1@acme.test']);
  assert.equal(r.leftover, false, 'previous person’s data erased');
  assert.equal(r.storedHcps, null, 'doctor list is not copied into browser storage');
  // No downloadable copy of the app with data inside
  const backup = await page.evaluate(() => {
    let downloaded = false; const orig = window.downloadFile; window.downloadFile = () => { downloaded = true; };
    saveBackupFile(false); saveToFile(); window.downloadFile = orig;
    return { downloaded, button: getComputedStyle(document.getElementById('p3-save')).display };
  });
  assert.deepEqual(backup, { downloaded: false, button: 'none' });
  // Pick the territory and build a plan, as a rep would
  const plan = await page.evaluate(() => {
    if (!STATE.hcps.length && typeof selectTerritoryFromAdmin === 'function') selectTerritoryFromAdmin('North');
    if (!STATE.hcps.length) { STATE.hcps = mergeHCPPrefs(ALL_HCPS.filter((h) => h.territory === 'North'), []); }
    document.getElementById('plan-start-date').value = '2026-10-12';
    generateQuarter();
    return { visits: STATE.plan.length, npis: new Set(STATE.plan.map((v) => v.npi)).size };
  });
  assert.ok(plan.visits > 30 && plan.npis === 30, JSON.stringify(plan));
  assert.deepEqual(page.errors, []);
});

test('a manager gets their territories; signed-out visitors are sent to sign in', async () => {
  const page = await newPage();
  await signIn(page, 'mgr@acme.test', 'mgr-password-1', '/app');
  await page.waitForFunction(() => typeof ALL_HCPS !== 'undefined' && document.querySelector('.ciq-acct'), null, { timeout: 60000 });
  assert.deepEqual(await page.evaluate(() => [ALL_HCPS.length, [...new Set(ALL_HCPS.map((h) => h.territory))].sort()]), [42, ['North', 'South']]);
  const anon = await newPage();
  await anon.goto(base + '/app');
  await anon.waitForURL(/\/\?next=%2Fapp$/, { timeout: 30000 });
  await anon.goto(base + '/admin');
  await anon.waitForURL(/\/\?next=\/admin$/);
});

test('turning a rep off locks them out and erases the app data on their device', async () => {
  const rep = await newPage();
  await signIn(rep, 'rep2@acme.test', 'rep2-password-1', '/app');
  await rep.waitForFunction(() => document.querySelector('.ciq-acct'), null, { timeout: 60000 });
  await rep.evaluate(() => saveState());
  assert.ok(await rep.evaluate(() => !!localStorage.getItem('tiq_territories')));

  const owner = await newPage();
  await signIn(owner, 'owner@acme.test', 'owner-password-1', '/admin');
  await owner.click('#people tr:has-text("Sam Rep") button:has-text("Turn off")');
  await owner.waitForSelector('#people tr:has-text("Sam Rep") .pill.off');

  // Next time the app opens, the rep is out and local data is gone
  await rep.reload();
  await rep.waitForURL(base + '/blocked', { timeout: 30000 });
  assert.equal(await rep.evaluate(() => localStorage.getItem('tiq_territories')), null);
  assert.match(await rep.textContent('h1'), /access is turned off/);
  // Signing out and back in lands on the same page
  await rep.click('#out');
  await rep.waitForURL(base + '/');
  await signIn(rep, 'rep2@acme.test', 'rep2-password-1', '/blocked');
});

test('an app left open finds out at its next access check', async () => {
  const rep = await newPage();
  await signIn(rep, 'rep1@acme.test', 'rep1-password-1', '/app');
  await rep.waitForFunction(() => document.querySelector('.ciq-acct'), null, { timeout: 60000 });
  await rep.evaluate(() => saveState());
  await fake.db.query(`update public.members set status = 'disabled' where email = 'rep1@acme.test'`);
  // The app checks every 5 minutes and when it comes back to the foreground
  await rep.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Date.now = ((n) => () => n() + 10 * 60 * 1000)(Date.now); document.dispatchEvent(new Event('visibilitychange')); });
  await rep.waitForURL(base + '/blocked', { timeout: 30000 });
  assert.equal(await rep.evaluate(() => localStorage.getItem('tiq_territories')), null);
  await fake.db.query(`update public.members set status = 'active' where email = 'rep1@acme.test'`);
});

test('suspending the company locks out everyone, including the owner', async () => {
  const team = await newPage();
  await signIn(team, 'team@compassiq.test', 'team-password-1', '/platform');
  await team.click('#orgs tr:has-text("Acme Pharma") button:has-text("Suspend")');
  await team.waitForSelector('#orgs tr:has-text("Acme Pharma") .pill.off');
  for (const [email, pw] of [['owner@acme.test', 'owner-password-1'], ['rep1@acme.test', 'rep1-password-1']]) {
    const p = await newPage();
    await signIn(p, email, pw, '/blocked');
  }
  await team.click('#orgs tr:has-text("Acme Pharma") button:has-text("Reactivate")');
  await team.waitForSelector('#orgs tr:has-text("Acme Pharma") .pill.ok');
  const back = await newPage();
  await signIn(back, 'rep1@acme.test', 'rep1-password-1', '/app');
  assert.deepEqual(team.errors.concat(back.errors), []);
});
