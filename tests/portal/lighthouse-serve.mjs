// Serves a checkout of the site for Lighthouse, with Supabase answered by
// sb-mock.mjs over plain HTTP, so /portal can be audited signed in:
//   node tests/portal/lighthouse-serve.mjs [root=.] [port=8901]
//   signed-in URL: http://localhost:<port>/portal#access_token=tok-vedika&...
// The portal's esm.sh import is swapped for the local supabase-js bundle
// (tests/portal/.cache, built by walkthrough.mjs) and runtime.json points
// Supabase at <port>+1. Nothing else is changed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { vedikaDb, USERS } from './fixture-vedika.mjs';
import { createMock } from './sb-mock.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(process.argv[2] || path.join(DIR, '../..'));
const PORT = Number(process.argv[3] || 8901), SBPORT = PORT + 1;
const BUNDLE = fs.readFileSync(path.join(DIR, '.cache/supabase-bundle.js'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/portal' || p === '/portal/') p = '/portal/index.html';
  if (p === '/waitlist') p = '/waitlist.html';
  if (p === '/__sb.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(BUNDLE); }
  const f = path.join(ROOT, path.normalize(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/config/runtime.json') { const j = JSON.parse(body); j.supabaseUrl = 'http://localhost:' + SBPORT; body = JSON.stringify(j); }
  if (p === '/portal/portal.js') body = String(body).replace('https://esm.sh/@supabase/supabase-js@2.45.0', '/__sb.js');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
  res.end(body);
}).listen(PORT);

const mock = createMock(vedikaDb(), USERS);
http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const post = chunks.length ? Buffer.concat(chunks).toString() : null;
    const route = {
      request: () => ({ url: () => 'http://localhost:' + SBPORT + req.url, method: () => req.method, postData: () => post, headers: () => req.headers }),
      fulfill: ({ status, contentType, headers, body }) => {
        res.writeHead(status || 200, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', ...(contentType ? { 'content-type': contentType } : {}), ...(headers || {}) });
        res.end(body || '');
      },
    };
    mock.handle(route);
  });
}).listen(SBPORT);
console.log(`serving ${ROOT} on :${PORT}, mock Supabase on :${SBPORT}`);
