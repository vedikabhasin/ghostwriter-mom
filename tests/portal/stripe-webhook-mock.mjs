// Minimal Supabase mock for stripe-webhook.test.mjs: auth admin (create/list
// users), /otp (the mailer; MAILER=down makes it fail like an unverified
// Resend domain), and PostgREST for companies, members, stripe_events.
import http from 'node:http';

export function startMock(port, state) {
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const filter = (rows, u) => {
    for (const [k, v] of u.searchParams) if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
    return rows;
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    state.calls.push(req.method + ' ' + p);
    if (p === '/auth/v1/admin/users' && req.method === 'POST') {
      if (state.users.some((x) => x.email === body.email)) return send(res, 422, { code: 'email_exists', msg: 'A user with this email address has already been registered' });
      if (state.createUserFails) return send(res, 500, { msg: 'boom' });
      const user = { id: 'u-' + state.users.length, email: body.email, email_confirmed_at: body.email_confirm ? 'now' : null };
      state.users.push(user);
      return send(res, 200, user);
    }
    if (p === '/auth/v1/admin/users') return send(res, 200, { users: state.users, aud: 'authenticated' });
    if (p === '/auth/v1/otp') {
      state.otp.push(body.email);
      return state.mailerDown ? send(res, 500, { code: 'unexpected_failure', msg: 'Error sending magic link email' }) : send(res, 200, {});
    }
    const table = p.replace('/rest/v1/', '');
    const rows = state[table];
    if (!rows) return send(res, 404, {});
    const single = (req.headers.accept || '').includes('vnd.pgrst.object');
    if (req.method === 'GET') {
      const out = filter(rows, u);
      return single ? (out.length ? send(res, 200, out[0]) : send(res, 406, { code: 'PGRST116' })) : send(res, 200, out);
    }
    if (req.method === 'POST') {
      if (table === 'stripe_events' && rows.some((r) => r.id === body.id)) return send(res, 409, { code: '23505', message: 'duplicate key' });
      if (table === 'members' && rows.filter((m) => m.company_id === body.company_id).length >= 3) return send(res, 400, { code: '23514', message: 'company already has 3 members' });
      rows.push({ id: table[0] + rows.length, ...body });
      return send(res, 201);
    }
    if (req.method === 'PATCH') { filter(rows, u).forEach((r) => Object.assign(r, body)); return send(res, 204); }
    if (req.method === 'DELETE') { const kill = new Set(filter(rows, u)); state[table] = rows.filter((r) => !kill.has(r)); return send(res, 204); }
    send(res, 405, {});
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
