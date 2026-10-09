// /api/team?week=YYYY-MM-DD — the manager team view (owners, admins and managers)
//   → { weekStart, quarter: { start, end }, reps: [...] } for the reps in the caller's territories:
//     quarter progress (calls vs goal, doctors reached, missed visits) and their plan for that week.
//   The week is the Monday–Sunday containing the date (default: this week); the quarter is the
//   calendar quarter of that Monday.
import { handler, requireAccess, rpc, httpError } from './_lib/ciq.js';
import { normDate } from './_lib/activity.js';

const iso = (d) => d.toISOString().slice(0, 10);

export function weekAndQuarter(dateIso) {
  const d = new Date((normDate(dateIso) || iso(new Date())) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));            // back to Monday
  const q = Math.floor(d.getUTCMonth() / 3) * 3;
  return {
    weekStart: iso(d),
    quarter: { start: iso(new Date(Date.UTC(d.getUTCFullYear(), q, 1))), end: iso(new Date(Date.UTC(d.getUTCFullYear(), q + 3, 0))) },
  };
}

export default handler(async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw httpError(405, 'Method not allowed'); }
  const { db, access } = await requireAccess(req, res);
  if (!access || !access.active) throw httpError(403, 'Your access is turned off');
  const w = weekAndQuarter(req.query && req.query.week);
  const reps = await rpc(db, 'ciq_team_overview', { p_week_start: w.weekStart, p_q_start: w.quarter.start, p_q_end: w.quarter.end });
  res.status(200).json({ ...w, org: access.org && access.org.name, role: access.member && access.member.role, reps });
});
