// Build the hosted pages from CompassIQ_ADMIN.html (the single source of truth):
//   public/app/index.html    — rep app shell: the embedded field template with no data inside;
//                              /api/app-data supplies the signed-in person's doctors at load time
//   public/admin/tool.html   — the admin tool, publishing to the cloud instead of downloading a file
// Run by Vercel on every deploy (vercel.json buildCommand) and by the tests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const admin = readFileSync(join(ROOT, 'CompassIQ_ADMIN.html'), 'utf8');

function once(src, from, to, what) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`build: expected 1 "${what}", found ${n}`);
  return src.replace(from, () => to);
}
function lastBodyClose(src, insert) {
  const i = src.lastIndexOf('</body>');
  if (i < 0) throw new Error('build: no </body>');
  return src.slice(0, i) + insert + src.slice(i);
}
const SW_ON = "if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {";
const SW_OFF = "if (false) { // cloud build: offline cache arrives with the Phase 2 offline mode";

// ── Rep app shell ──────────────────────────────────────────────────────────
const m = admin.match(/<script type="text\/plain" id="ciq-field-template">([A-Za-z0-9+/=\s]+)<\/script>/);
if (!m) throw new Error('build: field template not found in CompassIQ_ADMIN.html');
let app = Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8');
app = once(app, 'ALL_HCPS = []; /* BAKED empty (rep template) */',
  'ALL_HCPS = (Array.isArray(window.__CIQ_DATA) ? window.__CIQ_DATA : []); /* cloud: loaded by /api/app-data */', 'baked data line');
app = once(app, SW_ON, SW_OFF, 'service worker registration');
app = once(app, '<link rel="manifest" href="manifest.json">', '', 'manifest link');
app = once(app, '<head>\n<meta charset="UTF-8">',
  '<head>\n<meta charset="UTF-8">\n<script src="/api/app-data?page=0"></script>', 'head charset meta');
app = lastBodyClose(app, '<link rel="stylesheet" href="/assets/ciq-cloud.css">\n<script src="/assets/ciq-cloud.js"></script>\n');

// ── Admin tool ─────────────────────────────────────────────────────────────
let tool = admin;
tool = once(tool, SW_ON, SW_OFF, 'admin service worker registration');
tool = once(tool, '<link rel="manifest" href="manifest.json">', '', 'admin manifest link');
tool = once(tool, 'onclick="_agxPublish()" disabled>Generate rep version</button>',
  'onclick="_agxPublish()" disabled>Publish to reps</button>', 'console publish button');
tool = once(tool, '<h2>Rep version ready</h2>', '<h2>Published to reps</h2>', 'done heading');
tool = once(tool,
  `        <li>Find the downloaded <code id="agx-done-file">.html</code> file.</li>
        <li>Deploy it to Netlify as <code>index.html</code> with the PWA files, and bump the version in <code>sw.js</code>.</li>
        <li>Reps open the app, choose their territory in Settings, and build their plan.</li>`,
  `        <li>Reps get the new data the next time they open CompassIQ <span id="agx-done-file" hidden></span>.</li>
        <li>Each rep only receives their own territory; managers receive theirs.</li>
        <li>Add people and assign territories under <a href="/admin">Team &amp; territories</a>.</li>`, 'done steps');
tool = once(tool, 'Deploy the file to Netlify as <b>index.html</b> alongside the PWA files, and bump the version in <b>sw.js</b> so iPads pick it up.',
  'Reps get the new data the next time they open CompassIQ — each rep only receives their own territory.', 'publish modal note');
tool = once(tool, `onclick="_ciqDoPublish(document.getElementById('pub-trends').checked)">Build &amp; download</button>`,
  `onclick="_ciqDoPublish(document.getElementById('pub-trends').checked)">Publish to reps</button>`, 'publish modal button');
tool = lastBodyClose(tool, '<link rel="stylesheet" href="/assets/ciq-cloud.css">\n<script src="/assets/ciq-admin-tool.js"></script>\n');

mkdirSync(join(ROOT, 'public/app'), { recursive: true });
mkdirSync(join(ROOT, 'public/admin'), { recursive: true });
writeFileSync(join(ROOT, 'public/app/index.html'), app);
writeFileSync(join(ROOT, 'public/admin/tool.html'), tool);
console.log(`build: app shell ${(app.length / 1e6).toFixed(1)} MB, admin tool ${(tool.length / 1e6).toFixed(1)} MB`);
