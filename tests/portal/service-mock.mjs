// A small HTTP stand-in for Supabase's service-role API, so scripts that use
// the service key (add-owner.mjs, reset-company.mjs) run unchanged against an
// in-memory db:
//   REST  GET / POST / PATCH / DELETE /rest/v1/<table> with eq / is / in
//         filters, order, limit, select, single / maybeSingle, and
//         Prefer: return=representation
//   Auth  GET/POST /auth/v1/admin/users, GET /auth/v1/admin/users/<id>,
//         POST /auth/v1/otp (recorded in db.otp)
// Unique (company_id, user_id) on members answers 23505 like Postgres.
import http from 'node:http';
import crypto from 'node:crypto';

function parseFilter(v) {
  const i = v.indexOf('.');
  return { op: v.slice(0, i), val: v.slice(i + 1) };
}
function match(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    const { op, val } = parseFilter(v);
    const x = row[k] == null ? null : String(row[k]);
    if (op === 'eq' && x !== val) return false;
    if (op === 'neq' && x === val) return false;
    if (op === 'is' && val === 'null' && x !== null) return false;
    if (op === 'in') {
      const list = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      if (!list.includes(x)) return false;
    }
  }
  return true;
}
function project(rows, select) {
  if (!select || select === '*') return rows;
  const cols = select.split(',').map((s) => s.trim());
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
}

export function startServiceMock(db, port) {
  db.otp = db.otp || [];
  db.users = db.users || [];
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || 'null') : null;
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      log.push({ method: req.method, path: url.pathname + url.search, body });
      const auth = req.headers.authorization || '';
      if (!/Bearer service/.test(auth)) return send(401, { message: 'service key required' });
      const p = url.pathname;

      // --- Auth admin
      if (p === '/auth/v1/admin/users' && req.method === 'GET') {
        const page = +(url.searchParams.get('page') || 1), per = +(url.searchParams.get('per_page') || 50);
        return send(200, { users: db.users.slice((page - 1) * per, page * per), aud: 'authenticated' }, { 'x-total-count': String(db.users.length) });
      }
      if (p === '/auth/v1/admin/users' && req.method === 'POST') {
        if (db.users.some((u) => u.email === body.email)) return send(422, { msg: 'A user with this email address has already been registered' });
        const u = { id: crypto.randomUUID(), email: body.email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: new Date().toISOString() };
        db.users.push(u);
        return send(200, u);
      }
      const um = p.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
      if (um && req.method === 'GET') {
        const u = db.users.find((x) => x.id === um[1]);
        return u ? send(200, u) : send(404, { msg: 'User not found' });
      }
      if (p === '/auth/v1/otp') { db.otp.push({ email: body.email, create_user: body.create_user, redirect: url.searchParams.get('redirect_to') }); return send(200, {}); }

      // --- REST
      const t = p.replace('/rest/v1/', '');
      if (!db[t]) return send(404, { message: 'no table ' + t });
      const params = url.searchParams;
      const want = (req.headers.accept || '').includes('vnd.pgrst.object');
      const prefer = req.headers.prefer || '';
      const out = (rows, status = 200) => {
        const shaped = project(rows, params.get('select'));
        if (want) return shaped.length === 1 ? send(status, shaped[0]) : send(406, { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' });
        return send(status, shaped);
      };
      if (req.method === 'GET') {
        let rows = db[t].filter((r) => match(r, params));
        const order = params.get('order');
        if (order) {
          const [col, dir] = order.split('.');
          rows = rows.slice().sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        if (params.get('limit')) rows = rows.slice(0, +params.get('limit'));
        return out(rows);
      }
      if (req.method === 'POST') {
        const list = (Array.isArray(body) ? body : [body]).map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), onboarding: t === 'members' ? {} : undefined, ...r }));
        if (t === 'members' && list.some((r) => db.members.some((m) => m.company_id === r.company_id && m.user_id === r.user_id))) {
          return send(409, { code: '23505', message: 'duplicate key value violates unique constraint "members_company_id_user_id_key"' });
        }
        db[t].push(...list);
        return /return=representation/.test(prefer) ? out(list, 201) : send(201);
      }
      if (req.method === 'PATCH') {
        const rows = db[t].filter((r) => match(r, params));
        rows.forEach((r) => Object.assign(r, body));
        return /return=representation/.test(prefer) ? out(rows) : send(204);
      }
      if (req.method === 'DELETE') {
        const gone = db[t].filter((r) => match(r, params));
        db[t] = db[t].filter((r) => !gone.includes(r));
        return /return=representation/.test(prefer) ? out(gone) : send(204);
      }
      return send(405, { message: 'method' });
    });
  });
  return new Promise((r) => server.listen(port, () => r({ server, log })));
}
