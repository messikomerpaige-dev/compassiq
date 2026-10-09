// Shared server helpers: Supabase clients, the signed-in session (HttpOnly cookies), responses.
//
// Sessions: the browser signs in with Supabase, hands the tokens to POST /api/session, and from
// then on only this server holds them, in HttpOnly cookies. The server refreshes the access token
// when it expires, so there is a single refresher (no refresh-token reuse between tabs).
import { createClient } from '@supabase/supabase-js';

const AT = 'ciq_at', RT = 'ciq_rt';
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;   // 30 days

export function env() {
  const url = process.env.SUPABASE_URL, anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) throw httpError(500, 'Server is not configured (Supabase keys missing)');
  return { url, anonKey, serviceKey };
}

// Tests replace this to run against a stand-in for Supabase
let factory = (url, key, opts) => createClient(url, key, opts);
export function setClientFactory(f) { factory = f; }

const baseOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
export function anonClient() { const e = env(); return factory(e.url, e.anonKey, baseOpts); }
export function serviceClient() { const e = env(); return factory(e.url, e.serviceKey, baseOpts); }
export function userClient(accessToken) {
  const e = env();
  return factory(e.url, e.anonKey, { ...baseOpts, global: { headers: { Authorization: `Bearer ${accessToken}` } } });
}

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ── Cookies ────────────────────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isLocal(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || '')); }
function cookie(req, name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (isLocal(req) ? '' : '; Secure');
}
function appendCookies(res, list) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), ...list]);
}
export function setSessionCookies(req, res, session) {
  appendCookies(res, [
    cookie(req, AT, session.access_token, Math.max(60, Number(session.expires_in) || 3600)),
    cookie(req, RT, session.refresh_token, REFRESH_MAX_AGE),
  ]);
}
export function clearSessionCookies(req, res) {
  appendCookies(res, [cookie(req, AT, '', 0), cookie(req, RT, '', 0)]);
}

// ── Session ────────────────────────────────────────────────────────────────
// Returns { user, accessToken } or null. Refreshes an expired access token (and re-sets cookies).
export async function getSession(req, res) {
  const c = parseCookies(req);
  if (c[AT]) {
    const { data, error } = await anonClient().auth.getUser(c[AT]);
    if (!error && data && data.user) return { user: data.user, accessToken: c[AT] };
  }
  if (c[RT]) {
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: c[RT] });
    if (!error && data && data.session && data.user) {
      setSessionCookies(req, res, data.session);
      return { user: data.user, accessToken: data.session.access_token };
    }
    clearSessionCookies(req, res);
  }
  return null;
}

// Signed-in caller with their access summary from the database (see ciq_my_access)
export async function requireAccess(req, res) {
  const session = await getSession(req, res);
  if (!session) throw httpError(401, 'Please sign in');
  const db = userClient(session.accessToken);
  const access = await rpc(db, 'ciq_my_access');
  return { session, db, access };
}

export async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw dbError(error);
  return data;
}

// Database errors → HTTP status; messages raised by our functions are written for people
function dbError(error) {
  const code = error.code || '';
  const status = code === '42501' ? 403 : code === 'P0002' ? 404 : code === '23505' ? 409 : code === '22023' ? 400 : 500;
  return httpError(status, status === 500 ? 'Database error' : error.message);
}

// Blocks cross-site form posts (cookies are SameSite=Lax, this is a second line)
export function checkOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { host = ''; }
  if (host !== req.headers.host) throw httpError(403, 'Cross-site request blocked');
}

export function siteOrigin(req) {
  const proto = isLocal(req) ? 'http' : 'https';
  return `${proto}://${req.headers.host}`;
}

// Wraps a handler: JSON errors, no caching, origin check
export function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      checkOrigin(req);
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.status(status).json({ error: status === 500 && !e.status ? 'Something went wrong' : e.message });
    }
  };
}

export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { throw httpError(400, 'Send JSON'); }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Find an existing login by email (used when an invite says the email is taken)
export async function findUserIdByEmail(admin, email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw httpError(500, 'Could not look up existing logins');
    const hit = (data.users || []).find((u) => String(u.email || '').toLowerCase() === target);
    if (hit) return hit.id;
    if (!data.users || data.users.length < 1000) return null;
  }
  return null;
}

// Invite a login (or reuse an existing one). Returns { userId, existing }.
export async function inviteLogin(req, email, fullName) {
  const admin = serviceClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${siteOrigin(req)}/set-password`,
    data: { full_name: fullName || '' },
  });
  if (!error && data && data.user) return { userId: data.user.id, existing: false };
  const taken = error && (error.code === 'email_exists' || /already been registered|already registered|exists/i.test(error.message || ''));
  if (!taken) throw httpError(502, 'Could not send the invite email: ' + ((error && error.message) || 'unknown error'));
  const id = await findUserIdByEmail(admin, email);
  if (!id) throw httpError(409, 'That email has a login we could not find');
  return { userId: id, existing: true };
}
