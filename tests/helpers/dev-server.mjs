// Local stand-in for Vercel: serves public/ with clean URLs and runs the api/ handlers.
// Also exposes POST /__test/login, which the stubbed supabase-js uses to "sign in".
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import session from '../../api/session.js';
import admin from '../../api/admin.js';
import platform from '../../api/platform.js';
import appData from '../../api/app-data.js';
import ping from '../../api/ping.js';
import sync from '../../api/sync.js';
import prefs from '../../api/prefs.js';
import state from '../../api/state.js';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const API = { session, admin, platform, 'app-data': appData, ping, sync, prefs, state };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

async function fileFor(path) {
  const clean = decodeURIComponent(path).replace(/\.\.+/g, '');
  for (const p of [clean, clean + '.html', join(clean, 'index.html')]) {
    try { const f = join(PUBLIC, p); if ((await stat(f)).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

export function startServer(fake, port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    res.send = (s) => { res.end(s); return res; };
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      if (url.pathname === '/__test/login') {
        const { email, password } = JSON.parse(raw);
        return res.json(await fake.signInWithPassword(email, password));
      }
      if (url.pathname === '/__test/reset') return res.json({ error: null });
      const m = url.pathname.match(/^\/api\/([\w-]+)$/);
      if (m && API[m[1]]) {
        req.query = Object.fromEntries(url.searchParams);
        req.body = raw ? JSON.parse(raw) : undefined;
        return await API[m[1]](req, res);
      }
      const f = await fileFor(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!f) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('content-type', TYPES[extname(f)] || 'application/octet-stream');
      res.end(await readFile(f));
    } catch (e) {
      console.error(e); res.statusCode = 500; res.end('error');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// Stand-in for the supabase-js browser bundle (the sign-in page loads it from the CDN)
export const SUPABASE_JS_STUB = `window.supabase = { createClient: function () { return { auth: {
  signInWithPassword: function (c) { return fetch('/__test/login', { method: 'POST', body: JSON.stringify(c) }).then(function (r) { return r.json(); }); },
  resetPasswordForEmail: function () { return fetch('/__test/reset', { method: 'POST' }).then(function (r) { return r.json(); }); }
} }; } };`;
