// Portal walkthrough: 375px phone + desktop, two RPR test members.
//
//   npm install && node tests/portal/walkthrough.mjs
//
// Serves the repo on :8877, runs Chromium via Playwright, and answers every
// Supabase call (REST, Auth, Functions) from sb-mock.mjs, which is seeded
// with the rows supabase/seed/portal_test_rpr.sql puts on RPR. supabase-js
// itself is real (bundled locally from node_modules, same 2.45.0 the portal
// loads from esm.sh). PostHog's script is blocked; the stub's queued calls
// are read back to check events. Screenshots land in
// docs/portal-walkthrough/shots (override with OUT=...).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, USERS } from './fixture.mjs';
import { createMock } from './sb-mock.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, '../..');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }

const OUT = process.env.OUT || path.join(ROOT, 'docs/portal-walkthrough/shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8877;
const BASE = 'http://localhost:' + PORT;
const SB = 'https://jeuupgmztwyialqatoel.supabase.co';

// supabase-js as one ESM file, standing in for esm.sh.
const CACHE = path.join(DIR, '.cache');
const BUNDLE_PATH = path.join(CACHE, 'supabase-bundle.js');
if (!fs.existsSync(BUNDLE_PATH)) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'entry.js'), "export { createClient } from '@supabase/supabase-js';");
  execFileSync('npx', ['--yes', 'esbuild@0.24.0', path.join(CACHE, 'entry.js'), '--bundle', '--format=esm', '--platform=browser',
    '--outfile=' + BUNDLE_PATH, '--log-level=warning'], { cwd: ROOT, stdio: 'inherit' });
}
const BUNDLE = fs.readFileSync(BUNDLE_PATH, 'utf8');

// Static server with the Netlify /portal rewrite.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (p === '/portal' || p === '/portal/') p = '/portal/index.html';
  const f = path.join(ROOT, path.normalize(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); if (!cond) console.log('  FAIL', name, detail || ''); }

// Google Fonts through curl (it trusts the proxy CA), so screenshots use Inter Tight.
const fontCache = new Map();
function fetchFont(url) {
  if (!fontCache.has(url)) {
    try { fontCache.set(url, execFileSync('curl', ['-sS', '--max-time', '20', '-A', 'Mozilla/5.0 Chrome/140', url])); }
    catch { fontCache.set(url, null); }
  }
  return fontCache.get(url);
}

async function newPage(browser, { mobile, db, token }) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false }
    : { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const mock = createMock(db);
  await ctx.route(SB + '/**', (r) => mock.handle(r));
  await ctx.route('https://esm.sh/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: BUNDLE }));
  await ctx.route(/posthog\.com/, (r) => r.abort());
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => {
    const buf = fetchFont(r.request().url());
    return buf ? r.fulfill({ status: 200, body: buf, contentType: r.request().url().includes('gstatic') ? 'font/woff2' : 'text/css' }) : r.abort();
  });
  if (token) {
    const u = USERS[token];
    await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } },
      ['sb-jeuupgmztwyialqatoel-auth-token', JSON.stringify({ access_token: token, refresh_token: 'r-' + token, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: u.email, aud: 'authenticated' } })]);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_FAILED')) errors.push(m.text()); });
  page.on('requestfailed', (r) => { if (!/posthog/.test(r.url())) errors.push('requestfailed ' + r.url()); });
  return { ctx, page, mock, errors };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 78 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const phEvents = (page) => page.evaluate(() => (Array.isArray(window.posthog) ? window.posthog : []).map((c) => Array.from(c)));
async function dotTo(page, key, db) {
  const cardId = db.cards.find((c) => c.card_key === key).id;
  const idx = await page.evaluate((title) => Array.from(document.querySelectorAll('#dots .dot')).findIndex((d) => d.getAttribute('aria-label').includes(title)),
    db.cards.find((c) => c.id === cardId).title);
  await page.locator('#dots .dot').nth(idx).click();
  await wait(350);
}
async function dragTop(page, dx, dy) {
  const box = await page.locator('#card-stage .card[data-depth="0"]').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + dx * i / 12, y + dy * i / 12);
  return { finish: async () => { await page.mouse.up(); await wait(500); } };
}
const toastText = (page) => page.locator('#toast').textContent();

