// Tests scripts/reset-company.mjs against an in-memory stand-in for the
// supabase-js calls it makes (select/eq, delete/in, update/in|eq,
// auth.admin.getUserById). Seeds three companies shaped like the live ones.
//   node tests/portal/reset-company.test.mjs
import { parseArgs, planReset, applyReset, COMPANY_FRESH } from '../../scripts/reset-company.mjs';

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail))); };

function fakeClient(db, users) {
  const q = (table) => {
    let rows = () => db[table];
    const filters = [];
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, list) { filters.push((r) => list.includes(r[c])); return api; },
      then(res, rej) { return Promise.resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej); },
      delete() {
        return { in(c, list) { db[table] = db[table].filter((r) => !list.includes(r[c])); return Promise.resolve({ error: null }); } };
      },
      update(patch) {
        const run = (pred) => { db[table].forEach((r) => { if (pred(r)) Object.assign(r, patch); }); return Promise.resolve({ error: null }); };
        return { in: (c, list) => run((r) => list.includes(r[c])), eq: (c, v) => run((r) => r[c] === v) };
      },
    };
    return api;
  };
  return { from: q, auth: { admin: { getUserById: async (id) => ({ data: { user: users[id] || null }, error: null }) } } };
}

const V = 'co-v', R = 'co-r', T = 'co-t';
function seed() {
  const n = (k, co, extra) => Array.from({ length: k }, (_, i) => ({ id: co + '-' + Math.random().toString(36).slice(2), company_id: co, ...(extra ? extra(i) : {}) }));
  return {
    companies: [
      { id: V, slug: 'vedika-bhasin-ycfogw', name: 'Vedika', is_internal: true, subscription_status: 'active', hub_unlocked: true, portal_access_until: null, seat_limit: 3, first_opened_at: '2026-09-27' },
      { id: R, slug: 'rpr-k7m2qx', name: 'RPR', is_internal: false, subscription_status: 'canceled', hub_unlocked: false, portal_access_until: null, seat_limit: 4, first_opened_at: '2026-09-25', unlock_mode: 'call' },
      { id: T, slug: 'swipetemplate', name: 'Template', is_internal: false, subscription_status: 'none', hub_unlocked: false, portal_access_until: '2026-10-29', seat_limit: 3, first_opened_at: '2026-09-25' },
    ],
    cards: [...n(17, V), ...n(10, R), ...n(10, T)],
    signals: [...n(1, V), ...n(1, R), ...n(1, T)],
    credit_ledger: [], pieces: [],
    members: [
      { id: 'm-v1', company_id: V, user_id: 'u-v1', onboarding: { feed_intro: true } },
      { id: 'm-v2', company_id: V, user_id: 'u-v2', onboarding: { lines: {} } },
      { id: 'm-r1', company_id: R, user_id: 'u-r1', onboarding: {} },
      { id: 'm-r2', company_id: R, user_id: 'u-r2', onboarding: {} },
      { id: 'm-t1', company_id: T, user_id: 'u-t1', onboarding: {} },
    ],
    decisions: [...n(13, V, () => ({ member_id: 'm-v1' })), ...n(10, R, () => ({ member_id: 'm-r1' })),
      ...n(5, T, () => ({ member_id: 'm-t1' })), ...n(2, T, () => ({ member_id: null }))],
    swipe_events: [...n(36, V, () => ({ member_id: 'm-v2' })), ...n(11, R, () => ({ member_id: null })),
      ...n(5, T, () => ({ member_id: 'm-t1' })), ...n(2, T, () => ({ member_id: null }))],
    approvals: [...n(2, R, () => ({ free_article_card_id: 'x' })), ...n(1, T, () => ({ free_article_card_id: 'card-t-free' }))],
    notes: [...n(1, V, () => ({ member_id: 'm-v1' })), ...n(4, R, () => ({ member_id: 'm-r1' }))],
    articles: [...n(3, V), ...n(4, R),
      { id: 'a-t-free', company_id: T, card_id: 'card-t-free', requested_by: null }, { id: 'a-t-req', company_id: T, card_id: 'c', requested_by: 'm-t1' }],
    hub_items: [
      { id: 'h-rules', company_id: V, kind: 'text', body: 'Rules for every post: Hook in the first two lines' },
      { id: 'h-cad', company_id: V, kind: 'text', body: 'Cadence: VB weekly, starting after' },
      { id: 'h-vb', company_id: V, kind: 'text', body: 'VB STUFF' },
      { id: 'h-dig', company_id: V, kind: 'text', body: 'i dig' },
      ...n(12, V, () => ({ kind: 'article' })),
      ...n(3, R, () => ({ kind: 'note' })),
    ],
  };
}
const USERS = { 'u-v1': { email: 'vedikabhasin@gmail.com' }, 'u-v2': { email: 'blendbases@gmail.com' }, 'u-r1': { email: 'vedikabhasinwork@gmail.com' },
  'u-r2': { email: 'vedika@ghostwriter.mom' }, 'u-t1': { email: 'vedikabhasin+owner@gmail.com' } };
