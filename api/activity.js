// /api/activity — call activity
//   GET  ?from=YYYY-MM-DD   (signed in) → { asOf, through, calls: [{ npi, date, type, status }] } for the
//        caller's doctors: warehouse calls plus visits marked done in the app before today.
//   POST (data warehouse)   Authorization: Bearer <company key from Team & territories>
//        body: JSON { through?: 'YYYY-MM-DD', calls: [{ npi, date, type?, status? }] }
//          or  CSV text (NPI, Call_Date, Call_Type?, Status?) with ?through=YYYY-MM-DD optional
//        → { rows, through, skipped }
import { createHash } from 'node:crypto';
import { handler, requireAccess, rpc, httpError, serviceClient } from './_lib/ciq.js';
import { normalizeCalls, normDate } from './_lib/activity.js';

// Vercel parses JSON and text/plain bodies; anything else (text/csv) is left unparsed but still
// readable from the request stream
function readRaw(req) {
  if (typeof req.on !== 'function') return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function quarterStart(d = new Date()) {
  return new Date(Date.UTC(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
}

export default handler(async (req, res) => {
  if (req.method === 'GET') {
    const { db } = await requireAccess(req, res);
    const from = normDate(req.query && req.query.from) || quarterStart();
    return res.status(200).json(await rpc(db, 'ciq_my_activity', { p_from: from }));
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw httpError(405, 'Method not allowed'); }

  const auth = String(req.headers.authorization || '');
  const keyText = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!keyText) throw httpError(401, 'Send the company’s data warehouse key as "Authorization: Bearer <key>"');
  const admin = serviceClient();
  const hash = createHash('sha256').update(keyText).digest('hex');
  const org = await rpc(admin, 'ciq_key_org', { p_hash: hash });
  if (!org) throw httpError(401, 'That key is not valid (revoked, mistyped, or the company is suspended)');

  let payload;
  try { payload = req.body; } catch { throw httpError(400, 'Body is not valid JSON'); }
  if (payload === undefined || payload === null || payload === '') payload = await readRaw(req);
  if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');
  const isCsv = typeof payload === 'string' && !/^\s*[{[]/.test(payload);
  if (typeof payload === 'string' && !isCsv) { try { payload = JSON.parse(payload); } catch { throw httpError(400, 'Body is not valid JSON or CSV'); } }
  const { calls, skipped } = normalizeCalls(isCsv ? payload : (Array.isArray(payload) ? payload : payload && payload.calls));
  if (!calls.length) throw httpError(400, 'No calls with an NPI and a readable date' + (skipped ? ` (${skipped} rows skipped)` : ''));
  const through = normDate((req.query && req.query.through) || (payload && payload.through)) || null;

  let rows = 0, last = null;
  for (let i = 0; i < calls.length; i += 5000) {
    const chunk = calls.slice(i, i + 5000);
    const isLast = i + 5000 >= calls.length;
    const r = await rpc(admin, 'ciq_ingest_activity', { p_org: org, p_through: isLast ? through : chunk.reduce((m, c) => (c.date > m ? c.date : m), ''),
      p_rows: chunk, p_source: 'warehouse', p_user: null });
    rows += r.rows; last = r.through;
  }
  res.status(200).json({ rows, through: last, skipped });
});
