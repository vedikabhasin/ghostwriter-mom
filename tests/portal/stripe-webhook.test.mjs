// Runs supabase/functions/stripe-webhook under Deno against a local mock and
// sends Stripe-signed events. Covers the "mailer down" case that left a paid
// customer without a portal.
//
//   npm i --no-save stripe@14.25.0 && node tests/portal/stripe-webhook.test.mjs
//   (needs deno on PATH, or `npx deno` works)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';
import { startMock } from './stripe-webhook-mock.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SECRET = 'whsec_test_portal';
const MOCK_PORT = 54322, FN_PORT = 8000;
const stripe = new Stripe('sk_test_x');

const state = {
  calls: [], otp: [], users: [], mailerDown: true, createUserFails: false,
  companies: [
    { id: 'c1', slug: 'rpr-k7m2qx', subscription_status: 'none', is_internal: false },
    { id: 'c2', slug: 'acme', subscription_status: 'active', is_internal: false, stripe_subscription_id: 'sub_19', plan_subscription_id: null, stripe_customer_id: 'cus_2' },
    { id: 'c3', slug: 'vedika', subscription_status: 'active', is_internal: true, stripe_subscription_id: null, plan_subscription_id: null, stripe_customer_id: null },
  ],
  members: [], stripe_events: [],
  // credits_grant is idempotent on source id in SQL (tested in credits-sql);
  // the mock mirrors that so replays are visible here.
  grants: [],
  rpcImpl: {
    credits_grant: (b) => { if (state.grants.some((g) => g.p_source_id === b.p_source_id)) return false; state.grants.push(b); return true; },
    credits_extend: () => 1,
    credits_expire_all: () => 5,
  },
};
const mock = await startMock(MOCK_PORT, state);

