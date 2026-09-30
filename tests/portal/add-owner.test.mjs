// The Patrick-call path, end to end, on an in-memory swipetemplate:
//   1. a prospect swipes 5 cards on the real sales page (anonymous log_swipe)
//   2. node scripts/add-owner.mjs swipetemplate vedikabhasin+owner@gmail.com --name "Test"
//      runs unchanged against service-mock.mjs
//   3. the new owner signs in to /portal with the emailed code
//   4. the Log shows the 5 swipes as theirs; liked + fast-tracked cards are
//      UP NEXT in the Library
//   5. node scripts/reset-company.mjs swipetemplate --confirm --member <email>
//      removes the test owner and its swipes; the 10 cards stay
//   node tests/portal/add-owner.test.mjs
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServiceMock } from './service-mock.mjs';
import { createMock } from './sb-mock.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, '../..');
const OUT = process.env.OUT || path.join(ROOT, 'docs/portal-walkthrough/shots');
fs.mkdirSync(OUT, { recursive: true });
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const SB = 'https://jeuupgmztwyialqatoel.supabase.co';
const PORT = 8961, SVC = 8962;
const EMAIL = 'vedikabhasin+owner@gmail.com';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (script, args) => new Promise((resolve) => {
  const p = spawn('node', [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: { ...process.env, SUPABASE_URL: 'http://localhost:' + SVC, SUPABASE_SERVICE_ROLE_KEY: 'service', PORTAL_REDIRECT: 'http://localhost:' + PORT + '/portal' } });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out: out.trim() }));
});

// swipetemplate as it is live: 10 cards, the signal, no members, window closed.
const feed = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients/swipetemplate.json'), 'utf8'));
const CO = 'afc50b9a-0000-4000-8000-000000000001';
const today = new Date().toISOString().slice(0, 10);
const db = {
  companies: [{ id: CO, slug: 'swipetemplate', name: feed.companyName, contact_first_name: feed.contactFirstName, is_internal: false,
    subscription_status: 'none', subscription_ends_at: null, portal_access_until: null, unlock_mode: 'call', hub_unlocked: false, seat_limit: 3,
    email_known: feed.emailKnown, direction_shape: feed.directionShape, offer_text: feed.offerText, show_scarcity: false,
    stripe_subscription_id: null, plan_subscription_id: null, first_opened_at: null, created_at: '2026-09-25T18:57:12Z' }],
  cards: feed.cards.map((c, i) => ({ id: 'c0000000-0000-4000-8000-00000000000' + i, company_id: CO, card_key: c.id, format: c.format, series: c.series || null,
    title: c.title, angle: c.angle, evidence: c.evidence, tags: c.tags || [], sources: c.sources || [], drop_date: today, sort_order: i })),
  signals: [{ id: 's1', company_id: CO, text: feed.signal.text, source: feed.signal.source, signal_date: today, created_at: today }],
  members: [], decisions: [], swipe_events: [], approvals: [], notes: [], articles: [], hub_items: [], credit_ledger: [], pieces: [], users: [],
};
const cardByKey = (k) => db.cards.find((c) => c.card_key === k);

// Static server with the Netlify rewrites the test needs.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/portal' || p === '/portal/') p = '/portal/index.html';
  else if (/^\/[a-z0-9-]+$/.test(p) && !fs.existsSync(path.join(ROOT, p))) p = '/swipe.html';
  const f = path.join(ROOT, path.normalize(p));
  if (req.method === 'POST') { res.writeHead(200); return res.end('ok'); }
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));
const { server: svc } = await startServiceMock(db, SVC);
const BUNDLE = fs.readFileSync(path.join(DIR, '.cache/supabase-bundle.js'));
const browser = await chromium.launch();