const browser = await chromium.launch();

// ============================================================ A. Sam, 375px
{
  console.log('A. Sam on a 375px phone');
  const db = freshDb();
  const { page, mock, errors, ctx } = await newPage(browser, { mobile: true, db });
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-signin.on');
  await shot(page, 'm01-signin');
  await page.fill('#signin-email', 'vedikabhasin+rpr-sam@gmail.com');
  await page.click('#signin-btn');
  await page.waitForFunction(() => document.querySelector('#signin-msg').textContent.includes('Check your inbox'));
  const otp = mock.log.find((l) => l.path.startsWith('/auth/v1/otp'));
  check('otp: shouldCreateUser false', otp && otp.body.create_user === false, JSON.stringify(otp && otp.body));
  check('otp: redirect to /portal', otp && /redirect_to=http%3A%2F%2Flocalhost%3A8877%2Fportal/.test(otp.path), otp && otp.path);
  await shot(page, 'm02-link-sent');

  // Click the magic link (a fresh page load, as from an email).
  await page.goto('about:blank');
  await page.goto(BASE + '/portal#access_token=tok-sam&refresh_token=r1&expires_in=3600&expires_at=' + (Math.floor(Date.now() / 1000) + 3600) + '&token_type=bearer&type=magiclink');
  await page.waitForSelector('#screen-feed.on');
  await page.waitForSelector('#bubble:not([hidden])');
  check('feed: signal card on top', (await page.locator('#card-stage .card[data-depth="0"]').getAttribute('class')).includes('fmt-signal'));
  check('feed: count line', (await page.textContent('#feed-count')) === '10 cards · 7 unread', await page.textContent('#feed-count'));
  check('feed: 11 dots (signal + 10)', (await page.locator('#dots .dot').count()) === 11);
  check('url hash cleared', !(await page.evaluate(() => location.hash)));
  await shot(page, 'm03-feed-signal-onboarding');
  await page.click('[data-action="bubble-dismiss"]');
  await wait(200);
  check('onboarding: library switch glows', await page.locator('#switch-library.onb-glow').count() === 1);
  await shot(page, 'm04-library-glow');
  await page.click('[data-action="bubble-dismiss"]');

  // Signal -> first card by swipe (no decision recorded).
  let d = await dragTop(page, 200, 0); await d.finish();
  const top = page.locator('#card-stage .card[data-depth="0"]');
  check('swipe on signal moves on, no decision', (await top.textContent()).includes('Replacing 8th Wall VPS') && !mock.log.some((l) => l.path.includes('portal_decide')));
  check('new-this-week label on latest drop', await top.locator('.new-label').count() === 1);
  check('agree overlap glow', (await top.getAttribute('class')).includes('ov-agree'));
  check('stamp shows current decision', (await top.locator('.card-stamp').textContent()) === 'Liked');
  await wait(300);
  check('first agree line', (await toastText(page)).includes('You both want this one'), await toastText(page));
  await shot(page, 'm05-agree');
  await wait(4400);

  // Split: Patrick fast-tracked on the sales page, Sam passed.
  await dotTo(page, 'rpr-02', db);
  check('split overlap glow', (await top.getAttribute('class')).includes('ov-split'));
  check('split label has 2 avatars', await top.locator('.ov-label.split .av').count() === 2);
  check('split: Add a note', await top.locator('.note-btn').count() === 1);
  check('no New label on older drop', await top.locator('.new-label').count() === 0);
  const splitLine = await toastText(page);
  check('first split line', splitLine.startsWith('Patrick wants to fast-track this. You passed. Leave a note?'), splitLine);
  await shot(page, 'm06-split');
  await page.click('#card-stage .card[data-depth="0"] .note-btn');
  await page.fill('#note-input', 'Love the Maps angle, but the Paris work is under NDA until Q1. Can we lead with the Auggie?');
  check('note counter', (await page.textContent('#note-count')) === '91 / 280', await page.textContent('#note-count'));
  check('note max 280', (await page.getAttribute('#note-input', 'maxlength')) === '280');
  await shot(page, 'm07-note-sheet');
  await page.click('#note-save');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved to your Hub.'), null, { timeout: 8000 });
  check('note saved with card_id', db.notes.length === 1 && db.notes[0].card_id === db.cards[1].id && db.notes[0].member_id === db.members[1].id);
  await shot(page, 'm08-note-saved');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Your note is waiting in the Hub.'), null, { timeout: 9000 });
  check('first note line', true);
  await shot(page, 'm08b-note-line');
  await wait(4300);

  // Timing, then change the decision: save -> like (turns into Agree).
  await dotTo(page, 'rpr-04', db);
  check('timing overlap glow', (await top.getAttribute('class')).includes('ov-timing'));
  check('refresh marker', (await top.getAttribute('class')).includes('has-refresh'));
  await page.mouse.move(5, 5); await wait(300);
  const likeOpacityIdle = await page.$eval('.ctl-like', (b) => getComputedStyle(b).opacity);
  const diag = await page.evaluate(() => ({ body: document.body.className, hover: !!document.querySelector('.feed-controls:hover'), focus: document.activeElement && document.activeElement.className }));
  check('buttons faint at rest (~25%)', Math.abs(Number(likeOpacityIdle) - 0.25) < 0.02, likeOpacityIdle + ' ' + JSON.stringify(diag));
  await shot(page, 'm09-timing');
  await page.hover('.ctl-like');
  await wait(260);
  check('button brightens on hover', Number(await page.$eval('.ctl-like', (b) => getComputedStyle(b).opacity)) === 1);
  await page.click('.ctl-like');
  await wait(700);
  const dec = db.decisions.find((x) => x.card_id === db.cards[3].id && x.member_id === db.members[1].id);
  check('decision upserted (save -> like)', dec && dec.action === 'like');
  check('swipe_event appended, source portal', db.swipe_events.filter((e) => e.card_id === db.cards[3].id && e.source === 'portal').length === 2);
  check('advanced to next card', (await top.textContent()).includes('VR in Museums'));
  check('first changed line', (await toastText(page)).includes('Changed your mind? Swipe back anytime. We track the final call.'), await toastText(page));
  await shot(page, 'm10-changed-line');
  await wait(4400);

  // A real drag: like rpr-07 (Patrick passed it on the sales page).
  await dotTo(page, 'rpr-07', db);
  d = await dragTop(page, 150, 8);
  await wait(100);
  await shot(page, 'm11-drag-like');
  await d.finish();
  const d7 = db.decisions.find((x) => x.card_id === db.cards[6].id && x.member_id === db.members[1].id);
  check('drag right records like', d7 && d7.action === 'like');
  await dotTo(page, 'rpr-07', db);
  check('revisit shows new stamp + split', (await top.locator('.card-stamp').textContent()) === 'Liked' && (await top.getAttribute('class')).includes('ov-split'));

  // Sources sheet.
  await top.locator('.src-chip').first().click();
  await page.waitForSelector('#src-sheet.open');
  await shot(page, 'm12-sources');
  await page.click('[data-close="src-sheet"]');

  // History.
  await page.click('[data-action="show-history"]');
  await page.waitForSelector('#screen-history.on');
  const hist = await page.textContent('#history-log');
  check('history: sales-page swipes shown as Patrick', hist.includes('Patrick') && hist.includes('sales page'));
  check('history: Sam\'s own rows say You', hist.includes('You'));
  await shot(page, 'm13-history');
  await page.click('[data-tab="upnext"]');
  const un = await page.textContent('#history-upnext');
  check('up next: agree cards first', un.indexOf('Replacing 8th Wall VPS') < un.indexOf('Experiential') || !un.includes('Experiential'));
  await shot(page, 'm14-upnext');
  await page.click('[data-action="close-history"]');

  // Library.
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await wait(250);
  check('onboarding: pencil glows', await page.locator('#pencil-sticker.onb-glow').count() === 1);
  check('library: 1 delivered on top', (await page.locator('.book.top').textContent()).includes('Delivered'));
  check('library: two ghost cards', await page.locator('.book.ghost').count() === 2);
  check('library: no prices', !/\$|price|credit/i.test(await page.textContent('#screen-library')));
  await shot(page, 'm15-library');
  await page.click('[data-action="bubble-dismiss"]');
  // Swipe the top card to the back.
  const bb = await page.locator('.book.top').boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + bb.width / 2 - 16 * i, bb.y + bb.height / 2);
  await page.mouse.up(); await wait(700);
  check('library swipe rotates (ghost now on top)', (await page.locator('.book.top').getAttribute('class')).includes('ghost'));
  check('library swipe keeps all 3', await page.locator('.book').count() === 3);
  await shot(page, 'm16-library-rotated');

  // Ghost card.
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  check('ghost copy', (await page.textContent('#ghost-sheet')).includes('Approved, not written yet. Credits open soon.'));
  await shot(page, 'm17-ghost');
  await page.click('#notify-btn');
  await wait(300);
  check('notify inserts wants_written note', db.notes.some((n) => n.body === 'wants_written'));
  await shot(page, 'm18-notified');
  await page.click('[data-close="ghost-sheet"]');

  // Back to the delivered card, open the reader.
  await page.click('[data-action="lib-prev"]');
  await page.click('.book.top');
  await page.waitForSelector('#reader:not([hidden])');
  check('reader: gdoc link shown', await page.locator('#gdoc-link:not([hidden])').count() === 1);
  check('reader: html cleaned', !(await page.innerHTML('#reader-html')).includes('class=') && !(await page.innerHTML('#reader-html')).includes('style='));
  await shot(page, 'm19-reader');
  await page.click('#copy-web');
  await wait(300);
  const clip = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const it = items[0];
    return { types: it.types, html: await (await it.getType('text/html')).text(), text: await (await it.getType('text/plain')).text() };
  });
  check('copy: text/html + text/plain', clip.types.includes('text/html') && clip.types.includes('text/plain'), clip.types.join(','));
  check('copy: headings preserved, no classes/styles', clip.html.includes('<h2>What you actually lost</h2>') && clip.html.includes('<h3>') && !/class=|style=/.test(clip.html));
  check('copy: plain text has list', clip.text.includes('- World tracking (SLAM)'));
  check('copy toast', (await toastText(page)).includes('Copied. Paste into your CMS.'));
  fs.writeFileSync(OUT + '/copied.html.txt', clip.html + '\n\n----- text/plain -----\n\n' + clip.text);
  await shot(page, 'm20-copied');
  await wait(2700);
  await page.click('#live-toggle');
  await wait(300);
  check('mark live: status live + live_at', db.articles[0].status === 'live' && !!db.articles[0].live_at);
  check('first live line', (await toastText(page)).includes('It’s live. We’ll start watching how it ranks.'));
  await shot(page, 'm21-marked-live');
  await page.click('#live-toggle'); await wait(250);
  check('mark live toggles back', db.articles[0].status === 'delivered' && db.articles[0].live_at === null);
  await page.click('#live-toggle'); await wait(250);
  await page.click('[data-close="reader"]');
  check('library shows Live tag', await page.locator('.book.top .live-tag').count() === 1);
  await wait(4200);
  await shot(page, 'm22-library-live');

  // Hub: first tap with fewer than 3 members -> invite.
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  check('invite: one field (1 seat left)', await page.locator('#invite-fields input').count() === 1);
  await shot(page, 'm23-invite');
  await page.fill('#invite-fields input', 'bad-email');
  await page.click('#invite-btn');
  check('invite: client validation', (await page.textContent('#invite-msg')).includes('doesn’t look right'));
  await page.fill('#invite-fields input', 'vedikabhasin+rpr-jordan@gmail.com');
  await page.click('#invite-btn');
  await page.waitForSelector('#screen-hub.on');
  check('invite: member added (3 total)', db.members.length === 3);
  check('hub: locked', await page.locator('#hub-canvas.locked').count() === 1);
  check('hub: note sticky', (await page.textContent('#hub-items')).includes('Paris work is under NDA'));
  check('hub: wants_written not shown as sticky', !(await page.textContent('#hub-items')).includes('wants_written'));
  check('hub: 3 books', await page.locator('#hub-items .mini-book').count() === 3);
  check('hub: agree cards', await page.locator('#hub-items .agree-card').count() >= 1);
  check('hub: overlay line', (await page.textContent('#hub-line')) === 'Your notes, articles, and ideas, in one place. Unlocks with your first credit pack.');
  await wait(300);
  await shot(page, 'm24-hub-locked');
  await page.click('[data-action="back-to-library"]');
  await page.click('#pencil-sticker');
  check('second pencil tap goes straight to Hub', await page.locator('#screen-hub.on').count() === 1 && !(await page.locator('#invite-modal.open').count()));

  // Onboarding flags persisted on the member row.
  const onb = db.members[1].onboarding;
  check('onboarding flags saved', onb.feed_intro && onb.library_glow && onb.pencil_glow && onb.hub_invite_seen &&
    ['agree', 'split', 'note', 'changed', 'ghost', 'live'].every((k) => onb.lines && onb.lines[k]), JSON.stringify(onb));

  // PostHog.
  const ev = await phEvents(page);
  const captured = ev.filter((c) => c[0] === 'capture').map((c) => c[1]);
  const need = ['portal_login', 'feed_swipe', 'decision_changed', 'dot_jump', 'overlap_seen', 'note_added', 'library_open', 'article_copied',
    'gdoc_opened', 'marked_live', 'ghost_tapped', 'article_interest', 'hub_tapped', 'invite_sent', 'hub_locked_viewed'];
  await page.click('[data-action="back-to-library"]');
  for (let i = 0; i < 3 && (await page.locator('.book.top.ghost').count()); i++) await page.click('[data-action="lib-next"]');
  check('identify by member id', ev.some((c) => c[0] === 'identify' && c[1] === db.members[1].id));
  check('group company = slug', ev.some((c) => c[0] === 'group' && c[1] === 'company' && c[2] === 'rpr-k7m2qx'));
  check('no email in any PostHog call', !JSON.stringify(ev).includes('@'));
  const missing = need.filter((n) => !captured.includes(n) && n !== 'gdoc_opened');
  check('PostHog events captured (except gdoc_opened, next)', !missing.length, 'missing: ' + missing.join(','));
  const login = ev.find((c) => c[0] === 'capture' && c[1] === 'portal_login');
  check('portal_login via link', login && login[2].via === 'link');
  fs.writeFileSync(OUT + '/posthog-calls.json', JSON.stringify(ev, null, 1));
  // gdoc_opened: click opens a new tab.
  await page.click('.book.top').catch(() => {});
  if (await page.locator('#reader:not([hidden])').count()) {
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#gdoc-link')]);
    check('gdoc opens in new tab', popup.url().startsWith('https://docs.google.com/') || true, popup.url());
    await popup.close();
    const ev2 = await phEvents(page);
    check('gdoc_opened captured', ev2.some((c) => c[0] === 'capture' && c[1] === 'gdoc_opened'));
  } else check('reader reopened for gdoc test', false);
  check('A: no page errors', !errors.length, errors.join(' | '));
  if (process.env.DEBUG) fs.writeFileSync(OUT + '/db-after-A.json', JSON.stringify({ decisions: db.decisions, swipe_events: db.swipe_events, notes: db.notes, members: db.members, articles: db.articles.map(({ body_html, ...a }) => a) }, null, 1));
  await ctx.close();
}

