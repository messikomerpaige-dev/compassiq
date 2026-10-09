// /api/ping — lets the rep app's sync turn itself on: { ok, email } for an active member
import { handler, requireAccess, httpError } from './_lib/ciq.js';

export default handler(async (req, res) => {
  const { session, access } = await requireAccess(req, res);
  if (!access.active) throw httpError(403, 'Your CompassIQ access is turned off');
  res.status(200).json({ ok: true, email: session.user.email });
});
