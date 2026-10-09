// Team & territories → "Import from a sheet": invite or update many people from one spreadsheet.
// Columns: Email, Name, Role, Territory (several territories for a manager: separate with ; or |).
// planImport() is pure (no DOM) so the tests can run it directly.
(function (root) {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function normRole(v) {
    const s = String(v || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
    if (!s) return '';
    if (/^(rep|reps|sales ?rep|representative|sales representative|field rep|territory rep)$/.test(s)) return 'rep';
    if (/^owner/.test(s)) return 'owner';
    if (/^admin/.test(s)) return 'admin';
    if (/manager|^dm$|^rm$|^rbd$|district|regional|director/.test(s)) return 'manager';
    return '';
  }

  // rows: array of arrays (first row = headers). state: /api/admin overview. Returns { items, error }.
  function planImport(rows, state) {
    if (!rows || rows.length < 2) return { items: [], error: 'The sheet is empty — use the template.' };
    const head = rows[0].map((c) => String(c || '').trim().toLowerCase().replace(/[^a-z]/g, ''));
    const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
    const iEmail = col('email', 'emailaddress'), iName = col('name', 'fullname', 'repname'),
      iRole = col('role', 'title', 'position'), iTerr = col('territory', 'territories', 'terr');
    if (iEmail < 0 || iRole < 0) return { items: [], error: 'The sheet needs at least Email and Role columns — use the template.' };

    const myRole = state.me.role;
    const terrByName = new Map(state.territories.map((t) => [t.name.trim().toLowerCase(), t]));
    const memberByEmail = new Map(state.members.map((m) => [m.email.toLowerCase(), m]));
    const seen = new Set();
    const items = [];

    rows.slice(1).forEach((r, k) => {
      const cell = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
      const email = cell(iEmail).toLowerCase(), name = cell(iName), roleRaw = cell(iRole), terrRaw = cell(iTerr);
      if (!email && !name && !roleRaw && !terrRaw) return;                        // blank row
      const it = { row: k + 2, email, name, role: normRole(roleRaw), roleRaw, territoryIds: [], territoryNames: [], action: 'error', note: '' };
      items.push(it);
      const fail = (note) => { it.action = 'error'; it.note = note; };

      if (!EMAIL_RE.test(email)) return fail('Email isn’t valid');
      if (seen.has(email)) return fail('This email is already in the sheet above');
      seen.add(email);
      if (!it.role) return fail(roleRaw ? `Unknown role “${roleRaw}” — use Rep, Manager, Admin or Owner` : 'Role is missing');
      if (['owner', 'admin'].includes(it.role) && myRole !== 'owner') return fail('Only an owner can add owners and admins');

      if (!['owner', 'admin'].includes(it.role)) {
        const names = terrRaw.split(/[;|\n]/).map((s) => s.trim()).filter(Boolean);
        const unknown = names.filter((n) => !terrByName.has(n.toLowerCase()));
        if (unknown.length) return fail(`No territory called ${unknown.map((n) => '“' + n + '”').join(', ')}`);
        const ts = [...new Map(names.map((n) => terrByName.get(n.toLowerCase())).map((t) => [t.id, t])).values()];
        it.territoryIds = ts.map((t) => t.id);
        it.territoryNames = ts.map((t) => t.name);
        if (it.role === 'rep' && ts.length !== 1) return fail(ts.length ? 'A rep gets exactly one territory' : 'Territory is missing');
        if (it.role === 'manager' && !ts.length) return fail('Territory is missing (separate several with ;)');
      }

      const m = memberByEmail.get(email);
      if (!m) { it.action = 'invite'; it.note = 'New — gets an invite email'; return; }
      it.userId = m.user_id;
      if (m.user_id === state.me.user_id) { it.action = 'skip'; it.note = 'That’s you'; return; }
      if (['owner', 'admin'].includes(m.role) && myRole !== 'owner') return fail('Only an owner can change owners and admins');
      const changes = [];
      if (m.role !== it.role) changes.push(`role ${m.role} → ${it.role}`);
      const before = [...m.territory_ids].sort().join(','), after = [...it.territoryIds].sort().join(',');
      if (!['owner', 'admin'].includes(it.role) && before !== after) changes.push('territories');
      if (name && name !== m.full_name) changes.push('name');
      const off = m.status !== 'active' ? ' (turned off — stays off)' : '';
      if (!changes.length) { it.action = 'skip'; it.note = 'Already on the team, no changes' + off; return; }
      it.action = 'update'; it.note = 'Update: ' + changes.join(', ') + off;
    });
    return { items, error: items.length ? '' : 'No people found in the sheet.' };
  }

  function templateCsv(state) {
    const t = state.territories.map((x) => x.name);
    const q = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const rows = [['Email', 'Name', 'Role', 'Territory'],
      ['jordan.lee@example.com', 'Jordan Lee', 'Rep', t[0] || 'Territory name'],
      ['sam.patel@example.com', 'Sam Patel', 'Rep', t[1] || t[0] || 'Territory name'],
      ['alex.kim@example.com', 'Alex Kim', 'Manager', t.slice(0, 2).join('; ') || 'Territory A; Territory B']];
    return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
  }

  root.CIQImport = { planImport, normRole, templateCsv };
})(typeof window !== 'undefined' ? window : globalThis);
