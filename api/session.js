// /api/session
//   GET  ?config=1            → { url, anonKey } for the sign-in page (both are public by design)
//   GET                       → who is signed in: { email, access } — 401 when signed out
//   POST { access_token, refresh_token }  → start the server session (HttpOnly cookies)
//   POST { action: 'password', password }  → set the signed-in person's password
//   DELETE                    → sign out
import {
  handler, env, body, getSession, requireAccess, anonClient, serviceClient,
  setSessionCookies, clearSessionCookies, httpError, parseCookies,
} from './_lib/ciq.js';

export default handler(async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.config) {
    const { url, anonKey } = env();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ url, anonKey });
  }

  if (req.method === 'GET') {
    const { session, access } = await requireAccess(req, res);
    return res.status(200).json({ email: session.user.email, access, home: homeFor(access) });
  }

  if (req.method === 'POST') {
    const b = body(req);
    if (b.action === 'password') {
      const session = await getSession(req, res);
      if (!session) throw httpError(401, 'Please sign in');
      const pw = String(b.password || '');
      if (pw.length < 10) throw httpError(400, 'Use at least 10 characters');
      const { error } = await serviceClient().auth.admin.updateUserById(session.user.id, { password: pw });
      if (error) throw httpError(400, error.message);
      return res.status(200).json({ ok: true });
    }
    const at = String(b.access_token || ''), rt = String(b.refresh_token || '');
    if (!at || !rt) throw httpError(400, 'Missing tokens');
    const { data, error } = await anonClient().auth.getUser(at);
    if (error || !data || !data.user) throw httpError(401, 'That sign-in link has expired — sign in again');
    setSessionCookies(req, res, { access_token: at, refresh_token: rt, expires_in: Number(b.expires_in) || 3600 });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const at = parseCookies(req).ciq_at;
    if (at) { try { await serviceClient().auth.admin.signOut(at, 'local'); } catch { /* already gone */ } }
    clearSessionCookies(req, res);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  throw httpError(405, 'Method not allowed');
});

// Where a person lands after signing in
export function homeFor(access) {
  if (!access) return '/';
  if (access.active && access.member && ['owner', 'admin'].includes(access.member.role)) return '/admin';
  if (access.active) return '/app';
  if (access.platform_admin) return '/platform';
  return '/blocked';
}
