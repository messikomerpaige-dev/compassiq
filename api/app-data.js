// /api/app-data?page=N — the rep app's doctor list, as a script the app shell loads before it starts.
//
// The app shell (/app, built from the field template) has <script src="/api/app-data?page=0"> in
// its <head>, and starts from window.__CIQ_DATA. Each page appends up to PAGE doctors and, when
// more remain, writes the script tag for the next page, so the browser loads them in order before
// the app's own code runs. Only the signed-in person's territories come back (row level security).
//
// Page 0 also sets window.__CIQ_CLOUD (who is signed in) and erases this browser's CompassIQ data
// if a different person used it last. Signed out → sign-in page; cut off → /blocked.
import { handler, requireAccess, rpc } from './_lib/ciq.js';

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
  }
  code += `window.__CIQ_DATA=window.__CIQ_DATA.concat(${JSON.stringify(data)});`;
  if (data.length === PAGE) code += `document.write('<script src="/api/app-data?page=${page + 1}"><\\/script>');`;
  return js(res, 200, code);
});
