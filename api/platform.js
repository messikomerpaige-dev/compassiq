// /api/platform — the CompassIQ team only (platform_admins)
//   GET                                                   → companies with counts
//   POST { action: 'create', name, owner_email, owner_name }  → new company + owner invite
//   POST { action: 'status', org_id, status: 'active' | 'suspended' }
//        Takes effect on everyone's next request: the database stops returning the company's data,
//        and open apps erase their local copy and show /blocked at their next access check.
import { handler, requireAccess, rpc, body, httpError, inviteLogin, EMAIL_RE } from './_lib/ciq.js';

export default handler(async (req, res) => {
  const { db, access } = await requireAccess(req, res);
  if (!access.platform_admin) throw httpError(403, 'CompassIQ team only');

  if (req.method === 'GET') return res.status(200).json(await rpc(db, 'ciq_platform_orgs'));
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw httpError(405, 'Method not allowed'); }

  const b = body(req);
  if (b.action === 'create') {
    const name = String(b.name || '').trim(), email = String(b.owner_email || '').trim().toLowerCase();
    if (!name) throw httpError(400, 'Enter the company name');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter the owner’s email');
    const orgId = await rpc(db, 'ciq_platform_create_org', { p_name: name });
    const { userId, existing } = await inviteLogin(req, email, String(b.owner_name || '').trim());
    await rpc(db, 'ciq_platform_add_owner', { p_org: orgId, p_user: userId, p_email: email, p_full_name: String(b.owner_name || '').trim() });
    return res.status(200).json({ ok: true, org_id: orgId, existing });
  }
  if (b.action === 'status') {
    if (!['active', 'suspended'].includes(b.status)) throw httpError(400, 'Choose active or suspended');
    const people = await rpc(db, 'ciq_platform_set_status', { p_org: String(b.org_id || ''), p_status: b.status });
    return res.status(200).json({ ok: true, people });
  }
  throw httpError(400, 'Unknown action');
});
