// "Import from a sheet": how each row is checked and what will happen to it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/assets/ciq-import.js';   // a browser script: it sets globalThis.CIQImport

const { planImport, normRole } = globalThis.CIQImport;

const T = { n: { id: 't-n', name: 'Trenton, NJ' }, s: { id: 't-s', name: 'Tulsa, OK' }, w: { id: 't-w', name: 'West Virtual' } };
const state = (myRole = 'owner') => ({
  me: { user_id: 'u-me', role: myRole },
  territories: Object.values(T),
  members: [
    { user_id: 'u-me', email: 'me@acme.test', full_name: 'Me', role: myRole, status: 'active', territory_ids: [] },
    { user_id: 'u-1', email: 'rita@acme.test', full_name: 'Rita Reyes', role: 'rep', status: 'active', territory_ids: ['t-n'] },
    { user_id: 'u-2', email: 'ada@acme.test', full_name: 'Ada', role: 'admin', status: 'active', territory_ids: [] },
    { user_id: 'u-3', email: 'off@acme.test', full_name: 'Off', role: 'rep', status: 'disabled', territory_ids: ['t-s'] },
  ],
});
const HEAD = ['Email', 'Name', 'Role', 'Territory'];
const plan = (rows, role) => planImport([HEAD, ...rows], state(role));
const byEmail = (r) => Object.fromEntries(r.items.map((i) => [i.email, i]));

test('roles are read from common spellings', () => {
  assert.deepEqual(['Rep', 'sales rep', 'Sales Representative', 'District Manager', 'DM', 'RBD', 'Admin', 'administrator', 'Owner', 'intern']
    .map(normRole), ['rep', 'rep', 'rep', 'manager', 'manager', 'manager', 'admin', 'admin', 'owner', '']);
});

test('new people are invited with their territories; names with commas work', () => {
  const r = byEmail(plan([
    ['New.Rep@Acme.test', 'New Rep', 'Rep', 'trenton, nj'],
    ['mgr@acme.test', 'Max', 'Manager', 'Trenton, NJ; Tulsa, OK | West Virtual'],
    ['boss@acme.test', 'Boss', 'Admin', ''],
  ]));
  assert.equal(r['new.rep@acme.test'].action, 'invite');
  assert.deepEqual(r['new.rep@acme.test'].territoryIds, ['t-n']);
  assert.deepEqual(r['mgr@acme.test'].territoryIds, ['t-n', 't-s', 't-w']);
  assert.equal(r['boss@acme.test'].action, 'invite');
  assert.deepEqual(r['boss@acme.test'].territoryIds, []);
});

test('rows with problems are flagged, not sent', () => {
  const r = plan([
    ['not-an-email', 'X', 'Rep', 'Tulsa, OK'],
    ['a@acme.test', 'A', 'Rep', 'Atlantis'],
    ['b@acme.test', 'B', 'Rep', 'Tulsa, OK; Trenton, NJ'],
    ['c@acme.test', 'C', 'Rep', ''],
    ['d@acme.test', 'D', 'Manager', ''],
    ['e@acme.test', 'E', 'Wizard', 'Tulsa, OK'],
    ['e@acme.test', 'E again', 'Rep', 'Tulsa, OK'],
    ['', '', '', ''],
  ]).items;
  assert.deepEqual(r.map((i) => [i.row, i.action, i.note.replace(/[“”]/g, '"')]), [
    [2, 'error', 'Email isn’t valid'],
    [3, 'error', 'No territory called "Atlantis"'],
    [4, 'error', 'A rep gets exactly one territory'],
    [5, 'error', 'Territory is missing'],
    [6, 'error', 'Territory is missing (separate several with ;)'],
    [7, 'error', 'Unknown role "Wizard" — use Rep, Manager, Admin or Owner'],
    [8, 'error', 'This email is already in the sheet above'],
  ]);
});

test('people already on the team are updated only when something changed', () => {
  const r = byEmail(plan([
    ['rita@acme.test', 'Rita Reyes', 'Rep', 'Trenton, NJ'],     // same
    ['me@acme.test', 'Me', 'Rep', 'Tulsa, OK'],                  // yourself
    ['off@acme.test', '', 'Rep', 'Trenton, NJ'],                 // moved, but stays turned off
  ]));
  assert.equal(r['rita@acme.test'].action, 'skip');
  assert.equal(r['me@acme.test'].action, 'skip');
  assert.equal(r['off@acme.test'].action, 'update');
  assert.match(r['off@acme.test'].note, /territories.*stays off/);
  const moved = byEmail(plan([['rita@acme.test', '', 'Manager', 'Trenton, NJ; Tulsa, OK']]))['rita@acme.test'];
  assert.equal(moved.action, 'update');
  assert.equal(moved.userId, 'u-1');
  assert.match(moved.note, /role rep → manager, territories/);
});

test('admins cannot add or change owners and admins', () => {
  const r = byEmail(plan([['new@acme.test', 'N', 'Admin', ''], ['ada@acme.test', 'Ada', 'Rep', 'Tulsa, OK']], 'admin'));
  assert.match(r['new@acme.test'].note, /Only an owner/);
  assert.match(r['ada@acme.test'].note, /Only an owner/);
});

test('sheets without the needed columns are refused', () => {
  assert.match(planImport([['Name', 'Territory'], ['x', 'y']], state()).error, /Email and Role/);
  assert.match(planImport([HEAD], state()).error, /empty/);
  assert.equal(planImport([['E-mail', 'Full Name', 'Title', 'Territories'], ['z@acme.test', 'Z', 'rep', 'Tulsa, OK']], state()).items[0].action, 'invite');
});
