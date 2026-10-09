// /api/sync — POST { rep, outcomes: [...], prefs: [...] } from the rep app's sync queue.
// Visit outcomes are kept per person; doctor preferences (hours, do-not-call, by-appointment,
// corrected address) are shared with everyone at the company who sees that doctor.
import { handler, requireAccess, rpc, body, httpError } from './_lib/ciq.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw httpError(405, 'Method not allowed'); }
  const { db } = await requireAccess(req, res);
  const b = body(req);
  const saved = await rpc(db, 'ciq_sync', {
    p_outcomes: Array.isArray(b.outcomes) ? b.outcomes : [],
    p_prefs: Array.isArray(b.prefs) ? b.prefs : [],
  });
  res.status(200).json({ ok: true, ...saved });
});