const count = (db, t, co) => db[t].filter((r) => r.company_id === co).length;

console.log('\n=== flags');
check('needs exactly one of --dry-run / --confirm', (() => { try { parseArgs(['x']); return false; } catch { return true; } })() && (() => { try { parseArgs(['x', '--dry-run', '--confirm']); return false; } catch { return true; } })());
const o = parseArgs(['vedika-bhasin-ycfogw', '--dry-run', '--force', '--keep-members', '--keep-hub-text', 'Rules for every post', '--keep-hub-text', 'Cadence:']);
check('parses --keep-members (implies --keep-company) and repeated --keep-hub-text', o.keepMembers && o.keepCompany && o.keepText.length === 2 && o.force && o.dry);

console.log('\n=== Vedika: keep members, Rules and Cadence');
{
  const db = seed(); const sb = fakeClient(db, USERS);
  const plan = await planReset(sb, db.companies[0], o);
  check('dry plan: every decision, swipe, note, article; hub items but Rules and Cadence', plan.deletes.decisions.length === 13 && plan.deletes.swipe_events.length === 36 &&
    plan.deletes.notes.length === 1 && plan.deletes.articles.length === 3 && plan.deletes.hub_items.length === 14 && plan.kept.hub_items === 2 && !plan.deletes.members, plan);
  check('dry plan: 17 cards, signal, both members kept; company row unchanged; onboarding reset for 2', plan.kept.cards === 17 && plan.kept.signals === 1 && plan.kept.members === 2 && plan.company === null && plan.onboarding.length === 2);
  check('dry run changes nothing', count(db, 'decisions', V) === 13 && count(db, 'hub_items', V) === 16);
  await applyReset(sb, db.companies[0], plan, () => {});
  const hub = db.hub_items.filter((h) => h.company_id === V).map((h) => h.id).sort().join(',');
  check('after: only Rules and Cadence in the Hub, members kept with onboarding {}', hub === 'h-cad,h-rules' && db.members.filter((m) => m.company_id === V).every((m) => JSON.stringify(m.onboarding) === '{}'), hub);
  check('after: other companies untouched', count(db, 'decisions', R) === 10 && count(db, 'hub_items', R) === 3);
  check('after: company row unchanged (internal stays fully unlocked)', db.companies[0].hub_unlocked === true && db.companies[0].subscription_status === 'active');
}

console.log('\n=== RPR: full reset');
{
  const db = seed(); const sb = fakeClient(db, USERS);
  const opts = parseArgs(['rpr-k7m2qx', '--confirm']);
  const plan = await planReset(sb, db.companies[1], opts);
  check('plan: notes 4, decisions 10, swipes 11, approvals 2, articles 4, hub 3, members 2', plan.deletes.notes.length === 4 && plan.deletes.decisions.length === 10 &&
    plan.deletes.swipe_events.length === 11 && plan.deletes.approvals.length === 2 && plan.deletes.articles.length === 4 && plan.deletes.hub_items.length === 3 && plan.deletes.members.length === 2, plan.deletes);
  await applyReset(sb, db.companies[1], plan, () => {});
  const c = db.companies[1];
  check('after: zero members, 10 cards, signal kept', count(db, 'members', R) === 0 && count(db, 'cards', R) === 10 && count(db, 'signals', R) === 1);
  check('after: company back to a prospect (none, no window, locked, call, first_opened_at null, 3 seats)',
    Object.entries(COMPANY_FRESH).every(([k, v]) => c[k] === v), c);
}

console.log('\n=== swipetemplate: remove the test owner only');
{
  const db = seed(); const sb = fakeClient(db, USERS);
  const opts = parseArgs(['swipetemplate', '--dry-run', '--member', 'VedikaBhasin+owner@gmail.com']);
  const plan = await planReset(sb, db.companies[2], opts);
  check('plan: the member row, its swipes and decisions (and anonymous ones), approvals and their articles', plan.deletes.members.length === 1 &&
    plan.deletes.swipe_events.length === 7 && plan.deletes.decisions.length === 7 && plan.deletes.approvals.length === 1 &&
    plan.deletes.articles.length === 2 && plan.company.portal_access_until === null, plan.deletes);
  await applyReset(sb, db.companies[2], plan, () => {});
  check('after: 10 cards kept, no members, window cleared', count(db, 'cards', T) === 10 && count(db, 'members', T) === 0 && db.companies[2].portal_access_until === null);
  const miss = await planReset(sb, db.companies[2], parseArgs(['swipetemplate', '--dry-run', '--member', 'nobody@x.co'])).then(() => null, (e) => e.message);
  check('unknown member: refused', /no member/.test(miss || ''), miss);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