// esm.sh is not reachable from CI sandboxes; map the function's imports to npm.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whk-'));
fs.writeFileSync(path.join(tmp, 'import_map.json'), JSON.stringify({ imports: {
  'https://esm.sh/stripe@14.25.0?target=denonext': 'npm:stripe@14.25.0',
  'https://esm.sh/@supabase/supabase-js@2.45.0': 'npm:@supabase/supabase-js@2.45.0',
} }));
const deno = process.env.DENO || 'deno';
const fn = spawn(deno === 'deno' ? 'deno' : 'npx', [...(deno === 'deno' ? [] : ['--yes', 'deno']), 'run', '--node-modules-dir=none',
  '--import-map', path.join(tmp, 'import_map.json'), '--allow-net', '--allow-env', '--allow-read', '--allow-sys',
  path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts')], {
  env: { ...process.env, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: SECRET,
    SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'service', DENO_NO_UPDATE_CHECK: '1',
    STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PLAN: 'price_plan', STRIPE_PRICE_TOPUP: 'price_topup', STRIPE_COUPON_FIRST_CREDITS: 'coupon_19' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let fnLog = '';
fn.stdout.on('data', (d) => (fnLog += d)); fn.stderr.on('data', (d) => (fnLog += d));
for (let i = 0; i < 120; i++) { try { await fetch(`http://127.0.0.1:${FN_PORT}`); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }

async function post(event) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const r = await fetch(`http://127.0.0.1:${FN_PORT}`, { method: 'POST', headers: { 'stripe-signature': header }, body: payload });
  return { status: r.status, text: await r.text() };
}
const checkout = (id, email) => ({ id, type: 'checkout.session.completed', object: 'event', data: { object: {
  id: 'cs_' + id, object: 'checkout.session', client_reference_id: 'rpr-k7m2qx', customer: 'cus_1', subscription: 'sub_1', customer_details: { email } } } });

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  ' + (detail || ''))); };

// 1. New payer while the mailer is down: member must still exist, 200.
let r = await post(checkout('evt_1', 'payer@example.com'));
check('mailer down: 200', r.status === 200, JSON.stringify(r));
check('mailer down: confirmed auth user created', state.users.length === 1 && state.users[0].email_confirmed_at);
check('mailer down: owner member created', state.members.length === 1 && state.members[0].role === 'owner' && state.members[0].user_id === state.users[0].id);
check('mailer down: company active', state.companies[0].subscription_status === 'active' && state.companies[0].stripe_subscription_id === 'sub_1');
check('mailer down: link attempted, failure logged', state.otp.includes('payer@example.com') && /portal link email failed/.test(fnLog));

// 2. Same event again: dedupe.
r = await post(checkout('evt_1', 'payer@example.com'));
check('duplicate event: already processed', r.status === 200 && r.text.includes('already processed'));

// 3. Returning owner on a full team (3 members): no insert, still owner, 200.
state.members.push({ id: 'm-a', company_id: 'c1', user_id: 'u-x', role: 'member' }, { id: 'm-b', company_id: 'c1', user_id: 'u-y', role: 'member' });
state.mailerDown = false;
r = await post(checkout('evt_2', 'payer@example.com'));
check('returning owner, full team: 200', r.status === 200, JSON.stringify(r));
check('returning owner: no duplicate user or member', state.users.length === 1 && state.members.length === 3);
check('mailer up: link sent', state.otp.filter((e) => e === 'payer@example.com').length === 2);

// 4. Auth user cannot be created or found: 500, dedupe row removed so Stripe retries.
state.createUserFails = true;
r = await post(checkout('evt_3', 'new@example.com'));
check('user creation fails: 500', r.status === 500, JSON.stringify(r));
check('user creation fails: dedupe row removed for retry', !state.stripe_events.some((e) => e.id === 'evt_3'));
state.createUserFails = false;

// 5. subscription.deleted still marks the company canceled.
r = await post({ id: 'evt_4', type: 'customer.subscription.deleted', object: 'event', data: { object: { id: 'sub_1', object: 'subscription', current_period_end: 1793000000 } } });
check('subscription deleted: canceled with end date', r.status === 200 && state.companies[0].subscription_status === 'canceled' && !!state.companies[0].subscription_ends_at);

// 6. Credits.
const ev = (id, type, object) => ({ id, type, object: 'event', data: { object } });
const credit = (id, kind, extra) => ev(id, 'checkout.session.completed', { id, object: 'checkout.session', mode: kind === 'plan' ? 'subscription' : 'payment',
  payment_status: 'paid', customer: 'cus_2', metadata: { company_id: 'c2', kind, credits: kind === 'starter' ? '5' : kind === 'plan' ? '20' : '3' }, ...(extra || {}) });
const rpcs = (name) => state.rpc.filter((x) => x.name === name).map((x) => x.body);
const c2 = () => state.companies.find((c) => c.id === 'c2');

r = await post(credit('cs_starter', 'starter'));
check('starter checkout: +5 starter, no expiry', r.status === 200 && state.grants.some((g) => g.p_company_id === 'c2' && g.p_amount === 5 && g.p_product === 'starter' && g.p_source_id === 'cs_starter' && g.p_expires_at === null), JSON.stringify(rpcs('credits_grant')));
r = await post({ ...credit('cs_starter', 'starter'), id: 'evt_replay' });
check('replayed checkout (new event id, same session): granted once', r.status === 200 && state.grants.filter((g) => g.p_source_id === 'cs_starter').length === 1);
r = await post(credit('cs_topup', 'topup'));
check('top-up checkout: +quantity credits, no expiry', state.grants.some((g) => g.p_source_id === 'cs_topup' && g.p_amount === 3 && g.p_product === 'topup' && g.p_expires_at === null));
r = await post(credit('cs_unpaid', 'topup', { payment_status: 'unpaid' }));
check('unpaid checkout: no credits', r.status === 200 && !state.grants.some((g) => g.p_source_id === 'cs_unpaid'));
r = await post(credit('cs_plan', 'plan', { subscription: 'sub_plan' }));
check('plan checkout: records the plan subscription, credits wait for the invoice', c2().plan_subscription_id === 'sub_plan' && !state.grants.some((g) => g.p_source_id === 'cs_plan'));
const start = 1790000000, end = start + 30 * 86400;
r = await post(ev('evt_inv1', 'invoice.paid', { id: 'in_plan1', object: 'invoice', customer: 'cus_2', subscription: 'sub_plan', period_start: start, period_end: end,
  lines: { data: [{ price: { id: 'price_plan' }, period: { start, end } }] } }));
const pg = state.grants.find((g) => g.p_source_id === 'in_plan1');
check('invoice.paid (plan): +20 plan credits, rollover cap 20', r.status === 200 && pg && pg.p_amount === 20 && pg.p_product === 'plan' && pg.p_rollover_cap === 20, JSON.stringify(pg));
check('plan credits expire at the end of the NEXT billing period', pg && pg.p_expires_at === new Date((end + 30 * 86400) * 1000).toISOString(), pg && pg.p_expires_at);
check('plan period end recorded', c2().plan_period_end === new Date(end * 1000).toISOString());
r = await post(ev('evt_inv19', 'invoice.paid', { id: 'in_19', object: 'invoice', customer: 'cus_2', subscription: 'sub_19', period_start: start, period_end: end,
  lines: { data: [{ price: { id: 'price_19' }, period: { start, end } }] } }));
check('invoice.paid ($19): no credits', r.status === 200 && !state.grants.some((g) => g.p_source_id === 'in_19'));
r = await post(ev('evt_upd1', 'customer.subscription.updated', { id: 'sub_19', object: 'subscription', status: 'active', cancel_at_period_end: true, current_period_end: end }));
check('$19 set to cancel at period end: canceled until the end date', c2().subscription_status === 'canceled' && c2().subscription_ends_at === new Date(end * 1000).toISOString());
r = await post(ev('evt_upd2', 'customer.subscription.updated', { id: 'sub_19', object: 'subscription', status: 'active', cancel_at_period_end: false, current_period_end: end }));
check('$19 resumed: active again, no end date', c2().subscription_status === 'active' && c2().subscription_ends_at === null);
r = await post(ev('evt_del_plan', 'customer.subscription.deleted', { id: 'sub_plan', object: 'subscription', current_period_end: end }));
check('plan cancelled, $19 active: credits get 60 more days, portal untouched',
  rpcs('credits_extend').some((b) => b.p_company_id === 'c2' && b.p_days === 60) && c2().plan_subscription_id === null && c2().subscription_status === 'active');
r = await post(ev('evt_del_19', 'customer.subscription.deleted', { id: 'sub_19', object: 'subscription', current_period_end: end }));
check('$19 cancelled: every credit expires, portal canceled',
  rpcs('credits_expire_all').some((b) => b.p_company_id === 'c2' && b.p_source_id === 'sub_19') && c2().subscription_status === 'canceled');
const before = state.rpc.length;
r = await post({ ...credit('cs_internal', 'starter'), data: { object: { id: 'cs_internal', object: 'checkout.session', payment_status: 'paid', metadata: { company_id: 'c3', kind: 'starter', credits: '5' } } } });
check('internal company: ignored', r.status === 200 && state.rpc.length === before);

fn.kill(); mock.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log(fnLog.slice(-1500));
process.exit(failed ? 1 : 0);