async function context(USERS) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'UTC' });
  await ctx.route('https://esm.sh/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: BUNDLE }));
  await ctx.route(/posthog|googleapis|gstatic|cdnjs/, (r) => r.abort());
  const portal = createMock(db, USERS);
  await ctx.route(SB + '/**', async (r) => {
    const u = new URL(r.request().url());
    const body = r.request().postData() ? JSON.parse(r.request().postData()) : {};
    const json = (s, b) => r.fulfill({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    // The sales page's anon RPCs, with the same effect as the SQL functions.
    if (u.pathname === '/rest/v1/rpc/get_feed') {
      const c = db.companies.find((x) => x.slug === body.p_slug);
      return json(200, { slug: c.slug, name: c.name, contact_first_name: c.contact_first_name, email_known: c.email_known, direction_shape: c.direction_shape,
        offer_text: c.offer_text, first_opened_at: c.first_opened_at, show_scarcity: c.show_scarcity, unlock_mode: c.unlock_mode,
        cards: db.cards.filter((x) => x.company_id === c.id), signal: { text: feed.signal.text, source: feed.signal.source, date: today } });
    }
    if (u.pathname === '/rest/v1/rpc/bump_first_opened_at') {
      const c = db.companies.find((x) => x.slug === body.p_slug);
      c.first_opened_at = c.first_opened_at || new Date().toISOString();
      return json(200, c.first_opened_at);
    }
    if (u.pathname === '/rest/v1/rpc/log_swipe') {
      const c = db.companies.find((x) => x.slug === body.p_slug);
      const card = db.cards.find((x) => x.company_id === c.id && x.card_key === body.p_card_key);
      const t = new Date().toISOString();
      db.swipe_events.push({ id: 900 + db.swipe_events.length, company_id: c.id, card_id: card.id, member_id: null, action: body.p_action, source: 'sales', created_at: t });
      const d = db.decisions.find((x) => x.card_id === card.id && x.member_id === null);
      if (d) { d.action = body.p_action; d.updated_at = t; }
      else db.decisions.push({ id: 'dn' + db.decisions.length, company_id: c.id, card_id: card.id, member_id: null, action: body.p_action, updated_at: t });
      return json(200, null);
    }
    return portal.handle(r);
  });
  return ctx;
}

console.log('\n=== 1. Five anonymous swipes on the sales page (swipetemplate)');
{
  const ctx = await context({});
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/swipetemplate`);
  await page.waitForSelector('[data-action="start"]', { state: 'visible' });
  await page.click('[data-action="start"]');
  await page.waitForSelector('#screen-feed .card');
  for (const a of ['like', 'super', 'pass', 'like', 'save']) {
    await page.click(`[data-action="${a}"]`);
    await wait(750);
    if (await page.locator('#screen-feed.on, #screen-feed.active').count() === 0) break;
  }
  await wait(500);
  const acts = db.swipe_events.map((e) => db.cards.find((c) => c.id === e.card_id).card_key + ':' + e.action);
  check('5 anonymous swipes logged through log_swipe (member_id null)', db.swipe_events.length === 5 && db.swipe_events.every((e) => e.member_id === null) &&
    acts.join(' ') === 'c1:like c2:fasttrack c3:pass c4:like c5:save', acts.join(' '));
  await ctx.close();
}

console.log('\n=== 2. add-owner.mjs swipetemplate ' + EMAIL + ' --name "Test"');
{
  const r = await run('add-owner.mjs', ['swipetemplate', EMAIL, '--name', 'Test']);
  console.log('     ' + r.out);
  const m = db.members.find((x) => x.company_id === CO);
  const until = db.companies[0].portal_access_until;
  const days = until ? (new Date(until) - Date.now()) / 86400e3 : 0;
  check('exit 0; one owner row "Test"', r.code === 0 && db.members.length === 1 && m.role === 'owner' && m.display_name === 'Test', r.out);
  check('portal window opened for 30 days', days > 29.9 && days <= 30.01, days);
  check('the 5 swipes and 5 decisions are claimed by the owner', db.swipe_events.every((e) => e.member_id === m.id) && db.decisions.length === 5 && db.decisions.every((d) => d.member_id === m.id));
  check('one sign-in email (link + code) to the owner, back to /portal', db.otp.length === 1 && db.otp[0].email === EMAIL && db.otp[0].create_user === false, db.otp);
  check('the report line says so', /5 swipe events \+ 5 decisions claimed/.test(r.out) && /Sign-in email sent/.test(r.out), r.out);
}

console.log('\n=== 3. Sign in with the emailed code, Log and Library');
{
  const u = db.users.find((x) => x.email === EMAIL);
  const ctx = await context({ 'tok-owner': { id: u.id, email: EMAIL } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/portal`);
  await page.waitForSelector('#screen-signin.on');
  await page.fill('#signin-email', EMAIL);
  await page.click('#signin-btn');
  await page.waitForSelector('#signin-sent:not([hidden])');
  await page.fill('#signin-code', '123456');
  await page.click('#code-btn');
  await page.waitForSelector('#screen-feed.on');
  check('signed in with the code', await page.locator('#screen-feed.on').count() === 1);
  for (let i = 0; i < 3; i++) await page.click('[data-action="bubble-dismiss"]', { timeout: 500 }).catch(() => {});
  await page.click('[data-action="show-history"]');
  await wait(300);
  const log = await page.evaluate(() => ({ head: document.getElementById('log-count').textContent,
    rows: Array.from(document.querySelectorAll('#history-log .log-row')).map((r) => r.querySelector('.hist-title').textContent + ' | ' + r.querySelector('.log-meta .pill').textContent) }));
  const expect = [['c5', 'Saved'], ['c4', 'Liked'], ['c3', 'Passed'], ['c2', 'Fast-track'], ['c1', 'Liked']];
  check('Log: "5 calls logged.", newest first, each with the stamp from the sales page', log.head === '5 calls logged.' &&
    expect.every(([k, st], i) => log.rows[i] === cardByKey(k).title + ' | ' + st), log);
  await page.screenshot({ path: `${OUT}/o01-owner-log.jpg`, type: 'jpeg', quality: 80 });
  await page.click('[data-action="close-history"]');
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  for (let i = 0; i < 3; i++) await page.click('[data-action="bubble-dismiss"]', { timeout: 500 }).catch(() => {});
  const titles = [];
  for (let i = 0; i < 4; i++) { titles.push(await page.locator('.book.top').innerText()); await page.click('[data-action="lib-next"]').catch(() => {}); await wait(250); }
  const up = ['c1', 'c2', 'c4'].map((k) => cardByKey(k).title);
  check('Library: "0 DELIVERED · 3 UP NEXT"', (await page.textContent('#lib-count')) === '0 delivered · 3 up next', await page.textContent('#lib-count'));
  check('the liked and fast-tracked cards are UP NEXT; the passed and saved ones are not', up.every((t) => titles.some((x) => x.includes(t) && /UP NEXT/.test(x))) &&
    !titles.some((x) => x.includes(cardByKey('c3').title) || x.includes(cardByKey('c5').title)), titles);
  await page.screenshot({ path: `${OUT}/o02-owner-library.jpg`, type: 'jpeg', quality: 80 });
  check('no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== 4. Remove the test owner and its swipes');
{
  const dry = await run('reset-company.mjs', ['swipetemplate', '--dry-run', '--member', EMAIL]);
  console.log(dry.out.split('\n').map((l) => '     ' + l).join('\n'));
  const r = await run('reset-company.mjs', ['swipetemplate', '--confirm', '--member', EMAIL]);
  check('reset-company --member: exit 0', r.code === 0, r.out);
  check('after: no members, no swipes or decisions, window cleared', db.members.length === 0 && db.swipe_events.length === 0 && db.decisions.length === 0 && db.companies[0].portal_access_until === null);
  check('after: the 10 cards and the signal stay; the auth user is never deleted', db.cards.length === 10 && db.signals.length === 1 && db.users.some((u) => u.email === EMAIL));
}

await browser.close(); server.close(); svc.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
