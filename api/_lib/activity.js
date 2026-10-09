// Call activity in the basic format: NPI, call date, optional call type and status.
// Accepts JSON rows ({ npi, date, type?, status? }, field names matched loosely) or CSV text.

const DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const DATE_US = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

export function normDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let y, m, d, x;
  if ((x = DATE_ISO.exec(s))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = DATE_US.exec(s))) [m, d, y] = [+x[1], +x[2], x[3].length === 2 ? 2000 + +x[3] : +x[3]];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;   // e.g. Feb 31
  return dt.toISOString().slice(0, 10);
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const pick = (obj, names) => { for (const k of Object.keys(obj)) if (names.some((n) => key(k) === n || key(k).startsWith(n))) return obj[k]; return undefined; };

// → { calls: [{ npi, date, type, status }], skipped }
export function normalizeCalls(input) {
  let objs;
  if (typeof input === 'string') {
    const rows = parseCsv(input);
    if (rows.length < 2) return { calls: [], skipped: 0 };
    const head = rows[0];
    objs = rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  } else objs = Array.isArray(input) ? input : [];
  const calls = []; let skipped = 0;
  for (const o of objs) {
    if (!o || typeof o !== 'object') { skipped++; continue; }
    const npi = String(pick(o, ['npi', 'hcpnpi', 'prescribernpi']) ?? '').replace(/\D/g, '');
    const date = normDate(pick(o, ['calldate', 'activitydate', 'visitdate', 'date']));
    if (!npi || !date) { skipped++; continue; }
    calls.push({ npi, date, type: String(pick(o, ['calltype', 'activitytype', 'channel', 'type']) ?? '').slice(0, 40),
      status: String(pick(o, ['callstatus', 'status']) ?? '') });
  }
  return { calls, skipped };
}
