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
  companies: [{ id: 'c1', slug: 'rpr-k7m2qx', subscription_status: 'none' }],
  members: [], stripe_events: [],
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
    SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'service', DENO_NO_UPDATE_CHECK: '1' },
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

fn.kill(); mock.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log(fnLog.slice(-1500));
process.exit(failed ? 1 : 0);
