// In-test stand-in for the Supabase REST / Auth / Functions endpoints the
// portal calls. Enforces the same access rules as the RLS policies and
// RPCs (company scoping, own-member writes, 3-seat cap, credits, Hub access).
// The credit rules themselves are tested against real Postgres in
// credits-sql.test.mjs; this mirrors them closely enough to drive the UI.
//
// Test knobs on `db`: inviteError = { status, error } answers the next
// invite with that error; checkout = [] records create-checkout calls.
export const COSTS = { post: 1, insight: 3, pillar: 8, call: null, usd_per_credit: 100 };
export function createMock(db, USERS) {
  const log = [];
  db.credit_ledger = db.credit_ledger || [];
  db.pieces = db.pieces || [];
  db.checkout = db.checkout || [];
  const now = () => Date.now();
  const grantsOf = (cid) => db.credit_ledger.filter((l) => l.company_id === cid && l.kind === 'grant').map((g) => ({
    ...g, remaining: g.delta + db.credit_ledger.filter((c) => c.grant_id === g.id).reduce((a, c) => a + c.delta, 0),
  }));
  const live = (g) => !g.expires_at || new Date(g.expires_at) > now();
  const balanceOf = (cid) => grantsOf(cid).filter(live).reduce((a, g) => a + Math.max(0, g.remaining), 0);
  const everBought = (cid) => grantsOf(cid).some((g) => ['starter', 'plan', 'topup'].includes(g.product));
  const companyById = (cid) => db.companies.find((c) => c.id === cid);
  const hubAccess = (cid) => { const c = companyById(cid); return !!(c.is_internal || c.hub_unlocked || (c.subscription_status === 'active' && everBought(cid))); };
  function account(cid) {
    const c = companyById(cid);
    return {
      balance: balanceOf(cid), costs: COSTS, hub_access: hubAccess(cid), portal_active: c.subscription_status === 'active',
      can_resume: c.subscription_status === 'canceled' && !!c.subscription_ends_at && new Date(c.subscription_ends_at) > now() && !!c.stripe_subscription_id,
      ever_bought: everBought(cid), starter_bought: grantsOf(cid).some((g) => g.product === 'starter'), plan_active: !!c.plan_subscription_id, next_expiry: null,
    };
  }
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

  async function handleInner(route) {
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
    // Email OTP: the code 123456 is valid for any known user; anything else is
    // treated as expired or invalid, the same 403 GoTrue returns.
    if (path === '/auth/v1/verify' && method === 'POST') {
      const tok = Object.keys(USERS).find((k) => USERS[k].email === String(body.email || '').toLowerCase());
      if (!tok || body.type !== 'email' || body.token !== '123456') return json(route, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      const u = USERS[tok];
      return json(route, 200, { access_token: tok, refresh_token: 'r-' + tok, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated' } });
    }
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (path === '/auth/v1/user') return user ? json(route, 200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated' }) : json(route, 401, { msg: 'invalid JWT' });

    if (!user) return json(route, 401, { message: 'JWT required' });
    const cos = companiesOf(user.id);
    const me = (cid) => db.members.find((m) => m.user_id === user.id && m.company_id === cid);
    const canWrite = (cid) => {
      const c = db.companies.find((x) => x.id === cid);
      return !(c.subscription_status === 'canceled' && c.subscription_ends_at && new Date(c.subscription_ends_at) <= new Date());
    };

    // --- Edge functions
    if (path === '/functions/v1/create-checkout') {
      const caller = myMemberships(user.id)[0];
      const c = companyById(caller.company_id);
      db.checkout.push({ ...body, company_id: c.id });
      if (c.is_internal) return json(route, 400, { error: 'internal' });
      const acct = account(c.id);
      if (body.action === 'resume') {
        if (!acct.can_resume) return json(route, 409, { error: 'cannot_resume' });
        c.subscription_status = 'active'; c.subscription_ends_at = null;
        return json(route, 200, { resumed: true });
      }
      if (!acct.portal_active) return json(route, 409, { error: 'portal_inactive', can_resume: acct.can_resume });
      if (body.action === 'starter' && acct.starter_bought) return json(route, 409, { error: 'starter_used' });
      if (body.action === 'plan' && acct.plan_active) return json(route, 409, { error: 'plan_active' });
      return json(route, 200, { url: 'https://checkout.stripe.test/' + body.action + '?q=' + (body.quantity || 1) + '&coupon=' + (acct.ever_bought ? 'none' : 'first'), first_purchase: !acct.ever_bought });
    }
    if (path === '/functions/v1/invite-member') {
      const caller = myMemberships(user.id)[0];
      if (!caller) return json(route, 403, { error: 'not_a_member' });
      if (db.inviteError) { const e = db.inviteError; db.inviteError = null; return json(route, e.status, { error: e.error }); }
      const emails = [...new Set((body.emails || []).map((e) => String(e).trim().toLowerCase()))];
      const team = db.members.filter((m) => m.company_id === caller.company_id);
      if (emails.includes(user.email)) return json(route, 400, { error: 'self_invite' });
      const limit = companyById(caller.company_id).seat_limit || 3;
      if (team.length + emails.length > limit) return json(route, 409, { error: 'seat_limit', seats_left: limit - team.length });
      const results = emails.map((email, i) => {
        db.members.push({ id: 'm-new-' + i, company_id: caller.company_id, user_id: 'u-new-' + i, role: 'member',
          display_name: email.split('@')[0].split(/[._+-]/)[0].replace(/^./, (c) => c.toUpperCase()), avatar_shape: ['pebble', 'curl'][i], onboarding: {}, created_at: new Date().toISOString() });
        return { email, status: 'invited' };
      });
      return json(route, 200, { results, seats_left: 3 - team.length - emails.length });
    }

    // --- RPCs
    if (path === '/rest/v1/rpc/portal_account') {
      if (!cos.has(body.p_company_id)) return json(route, 403, { message: 'not a member' });
      return json(route, 200, account(body.p_company_id));
    }
    if (path === '/rest/v1/rpc/spend_credits') {
      const a = db.articles.find((x) => x.id === body.p_article_id && cos.has(x.company_id));
      if (!a) return json(route, 400, { message: 'unknown article' });
      if (!canWrite(a.company_id)) return json(route, 403, { message: 'subscription ended' });
      if (a.status !== 'approved_unwritten' || a.requested_at) return json(route, 400, { message: 'not writable' });
      if (db.pieces.some((p) => p.article_id === a.id && p.status !== 'killed')) return json(route, 409, { message: 'already queued' });
      const cost = COSTS[body.p_format];
      if (balanceOf(a.company_id) < cost) return json(route, 400, { message: 'insufficient_credits' });
      const m = me(a.company_id);
      const writing = db.pieces.some((p) => p.company_id === a.company_id && p.status === 'writing');
      const t = new Date().toISOString();
      const piece = { id: 'pc' + db.pieces.length, company_id: a.company_id, article_id: a.id, card_id: a.card_id, format: body.p_format, cost,
        status: writing ? 'queued' : 'writing', position: db.pieces.length + 1, queued_at: t, writing_at: writing ? null : t,
        deliver_by: writing ? null : new Date(now() + 24 * 3600e3).toISOString(), delivered_at: null, created_by: m.id };
      db.pieces.push(piece);
      let need = cost;
      grantsOf(a.company_id).filter((g) => live(g) && g.remaining > 0)
        .sort((x, y) => (x.expires_at ? +new Date(x.expires_at) : Infinity) - (y.expires_at ? +new Date(y.expires_at) : Infinity))
        .forEach((g) => { if (need <= 0) return; const take = Math.min(need, g.remaining); need -= take;
          db.credit_ledger.push({ id: 'l' + db.credit_ledger.length, company_id: a.company_id, delta: -take, kind: 'spend', grant_id: g.id, piece_id: piece.id, created_by: m.id }); });
      a.format = body.p_format;
      if (!writing) { a.requested_at = piece.writing_at; a.deliver_by = piece.deliver_by; }
      return json(route, 200, { piece, balance: balanceOf(a.company_id) });
    }
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
      if (a.status !== 'delivered') return json(route, 400, { message: 'article not delivered yet' });
      // Match migration 8's portal_set_live: status stays 'delivered'; toggle
      // just flips live_at.
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
    if (method === 'POST' && table === 'hub_items') {
      const rows = (Array.isArray(body) ? body : [body]).map((r) => {
        const mem = r.created_by ? db.members.find((x) => x.id === r.created_by) : null;
        if (!cos.has(r.company_id) || (r.created_by && (!mem || mem.user_id !== user.id))) throw new Error('rls');
        // Notes are never locked; everything else on the canvas needs Hub access.
        if (r.kind !== 'note' && !hubAccess(r.company_id)) throw new Error('rls: hub locked');
        return { id: 'h' + Math.random().toString(36).slice(2), ref_id: null, body: null, emoji: null, x: 0, y: 0, rotation: 0, z: 0, hidden: false, updated_at: new Date().toISOString(), ...r };
      });
      db.hub_items.push(...rows);
      return json(route, 201, single ? rows[0] : rows);
    }
    if (method === 'PATCH' && table === 'hub_items') {
      const rows = applyFilters(visible(), url.searchParams).filter((r) => hubAccess(r.company_id));
      rows.forEach((r) => Object.assign(r, body));
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    if (method === 'PATCH' && table === 'members') {
      const rows = applyFilters(visible(), url.searchParams).filter((r) => r.user_id === user.id);
      rows.forEach((r) => Object.assign(r, body));
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    return json(route, 403, { message: 'new row violates row-level security policy' });
  }
  // A thrown 'rls' (or anything else) answers like PostgREST does.
  async function handle(route) {
    try { return await handleInner(route); }
    catch (e) { return json(route, 403, { code: '42501', message: 'new row violates row-level security policy (' + e.message + ')' }); }
  }
  return { handle, log, db };
}
