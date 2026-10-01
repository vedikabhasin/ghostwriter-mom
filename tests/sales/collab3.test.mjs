// The collab3 flow (templates/swipe2.html) end to end in Chromium.
//   node tests/sales/collab3.test.mjs
// Serves the repo with the generated _redirects, answers Supabase with a
// stateful in-memory stand-in that mirrors log_swipe / get_collab_state /
// set_collab_pick / submit_approval (keyed by slug, shared by every browser
// context, so each context is "another device"), and records Netlify form
// posts. Screenshots: OUT (default tests/sales/shots).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, '../..');
const OUT = process.env.OUT || path.join(DIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BUNDLE_PATH = path.join(DIR, '.cache/supabase-bundle.js');
if (!fs.existsSync(BUNDLE_PATH)) {
  fs.mkdirSync(path.dirname(BUNDLE_PATH), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.cache/entry.js'), "export { createClient } from '@supabase/supabase-js';");
  execFileSync('npx', ['--yes', 'esbuild@0.24.0', path.join(DIR, '.cache/entry.js'), '--bundle', '--format=esm', '--platform=browser', '--outfile=' + BUNDLE_PATH, '--log-level=warning'], { cwd: ROOT, stdio: 'inherit' });
}
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');
execFileSync('node', ['validate-feeds.js'], { cwd: ROOT, stdio: 'ignore' });

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail))); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- site
const PORT = 8981, BASE = 'http://localhost:' + PORT;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const rules = fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
const forms = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE), p = decodeURIComponent(u.pathname);
  if (req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { forms.push({ at: Date.now(), ...Object.fromEntries(new URLSearchParams(b)) }); res.end('ok'); });
    return;
  }
  const send = (f) => { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); };
  for (const [from, to, st] of rules) {
    if (from !== p) continue;
    if (st.startsWith('30')) { res.writeHead(+st.replace('!', ''), { location: to + u.search }); return res.end(); }
    return send(path.join(ROOT, to.split('?')[0]));
  }
  const f = path.join(ROOT, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return send(f);
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, r));

// ---- database stand-in (slug -> state)
const SLUG = 'swipe2template';
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', SLUG + '.json'), 'utf8'));
const db = {};
const co = (slug) => (db[slug] = db[slug] || { decisions: {}, log: [], pick: null, approval: null });
const rpcLog = [];
function rpc(name, a) {
  rpcLog.push({ name, ...a });
  const c = co(a.p_slug);
  const known = (k) => CONFIG.cards.some((x) => x.id === k);
  switch (name) {
    case 'get_feed': return { slug: SLUG, name: CONFIG.companyName, contact_first_name: CONFIG.contactFirstName, greeting_name: CONFIG.greetingName, intro_basis: CONFIG.introBasis,
      email_known: CONFIG.emailKnown, direction_shape: CONFIG.directionShape, offer_text: CONFIG.offerText, first_opened_at: '2026-10-01T10:00:00Z', show_scarcity: false, unlock_mode: 'call', signal: null,
      cards: CONFIG.cards.map((x) => ({ id: x.id, card_key: x.id, format: x.format, title: x.title, angle: x.angle, evidence: x.evidence, tags: x.tags || [], sources: x.sources, series: null })) };
    case 'log_swipe': if (!known(a.p_card_key)) throw new Error('unknown card'); c.log.push({ card_key: a.p_card_key, action: a.p_action, created_at: new Date().toISOString() }); c.decisions[a.p_card_key] = a.p_action; return null;
    case 'get_collab_state': return { decisions: CONFIG.cards.filter((x) => c.decisions[x.id]).map((x) => ({ card_key: x.id, action: c.decisions[x.id] })), log: c.log, pick: c.pick, approval: c.approval };
    case 'set_collab_pick': if (!c.pick) c.pick = { card_key: a.p_card_key, picked_at: new Date().toISOString() }; return c.pick;
    case 'submit_approval': c.approval = { card_key: a.p_free_card_key, approved_at: new Date().toISOString(), deliver_by: new Date(Date.now() + 864e5).toISOString(), email: a.p_email }; return 'ap-1';
    default: return null;
  }
}

const browser = await chromium.launch();
async function device(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route('https://esm.sh/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: BUNDLE }));
  await ctx.route(/posthog\.com|fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await ctx.route('https://cal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Cal</title>' }));
  await ctx.route('https://*.supabase.co/**', (r) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: cors });
    const name = new URL(r.request().url()).pathname.split('/').pop();
    try { return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(rpc(name, JSON.parse(r.request().postData() || '{}'))) }); }
    catch (e) { return r.fulfill({ status: 400, contentType: 'application/json', headers: cors, body: JSON.stringify({ message: e.message }) }); }
  });
  if (opts.local) await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, ['gwm-swipe-' + SLUG, JSON.stringify(opts.local)]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
