// A stand-in for Supabase used by the tests: auth (tokens, refresh, invites, bans) is simulated in
// memory, and every .rpc() call runs the real database function in PGlite as the calling user,
// so row level security and the functions' own checks apply exactly as they would in Supabase.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261009000000_init.sql', import.meta.url), 'utf8');
const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;
const TABLE_FNS = new Set(['ciq_app_hcps']);

export async function createFakeSupabase() {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(MIGRATION);

  const state = {
    access: new Map(),      // access token → user id
    refresh: new Map(),     // refresh token → user id
    passwords: new Map(),   // user id → password
    banned: new Set(),
    invites: [],            // { email, redirectTo }
    resets: [],
    seq: 0,
  };

  async function users() { return (await db.query('select id, email from auth.users order by email')).rows; }
  async function userById(id) { return (await db.query('select id, email from auth.users where id = $1', [id])).rows[0] || null; }
  async function createUser(email, password) {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email.toLowerCase()]);
    if (password) state.passwords.set(id, password);
    return id;
  }
  function issue(userId) {
    const n = ++state.seq;
    const session = { access_token: `at-${n}-${userId}`, refresh_token: `rt-${n}-${userId}`, expires_in: 3600, token_type: 'bearer' };
    state.access.set(session.access_token, userId);
    state.refresh.set(session.refresh_token, userId);
    return session;
  }
  async function signInWithPassword(email, password) {
    const u = (await db.query('select id from auth.users where email = $1', [String(email).toLowerCase()])).rows[0];
    if (!u || state.passwords.get(u.id) !== password) return { data: { session: null, user: null }, error: { message: 'Invalid login credentials' } };
    if (state.banned.has(u.id)) return { data: { session: null, user: null }, error: { message: 'User is banned' } };
    return { data: { session: issue(u.id), user: await userById(u.id) }, error: null };
  }

  async function runRpc(userId, fn, args) {
    const names = Object.keys(args || {});
    const call = `public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const params = names.map((k) => {
      const v = args[k];
      if (Array.isArray(v) && fn !== 'ciq_publish_rows') return `{${v.join(',')}}`;   // uuid[]
      if (v !== null && typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.query(`set local role ${userId ? 'authenticated' : 'anon'}`);
        if (userId) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })]);
        const sql = TABLE_FNS.has(fn) ? `select * from ${call}` : `select ${call} as v`;
        return (await tx.query(sql, params)).rows;
      });
      return { data: TABLE_FNS.has(fn) ? rows : rows[0].v, error: null };
    } catch (e) {
      return { data: null, error: { code: e.code || '', message: e.message } };
    }
  }

  // createClient(url, key, opts) replacement
  function factory(url, key, opts) {
    const auth = (opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || '';
    const token = auth.replace(/^Bearer /, '');
    const isService = key === 'service-key';
    return {
      rpc: (fn, args) => runRpc(state.access.get(token) || null, fn, args),
      auth: {
        async getUser(jwt) {
          const id = state.access.get(jwt);
          if (!id || state.banned.has(id)) return { data: { user: null }, error: { message: 'invalid JWT' } };
          return { data: { user: await userById(id) }, error: null };
        },
        async refreshSession({ refresh_token }) {
          const id = state.refresh.get(refresh_token);
          if (!id || state.banned.has(id)) return { data: { session: null, user: null }, error: { message: 'Invalid Refresh Token' } };
          state.refresh.delete(refresh_token);
          const session = issue(id);
          return { data: { session, user: await userById(id) }, error: null };
        },
        signInWithPassword: ({ email, password }) => signInWithPassword(email, password),
        async resetPasswordForEmail(email, o) { state.resets.push({ email, redirectTo: o && o.redirectTo }); return { error: null }; },
        admin: isService ? {
          async inviteUserByEmail(email, o) {
            if (state.inviteLimit != null && state.invites.length >= state.inviteLimit) {
              return { data: { user: null }, error: { status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' } };
            }
            const exists = (await users()).some((u) => u.email === email.toLowerCase());
            if (exists) return { data: { user: null }, error: { code: 'email_exists', message: 'A user with this email address has already been registered' } };
            const id = await createUser(email);
            state.invites.push({ email, id, redirectTo: o && o.redirectTo });
            return { data: { user: { id, email } }, error: null };
          },
          async listUsers({ page = 1, perPage = 50 } = {}) {
            const all = await users();
            return { data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null };
          },
          async updateUserById(id, attrs) {
            if (!(await userById(id))) return { data: null, error: { message: 'User not found' } };
            if (attrs.ban_duration) {
              if (attrs.ban_duration === 'none') state.banned.delete(id);
              else { state.banned.add(id); for (const [t, u] of state.access) if (u === id) state.access.delete(t); }
            }
            if (attrs.password) state.passwords.set(id, attrs.password);
            return { data: { user: { id } }, error: null };
          },
          async signOut(jwt) { state.access.delete(jwt); return { error: null }; },
        } : undefined,
      },
    };
  }

  return { db, state, factory, createUser, issue, signInWithPassword };
}

// Vercel-style request/response doubles for calling handlers directly
export function mockReq({ method = 'GET', query = {}, body, cookie = '', origin, host = 'localhost:3000' } = {}) {
  const headers = { host, cookie };
  if (origin) headers.origin = origin;
  return { method, query, body, headers };
}
export function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.headersSent = true; return this; },
    send(s) { this.body = s; this.headersSent = true; return this; },
  };
  return res;
}
// Cookie header for the next request from a response's Set-Cookie list
export function cookiesFrom(res, prev = '') {
  const jar = Object.fromEntries(prev.split(';').map((p) => p.trim()).filter(Boolean).map((p) => [p.split('=')[0], p.slice(p.indexOf('=') + 1)]));
  for (const c of [].concat(res.getHeader('set-cookie') || [])) {
    const [kv, ...attrs] = c.split(';');
    const k = kv.split('=')[0], v = kv.slice(kv.indexOf('=') + 1);
    if (attrs.some((a) => /max-age=0/i.test(a.trim()))) delete jar[k]; else jar[k] = v;
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