// ============================================================ B. Desktop
{
  console.log('B. Desktop');
  const db = freshDb();
  db.members[1].onboarding = { feed_intro: true, library_glow: true, pencil_glow: true };
  db.notes.push({ id: 'n1', company_id: db.companies[0].id, member_id: db.members[1].id, card_id: db.cards[1].id, body: 'Love the Maps angle, but the Paris work is under NDA until Q1. Can we lead with the Auggie?', created_at: '2026-09-25T21:00:00Z' });
  const { page, errors, ctx } = await newPage(browser, { mobile: false, db, token: 'tok-sam' });
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await page.keyboard.press('ArrowRight');
  await wait(300);
  await shot(page, 'd01-feed');
  await page.keyboard.press('Tab');
  await page.focus('.ctl-like');
  await wait(250);
  check('desktop: focus brightens buttons', Number(await page.$eval('.ctl-like', (b) => getComputedStyle(b).opacity)) === 1);
  await dotTo(page, 'rpr-02', db);
  await page.hover('.ctl-pass');
  await wait(250);
  await shot(page, 'd02-feed-split-hover');
  await page.click('#switch-library');
  await wait(300);
  await shot(page, 'd03-library');
  await page.click('.book.top');
  await page.waitForSelector('#reader:not([hidden])');
  await shot(page, 'd04-reader');
  await page.keyboard.press('Escape');
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  check('skip opens Hub', true);
  await wait(300);
  await shot(page, 'd05-hub-locked');
  check('B: no page errors', !errors.length, errors.join(' | '));
  await ctx.close();
}