const ph = (page) => page.evaluate(() => (Array.isArray(window.posthog) ? window.posthog : []).filter((c) => c[0] === 'capture').map((c) => ({ name: c[1], props: c[2] })));
const visibleText = (page) => page.evaluate(() => document.body.innerText);
const tile = (page, i) => page.evaluate((n) => { const t = document.querySelectorAll('#collab-portal .collab-tile')[n]; return { text: t.innerText.trim(), opacity: getComputedStyle(t).opacity, lock: !!t.querySelector('.tile-lock') }; }, i);

console.log('\n=== Device A: intro, deck, collab screen, send, unlock');
{
  const { ctx, page, errors } = await device();
  await page.goto(BASE + '/' + SLUG + '?ph_debug=1');
  await page.waitForSelector('[data-action="start"]', { state: 'visible' });
  const intro = await page.evaluate(() => ({ eyebrow: document.querySelector('.intro-eyebrow').innerText.trim(), hello: document.querySelector('.intro-hello').innerText.trim(),
    bold: document.querySelector('#intro-offer strong').textContent, lines: Array.from(document.querySelectorAll('#intro-offer .intro-line')).map((e) => e.textContent),
    muted: document.querySelector('#intro-offer .intro-muted').textContent, mutedSize: parseFloat(getComputedStyle(document.querySelector('#intro-offer .intro-muted')).fontSize),
    bodySize: parseFloat(getComputedStyle(document.querySelector('#intro-offer')).fontSize), offer: document.getElementById('intro-offer').textContent,
    btn: document.querySelector('[data-action="start"]').innerText.trim() }));
  check('intro: "3 DIRECTIONS FOR", greeting and button kept', intro.eyebrow === '3 DIRECTIONS FOR' && intro.hello === 'Hi Sam.' && /Deal me in/.test(intro.btn), intro);
  check('intro: bold first sentence', intro.bold === 'Ghostwriter Mom turns search and AI-citation gaps into technical articles.');
  check('intro: "These 3 directions come from {sourceLine}."', intro.offer.includes('These 3 directions come from ' + CONFIG.introBasis + '.'));
  check('intro: three new lines, each its own line', JSON.stringify(intro.lines) === JSON.stringify(['Swipe to keep or pass.',
    'We pick the best match from your swipes and write it free, in your inbox within 24 hours. No call needed.',
    'Written and edited by a human for your brand, not an unreviewed AI draft.']), intro.lines);
  check('intro: small muted last line with lockedCount', intro.muted === 'A 15-minute call unlocks your portal and 7 more directions. Your swipes stay saved on any device.' && intro.mutedSize < intro.bodySize, intro);
  await page.waitForFunction(() => !document.getElementById('screen-loading').classList.contains('on'));
  await wait(900);
  await page.screenshot({ path: OUT + '/c01-intro.jpg', type: 'jpeg', quality: 80 });

  await page.click('[data-action="start"]');
  await page.waitForSelector('.card[data-depth="0"]');
  await wait(800);
  const ctl = await page.evaluate(() => Object.fromEntries(['pass', 'save', 'super', 'like'].map((a) => { const b = document.querySelector(`.feed-controls [data-action="${a}"]`); const s = getComputedStyle(b);
    return [a, { label: b.querySelector('.ctl-label').textContent, opacity: s.opacity, pe: s.pointerEvents, disabled: b.disabled, lock: !!b.querySelector('.ctl-lock'), title: b.getAttribute('title') }]; })));
  check('Keep under the heart, Pass under the X, both active', ctl.like.label === 'Keep' && ctl.pass.label === 'Pass' && ctl.like.opacity === '1' && ctl.pass.pe !== 'none', ctl);
  check('Save and fast-track: visible, opacity 0.35, not clickable, lock icon, no tooltip', ['save', 'super'].every((k) => ctl[k].opacity === '0.35' && ctl[k].pe === 'none' && ctl[k].disabled && ctl[k].lock && !ctl[k].title), ctl);
  check('3 cards in the deck', (await page.textContent('#feed-counter')).trim().endsWith('of 3'), await page.textContent('#feed-counter'));
  await page.screenshot({ path: OUT + '/c02-card.jpg', type: 'jpeg', quality: 80 });
  // Swipe up and down: nothing happens.
  const box = await page.locator('.card[data-depth="0"]').boundingBox();
  for (const dy of [-260, 260]) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 8 }); await page.mouse.up(); await wait(700);
  }
  check('swiping up or down does nothing (no swipe logged, still card 1)', !rpcLog.some((r) => r.name === 'log_swipe') && (await page.textContent('#feed-counter')).trim().startsWith('1'));
  // Swipe gesture right on card 1, buttons for 2 and 3.
  await page.keyboard.press('Escape');
  const b1 = await page.locator('.card[data-depth="0"]').boundingBox();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2); await page.mouse.down();
  await page.mouse.move(b1.x + b1.width / 2 + 260, b1.y + b1.height / 2, { steps: 8 }); await page.mouse.up(); await wait(900);
  await page.click('.feed-controls [data-action="pass"]'); await wait(900);
  await page.click('.feed-controls [data-action="like"]');
  await page.waitForSelector('#screen-collab.on', { timeout: 5000 });
  await wait(600);
  check('swipes stored in the database by slug', JSON.stringify(db[SLUG].decisions) === JSON.stringify({ c1: 'like', c2: 'pass', c3: 'like' }), db[SLUG].decisions);
  const cv = await page.evaluate(() => ({ head: document.querySelector('.collab-head').textContent,
    rows: Array.from(document.querySelectorAll('.collab-row')).map((r) => ({ title: r.querySelector('.collab-title').textContent, tag: r.querySelector('.collab-tag').textContent,
      who: Array.from(r.querySelectorAll('.collab-react')).map((x) => x.querySelector('.nm').textContent + ':' + x.querySelector('.ic').className.replace('ic ', '')) })),
    pick: document.getElementById('collab-pick-title').textContent, cta: document.getElementById('collab-send').innerText.trim(), email: !!document.querySelector('#collab-email:not([hidden])'),
    unlock: document.getElementById('collab-unlock').innerText.trim() }));
  check('heading', cv.head === "Here's how we reacted. This is how your team sees it in the portal.");
  check('each card: both reactions side by side, tagged Match / Pass / Match', cv.rows.map((r) => r.tag).join() === 'Match,Pass,Match' &&
    cv.rows[0].who.join() === 'Sam:like,Vedika:like' && cv.rows[1].who.join() === 'Sam:pass,Vedika:pass', cv.rows);
  const t3 = CONFIG.cards.find((c) => c.id === 'c3').title;
  check('auto-pick: first Match in writeOn order (c3), stored in the database', cv.pick === t3 && db[SLUG].pick.card_key === 'c3', { pick: cv.pick, db: db[SLUG].pick });
  check('email field + "Send my article"', cv.email && /^Send my article/.test(cv.cta), cv.cta);
  const tiles = [await tile(page, 0), await tile(page, 1), await tile(page, 2), await tile(page, 3)];
  check('portal preview: Feed open; Library, Hub, "7 more directions" locked at 0.35', tiles[0].text === 'FEED' && tiles[0].opacity === '1' &&
    tiles.slice(1).map((t) => t.text).join() === 'LIBRARY,HUB,7 MORE DIRECTIONS' && tiles.slice(1).every((t) => t.opacity === '0.35' && t.lock), tiles);
  const txt = await visibleText(page);
  check('no Signals, Log or seat items in the preview; no "Open 3 seats" anywhere', !/signal|seat/i.test(await page.textContent('#collab-portal')) && !/open 3 seats|seat/i.test(txt), txt.slice(0, 200));
  check('one unlock button: "Unlock portal now"', cv.unlock === 'Unlock portal now' && (await page.locator('#screen-collab .btn-primary:visible').count()) === 2);
  await page.screenshot({ path: OUT + '/c03-collab.jpg', type: 'jpeg', quality: 80, fullPage: true });

  await page.fill('#collab-email', 'not-an-email'); await page.click('#collab-send');
  check('bad email: existing error copy', (await page.textContent('#collab-err')).trim() === 'That email address does not look right.');
  await page.fill('#collab-email', 'sam@beacon.test'); await page.click('#collab-send'); await wait(800);
  const ap = forms.find((f) => f['form-name'] === 'approvals');
  check('send: approval in the database for the picked card, Netlify approvals form posted', db[SLUG].approval && db[SLUG].approval.card_key === 'c3' && ap && ap.cardTitle === t3 && ap.email === 'sam@beacon.test', { db: db[SLUG].approval, ap });
  const sent = (await page.textContent('#collab-sent')).trim();
  check('after send: the confirmation sentence replaces the form', /^Your LinkedIn post, .+, lands in your inbox by .+\.$/.test(sent) && await page.locator('#collab-form').isHidden(), sent);
  await page.screenshot({ path: OUT + '/c04-sent.jpg', type: 'jpeg', quality: 80, fullPage: true });

  const evBefore = (await ph(page)).map((e) => e.name);
  // The page leaves for Cal.com, so stream later events out as they fire.
  const late = [];
  await page.exposeFunction('__phSink', (n) => late.push(n));
  await page.evaluate(() => { const p = window.posthog, op = p.push; p.push = function(x){ try { if (x && x[0] === 'capture') window.__phSink(x[1]); } catch (_) {} return op.apply(this, arguments); }; });
  const navAt = { t: 0 }; page.on('framenavigated', (f) => { if (f === page.mainFrame() && /cal\.com/.test(f.url())) navAt.t = Date.now(); });
  await page.click('#collab-unlock');
  await page.waitForURL(/cal\.com/, { timeout: 5000 });
  const unlockForm = forms.find((f) => f['form-name'] === 'portal-unlock');
  check('unlock: Netlify portal-unlock captured before the redirect', unlockForm && unlockForm.slug === SLUG && unlockForm.at <= navAt.t, { unlockForm, navAt });
  check('unlock: lands on cal.com/vedika/ghostwriter-mom', page.url().startsWith('https://cal.com/vedika/ghostwriter-mom'), page.url());
  for (const e of ['page_open', 'deal_me_in', 'first_swipe', 'swipe_complete', 'collab_view_seen', 'article_auto_picked', 'email_submitted']) check('PostHog: ' + e, evBefore.includes(e));
  check('PostHog: unlock_clicked fired before leaving', late.includes('unlock_clicked'), late);
  check('Device A: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Device B (a colleague, a new phone): same swipes, pick and log');
{
  const { ctx, page, errors } = await device();
  await page.goto(BASE + '/' + SLUG + '?ph_debug=1');
  await page.waitForSelector('#screen-collab.on', { timeout: 8000 });
  const t3 = CONFIG.cards.find((c) => c.id === 'c3').title;
  const v = await page.evaluate(() => ({ tags: Array.from(document.querySelectorAll('.collab-tag')).map((t) => t.textContent).join(), pick: document.getElementById('collab-pick-title').textContent,
    sent: !document.getElementById('collab-sent').hidden }));
  check('opens straight on the collab view with the same tags, pick and sent state', v.tags === 'Match,Pass,Match' && v.pick === t3 && v.sent, v);
  await page.click('#screen-collab [data-action="show-history"]');
  await page.waitForSelector('#screen-history.on');
  const log = await page.evaluate(() => Array.from(document.querySelectorAll('#history-list .history-item')).map((li) => li.querySelector('.history-title').textContent));
  check('the same log: 3 swipes and the pick', log.length === 4 && log.filter((x) => x === t3).length === 2, log);
  check('no second pick written', rpcLog.filter((r) => r.name === 'set_collab_pick').length === 1);
  check('Device B: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Device C: swipes only in localStorage are migrated on first load');
{
  delete db[SLUG];
  const brief = (id) => ({ id, format: CONFIG.cards.find((c) => c.id === id).format, title: CONFIG.cards.find((c) => c.id === id).title });
  const local = { cardIndex: 2, liked: [brief('c1')], passed: [brief('c2')], saved: [], superLiked: null,
    events: [{ cardId: 'c1', action: 'like', timestamp: '2026-10-01T09:00:00Z' }, { cardId: 'c2', action: 'pass', timestamp: '2026-10-01T09:00:05Z' }], onboardingDone: { t: true, h: true, v: true } };
  const { ctx, page, errors } = await device({ local });
  await page.goto(BASE + '/' + SLUG);
  await page.waitForSelector('#screen-feed.on', { timeout: 8000 });
  await wait(500);
  check('the two cached swipes are now in the database, in order', db[SLUG] && db[SLUG].log.map((l) => l.card_key + ':' + l.action).join() === 'c1:like,c2:pass', db[SLUG]);
  check('resumes on card 3', (await page.textContent('#feed-counter')).trim().startsWith('3'), await page.textContent('#feed-counter'));
  await page.click('.feed-controls [data-action="pass"]');
  await page.waitForSelector('#screen-collab.on', { timeout: 5000 });
  const c1 = CONFIG.cards.find((c) => c.id === 'c1').title;
  check('no Match except c1 -> auto-pick c1', (await page.textContent('#collab-pick-title')) === c1 && db[SLUG].pick.card_key === 'c1');
  check('Device C: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Copy rules');
{
  const html = fs.readFileSync(path.join(ROOT, 'templates/swipe2.html'), 'utf8');
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('swipe2: no em dash in markup or strings', !/—/.test(stripped));
  check('swipe2 config: no RPR formats', !CONFIG.cards.some((c) => /^(pillar|insight|post)$/.test(c.format)));
}

await browser.close(); server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
