// /api/prefs — shared doctor preferences for the signed-in person's doctors: { prefs: [...] }
import { handler, requireAccess, rpc } from './_lib/ciq.js';

export default handler(async (req, res) => {
  const { db } = await requireAccess(req, res);
  res.status(200).json({ prefs: await rpc(db, 'ciq_shared_prefs') });
});