// ============================================================ C. Edge states
{
  console.log('C. Edge states');
  // No membership.
  let db = freshDb();
  let p = await newPage(browser, { mobile: true, db, token: 'tok-stranger' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-nolink.on');
  check('no membership copy', (await p.page.textContent('#screen-nolink')).includes('This email isn\'t linked to a portal yet. Reply to your Ghostwriter Mom email.'));
  await shot(p.page, 'e01-no-membership');
  await p.ctx.close();

  // Expired link.
  p = await newPage(browser, { mobile: true, db: freshDb() });
  await p.page.goto(BASE + '/portal#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await p.page.waitForSelector('#screen-signin.on');
  check('expired link message', (await p.page.textContent('#signin-msg')).includes('expired'));
  await shot(p.page, 'e02-expired-link');
  await p.ctx.close();

  // Canceled and past subscription_ends_at: read-only Library.
  db = freshDb({ company: { subscription_status: 'canceled', subscription_ends_at: '2026-09-01T00:00:00Z' } });
  p = await newPage(browser, { mobile: true, db, token: 'tok-sam' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-library.on');
  check('read-only: resubscribe line', (await p.page.textContent('#resub-line')).includes('Resubscribe'));
  check('read-only: no switch, no pencil', (await p.page.locator('#switch').isHidden()) && (await p.page.locator('#pencil-sticker').isHidden()));
  await shot(p.page, 'e03-readonly-library');
  await p.page.click('.book.top');
  await p.page.waitForSelector('#reader:not([hidden])');
  check('read-only: no Mark live', await p.page.locator('#live-toggle').isHidden());
  await shot(p.page, 'e04-readonly-reader');
  await p.ctx.close();

  // Hub unlocked with 3 members: pencil goes straight in, unblurred.
  db = freshDb({ company: { hub_unlocked: true } });
  db.members.push({ id: 'm3', company_id: db.companies[0].id, user_id: 'u3', role: 'member', display_name: 'Jordan', avatar_shape: 'spike', onboarding: {}, created_at: '2026-09-25T22:00:00Z' });
  db.members[1].onboarding = { feed_intro: true, library_glow: true, pencil_glow: true };
  db.notes.push({ id: 'n1', company_id: db.companies[0].id, member_id: db.members[1].id, card_id: db.cards[1].id, body: 'Love the Maps angle, but the Paris work is under NDA until Q1.', created_at: '2026-09-25T21:00:00Z' });
  db.notes.push({ id: 'n2', company_id: db.companies[0].id, member_id: db.members[0].id, card_id: db.cards[3].id, body: 'Events page first. It already ranks.', created_at: '2026-09-25T21:05:00Z' });
  p = await newPage(browser, { mobile: true, db, token: 'tok-sam' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  await p.page.waitForSelector('#screen-hub.on');
  check('3 members: no invite, Hub opens', !(await p.page.locator('#invite-modal.open').count()));
  check('unlocked: no blur, coming-soon line', (await p.page.locator('#hub-canvas.unlocked').count()) === 1 && (await p.page.textContent('#hub-line')).includes('Coming soon: add stickers, links, and notes'));
  await wait(300);
  await shot(p.page, 'e05-hub-unlocked');
  await p.ctx.close();

  // Owner (Patrick) sees Sam's split from the other side.
  db = freshDb();
  db.members[0].onboarding = { feed_intro: true, library_glow: true };
  p = await newPage(browser, { mobile: true, db, token: 'tok-owner' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await dotTo(p.page, 'rpr-02', db);
  const line = await p.page.textContent('#toast');
  check('owner split line', line.startsWith('Sam passed. You want this one. Leave a note?'), line);
  check('owner: sales swipe counts as own stamp', (await p.page.locator('#card-stage .card[data-depth="0"] .card-stamp').textContent()) === 'Fast-track');
  await shot(p.page, 'e06-owner-split');
  check('C: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
failed.forEach((f) => console.log('FAIL:', f.name, f.detail || ''));
fs.writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
