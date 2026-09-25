// In-test stand-in for the Supabase REST / Auth / Functions endpoints the
// portal calls. Enforces the same access rules as the RLS policies and
// portal_* RPCs (company scoping, own-member writes, 3-seat cap).
import { USERS } from './fixture.mjs';

export function createMock(db) {
  const log = [];
  const userFor = (req) => USERS[(req.headers()['authorization'] || '').replace(/^Bearer\s+/i, '')] || null;
  const myMemberships = (uid) => db.members.filter((m) => m.user_id === uid);
  const companiesOf = (uid) => new Set(myMemberships(uid).map((m) => m.company_id));
  const json = (route, status, body, headers = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });

  function applyFilters(rows, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
      const i = v.indexOf('.');
      const op = v.slice(0, i), val = v.slice(i + 1);
      rows = rows.filter((r) => {
        const x = r[k] == null ? null : String(r[k]);
        if (op === 'eq') return x === val;
        if (op === 'neq') return x !== val;
        if (op === 'lte') return x !== null && x <= val;
        if (op === 'gte') return x !== null && x >= val;
        if (op === 'is') return val === 'null' ? x === null : true;
        return true;
      });
    }
    const order = params.get('order');
    if (order) {
      const keys = order.split(',').map((s) => s.split('.'));
      rows = rows.slice().sort((a, b) => {
        for (const [col, dir] of keys) {
          if (a[col] === b[col]) continue;
          const c = (a[col] ?? '') < (b[col] ?? '') ? -1 : 1;
          return dir === 'desc' ? -c : c;
        }
        return 0;
      });
    }
    if (params.get('limit')) rows = rows.slice(0, Number(params.get('limit')));
    return rows;
  }

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    log.push({ method, path: path + url.search, body });
    const user = userFor(req);

    // --- Auth
    if (path === '/auth/v1/otp') return json(route, 200, {});
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (path === '/auth/v1/user') return user ? json(route, 200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' }) : json(route, 401, { msg: 'invalid JWT' });

    if (!user) return json(route, 401, { message: 'JWT required' });
    const cos = companiesOf(user.id);
    const me = (cid) => db.members.find((m) => m.user_id === user.id && m.company_id === cid);
    const canWrite = (cid) => {
      const c = db.companies.find((x) => x.id === cid);
      return !(c.subscription_status === 'canceled' && c.subscription_ends_at && new Date(c.subscription_ends_at) <= new Date());
    };

    // --- Edge function
    if (path === '/functions/v1/invite-member') {
      const caller = myMemberships(user.id)[0];
      if (!caller) return json(route, 403, { error: 'not_a_member' });
      const emails = [...new Set((body.emails || []).map((e) => String(e).trim().toLowerCase()))];
      const team = db.members.filter((m) => m.company_id === caller.company_id);
      if (team.length + emails.length > 3) return json(route, 409, { error: 'seat_limit', seats_left: 3 - team.length });
      const results = emails.map((email, i) => {
        db.members.push({ id: 'm-new-' + i, company_id: caller.company_id, user_id: 'u-new-' + i, role: 'member',
          display_name: email.split('@')[0].split(/[._+-]/)[0].replace(/^./, (c) => c.toUpperCase()), avatar_shape: ['pebble', 'curl'][i], onboarding: {}, created_at: new Date().toISOString() });
        return { email, status: 'invited' };
      });
      return json(route, 200, { results, seats_left: 3 - team.length - emails.length });
    }

    // --- RPCs
    if (path === '/rest/v1/rpc/portal_decide') {
      const card = db.cards.find((c) => c.id === body.p_card_id && cos.has(c.company_id));
      if (!card) return json(route, 400, { message: 'unknown card' });
      if (!canWrite(card.company_id)) return json(route, 403, { message: 'subscription ended' });
      const m = me(card.company_id);
      const row = db.decisions.find((d) => d.card_id === card.id && d.member_id === m.id);
      const prev = row ? row.action : null;
      db.swipe_events.push({ id: 1000 + db.swipe_events.length, company_id: card.company_id, card_id: card.id, member_id: m.id, action: body.p_action, source: 'portal', created_at: new Date().toISOString() });
      if (row) { row.action = body.p_action; row.updated_at = new Date().toISOString(); }
      else db.decisions.push({ id: 'dn' + db.decisions.length, company_id: card.company_id, card_id: card.id, member_id: m.id, action: body.p_action, updated_at: new Date().toISOString() });
      return json(route, 200, prev);
    }
    if (path === '/rest/v1/rpc/portal_set_live') {
      const a = db.articles.find((x) => x.id === body.p_article_id && cos.has(x.company_id));
      if (!a) return json(route, 400, { message: 'unknown article' });
      if (!canWrite(a.company_id)) return json(route, 403, { message: 'subscription ended' });
      if (!['delivered', 'live'].includes(a.status)) return json(route, 400, { message: 'article not delivered yet' });
      a.status = body.p_live ? 'live' : 'delivered';
      a.live_at = body.p_live ? (a.live_at || new Date().toISOString()) : null;
      return json(route, 200, { id: a.id, status: a.status, live_at: a.live_at });
    }

    // --- Tables
    const table = path.replace('/rest/v1/', '');
    if (!db[table]) return json(route, 404, { message: 'no table ' + table });
    const visible = () => db[table].filter((r) => cos.has(table === 'companies' ? r.id : r.company_id));
    const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');

    if (method === 'GET') {
      const rows = applyFilters(visible(), url.searchParams);
      if (single) return rows.length === 1 ? json(route, 200, rows[0]) : json(route, 406, { message: 'not single' });
      return json(route, 200, rows);
    }
    if (method === 'POST' && table === 'notes') {
      const rows = (Array.isArray(body) ? body : [body]).map((r) => {
        const m = db.members.find((x) => x.id === r.member_id);
        if (!m || m.user_id !== user.id || !cos.has(r.company_id)) throw new Error('rls');
        return { id: 'n' + Math.random().toString(36).slice(2), created_at: new Date().toISOString(), ...r };
      });
      db.notes.push(...rows);
      return json(route, 201, single ? rows[0] : rows);
    }
    if (method === 'PATCH' && table === 'members') {
      const rows = applyFilters(visible(), url.searchParams).filter((r) => r.user_id === user.id);
      rows.forEach((r) => Object.assign(r, body));
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    return json(route, 403, { message: 'new row violates row-level security policy' });
  }
  return { handle, log, db };
}
