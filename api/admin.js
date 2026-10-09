// /api/admin — company owners and admins (every check is repeated in the database functions)
//   GET                                         → overview: company, territories, people, last publish
//   POST { action: 'invite', email, full_name, role, territory_ids }
//   POST { action: 'update', user_id, role?, territory_ids?, status?, full_name? }
//   POST { action: 'publish_begin' }            → { publish_id }
//   POST { action: 'publish_rows', publish_id, rows }   (≤ 1000 doctors per call)
//   POST { action: 'publish_finish', publish_id }       → { hcp_count, territory_count }
import { handler, requireAccess, rpc, body, httpError, inviteLogin, EMAIL_RE } from './_lib/ciq.js';

const ROLES = ['owner', 'admin', 'manager', 'rep'];
const uuids = (v) => (Array.isArray(v) ? v.map(String) : null);

export default handler(async (req, res) => {
  const { db, access } = await requireAccess(req, res);
  if (!access.active || !['owner', 'admin'].includes(access.member && access.member.role)) {
    throw httpError(403, 'Only company owners and admins can do this');
  }

  if (req.method === 'GET') return res.status(200).json(await rpc(db, 'ciq_admin_overview'));
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); throw httpError(405, 'Method not allowed'); }

  const b = body(req);
  switch (b.action) {
    case 'invite': {
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email');
      if (!ROLES.includes(b.role)) throw httpError(400, 'Choose a role');
      const territoryIds = uuids(b.territory_ids) || [];
      if (b.role === 'rep' && territoryIds.length !== 1) throw httpError(400, 'Give a rep exactly one territory');
      // Check permissions before sending any email: the database refuses roles the caller can't grant
      if (['owner', 'admin'].includes(b.role) && access.member.role !== 'owner') {
        throw httpError(403, 'Only an owner can add owners and admins');
      }
      const overview = await rpc(db, 'ciq_admin_overview');
      const known = new Set(overview.territories.map((t) => t.id));
      if (territoryIds.some((id) => !known.has(id))) throw httpError(400, 'Territory is not in this company');
      if (overview.members.some((m) => m.email === email)) throw httpError(409, 'That person is already on your team');
      const { userId, existing } = await inviteLogin(req, email, String(b.full_name || '').trim());
      await rpc(db, 'ciq_admin_add_member', {
        p_user: userId, p_email: email, p_full_name: String(b.full_name || '').trim(), p_role: b.role, p_territories: territoryIds,
      });
      return res.status(200).json({ ok: true, existing });
    }
    case 'update': {
      if (!b.user_id) throw httpError(400, 'Missing person');
      if (b.role === 'rep' && Array.isArray(b.territory_ids) && b.territory_ids.length !== 1) {
        throw httpError(400, 'Give a rep exactly one territory');
      }
      const status = await rpc(db, 'ciq_admin_update_member', {
        p_user: String(b.user_id),
        p_role: b.role || null,
        p_territories: uuids(b.territory_ids),
        p_status: b.status || null,
        p_full_name: b.full_name || null,
      });
      return res.status(200).json({ ok: true, status });
    }
    case 'publish_begin':
      return res.status(200).json({ publish_id: await rpc(db, 'ciq_publish_begin') });
    case 'publish_rows': {
      if (!Array.isArray(b.rows) || b.rows.length > 1000) throw httpError(400, 'Send up to 1000 doctors at a time');
      const n = await rpc(db, 'ciq_publish_rows', { p_publish: String(b.publish_id || ''), p_rows: b.rows });
      return res.status(200).json({ received: n });
    }
    case 'publish_finish':
      return res.status(200).json(await rpc(db, 'ciq_publish_finish', { p_publish: String(b.publish_id || '') }));
    default:
      throw httpError(400, 'Unknown action');
  }
});
