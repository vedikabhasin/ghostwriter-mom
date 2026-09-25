// Minimal Supabase (auth admin + PostgREST members) mock for invite-member.sh.
import http from 'node:http';
const state = {
  users: [
    { id: 'u-owner', email: 'owner@x.com' },
    { id: 'u-sam', email: 'sam@x.com' },
    { id: 'u-out', email: 'outsider@x.com' },
    { id: 'u-exist', email: 'existing@x.com' },
  ],
  members: [
    { id: 'm1', company_id: 'c1', user_id: 'u-owner', role: 'owner', avatar_shape: 'ghost', created_at: '1' },
    { id: 'm2', company_id: 'c1', user_id: 'u-sam', role: 'member', avatar_shape: 'blob', created_at: '2' },
  ],
  invites: [],
};
const tokens = { 'tok-sam': 'u-sam', 'tok-out': 'u-out' };
function send(res, code, body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/auth/v1/user') {
    const uid = tokens[(req.headers.authorization || '').replace('Bearer ', '')];
    return uid ? send(res, 200, { id: uid, email: state.users.find((x) => x.id === uid).email, aud: 'authenticated' }) : send(res, 401, { msg: 'bad jwt' });
  }
  if (p === '/auth/v1/invite') {
    const { email } = JSON.parse(raw);
    if (state.users.some((x) => x.email === email)) return send(res, 422, { msg: 'A user with this email address has already been registered', error_code: 'email_exists' });
    const nu = { id: 'u-' + email.split('@')[0], email };
    state.users.push(nu); state.invites.push({ email, redirect: u.searchParams.get('redirect_to') });
    return send(res, 200, nu);
  }
  if (p === '/auth/v1/admin/users') return send(res, 200, { users: state.users, aud: 'authenticated' });
  if (p === '/rest/v1/members' && req.method === 'GET') {
    let rows = state.members;
    for (const [k, v] of u.searchParams) if (v.startsWith('eq.')) rows = rows.filter((r) => r[k] === v.slice(3));
    if (u.searchParams.get('limit')) rows = rows.slice(0, +u.searchParams.get('limit'));
    return send(res, 200, rows);
  }
  if (p === '/rest/v1/members' && req.method === 'POST') {
    const row = JSON.parse(raw);
    if (state.members.filter((m) => m.company_id === row.company_id).length >= 3) return send(res, 400, { code: '23514', message: 'company already has 3 members' });
    state.members.push({ id: 'm' + (state.members.length + 1), ...row });
    res.writeHead(201); return res.end();
  }
  if (p === '/__state') return send(res, 200, state);
  send(res, 404, { p });
}).listen(54321, () => console.log('mock on 54321'));
