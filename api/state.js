// /api/state — each person's own plan and settings, so they can switch iPads or territories
//   GET ?since=ISO   → { at, data? } (data only when the saved copy is newer than `since`)
//   POST { data }    → { at }  (data = { T: territories, A: active territory id })
import { handler, requireAccess, rpc, body, httpError, setStateCookie } from './_lib/ciq.js';

export default handler(async (req, res) => {
  const { session, db } = await requireAccess(req, res);
  if (req.method === 'GET') {
    const since = req.query && req.query.since ? String(req.query.since) : null;
    return res.status(200).json((await rpc(db, 'ciq_my_state', { p_since: since })) || {});
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw httpError(405, 'Method not allowed'); }
  const b = body(req);
  if (!b.data || typeof b.data !== 'object' || !b.data.T) throw httpError(400, 'Nothing to save');
  const at = await rpc(db, 'ciq_save_state', { p_data: b.data });
  setStateCookie(req, res, session.user.id, at);
  res.status(200).json({ at });
});
