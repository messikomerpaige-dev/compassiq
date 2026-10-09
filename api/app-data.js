// /api/app-data?page=N — the rep app's doctor list, as a script the app shell loads before it starts.
//
// The app shell (/app, built from the field template) has <script src="/api/app-data?page=0"> in
// its <head>, and starts from window.__CIQ_DATA. Each page appends up to PAGE doctors and, when
// more remain, writes the script tag for the next page, so the browser loads them in order before
// the app's own code runs. Only the signed-in person's territories come back (row level security).
//
// Page 0 also sets window.__CIQ_CLOUD (who is signed in), erases this browser's CompassIQ data
// if a different person used it last, and restores the person's saved plan when it is newer. Signed out → sign-in page; cut off → /blocked.
import { handler, requireAccess, rpc, stateCookie, setStateCookie } from './_lib/ciq.js';

const PAGE = 2000;
const WIPE = `function(){try{[localStorage,sessionStorage].forEach(function(s){Object.keys(s).forEach(function(k){if(/^(tiq_|ciq_)/.test(k))s.removeItem(k)})})}catch(e){}}`;
// Leaving the page: stop the parser so none of the app's own scripts run (and save) on the way out
const HALT = `window.__CIQ_STOP=true;document.write('<plaintext hidden>');`;

function js(res, status, code) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(code);
}

export default handler(async (req, res) => {
  const page = Math.max(0, parseInt((req.query && req.query.page) || '0', 10) || 0);
  let ctx;
  try {
    ctx = await requireAccess(req, res);
  } catch (e) {
    if (e.status === 401) return js(res, 200, `location.replace('/?next=' + encodeURIComponent(location.pathname));${HALT}`);
    throw e;
  }
  const { session, db, access } = ctx;
  if (!access || !access.active) {
    return js(res, 200, `(${WIPE})();location.replace('/blocked');${HALT}`);
  }

  const rows = await rpc(db, 'ciq_app_hcps', { p_offset: page * PAGE, p_limit: PAGE });
  const data = (rows || []).map((r) => r.data);
  let code = '';
  if (page === 0) {
    const cloud = {
      userId: session.user.id,
      email: session.user.email,
      name: access.member.full_name || '',
      role: access.member.role,
      org: access.org.name,
      territories: access.territories.map((t) => t.name),
    };
    code += `window.__CIQ_CLOUD=${JSON.stringify(cloud)};`
      + `(function(){var w=${WIPE};try{if(localStorage.getItem('ciq_owner')!==${JSON.stringify(session.user.id)}){w();localStorage.setItem('ciq_owner',${JSON.stringify(session.user.id)})}}catch(e){}})();`
      + `window.__CIQ_DATA=[];`;
    // This person's saved plan and settings: restored before the app starts when this browser
    // doesn't have the latest copy (new iPad, cleared data, or saved from another device)
    const saved = await rpc(db, 'ciq_my_state', { p_since: stateCookie(req, session.user.id) });
    if (saved && saved.data && saved.data.T && JSON.stringify(saved.data).length < 3e6) {
      code += `(function(){try{var s=${JSON.stringify({ at: saved.at, data: saved.data })};`
        + `localStorage.setItem('tiq_territories',JSON.stringify(s.data.T));if(s.data.A)localStorage.setItem('tiq_active',s.data.A);`
        + `localStorage.setItem('ciq_welcome_seen','1');localStorage.setItem('ciq_state_at',s.at)}catch(e){}})();`;
    }
    if (saved && saved.at) setStateCookie(req, res, session.user.id, saved.at);
  }
  code += `window.__CIQ_DATA=window.__CIQ_DATA.concat(${JSON.stringify(data)});`;
  if (data.length === PAGE) code += `document.write('<script src="/api/app-data?page=${page + 1}"><\\/script>');`;
  return js(res, 200, code);
});
