// Runs supabase/functions/create-checkout under Deno against the local
// Supabase + fake Stripe mock (stripe-webhook-mock.mjs) and checks what it
// asks Stripe for: products, quantities, the first-purchase coupon, resume.
//
//   node tests/portal/create-checkout.test.mjs   (needs deno on PATH, or `npx deno`)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './stripe-webhook-mock.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const MOCK_PORT = 54323, FN_PORT = 8000;
const future = new Date(Date.now() + 20 * 86400e3).toISOString();

const state = {
  calls: [], otp: [], users: [], stripe_events: [],
  tokens: {
    'tok-new':  { id: 'u-new',  email: 'owner@acme.co' },
    'tok-end':  { id: 'u-end',  email: 'owner@ending.co' },
    'tok-dead': { id: 'u-dead', email: 'owner@dead.co' },
    'tok-int':  { id: 'u-int',  email: 'me@internal.co' },
    'tok-out':  { id: 'u-out',  email: 'nobody@x.co' },
  },
  companies: [
    { id: 'c-new',  slug: 'acme',   is_internal: false, subscription_status: 'active',   subscription_ends_at: null,   stripe_customer_id: 'cus_acme', stripe_subscription_id: 'sub_acme', plan_subscription_id: null },
    { id: 'c-end',  slug: 'ending', is_internal: false, subscription_status: 'canceled', subscription_ends_at: future, stripe_customer_id: 'cus_end',  stripe_subscription_id: 'sub_end',  plan_subscription_id: null },
    { id: 'c-dead', slug: 'dead',   is_internal: false, subscription_status: 'canceled', subscription_ends_at: future, stripe_customer_id: 'cus_dead', stripe_subscription_id: 'sub_dead', plan_subscription_id: null },
    { id: 'c-int',  slug: 'vedika', is_internal: true,  subscription_status: 'active',   subscription_ends_at: null,   stripe_customer_id: null,       stripe_subscription_id: null,       plan_subscription_id: null },
  ],
  members: [
    { id: 'm-new', company_id: 'c-new', user_id: 'u-new', created_at: '1' },
    { id: 'm-end', company_id: 'c-end', user_id: 'u-end', created_at: '1' },
    { id: 'm-dead', company_id: 'c-dead', user_id: 'u-dead', created_at: '1' },
    { id: 'm-int', company_id: 'c-int', user_id: 'u-int', created_at: '1' },
  ],
  credit_ledger: [],
  stripeImpl: ({ method, path: p, body }) => {
    if (method === 'POST' && p === '/v1/checkout/sessions') return [200, { id: 'cs_' + state.stripe.length, object: 'checkout.session', url: 'https://checkout.stripe.test/' + state.stripe.length }];
    if (method === 'POST' && p === '/v1/subscriptions/sub_end') return [200, { id: 'sub_end', object: 'subscription', status: 'active', cancel_at_period_end: body.cancel_at_period_end === 'true' }];
    if (method === 'POST' && p === '/v1/subscriptions/sub_dead') return [400, { error: { type: 'invalid_request_error', message: 'A canceled subscription can only update its cancellation_details and metadata.' } }];
    return null;
  },
};
const mock = await startMock(MOCK_PORT, state);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
fs.writeFileSync(path.join(tmp, 'import_map.json'), JSON.stringify({ imports: {
  'https://esm.sh/stripe@14.25.0?target=denonext': 'npm:stripe@14.25.0',
  'https://esm.sh/@supabase/supabase-js@2.45.0': 'npm:@supabase/supabase-js@2.45.0',
} }));
const deno = process.env.DENO || 'deno';
const fn = spawn(deno === 'deno' ? 'deno' : 'npx', [...(deno === 'deno' ? [] : ['--yes', 'deno']), 'run', '--node-modules-dir=none',
  '--import-map', path.join(tmp, 'import_map.json'), '--allow-net', '--allow-env', '--allow-read', '--allow-sys',
  path.join(ROOT, 'supabase/functions/create-checkout/index.ts')], {
  env: { ...process.env, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PLAN: 'price_plan', STRIPE_PRICE_TOPUP: 'price_topup', STRIPE_COUPON_FIRST_CREDITS: 'coupon_19',
    SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'service', DENO_NO_UPDATE_CHECK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let fnLog = '';
fn.stdout.on('data', (d) => (fnLog += d)); fn.stderr.on('data', (d) => (fnLog += d));
for (let i = 0; i < 120; i++) { try { await fetch(`http://127.0.0.1:${FN_PORT}`); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }

async function call(token, body) {
  const r = await fetch(`http://127.0.0.1:${FN_PORT}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const lastSession = () => [...state.stripe].reverse().find((c) => c.path === '/v1/checkout/sessions').body;
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  ' + (detail === undefined ? '' : JSON.stringify(detail)))); };

let r = await call('', { action: 'starter' });
check('no session: 401', r.status === 401);
r = await call('tok-out', { action: 'starter' });
check('not a member: 403', r.status === 403 && r.json.error === 'not_a_member');
r = await call('tok-int', { action: 'starter' });
check('internal company: refused (the webhook ignores it anyway)', r.status === 400 && r.json.error === 'internal');

r = await call('tok-new', { action: 'starter' });
let s = lastSession();
check('Starter: Checkout URL returned', r.status === 200 && /^https:\/\/checkout\.stripe\.test\//.test(r.json.url), r);
check('Starter: one-time payment, price_starter x1, existing customer', s.mode === 'payment' && s['line_items[0][price]'] === 'price_starter' && s['line_items[0][quantity]'] === '1' && s.customer === 'cus_acme', s);
check('first credit purchase: the $19 coupon is applied', s['discounts[0][coupon]'] === 'coupon_19' && r.json.first_purchase === true, s);
check('Starter: metadata carries company, kind and credits', s['metadata[company_id]'] === 'c-new' && s['metadata[kind]'] === 'starter' && s['metadata[credits]'] === '5');
check('Starter: back to the portal on success and cancel', /\/portal\?credits=success&kind=starter$/.test(s.success_url) && /\/portal\?credits=cancel$/.test(s.cancel_url), s);

state.credit_ledger.push({ company_id: 'c-new', kind: 'grant', product: 'starter' });
r = await call('tok-new', { action: 'starter' });
check('Starter only once per company', r.status === 409 && r.json.error === 'starter_used');
r = await call('tok-new', { action: 'topup', quantity: 3 });
s = lastSession();
check('Top-up: price_topup x3, no coupon after the first purchase', r.status === 200 && s['line_items[0][price]'] === 'price_topup' && s['line_items[0][quantity]'] === '3' && !s['discounts[0][coupon]'] && s['metadata[credits]'] === '3', s);
r = await call('tok-new', { action: 'topup', quantity: 0 });
check('Top-up: quantity must be 1 or more', r.status === 400 && r.json.error === 'bad_quantity');
r = await call('tok-new', { action: 'plan' });
s = lastSession();
check('Plan: subscription mode, metadata on the subscription too', r.status === 200 && s.mode === 'subscription' && s['line_items[0][price]'] === 'price_plan' && s['subscription_data[metadata][kind]'] === 'plan', s);
state.companies[0].plan_subscription_id = 'sub_plan';
r = await call('tok-new', { action: 'plan' });
check('Plan: not while one is running', r.status === 409 && r.json.error === 'plan_active');

r = await call('tok-end', { action: 'starter' });
check('$19 set to cancel: credits need the $19, resume offered', r.status === 409 && r.json.error === 'portal_inactive' && r.json.can_resume === true, r);
const stripeBefore = state.stripe.length;
r = await call('tok-end', { action: 'resume' });
const upd = state.stripe.slice(stripeBefore).find((c) => c.path === '/v1/subscriptions/sub_end');
check('Resume: the SAME subscription, cancel_at_period_end=false', r.status === 200 && r.json.resumed === true && upd && upd.body.cancel_at_period_end === 'false', { r, upd });
check('Resume: no new subscription and no new charge', !state.stripe.slice(stripeBefore).some((c) => c.path === '/v1/checkout/sessions' || c.path === '/v1/subscriptions'));
check('Resume: portal active again right away', state.companies[1].subscription_status === 'active' && state.companies[1].subscription_ends_at === null);
r = await call('tok-end', { action: 'starter' });
check('after resume: straight into the Starter checkout, with the coupon', r.status === 200 && lastSession()['discounts[0][coupon]'] === 'coupon_19');
r = await call('tok-dead', { action: 'resume' });
check('Resume refused by Stripe (fully canceled): cannot_resume, nothing changed', r.status === 409 && r.json.error === 'cannot_resume' && state.companies[2].subscription_status === 'canceled');

fn.kill(); mock.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log(fnLog.slice(-1500));
process.exit(failed ? 1 : 0);
