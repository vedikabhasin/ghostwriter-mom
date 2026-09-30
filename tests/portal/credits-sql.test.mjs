// Runs every migration in supabase/migrations against PGlite (Postgres in
// WASM, no server) with Supabase's roles and auth.uid() stubbed, then checks
// the credit ledger, the piece queue, Hub access, RLS and first_opened_at.
//   npm i --no-save --no-package-lock @electric-sql/pglite
//   node tests/portal/credits-sql.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIG = path.join(ROOT, 'supabase/migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const db = new PGlite();
const die = (e) => { console.error('\nUNEXPECTED: ' + (e && e.message) + (e && e.query ? '\n  in: ' + String(e.query).slice(0, 200) : '')); process.exit(1); };
process.on('unhandledRejection', die);
process.on('uncaughtException', die);
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail))); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

// Supabase scaffolding.
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select current_user::text $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`);
// pgcrypto isn't in PGlite; gen_random_uuid() is core Postgres anyway.
const sqlOf = (f) => fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create extension if not exists "pgcrypto";/, '');
const run = async (f) => { try { await db.exec(sqlOf(f)); } catch (e) { console.error('migration ' + f + ': ' + e.message); process.exit(1); } };
const cut = files.findIndex((f) => f.includes('_credits'));
for (const f of files.slice(0, cut)) await run(f);

// Seed before migration 7 so the backfill has something to do.
const U = { a: '00000000-0000-0000-0000-00000000000a', b: '00000000-0000-0000-0000-00000000000b', x: '00000000-0000-0000-0000-00000000000c' };
await db.exec(`
  insert into auth.users values ('${U.a}','a@x.co'), ('${U.b}','b@x.co'), ('${U.x}','x@y.co');
  insert into companies (id, slug, name, subscription_status, created_at, direction_shape) values
    ('10000000-0000-0000-0000-000000000001', 'acme', 'Acme', 'active', '2026-09-01T10:00:00Z', '{}'),
    ('10000000-0000-0000-0000-000000000002', 'other', 'Other', 'active', '2026-09-02T10:00:00Z', '{}'),
    ('10000000-0000-0000-0000-000000000003', 'quiet', 'Quiet', 'none',  '2026-09-03T10:00:00Z', '{}');
  insert into members (id, company_id, user_id, role) values
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '${U.a}', 'owner'),
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '${U.b}', 'member'),
    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '${U.x}', 'owner');
  insert into cards (id, company_id, card_key, format, title, angle, evidence) values
    ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'k1', 'pillar',  'One', 'a', 'e'),
    ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'k2', 'insight', 'Two', 'a', 'e'),
    ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'k3', 'post',    'Three', 'a', 'e'),
    ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'k4', 'post',    'Four', 'a', 'e'),
    ('30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'k5', 'post',    'Five', 'a', 'e');
  insert into swipe_events (company_id, card_id, action, source, created_at) values
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'like', 'sales', '2026-08-30T08:00:00Z');
  insert into approvals (company_id, free_article_card_id, direction_card_ids, approved_at, deliver_by) values
    ('10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', '{}', '2026-08-29T09:00:00Z', now());
