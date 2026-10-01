// Shared state for the collab3 flow (migration 20261001000015): runs every
// migration against PGlite and calls the functions as the anon role, the way
// the sales page does.
//   npm i --no-save --no-package-lock @electric-sql/pglite
//   node tests/sales/collab-state.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIG = path.join(ROOT, 'supabase/migrations');
const db = new PGlite();
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail))); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

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
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  try { await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create extension if not exists "pgcrypto";/, '')); }
  catch (e) { console.error('migration ' + f + ': ' + e.message); process.exit(1); }
}
const CO = '10000000-0000-0000-0000-000000000001';
await db.exec(`
  insert into companies (id, slug, name, direction_shape) values ('${CO}', 'lead-a', 'Lead A', '{}'), ('10000000-0000-0000-0000-000000000002', 'lead-b', 'Lead B', '{}');
  insert into companies (id, slug, name, direction_shape, is_internal) values ('10000000-0000-0000-0000-000000000009', 'inside', 'Inside', '{}', true);
  insert into cards (company_id, card_key, format, title, angle, evidence, sort_order) values
    ('${CO}', 'a1', 'long_form', 'One', 'a', 'e', 0), ('${CO}', 'a2', 'short_insight', 'Two', 'a', 'e', 1), ('${CO}', 'a3', 'linkedin_post', 'Three', 'a', 'e', 2),
    ('10000000-0000-0000-0000-000000000002', 'b1', 'long_form', 'B', 'a', 'e', 0);
`);
const anon = () => db.exec(`reset role; set role anon;`);
const state = async (slug) => (await one(`select get_collab_state($1) s`, [slug])).s;

await anon();
let s = await state('lead-a');
check('fresh slug: no decisions, no log, no pick, no approval', s.decisions.length === 0 && s.log.length === 0 && s.pick === null && s.approval === null, s);

// Device 1 swipes the three cards (one changes its mind).
for (const [k, a] of [['a1', 'like'], ['a2', 'pass'], ['a2', 'like'], ['a3', 'pass']]) await db.query(`select log_swipe('lead-a', $1, $2)`, [k, a]);
s = await state('lead-a');
check('device 2 sees the same reactions, in card order', s.decisions.map((d) => d.card_key + ':' + d.action).join(',') === 'a1:like,a2:like,a3:pass', s.decisions);
check('device 2 sees the full log, oldest first', s.log.map((d) => d.card_key + ':' + d.action).join(',') === 'a1:like,a2:pass,a2:like,a3:pass', s.log);

const p1 = (await one(`select set_collab_pick('lead-a', 'a2', '{"a1":"like","a2":"like","a3":"pass"}') p`)).p;
const p2 = (await one(`select set_collab_pick('lead-a', 'a1', '{"a1":"pass"}') p`)).p;
check('pick: first write wins, a second device cannot change it', p1.card_key === 'a2' && p2.card_key === 'a2' && (await state('lead-a')).pick.card_key === 'a2', { p1, p2 });
check('pick: only the first call reports created', p1.created === true && p2.created === false, { p1: p1.created, p2: p2.created });
const lag = (new Date(p1.deliver_by) - new Date(p1.picked_at)) / 3600e3;
check('pick: delivery time is 24h after the pick, and stays put', Math.abs(lag - 24) < 0.01 && p2.deliver_by === p1.deliver_by, { lag });
check('pick: reaction snapshot stored once', JSON.stringify(p2.vedi_reactions) === JSON.stringify({ a1: 'like', a2: 'like', a3: 'pass' }) && (await state('lead-a')).pick.vedi_reactions.a3 === 'pass', p2.vedi_reactions);
check('pick: reactions must be an object', /must be an object/.test(await fails(`select set_collab_pick('lead-b', 'b1', '[1]')`) || ''));

await db.query(`select submit_approval('lead-a', 'a2', array['a1','a2','a3'], 'visitor@lead-a.co')`);
s = await state('lead-a');
check('approval shared (card, deliver_by), email never returned', s.approval.card_key === 'a2' && !!s.approval.deliver_by && !JSON.stringify(s).includes('@'), s.approval);

const other = await state('lead-b');
check('other slug: untouched', other.decisions.length === 0 && other.pick === null && other.approval === null, other);
check('internal company: refused', /unknown slug/.test(await fails(`select get_collab_state('inside')`) || '') && /unknown slug/.test(await fails(`select set_collab_pick('inside', 'x')`) || ''));
check('unknown card: refused', /unknown card_key/.test(await fails(`select set_collab_pick('lead-b', 'a1')`) || ''));
check('anon cannot read collab_picks directly', /permission denied/.test(await fails(`select * from collab_picks`) || ''));
check('anon cannot write collab_picks directly', /permission denied/.test(await fails(`insert into collab_picks (company_id, card_id) select '${CO}', id from cards limit 1`) || ''));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