`);
for (const f of files.slice(cut)) await run(f);
console.log('migrations applied: ' + files.join(', '));

const CO = '10000000-0000-0000-0000-000000000001', CO2 = '10000000-0000-0000-0000-000000000002', CO3 = '10000000-0000-0000-0000-000000000003';
const MA = '20000000-0000-0000-0000-000000000001';
const asUser = (uid) => db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
const asService = () => db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
const grant = async (co, n, product, expires, source) => (await one(
  `insert into credit_ledger (company_id, delta, kind, product, expires_at, source_id) values ($1, $2, 'grant', $3, $4, $5) returning id`,
  [co, n, product, expires, source || null])).id;
const article = async (cardId, format, title) => (await one(
  `insert into articles (company_id, card_id, format, title, status) values ($1, $2, $3, $4, 'requested') returning id`,
  [CO, cardId, format, title])).id;
const balance = async (co) => (await one('select credit_balance($1) as b', [co || CO])).b;
const reset = () => db.exec(`reset role; delete from credit_ledger; delete from pieces; delete from articles;`);

console.log('\n=== first_opened_at');
{
  const rows = await q(`select slug, first_opened_at from companies order by slug`);
  const by = Object.fromEntries(rows.map((r) => [r.slug, r.first_opened_at.toISOString()]));
  check('backfill: first swipe_event when it is earliest', by.acme === '2026-08-30T08:00:00.000Z', by);
  check('backfill: first approval when it is earliest', by.other === '2026-08-29T09:00:00.000Z', by);
  check('backfill: companies.created_at otherwise', by.quiet === '2026-09-03T10:00:00.000Z', by);
  await db.exec(`update companies set first_opened_at = null where slug = 'quiet'`);
  await db.exec(`reset role; set role anon;`);
  await q(`select bump_first_opened_at('quiet')`);
  await asService();
  const t1 = (await one(`select first_opened_at from companies where slug = 'quiet'`)).first_opened_at;
  await db.exec(`set role anon;`);
  await q(`select bump_first_opened_at('quiet')`);
  await asService();
  const t2 = (await one(`select first_opened_at from companies where slug = 'quiet'`)).first_opened_at;
  check('bump_first_opened_at (sales page) stamps first_opened_at once, then leaves it', !!t1 && +t1 === +t2);
  await asUser(U.a);
  await q(`select portal_account($1)`, [CO]);
  await asService();
  const acme = (await one(`select first_opened_at from companies where id = $1`, [CO])).first_opened_at.toISOString();
  check('portal calls never touch first_opened_at', acme === '2026-08-30T08:00:00.000Z');
}

console.log('\n=== balance');
{
  await reset();
  const g = await grant(CO, 20, 'plan', new Date(Date.now() + 86400e3).toISOString(), 'in_1');
  const a1 = await article('30000000-0000-0000-0000-000000000001', 'pillar', 'One');
  const a2 = await article('30000000-0000-0000-0000-000000000002', 'insight', 'Two');
  const a3 = await article('30000000-0000-0000-0000-000000000003', 'post', 'Three');
  await asUser(U.a);
  await q(`select spend_credits($1, 'pillar')`, [a1]);   // 8
  await q(`select spend_credits($1, 'insight')`, [a2]);  // 3
  await q(`select spend_credits($1, 'insight')`, [a3]);  // 3 (post card written as an insight)
  await q(`select spend_credits($1, 'post')`, [await (async () => { await asService(); const id = await article('30000000-0000-0000-0000-000000000004', 'post', 'Four'); await asUser(U.a); return id; })()]); // 1
  const b15 = await balance();
  await asService();
  await db.exec(`update credit_ledger set expires_at = now() - interval '1 second' where id = '${g}'`);
  const b0 = await balance();
  check('grant 20, spend 15, grant expires: balance = 0', b15 === 5 && b0 === 0, { before: b15, after: b0 });
}
{
  await reset();
  const soon = new Date(Date.now() + 5 * 86400e3).toISOString(), later = new Date(Date.now() + 10 * 86400e3).toISOString();
  const gA = await grant(CO, 5, 'plan', later, 'in_A');
  const gB = await grant(CO, 10, 'topup', null, 'cs_B');
  const gC = await grant(CO, 3, 'plan', soon, 'in_C');
  const a4 = await article('30000000-0000-0000-0000-000000000004', 'post', 'Four');
  const a1 = await article('30000000-0000-0000-0000-000000000001', 'pillar', 'One');
  await asUser(U.a);
  await q(`select spend_credits($1, 'post')`, [a4]);                   // 1 from C; goes to writing
  await asUser(U.b);
  const r = await one(`select spend_credits($1, 'pillar') as r`, [a1]); // 8: C 2, A 5, B 1; queued
  await asService();
  const rows = await q(`select grant_id, delta, created_by from credit_ledger where kind = 'spend' and piece_id = $1`, [r.r.piece.id]);
  const took = Object.fromEntries(rows.map((x) => [x.grant_id, x.delta]));
  check('spend takes the soonest-expiring grant first, no-expiry last', took[gC] === -2 && took[gA] === -5 && took[gB] === -1, took);
  check('spend rows record the seat that spent', rows.every((x) => x.created_by === '20000000-0000-0000-0000-000000000002'));
  check('shared balance after two seats spend', r.r.balance === 9 && (await balance()) === 9 && r.r.piece.status === 'queued');
  await db.exec(`update pieces set status = 'killed' where id = '${r.r.piece.id}'`);
  const back = await q(`select grant_id, delta from credit_ledger where kind = 'refund'`);
  const ref = Object.fromEntries(back.map((x) => [x.grant_id, x.delta]));
  const left = Object.fromEntries((await q(`select grant_id, remaining from credit_grants($1)`, [CO])).map((x) => [x.grant_id, x.remaining]));
  check('killed before writing: refund rows go back to the grants they came from', ref[gC] === 2 && ref[gA] === 5 && ref[gB] === 1 && (await balance()) === 17, ref);
  check('each grant ends where it was before the queued spend', left[gC] === 2 && left[gA] === 5 && left[gB] === 10, left);
}
{
  await reset();
  await grant(CO, 2, 'starter', null, 'cs_small');
  const a1 = await article('30000000-0000-0000-0000-000000000001', 'pillar', 'One');
  await asUser(U.a);
  const err = await fails(`select spend_credits($1, 'pillar')`, [a1]);
  await asService();
  const n = (await one(`select count(*)::int n from pieces`)).n;
  check('not enough credits: error, no piece, no rows', /insufficient_credits/.test(err || '') && n === 0 && (await balance()) === 2, err);
  const dup = await fails(`insert into credit_ledger (company_id, delta, kind, product, source_id) values ($1, 5, 'grant', 'starter', 'cs_small')`, [CO]);
  check('a Stripe source grants once (idempotent on source_id)', /duplicate|unique/i.test(dup || ''), dup);
}

console.log('\n=== pieces and queue');
{
  await reset();
  await grant(CO, 30, 'topup', null, 'cs_q');
  const a1 = await article('30000000-0000-0000-0000-000000000001', 'pillar', 'One');
  const a2 = await article('30000000-0000-0000-0000-000000000002', 'insight', 'Two');
  const a3 = await article('30000000-0000-0000-0000-000000000003', 'post', 'Three');
  await asUser(U.a);
  const p1 = (await one(`select spend_credits($1, 'pillar') as r`, [a1])).r.piece;
  const p2 = (await one(`select spend_credits($1, 'insight') as r`, [a2])).r.piece;
  const again = await fails(`select spend_credits($1, 'pillar')`, [a1]);
  await asService();
  check('first piece goes straight to writing, 24h clock set', p1.status === 'writing' && Math.round((new Date(p1.deliver_by) - new Date(p1.writing_at)) / 36e5) === 24);
  check('second piece waits in the queue', p2.status === 'queued');
  check('a card can only be queued once', !!again);
  const art1 = await one(`select requested_at, deliver_by from articles where id = $1`, [a1]);
  check('writing stamps the article (Arriving in countdown)', +art1.requested_at === +new Date(p1.writing_at) && !!art1.deliver_by);
  const two = await fails(`update pieces set status = 'writing' where id = $1`, [p2.id]);
  check('only one piece per company in writing', !!two, two);
  await db.exec(`update pieces set status = 'delivered' where id = '${p1.id}'`);
  const s2 = await one(`select status, writing_at from pieces where id = $1`, [p2.id]);
  const art = await one(`select status, delivered_at from articles where id = $1`, [a1]);
  check('delivering one starts the next in order', s2.status === 'writing' && !!s2.writing_at);
  check('delivery marks the article delivered', art.status === 'delivered' && !!art.delivered_at);
  await db.exec(`update pieces set status = 'revising' where id = '${p1.id}'`);
  await db.exec(`update pieces set status = 'delivered' where id = '${p1.id}'`);
  const rev2 = await fails(`update pieces set status = 'revising' where id = $1`, [p1.id]);
  check('one revision round included, a second is refused', /one revision/.test(rev2 || ''), rev2);
  const before = await balance();
  await db.exec(`update pieces set status = 'killed' where id = '${p1.id}'`);
  check('killed after delivery: credits stay spent', (await balance()) === before && !(await one(`select 1 x from credit_ledger where kind = 'refund'`)));
  const bad = await fails(`update pieces set status = 'queued' where id = $1`, [p2.id]);
  check('status can only move forward', !!bad);
  await asUser(U.a);
  const free = await (async () => { await asService(); const id = (await one(`insert into articles (company_id, card_id, format, title, status, requested_at, deliver_by) values ($1, $2, 'post', 'Free pick', 'writing', now(), now() + interval '24 hours') returning id`, [CO, '30000000-0000-0000-0000-000000000005'])).id; await asUser(U.a); return id; })();
  const fr = await fails(`select spend_credits($1, 'post')`, [free]);
  check('the free article is not a credit spend', /not writable/.test(fr || ''), fr);
  await asUser(U.x);
  const outsider = await fails(`select spend_credits($1, 'post')`, [a3]);
  check('another company cannot spend on your card', /not a member/.test(outsider || ''), outsider);
  await asService();
}

console.log('\n=== Stripe rules');
{
  await reset();
  const in10 = new Date(Date.now() + 10 * 86400e3).toISOString(), in40 = new Date(Date.now() + 40 * 86400e3).toISOString();
  await grant(CO, 20, 'plan', in10, 'in_1');
  await grant(CO, 10, 'plan', in40, 'in_x');
  await grant(CO, 5, 'topup', null, 'cs_t');
  const n = (await one(`select credits_cap_rollover($1, 20, 'in_2') as n`, [CO])).n;
  const left = await q(`select product, remaining from credit_grants($1) order by expires_at nulls last`, [CO]);
  check('rollover: plan credits above 20 expire, soonest first; top-ups untouched', n === 10 && left[0].remaining === 10 && left[1].remaining === 10 && left[2].remaining === 5, { n, left });
  const t = await grant(CO, 3, 'plan', new Date(Date.now() + 2 * 86400e3).toISOString(), 'in_short');
  const past = await grant(CO, 4, 'plan', new Date(Date.now() - 86400e3).toISOString(), 'in_past');
  await q(`select credits_extend($1, 60)`, [CO]);
  const ex = await one(`select expires_at from credit_ledger where id = $1`, [t]);
  const days = (new Date(ex.expires_at) - Date.now()) / 86400e3;
  const pastEx = await one(`select expires_at from credit_ledger where id = $1`, [past]);
  const nul = await one(`select expires_at from credit_ledger where source_id = 'cs_t'`);
  check('plan cancelled: remaining credits get up to 60 days', days > 59.9 && days <= 60.01, days);
  check('plan cancelled: expired stay expired, no-expiry stay no-expiry', new Date(pastEx.expires_at) < new Date() && nul.expires_at === null);
  const gone = (await one(`select credits_expire_all($1, 'sub_19') as n`, [CO])).n;
  check('$19 cancelled: every credit expires', gone > 0 && (await balance()) === 0, { gone });
  await asUser(U.a);
  const denied = await fails(`select credits_expire_all($1, 'x')`, [CO]);
  check('members cannot run the Stripe-side rules', !!denied);
  await asService();
}

console.log('\n=== credits_grant (what the webhook calls)');
{
  await reset();
  const in40 = new Date(Date.now() + 40 * 86400e3).toISOString(), in70 = new Date(Date.now() + 70 * 86400e3).toISOString();
  const g1 = (await one(`select credits_grant($1, 20, 'plan', 'in_A', $2, 20) as g`, [CO, in40])).g;
  const again = (await one(`select credits_grant($1, 20, 'plan', 'in_A', $2, 20) as g`, [CO, in40])).g;
  check('webhook replay: same invoice grants once', g1 === true && again === false && (await balance()) === 20);
  await grant(CO, 7, 'plan', in40, 'in_manual_extra'); // 27 plan credits carried over
  await q(`select credits_grant($1, 20, 'plan', 'in_B', $2, 20)`, [CO, in70]);
  check('new plan grant: carried-over plan credits capped at 20, then +20', (await balance()) === 40);
  await q(`select credits_grant($1, 5, 'starter', 'cs_S', null)`, [CO]);
  await q(`select credits_grant($1, 3, 'topup', 'cs_T', null)`, [CO]);
  check('Starter and top-up grants never expire', (await one(`select count(*)::int n from credit_ledger where source_id in ('cs_S','cs_T') and expires_at is null`)).n === 2 && (await balance()) === 48);
  await asUser(U.a);
  const denied = await fails(`select credits_grant($1, 100, 'manual', 'x', null)`, [CO]);
  check('members cannot grant themselves credits', !!denied);
  await asService();
}

console.log('\n=== seat_limit');
{
  await asService();
  const addMember = (id, uid) => fails(`insert into members (id, company_id, user_id, role) values ($1, $2, $3, 'member')`, [id, CO, uid]);
  await db.exec(`insert into auth.users values ('00000000-0000-0000-0000-0000000000d1','d1@x.co'), ('00000000-0000-0000-0000-0000000000d2','d2@x.co')`);
  const third = await addMember('20000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1');
  const fourth = await addMember('20000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d2');
  check('default seat_limit 3: a 4th member is refused', third === null && /already has 3 members/.test(fourth || ''), fourth);
  await db.exec(`update companies set seat_limit = 4 where id = '${CO}'`);
  const fourthOk = await addMember('20000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d2');
  check('seat_limit 4: the 4th member fits', fourthOk === null, fourthOk);
  await db.exec(`delete from members where id in ('20000000-0000-0000-0000-0000000000d1','20000000-0000-0000-0000-0000000000d2'); update companies set seat_limit = 3 where id = '${CO}'`);
}

console.log('\n=== Hub access and RLS');
{
  await reset();
  await db.exec(`update companies set hub_unlocked = false, is_internal = false, subscription_status = 'active' where id = '${CO}'`);
  const h = async () => (await one(`select hub_access($1) as h`, [CO])).h;
  check('active portal, no credits: Hub locked', (await h()) === false);
  await db.exec(`update companies set subscription_status = 'none', portal_access_until = now() + interval '30 days' where id = '${CO}'`);
  check('30-day window alone: Hub locked', (await h()) === false);
  await grant(CO, 2, 'manual', null, 'by_hand');
  check('a credit grant (manual too): Hub open', (await h()) === true);
  await q(`select credits_expire_all($1, 'x')`, [CO]);
  check('stays open at 0 balance', (await h()) === true && (await balance()) === 0);
  await db.exec(`update companies set portal_access_until = now() - interval '1 day' where id = '${CO}'`);
  check('window closed: Hub stays open once credits were added', (await h()) === true);
  await reset();
  await db.exec(`update companies set hub_unlocked = true where id = '${CO}'`);
  check('hub_unlocked (open today) stays open', (await h()) === true);
  await db.exec(`update companies set hub_unlocked = false, is_internal = true where id = '${CO}'`);
  check('internal: always open', (await h()) === true);
  await db.exec(`update companies set portal_access_until = null where id = '${CO}'`);
  await db.exec(`update companies set is_internal = false, subscription_status = 'active' where id = '${CO}'`);

  await db.exec(`update companies set subscription_status = 'none' where id = '${CO3}'`);
  await asUser(U.x);
  const seen = (await one(`select count(*)::int n from credit_ledger`)).n;
  check('RLS: another company sees none of your ledger', seen === 0);
  const ins = await fails(`insert into credit_ledger (company_id, delta, kind, product) values ($1, 100, 'grant', 'manual')`, [CO2]);
  check('RLS: members cannot write the ledger', !!ins);
  const acct = await fails(`select portal_account($1)`, [CO]);
  check('portal_account refuses non-members', /not a member/.test(acct || ''));
  // A locked company: notes still reach the Hub, canvas edits do not.
  await asService();
  await db.exec(`update companies set subscription_status = 'active', hub_unlocked = false where id = '${CO2}'`);
  await db.exec(`delete from credit_ledger where company_id = '${CO2}'`);
  await asUser(U.x);
  const note = await fails(`insert into hub_items (company_id, kind, ref_id) values ($1, 'note', gen_random_uuid())`, [CO2]);
  const text = await fails(`insert into hub_items (company_id, kind, body) values ($1, 'text', 'hi')`, [CO2]);
  check('locked Hub: a note still gets its hub_items row', note === null, note);
  check('locked Hub: text, pins and moves are refused', !!text);
  await asService();
  await grant(CO, 5, 'starter', null, 'cs_s2');
  await asUser(U.a);
  const acc = (await one(`select portal_account($1) as a`, [CO])).a;
  check('portal_account: balance, costs, access for the caller', acc.costs.post === 1 && acc.costs.insight === 3 && acc.costs.pillar === 8 && acc.costs.call === null && acc.hub_access === true && acc.ever_bought === true && acc.starter_bought === true && acc.portal_active === true && acc.unlock_mode === 'call', acc);
  await asService();
}

console.log('\n=== call mode: window, swipes, requests, clock');
{
  await reset();
  await db.exec(`update companies set is_internal = false, subscription_status = 'none', portal_access_until = now() + interval '30 days' where id = '${CO}'`);
  const act = async () => (await one(`select portal_active($1) as a`, [CO])).a;
  check('portal_access_until in the future: active', (await act()) === true);
  await asUser(U.a);
  const r1 = (await one(`select request_card($1, 'insight') as r`, ['30000000-0000-0000-0000-000000000003'])).r;
  check('request_card: requested, format, requester', r1.status === 'requested' && r1.format === 'insight' && r1.requested_by === MA && !!r1.requested_at, r1);
  await asUser(U.b);
  const r2 = (await one(`select request_card($1) as r`, ['30000000-0000-0000-0000-000000000003'])).r;
  check('request_card twice: same row, first requester kept', r2.id === r1.id && r2.requested_by === MA, r2);
  await asService();
  await db.exec(`update articles set status = 'writing' where id = '${r1.id}'`);
  const w = await one(`select deliver_by, requested_at from articles where id = $1`, [r1.id]);
  check('moving to writing by hand starts the 24h clock', Math.round((new Date(w.deliver_by) - Date.now()) / 36e5) === 24, w);
  await db.exec(`update articles set status = 'delivered' where id = '${r1.id}'`);
  check('moving to delivered stamps delivered_at', !!(await one(`select delivered_at from articles where id = $1`, [r1.id])).delivered_at);
  await asUser(U.a);
  const again = await fails(`select request_card($1)`, ['30000000-0000-0000-0000-000000000003']);
  check('a delivered card cannot be requested again', /already delivered/.test(again || ''), again);
  await asService();
  await db.exec(`update companies set portal_access_until = now() - interval '1 minute' where id = '${CO}'`);
  check('window passed: not active', (await act()) === false);
  await asUser(U.a);
  const closed = await fails(`select request_card($1)`, ['30000000-0000-0000-0000-000000000004']);
  const swipe = await fails(`select portal_decide($1, 'like')`, ['30000000-0000-0000-0000-000000000004']);
  const note = await fails(`insert into notes (company_id, card_id, member_id, body) values ($1, $2, $3, 'still here')`, [CO, '30000000-0000-0000-0000-000000000004', MA]);
  check('expired: request_card refused', /portal closed/.test(closed || ''), closed);
  check('expired: swiping still works', swipe === null, swipe);
  check('expired: notes still work', note === null, note);
  await asUser(U.x);
  const outsider = await fails(`select request_card($1)`, ['30000000-0000-0000-0000-000000000004']);
  check('another company cannot request your card', /not a member/.test(outsider || ''), outsider);
  await asService();
  await db.exec(`update companies set subscription_status = 'active', portal_access_until = null where id = '${CO}'`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
