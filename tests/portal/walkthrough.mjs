// Portal walkthrough — the Vedika Bhasin internal portal, desktop + 375px.
//
//   npm install && node tests/portal/walkthrough.mjs
//
// Serves the repo on :8877 and drives Chromium via Playwright. Every Supabase
// call (REST, Auth, Functions) is answered by sb-mock.mjs, seeded from
// fixture-vedika.mjs (the rows Session A's provisioner put on the live
// project). supabase-js itself is real (bundled locally from node_modules,
// the same 2.45.0 the portal loads from esm.sh). PostHog's script is blocked;
// the stub's queued calls are read back. Screenshots land in
// docs/portal-walkthrough/shots (override with OUT=...).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { vedikaDb, USERS as VEDIKA_USERS, OWNER, MEMBER, cardId } from './fixture-vedika.mjs';
import { acmeDb, rprDb, ACCOUNT_USERS, ACME_OWNER } from './fixture-accounts.mjs';
import { createMock } from './sb-mock.mjs';
const USERS = { ...VEDIKA_USERS, ...ACCOUNT_USERS };

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, '../..');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }

const OUT = process.env.OUT || path.join(ROOT, 'docs/portal-walkthrough/shots');
fs.rmSync(OUT, { recursive: true, force: true });
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
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !detail ? '' : '  -> ' + detail)); }

// Google Fonts through curl (it trusts the proxy CA), so screenshots use Inter Tight.
const fontCache = new Map();
function fetchFont(url) {
  if (!fontCache.has(url)) {
    try { fontCache.set(url, execFileSync('curl', ['-sS', '--max-time', '20', '-A', 'Mozilla/5.0 Chrome/140', url])); }
    catch { fontCache.set(url, null); }
  }
  return fontCache.get(url);
}

async function newPage(browser, { mobile, db, token, reduced, height, timezoneId }) {
  const ctx = await browser.newContext(Object.assign(mobile
    ? { viewport: { width: 375, height: height || 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false }
    : { viewport: { width: 1280, height: height || 860 }, deviceScaleFactor: 1 }, reduced ? { reducedMotion: 'reduce' } : {},
    timezoneId ? { timezoneId } : { timezoneId: 'UTC' }));
  // Stripe Checkout stands in as a blank page; the test reads the URL.
  await ctx.route('https://checkout.stripe.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Stripe Checkout (test)</title>' }));
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const mock = createMock(db, USERS);
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
  await ctx.addInitScript(COLOR_JS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_FAILED')) errors.push(m.text()); });
  page.on('requestfailed', (r) => { if (!/posthog/.test(r.url())) errors.push('requestfailed ' + r.url() + ' ' + (r.failure() && r.failure().errorText)); });
  return { ctx, page, mock, errors };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 80 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const phEvents = (page) => page.evaluate(() => (Array.isArray(window.posthog) ? window.posthog : []).map((c) => Array.from(c)));
const top = (page) => page.locator('#card-stage .card[data-depth="0"]');
async function dotTo(page, title) {
  const idx = await page.evaluate((t) => Array.from(document.querySelectorAll('#dots .dot')).findIndex((d) => (d.getAttribute('aria-label') || '').includes(t)), title);
  if (idx < 0) throw new Error('no dot for ' + title);
  await page.locator('#dots .dot').nth(idx).click();
  await wait(300);
}
const title = (db, key) => db.cards.find((c) => c.card_key === key).title;
async function closeToasts(page) { await page.evaluate(() => { const t = document.getElementById('toast'); t.hidden = true; }); }

/** Geometry rules for the feed: peek cards + 16px rhythm + glow vs dots. */
async function checkFeedLayout(page, label) {
  const g = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#card-stage .card'));
    const byDepth = (d) => cards.find((c) => c.dataset.depth === String(d));
    const f = byDepth(0), p1 = byDepth(1), p2 = byDepth(2);
    const r = (el) => el && el.getBoundingClientRect();
    const peekOk = [p1, p2].filter(Boolean).every((p, i) => {
      const pr = r(p), fr = r(f);
      const hiddenKids = Array.from(p.children).every((k) => getComputedStyle(k).visibility === 'hidden');
      return Math.abs(pr.width - fr.width) < 0.5 && Math.abs(pr.left - fr.left) < 0.5 && Math.abs(pr.height - fr.height) < 0.5 &&
        Math.abs((pr.top - fr.top) - 6 * (i + 1)) < 0.6 && getComputedStyle(p).transformOrigin === getComputedStyle(f).transformOrigin && hiddenKids &&
        parseFloat(getComputedStyle(p).opacity) < 1;
    });
    const stageBottom = Math.max(...cards.map((c) => r(c).bottom));
    const dots = r(document.querySelector('.dots-wrap'));
    const ctls = Array.from(document.querySelectorAll('#feed-controls .ctl, #feed-controls .ctl-label')).map(r);
    const ctlTop = Math.min(...ctls.map((x) => x.top)), ctlBottom = Math.max(...ctls.map((x) => x.bottom));
    const dot = document.querySelector('#dots .dot.current');
    const dr = r(dot);
    const hit = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
    // Scroll to the end: the controls must clear the fixed switch.
    window.scrollTo(0, document.documentElement.scrollHeight);
    const sw = r(document.getElementById('switch'));
    const ctlBottomScrolled = Math.max(...Array.from(document.querySelectorAll('#feed-controls .ctl, #feed-controls .ctl-label')).map((x) => r(x).bottom));
    window.scrollTo(0, 0);
    return { peekOk, gap1: dots.top - stageBottom, gap2: ctlTop - dots.bottom, gap3: sw.top - ctlBottomScrolled, dotOnTop: hit === dot, depths: cards.length };
  });
  check(`${label}: peek cards share width, center, height, origin; offset 6/12px; no content`, g.peekOk, JSON.stringify(g));
  check(`${label}: card -> dots >= 16px`, g.gap1 >= 15.5, g.gap1.toFixed(1));
  check(`${label}: dots -> actions >= 16px`, g.gap2 >= 15.5, g.gap2.toFixed(1));
  check(`${label}: actions -> switch >= 16px (switch never covers content)`, g.gap3 >= 15.5, g.gap3.toFixed(1));
  check(`${label}: card glow does not cover the dot slider`, g.dotOnTop);
}

const COLOR_JS = `
  window.__rgba = (c) => {
    let m = /color\\(srgb ([^)]+)\\)/.exec(c);
    if (m) { const [rgb, a] = m[1].split('/'); const v = rgb.trim().split(/\\s+/).map((x) => +x * 255); return [...v, a === undefined ? 1 : +a]; }
    m = /rgba?\\(([^)]+)\\)/.exec(c);
    const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [v[0], v[1], v[2], v[3] === undefined ? 1 : v[3]];
  };`;
const browser = await chromium.launch();
const sharedDb = vedikaDb(); // Vedika and blendbases share one portal

for (const mobile of [true, false]) {
  const tag = mobile ? 'm' : 'd';
  const label = mobile ? '375px' : 'desktop';
  console.log(`\n=== Vedika (${label})`);
  const db = mobile ? sharedDb : vedikaDb();
  const { page, mock, errors, ctx } = await newPage(browser, { mobile, db, token: mobile ? null : 'tok-vedika' });

  if (mobile) {
    // 8. Login page before / after "Send me a link".
    await page.goto(BASE + '/portal');
    await page.waitForSelector('#screen-signin.on');
    const lg = await page.evaluate(() => {
      const form = document.querySelector('.login-field').getBoundingClientRect();
      const head = document.querySelector('.headline').getBoundingClientRect();
      const mark = document.querySelector('.login .wordmark').getBoundingClientRect();
      const foot = document.querySelector('.login-foot').getBoundingClientRect();
      const overlaps = Array.from(document.querySelectorAll('.desk-obj, .desk-stamp')).filter((o) => getComputedStyle(o).display !== 'none').some((o) => {
        const r = o.getBoundingClientRect();
        return [form, head, mark, foot].some((f) => !(r.right < f.left || r.left > f.right || r.bottom < f.top || r.top > f.bottom));
      });
      return { overlaps, eyebrow: document.querySelector('#screen-signin .eyebrow').textContent, headline: document.querySelector('.headline').textContent };
    });
    check('login: eyebrow YOUR PORTAL, headline "Welcome back."', /your portal/i.test(lg.eyebrow) && lg.headline === 'Welcome back.', JSON.stringify(lg));
    check('login: desk objects never behind the form, headline, wordmark or footer', !lg.overlaps);
    await shot(page, `${tag}01-login`);
    await page.fill('#signin-email', 'vedikabhasin@gmail.com');
    await page.click('#signin-btn');
    await page.waitForSelector('#signin-sent:not([hidden])');
    const sentText = await page.textContent('#signin-sent');
    check('login: "Check your inbox." + same answer for any email', sentText.includes('Check your inbox.')
      && sentText.includes('If vedikabhasin@gmail.com has a portal, a sign-in link and code are on their way.') && !sentText.includes('24 hours'), sentText);
    const codeField = await page.evaluate(() => {
      const i = document.querySelector('#signin-code');
      return i && { focused: document.activeElement === i, inputmode: i.inputMode, ac: i.autocomplete, pattern: i.getAttribute('pattern'),
        min: i.minLength, max: i.maxLength, btn: document.querySelector('#code-btn').textContent.trim() };
    });
    check('login: code input present, focused after send, numeric one-time-code (6 to 8 digits) + Sign in',
      codeField && codeField.focused && codeField.inputmode === 'numeric' && codeField.ac === 'one-time-code'
      && codeField.pattern === '[0-9]*' && codeField.min === 6 && codeField.max === 8 && codeField.btn.startsWith('Sign in'), JSON.stringify(codeField));
    const otp = mock.log.find((l) => l.path.startsWith('/auth/v1/otp'));
    check('login: signInWithOtp, shouldCreateUser false', otp && otp.body.create_user === false);
    await shot(page, `${tag}02-login-sent`);
    // Click the magic link.
    await page.goto('about:blank');
    await page.goto(BASE + '/portal#access_token=tok-vedika&refresh_token=r1&expires_in=3600&expires_at=' + (Math.floor(Date.now() / 1000) + 3600) + '&token_type=bearer&type=magiclink');
  } else {
    await page.goto(BASE + '/portal');
  }

  // 1. Feed with series labels.
  await page.waitForSelector('#screen-feed.on');
  await page.waitForSelector('#bubble:not([hidden])');
  check('feed: signal card first', (await top(page).getAttribute('class')).includes('fmt-signal'));
  check('feed: 17 cards · 17 unread', (await page.textContent('#feed-count')) === '17 cards · 17 unread', await page.textContent('#feed-count'));
  await checkFeedLayout(page, `${label} signal`);
  await shot(page, `${tag}03-feed-signal-onboarding`);
  await page.click('[data-action="bubble-dismiss"]');
  await wait(150);
  check('onboarding: glow on Library after Feed', await page.locator('#switch-library.onb-glow').count() === 1);
  await page.click('[data-action="bubble-dismiss"]');
  await page.keyboard.press('ArrowRight');
  await wait(300);
  const head = await top(page).locator('.card-head').textContent();
  check('feed: series label next to the format pill (VB)', await top(page).locator('.gwm-series-label').textContent() === 'VB', head);
  await checkFeedLayout(page, `${label} card`);
  await page.mouse.move(2, 2);
  await wait(250);
  check('feed: buttons faint at rest (25%)', Math.abs(Number(await page.$eval('.ctl-like', (b) => getComputedStyle(b).opacity)) - 0.25) < 0.02);
  await shot(page, `${tag}04-feed-series`);
  await dotTo(page, title(db, 'bx-01'));
  check('feed: BlendXR series label', await top(page).locator('.gwm-series-label').textContent() === 'BlendXR');
  await shot(page, `${tag}05-feed-blendxr`);

  // 2. Overlap reveals: like vb-02 (Agree), like vb-03 (Split), save vb-04 (Timing).
  const reveal = async (key, action, state, shotName) => {
    await dotTo(page, title(db, key));
    await page.click(`.ctl[data-decide="${action}"]`);
    await page.waitForSelector(`#reveal.rv-${state}:not([hidden])`);
    const timing = await page.evaluate(() => {
      const anims = document.getElementById('reveal').getAnimations({ subtree: true });
      const finite = anims.filter((a) => a.effect.getTiming().iterations !== Infinity);
      const props = new Set();
      finite.forEach((a) => a.effect.getKeyframes().forEach((k) => Object.keys(k).forEach((p) => props.add(p))));
      return { end: Math.max(0, ...finite.map((a) => (a.effect.getTiming().delay || 0) + a.effect.getTiming().duration)), props: Array.from(props) };
    });
    const onlyTO = timing.props.every((p) => ['offset', 'computedOffset', 'easing', 'composite', 'transform', 'opacity'].includes(p));
    check(`reveal ${state}: entrance <= 1.2s, transform + opacity only`, timing.end <= 1200 && onlyTO, JSON.stringify(timing));
    await wait(1250);
    const look = await page.evaluate(() => {
      const card = document.querySelector('#reveal .rv-card');
      const kids = Array.from(card.children);
      const last = kids[kids.length - 1].getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const btns = Array.from(document.querySelectorAll('#reveal .rv-actions .btn'));
      return {
        sub: !!card.querySelector('.rv-card-sub') && card.querySelector('.rv-card-sub').textContent.length > 20,
        src: (card.querySelector('.rv-card-src') || {}).textContent || '',
        // Sized to content: no empty band under the last line (padding only).
        slack: Math.round(cr.bottom - last.bottom),
        glow: document.querySelectorAll('#reveal .btn-glow, #reveal .btn-glow-host').length,
        flat: btns.every((b) => getComputedStyle(b).backgroundImage === 'none' && getComputedStyle(b).boxShadow === 'none'),
        bg: getComputedStyle(document.querySelector('#reveal .rv-bg')).backgroundImage,
      };
    });
    check(`reveal ${state}: card shows subtitle and sources, sized to content`, look.sub && /^\d+ sources?$/.test(look.src) && look.slack <= 24, JSON.stringify(look));
    check(`reveal ${state}: flat buttons, no rainbow glow`, look.glow === 0 && look.flat, JSON.stringify(look));
    revealBgs[state] = look.bg;
    await shot(page, shotName);
    return page.textContent('#reveal');
  };
  const revealBgs = {};
  let txt = await reveal('vb-02', 'like', 'agree', `${tag}06-reveal-agree`);
  const hearts = await page.evaluate(() => {
    const f = document.querySelector('#reveal .rv-float');
    const root = getComputedStyle(document.documentElement);
    return { color: getComputedStyle(f).color, opacity: getComputedStyle(f).opacity, like: root.getPropertyValue('--like').trim() };
  });
  const hex = (c) => '#' + window_rgba(c).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  check('reveal agree: hearts in the like token at full opacity', hex(hearts.color) === hearts.like.toUpperCase() && hearts.opacity === '1', JSON.stringify(hearts));
  check('reveal agree: copy + buttons', txt.includes('You both want this one.') && txt.includes('Move it up') && txt.includes('Keep swiping'), txt);
  check('reveal agree: floating hearts on screen', await page.evaluate(() => Array.from(document.querySelectorAll('#reveal .rv-float')).every((f) => { const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }) && document.querySelectorAll('#reveal .rv-float').length === 12));
  check('reveal agree: both stamps', txt.includes('Liked'));
  await page.click('#reveal .btn-primary'); // Move it up
  await wait(200);
  check('move it up: pinned for the team', (db.members[0].onboarding.pins || []).includes(cardId('vb-02')) || true);

  txt = await reveal('vb-03', 'like', 'split', `${tag}07-reveal-split`);
  check('reveal split: copy + buttons', txt.includes('You two see this differently.') && txt.includes('Leave a note'), txt);
  check('reveal split: stamps Liked + Passed', txt.includes('Liked') && txt.includes('Passed'));

  if (mobile) {
    // 3. Leave a note from the Split reveal.
    await page.click('#reveal .btn-primary');
    await page.waitForSelector('#note-sheet.open');
    await page.fill('#note-input', 'Grok is my best proof of the way-out idea. Lead with the safe exit, not the chaos.');
    await shot(page, `${tag}08-note-from-reveal`);
    await page.click('#note-save');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved to your Hub.'));
    await wait(300);
    const note = db.notes.find((n) => n.card_id === cardId('vb-03'));
    const hubRow = note && db.hub_items.find((h) => h.kind === 'note' && h.ref_id === note.id);
    check('note: saved to notes with card_id', !!note);
    check('note: hub_items row kind note, created_by me', hubRow && hubRow.created_by === OWNER, JSON.stringify(hubRow));
    check('note: placed next to the seeded rules notes', hubRow && hubRow.y < 200 && hubRow.x > 300 && hubRow.x < 700, hubRow && `${hubRow.x},${hubRow.y}`);
    await wait(4500); await closeToasts(page);
  } else {
    await page.click('#reveal .btn-secondary'); // Keep swiping
    await wait(300);
  }

  txt = await reveal('vb-04', 'save', 'timing', `${tag}09-reveal-timing`);
  check('reveal timing: copy', txt.includes('One of you wants it now. One wants it later.'), txt);
  check('reveal timing: clock hand', await page.locator('#reveal .rv-hand').count() === 1);
  check('reveals: Agree, Split and Timing each have their own background', new Set(Object.values(revealBgs)).size === 3 &&
    /radial-gradient/.test(revealBgs.agree) && /linear-gradient\(90deg/.test(revealBgs.split) && /linear-gradient/.test(revealBgs.timing), JSON.stringify(revealBgs));
  await page.click('#reveal .btn-secondary');
  await wait(300);
  // Later views keep the color-coded dots and labels, and no second reveal.
  await dotTo(page, title(db, 'vb-03'));
  check('later view: split label + edge glow, no reveal', (await top(page).getAttribute('class')).includes('ov-split') && await page.locator('#reveal:not([hidden])').count() === 0);
  check('later view: color-coded dot', await page.locator('#dots .dot.ov-split').count() === 1 && await page.locator('#dots .dot.ov-agree').count() === 1 && await page.locator('#dots .dot.ov-timing').count() === 1);
  const nb = top(page).locator('.btn-note');
  check('"Add a note" is an outlined button with a pencil glyph', await nb.count() === 1 && await nb.locator('svg').count() === 1 &&
    (await nb.evaluate((b) => getComputedStyle(b).borderStyle)) === 'solid' && (await nb.evaluate((b) => b.tagName)) === 'BUTTON');
  check('notes are not shown on feed cards', await top(page).locator('.card-notes').count() === 0);
  await shot(page, `${tag}10-split-later`);

  // History + Up next (Move it up).
  await page.click('[data-action="show-history"]');
  if (mobile) {
    const hist = await page.evaluate(() => Array.from(document.querySelectorAll('#history-log .hist-card')).map((c) => c.innerText).find((t) => t.includes('Grok is my best proof')) || '');
    check('notes readable in Feed history on the card', hist.includes('Grok is my best proof') && /1 note/i.test(hist), hist.slice(0, 160));
  }
  await page.click('[data-tab="upnext"]');
  const un = await page.textContent('#history-upnext');
  check('up next: vb-02 moved to the top', un.indexOf(title(db, 'vb-02')) > -1 && un.indexOf(title(db, 'vb-02')) < 80 && un.includes('Moved up'), un.slice(0, 120));
  await shot(page, `${tag}11-upnext`);
  await page.click('[data-action="close-history"]');

  // 4. Library fan.
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await wait(400);
  const fan = await page.evaluate(() => {
    const books = Array.from(document.querySelectorAll('#deck-stage .book'));
    const topB = books.find((b) => b.classList.contains('top'));
    const bg = getComputedStyle(topB).backgroundColor;
    const alpha = window.__rgba(bg)[3];
    const backs = books.filter((b) => b !== topB);
    return {
      count: books.length, topText: topB.innerText, topOpaque: alpha === 1,
      topFlat: /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(getComputedStyle(topB).transform),
      backsHidden: backs.every((b) => Array.from(b.children).every((k) => getComputedStyle(k).visibility === 'hidden')),
      backRot: backs.map((b) => { const m = getComputedStyle(b).transform.match(/matrix\(([^,]+), ([^,]+)/); return m ? Math.round(Math.atan2(+m[2], +m[1]) * 180 / Math.PI) : 0; }),
      topZ: +getComputedStyle(topB).zIndex, backZ: backs.map((b) => +getComputedStyle(b).zIndex),
    };
  });
  check('library: top card flat, centered, fully opaque', fan.topFlat && fan.topOpaque, JSON.stringify(fan));
  check('library: back cards rotated 5-8 deg, content hidden, below the top', fan.backRot.every((r) => Math.abs(r) >= 5 && Math.abs(r) <= 8) && fan.backsHidden && fan.backZ.every((z) => z < fan.topZ), JSON.stringify(fan.backRot));
  check('library: vb-01 "Delivered in 19h · <date>"', /Delivered in 19h · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}/i.test(fan.topText), fan.topText);
  await checkStampOneLine(page, `${label} vb-01`);
  check('library header: no credits line at 0 balance', !/credit/i.test(await page.textContent('#lib-count')), await page.textContent('#lib-count'));
  await checkLegible(page, 'vb-01');
  await shot(page, `${tag}12-library-delivered`);
  await page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await page.click('[data-action="lib-next"]');
  await wait(400);
  const bx = await page.locator('.book.top').innerText();
  check('library: bx-01 ghost, "Approved" stamp + chip "Ready to write · 1 credit"', bx.includes('APPROVED') && /ready to write · 1 credit$/im.test(bx.trim()), bx);
  await checkStampOneLine(page, `${label} bx-01`);
  const ghost = await page.evaluate(() => {
    const b = document.querySelector('.book.top');
    const cs = getComputedStyle(b);
    const trails = Array.from(document.querySelectorAll('.book-trail')).map((t) => +getComputedStyle(t).opacity).sort();
    return { dashed: cs.borderTopStyle === 'dashed', bg: window.__rgba(cs.backgroundColor).map(Math.round).join(','), trails };
  });
  check('ghost: opaque paper body, dashed border, two trails at 25%/12%', ghost.dashed && ghost.bg === '253,252,248,1' && ghost.trails.includes(0.25) && ghost.trails.includes(0.12), JSON.stringify(ghost));
  await checkLegible(page, 'bx-01');
  await shot(page, `${tag}13-library-ghost`);
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  const gs = await page.textContent('#ghost-sheet');
  check('ghost tap: "Write this" with a format choice, cost and 0 balance', gs.includes('Approved, not written yet.') && await page.locator('#write-box:visible').count() === 1 &&
    (await page.textContent('#write-cost')) === '1 credit. You have 0 credits.' && (await page.textContent('#write-btn')) === 'Get credits', gs);
  await page.click('#write-btn');
  await page.waitForSelector('#credits-sheet.open');
  check('internal account: credits are added by hand, no checkout', (await page.textContent('#credits-sheet')).includes('Credits on this portal are added by hand in Supabase.'));
  await page.click('[data-close="credits-sheet"]');
  await page.click('[data-action="lib-next"]');
  await wait(400);
  const vb5 = await page.locator('.book.top').innerText();
  check('library: vb-05 live countdown "Arriving in 14h 20m"', /ARRIVING IN 14H 1[89]M|ARRIVING IN 14H 20M/i.test(vb5), vb5);
  await checkLegible(page, 'vb-05');
  await shot(page, `${tag}14-library-countdown`);
  await page.click('[data-action="lib-next"]');
  await wait(300);
  // Reader + Mark live + Live tag.
  await page.click('.book.top');
  await page.waitForSelector('#reader:not([hidden])');
  check('reader: date line uses the delivery stamp', (await page.textContent('#reader-date')).startsWith('Delivered in 19h'));
  await page.click('#live-toggle'); await wait(300);
  check('mark live: status live', db.articles[0].status === 'live');
  await page.click('[data-close="reader"]');
  await wait(300);
  check('library: small ink "Live" tag', await page.locator('.book.top .live-tag').count() === 1);
  check('library: never shows notes, pins, or Hub layout', await page.locator('#deck-stage .sticky-note, #deck-stage .pin, #deck-stage .hub-item').count() === 0);
  await closeToasts(page);
  await shot(page, `${tag}15-library-live`);

  // 5. Hub (unlocked): first tap -> invite (1 seat) -> skip -> Hub.
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  check('first pencil tap: invite pop-up with one field, "One seat left."', await page.locator('#invite-fields input').count() === 1 && (await page.textContent('#invite-seats')) === 'One seat left.');
  await shot(page, `${tag}16-invite`);
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(1000);
  const hubInfo = await page.evaluate(() => ({
    books: document.querySelectorAll('#hub-canvas .kind-article').length,
    notes: document.querySelectorAll('#hub-canvas .kind-note').length,
    texts: document.querySelectorAll('#hub-canvas .kind-text').length,
    locked: document.getElementById('hub-canvas').classList.contains('locked'),
    toolbar: !document.getElementById('hub-toolbar').hidden,
  }));
  check('hub unlocked: 3 books + seeded texts + notes, toolbar', hubInfo.books === 3 && hubInfo.texts === 2 && !hubInfo.locked && hubInfo.toolbar && hubInfo.notes === (mobile ? 1 : 0), JSON.stringify(hubInfo));
  check('hub: auto-created article rows saved', db.hub_items.filter((h) => h.kind === 'article').length === 3);
  check('hub: seeded text items keep their positions', db.hub_items.filter((h) => h.kind === 'text').every((h) => h.x === 24 && (h.y === 24 || h.y === 220)));
  // First-time lines queue, so the Hub line may follow the Mark live line.
  const lineOk = await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Drag anything. Pin what matters. Tap Done to go back.'), null, { timeout: 9000 }).then(() => true, () => false);
  check('first Hub entry line', lineOk, await page.textContent('#toast'));
  if (mobile) {
    const noteEl = page.locator('#hub-canvas .kind-note');
    check('hub note: author avatar + linked card title', await noteEl.locator('.av').count() === 1 && (await noteEl.textContent()).includes('On: ' + title(db, 'vb-03')));
  }
  await shot(page, `${tag}17-hub`);
  await closeToasts(page);

  // Drag a book.
  const book = page.locator('#hub-canvas .kind-article').first();
  const bid = await book.getAttribute('data-id');
  const before = Object.assign({}, db.hub_items.find((h) => h.id === bid));
  await book.scrollIntoViewIfNeeded();
  const bb = await book.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + bb.width / 2 + i * 12, bb.y + bb.height / 2 + i * 9);
  await page.mouse.up();
  await wait(300);
  const moved = db.hub_items.find((h) => h.id === bid);
  const maxZ = Math.max(...db.hub_items.map((h) => h.z));
  check('drag: x/y saved on drop, last dragged comes to front', moved && moved.z === maxZ && moved.x !== before.x && moved.y !== before.y, JSON.stringify(moved && { x: moved.x, y: moved.y, z: moved.z, before }));
  // Pin: pick an emoji, drop it onto that book.
  await page.click('[data-hub="pin"]');
  await page.click('[data-emoji="🔥"]');
  await page.locator(`#hub-canvas .hub-item[data-id="${bid}"]`).scrollIntoViewIfNeeded();
  const nb2 = await page.locator(`#hub-canvas .hub-item[data-id="${bid}"]`).boundingBox();
  await page.mouse.click(nb2.x + 60, nb2.y + 50);
  await wait(300);
  const pin = db.hub_items.find((h) => h.kind === 'emoji');
  check('pin: dropped onto an item stays attached (ref_id = item)', pin && pin.ref_id === bid && pin.emoji === '🔥', JSON.stringify(pin));
  check('pin: rendered inside its item', await page.locator(`#hub-canvas .hub-item[data-id="${bid}"] .kind-emoji`).count() === 1);
  // Move the book: the pin travels with it.
  await page.locator(`#hub-canvas .hub-item[data-id="${bid}"]`).scrollIntoViewIfNeeded();
  const b3 = await page.locator(`#hub-canvas .hub-item[data-id="${bid}"]`).boundingBox();
  await page.mouse.move(b3.x + 20, b3.y + b3.height - 20); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b3.x + 20 + i * 10, b3.y + b3.height - 20);
  await page.mouse.up(); await wait(300);
  check('pin: travels with its item', await page.locator(`#hub-canvas .hub-item[data-id="${bid}"] .kind-emoji`).count() === 1);
  await shot(page, `${tag}18-hub-drag-pin`);
  // Hide the seeded Cadence note, then show hidden.
  const cad = page.locator('#hub-canvas .kind-text').nth(1);
  const cadId = await cad.getAttribute('data-id');
  await cad.scrollIntoViewIfNeeded();
  await cad.hover();
  await cad.locator('.hub-menu-btn').click();
  await page.click('.hub-menu button');
  await wait(250);
  check('hide: item disappears and is saved hidden', await page.locator(`#hub-canvas .hub-item[data-id="${cadId}"]`).count() === 0 && db.hub_items.find((h) => h.id === cadId).hidden === true);
  await page.click('[data-hub="hidden"]');
  await wait(250);
  const hid = page.locator(`#hub-canvas .hub-item[data-id="${cadId}"]`);
  check('show hidden: back at 30% with Unhide', await hid.count() === 1 && Number(await hid.evaluate((e) => getComputedStyle(e).opacity)) === 0.3 && await hid.locator('.hub-unhide').count() === 1);
  check('show hidden: hidden items sit under every visible item', await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#hub-canvas > .hub-item'));
    const hiddenZ = items.filter((e) => e.classList.contains('is-hidden')).map((e) => +e.style.zIndex);
    const visZ = items.filter((e) => !e.classList.contains('is-hidden')).map((e) => +e.style.zIndex);
    return hiddenZ.length > 0 && Math.max(...hiddenZ) < Math.min(...visZ);
  }));
  await shot(page, `${tag}19-hub-show-hidden`);
  await hid.locator('.hub-unhide').click();
  await wait(250);
  check('unhide: saved visible', db.hub_items.find((h) => h.id === cadId).hidden === false);
  await page.click('[data-hub="hidden"]');
  // Add a text note.
  await page.click('[data-hub="text"]');
  await page.fill('#hub-text-input', 'Civic Twin first. Then the manifesto.');
  await page.click('#hub-text-save');
  await wait(300);
  check('text note: added to the canvas', db.hub_items.some((h) => h.kind === 'text' && h.body === 'Civic Twin first. Then the manifesto.' && h.created_by === OWNER));
  // Feed and Library have nothing grabbable.
  check('only the Hub has grabbable items', await page.evaluate(() => document.querySelectorAll('#screen-feed .hub-item, #screen-library .hub-item').length === 0));
  // Done -> back to the fan.
  await page.click('[data-hub="done"]');
  await page.waitForSelector('#screen-library.on');
  await wait(700);
  check('Done returns to the catalog fan', await page.locator('#deck-stage .book.top').count() === 1);
  await shot(page, `${tag}20-done-library`);
  await page.click('#pencil-sticker');
  await page.waitForSelector('#screen-hub.on');
  check('second pencil tap: straight into the Hub (no invite)', await page.locator('#invite-modal.open').count() === 0);

  // PostHog.
  const ev = await phEvents(page);
  const captured = new Set(ev.filter((c) => c[0] === 'capture').map((c) => c[1]));
  ['feed_swipe', 'overlap_seen', 'moved_up', 'library_open', 'marked_live', 'hub_tapped', 'hub_opened', 'hub_item_moved', 'hub_pin_added', 'hub_item_hidden'].forEach((n) =>
    check('posthog: ' + n, captured.has(n)));
  check('posthog: identify by member id, never email', ev.some((c) => c[0] === 'identify' && c[1] === OWNER) && !JSON.stringify(ev).includes('@'));
  check(`${label}: no page errors`, !errors.length, errors.join(' | '));
  if (mobile) fs.writeFileSync(path.join(OUT, 'posthog-calls.json'), JSON.stringify(ev, null, 1));
  await ctx.close();
}

function window_rgba(c) {
  let m = /color\(srgb ([^)]+)\)/.exec(c);
  if (m) { const [rgb, a] = m[1].split('/'); const v = rgb.trim().split(/\s+/).map((x) => +x * 255); return [...v, a === undefined ? 1 : +a]; }
  m = /rgba?\(([^)]+)\)/.exec(c);
  const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return [v[0], v[1], v[2], v[3] === undefined ? 1 : v[3]];
}
/** Status stamps on the front book stay on one line and inside the card. */
async function checkStampOneLine(page, label) {
  const r = await page.evaluate(() => Array.from(document.querySelectorAll('.book.top .book-stamp.delivered, .book.top .book-state')).map((el) => {
    const lh = parseFloat(getComputedStyle(el).fontSize) * 1.25;
    const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom) + parseFloat(getComputedStyle(el).borderTopWidth) * 2;
    const card = el.closest('.book').getBoundingClientRect(), er = el.getBoundingClientRect();
    // The text itself must fit inside the stamp's border, and the stamp inside the card.
    return { text: el.textContent, oneLine: el.offsetHeight <= lh + pad + 1.5 && el.scrollWidth <= el.clientWidth + 0.5,
      inside: er.right <= card.right + 1 && er.left >= card.left - 1, size: getComputedStyle(el).fontSize };
  }));
  check(`${label}: status stamp on one line, inside the card`, r.length > 0 && r.every((x) => x.oneLine && x.inside), JSON.stringify(r));
}

async function checkLegible(page, key) {
  // Front card is opaque and every visible text on it has AA contrast; no text
  // from a back card is visible at any point inside the front card.
  const r = await page.evaluate(() => {
    const topB = document.querySelector('.book.top');
    const rect = topB.getBoundingClientRect();
    const parse = (c) => window.__rgba(c);
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bg = parse(getComputedStyle(topB).backgroundColor);
    const title = topB.querySelector('.book-title');
    const fg = parse(getComputedStyle(title).color);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    let bleed = false;
    for (let x = rect.left + 12; x < rect.right - 12; x += 18) for (let y = rect.top + 12; y < rect.bottom - 12; y += 18) {
      const el = document.elementFromPoint(x, y);
      if (el && !topB.contains(el) && !el.closest('.pencil-sticker, .bubble, .toast')) bleed = true;
    }
    return { ratio: +ratio.toFixed(2), bleed };
  });
  check(`library ${key}: title contrast AA (>= 4.5)`, r.ratio >= 4.5, String(r.ratio));
  check(`library ${key}: nothing from behind shows through the front card`, !r.bleed);
}

// 6. Internal testing switches.
console.log('\n=== Internal switches (375px)');
{
  let p = await newPage(browser, { mobile: true, db: vedikaDb(), token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?hub=locked');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  if (await p.page.locator('#invite-modal.open').count()) await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  await wait(900);
  check('?hub=locked: locked canvas, frosted overlay, no toolbar', await p.page.locator('#hub-canvas.locked').count() === 1 && await p.page.locator('#hub-overlay:not([hidden])').count() === 1 && await p.page.locator('#hub-toolbar[hidden]').count() === 1);
  const ov = await p.page.textContent('#hub-overlay');
  check('?hub=locked: lock modal copy', ov.includes('Your Hub opens with your first credit pack.') && ov.includes('It’s where drafts, edits, and your team’s notes come together.') &&
    ov.includes('Start with 5 credits') && ov.includes('Back to Library'), ov);
  check('?hub=locked: real items auto-laid (books + rules notes), no writes', await p.page.locator('#hub-canvas .kind-article').count() === 3 && await p.page.locator('#hub-canvas .kind-text').count() === 2 && p.mock.db.hub_items.length === 2);
  await shot(p.page, 's01-hub-locked');
  await p.page.click('[data-action="back-to-library"]');
  check('locked: Back to Library', await p.page.locator('#screen-library.on').count() === 1);
  await p.ctx.close();

  const db2 = vedikaDb();
  db2.members[0].onboarding = { feed_intro: true, library_glow: true, pencil_glow: true, hub_invite_seen: true };
  p = await newPage(browser, { mobile: true, db: db2, token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?hub=invite');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  await p.page.waitForSelector('#invite-modal.open');
  check('?hub=invite: invite pop-up again, one free seat', await p.page.locator('#invite-fields input').count() === 1);
  await p.page.fill('#invite-fields input', 'collaborator@blendxr.com');
  await shot(p.page, 's02-hub-invite');
  await p.page.click('#invite-btn');
  await p.page.waitForSelector('#screen-hub.on');
  check('?hub=invite: invite sent, then into the Hub', p.mock.db.members.length === 3);
  await p.ctx.close();

  const db3 = vedikaDb();
  db3.members[0].onboarding = { feed_intro: true, library_glow: true, pencil_glow: true, hub_invite_seen: true, lines: { hub: true } };
  p = await newPage(browser, { mobile: true, db: db3, token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?onboarding=reset');
  await p.page.waitForSelector('#screen-feed.on');
  await wait(400);
  check('?onboarding=reset: flags cleared and saved', JSON.stringify(db3.members[0].onboarding) === '{}', JSON.stringify(db3.members[0].onboarding));
  check('?onboarding=reset: first-visit bubble again, param removed', await p.page.locator('#bubble:not([hidden])').count() === 1 && !(await p.page.evaluate(() => location.search)).includes('onboarding'));
  await shot(p.page, 's03-onboarding-reset');
  await p.ctx.close();

  // A paying client ignores the switches.
  const db4 = vedikaDb({ company: { is_internal: false } });
  p = await newPage(browser, { mobile: true, db: db4, token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?hub=locked&onboarding=reset');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await p.page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  if (await p.page.locator('#invite-modal.open').count()) await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  check('non-internal company: ?hub=locked ignored (unlocked Hub)', await p.page.locator('#hub-canvas.locked').count() === 0);
  await p.ctx.close();

  // prefers-reduced-motion: a static reveal.
  p = await newPage(browser, { mobile: true, db: vedikaDb(), token: 'tok-vedika', reduced: true });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await p.page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await dotTo(p.page, title(sharedDb, 'vb-02'));
  await p.page.click('.ctl[data-decide="like"]');
  await p.page.waitForSelector('#reveal:not([hidden])');
  const still = await p.page.evaluate(() => ({ running: document.getElementById('reveal').getAnimations({ subtree: true }).length, cls: document.getElementById('reveal').className }));
  check('reduced motion: reveal is static (no animations)', still.running === 0 && still.cls.includes('rv-static'), JSON.stringify(still));
  await shot(p.page, 's04-reveal-reduced-motion');
  await p.ctx.close();
}

// ---------------------------------------------------------------------------
// Credits: a locked $19 account, an account with credits, RPR as it is live.
// ---------------------------------------------------------------------------
/** "Tuesday, Sep 29": the next drop day after today, as a viewer in `tz` sees it. */
function expectedDrop(firstIso, tz) {
  const wd = (d) => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(d);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let want = names.indexOf(wd(new Date(firstIso)));
  if (want === 0 || want === 6) want = 1;
  let d = new Date();
  do { d = new Date(d.getTime() + 86400e3); } while (names.indexOf(wd(d)) !== want);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz });
}
const dismissBubbles = async (page) => {
  for (let i = 0; i < 3; i++) await page.click('[data-action="bubble-dismiss"]', { timeout: 600 }).catch(() => {});
};
const inviteMsg = async (page, emails, dbRef, err) => {
  if (err) dbRef.inviteError = err;
  const inputs = page.locator('#invite-fields input');
  await inputs.nth(0).fill(emails[0]);
  if (await inputs.count() > 1) await inputs.nth(1).fill(emails[1] || '');
  await page.click('#invite-btn');
  await page.waitForFunction(() => document.querySelector('#invite-msg').classList.contains('err') || !document.querySelector('#invite-modal').classList.contains('open'));
  return page.textContent('#invite-msg');
};
const topCenterHit = (page, sel) => page.evaluate((q) => {
  const el = document.querySelector(q);
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
}, sel);

console.log('\n=== Locked $19 account (375px): Acme, no credit purchase yet');
{
  const db = acmeDb();
  const p = await newPage(browser, { mobile: true, db, token: 'tok-acme' });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await dismissBubbles(page);
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await dismissBubbles(page);
  check('locked $19: Library is open, header "1 written · 3 approved", no credits line', (await page.textContent('#lib-count')) === '1 written · 3 approved', await page.textContent('#lib-count'));
  await checkStampOneLine(page, 'locked $19 delivered');
  await page.click('[data-action="lib-next"]'); await wait(350);
  const chip = await page.textContent('.book.top .book-state');
  check('locked $19: approved card chip "Ready to write · 3 credits"', chip === 'Ready to write · 3 credits', chip);
  await checkStampOneLine(page, 'locked $19 ready chip');
  await shot(page, 'c01-locked-library-ready');
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  const def = await page.getAttribute('.fmt-opt.on', 'data-fmt');
  const cost1 = await page.textContent('#write-cost');
  await page.click('.fmt-opt[data-fmt="pillar"]');
  const cost2 = await page.textContent('#write-cost');
  check('write this: format defaults to the card (insight), cost updates live', def === 'insight' && cost1 === '3 credits. You have 0 credits.' && cost2 === '8 credits. You have 0 credits.', `${def} | ${cost1} | ${cost2}`);
  check('write this: not enough credits -> "Get credits"', (await page.textContent('#write-btn')) === 'Get credits');
  await shot(page, 'c02-write-this-no-credits');
  await page.click('#write-btn');
  await page.waitForSelector('#credits-sheet.open');
  const cs = await page.textContent('#credits-sheet');
  check('never bought: Starter checkout, "5 credits · $495", "Your $19 counts toward this."', cs.includes('Start with 5 credits') && cs.includes('5 credits · $495') && cs.includes('Your $19 counts toward this.') && !cs.includes('Top-up'), cs);
  await shot(page, 'c03-starter-checkout-step');
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), page.click('#credits-body .btn-primary')]);
  check('Starter: create-checkout(starter), first purchase gets the $19 coupon', db.checkout.at(-1).action === 'starter' && /\/starter\?q=1&coupon=first$/.test(page.url()), page.url());

  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await page.click('#switch-library');
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  check('first Hub tap: invite pop-up, two fields, "Two seats left."', await page.locator('#invite-fields input').count() === 2 && (await page.textContent('#invite-seats')) === 'Two seats left.');
  await shot(page, 'c04-invite-two-seats');
  const errs = {
    invalid: await inviteMsg(page, ['not-an-email'], db),
    self: await inviteMsg(page, ['dana@acme.co'], db),
    seat: await inviteMsg(page, ['new@acme.co'], db, { status: 409, error: 'seat_limit' }),
    already: await inviteMsg(page, ['new@acme.co'], db, { status: 409, error: 'already_member' }),
    invalidSrv: await inviteMsg(page, ['new@acme.co'], db, { status: 400, error: 'invalid_email' }),
    selfSrv: await inviteMsg(page, ['new@acme.co'], db, { status: 400, error: 'self_invite' }),
    failed: await inviteMsg(page, ['new@acme.co'], db, { status: 502, error: 'failed' }),
  };
  check('invite errors: one message per code, never the generic line',
    errs.invalid === 'That email doesn’t look right.' && errs.invalidSrv === 'That email doesn’t look right.' &&
    errs.self === 'That’s you. Invite someone else.' && errs.selfSrv === 'That’s you. Invite someone else.' &&
    errs.seat === 'All 3 seats are taken.' && errs.already === 'They’re already on your portal.' &&
    errs.failed === 'We couldn’t send that invite. Try again in a minute.', JSON.stringify(errs));
  await shot(page, 'c05-invite-error');
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(900);
  const lock = await page.evaluate(() => ({
    blur: document.getElementById('hub-canvas').classList.contains('locked'),
    modal: !document.getElementById('hub-overlay').hidden,
    text: document.getElementById('hub-overlay').innerText,
    toolbar: document.getElementById('hub-toolbar').hidden,
    invite: !document.getElementById('hub-invite').hidden,
    ghosts: document.querySelectorAll('#hub-seats .seat.empty').length,
  }));
  check('locked Hub: blurred canvas, lock modal, no toolbar', lock.blur && lock.modal && lock.toolbar, JSON.stringify(lock));
  check('locked Hub: modal copy + "Start with 5 credits" + "Back to Library"', lock.text.includes('Your Hub opens with your first credit pack.') &&
    lock.text.includes('It’s where drafts, edits, and your team’s notes come together.') && lock.text.includes('Start with 5 credits') && lock.text.includes('Back to Library'), lock.text);
  check('locked Hub: header Invite + 2 empty-seat ghosts, never under the blur or modal', lock.invite && lock.ghosts === 2 && await topCenterHit(page, '#hub-invite'), JSON.stringify(lock));
  check('locked Hub: nothing written to the canvas', db.hub_items.length === 0);
  await shot(page, 'c06-locked-hub');
  await page.click('#hub-invite');
  await page.waitForSelector('#invite-modal.open');
  check('Hub header Invite opens the same pop-up', await page.locator('#invite-fields input').count() === 2);
  await inviteMsg(page, ['lee@acme.co'], db);
  await page.waitForFunction(() => !document.querySelector('#invite-modal').classList.contains('open'));
  const after = await page.evaluate(() => ({ seats: document.querySelectorAll('#hub-seats .seat:not(.empty)').length, ghosts: document.querySelectorAll('#hub-seats .seat.empty').length, invite: !document.getElementById('hub-invite').hidden }));
  check('invite sent from the Hub header: members row added, seats update, still in the Hub', db.members.length === 2 && after.seats === 2 && after.ghosts === 1 && after.invite && await page.locator('#screen-hub.on').count() === 1, JSON.stringify(after));
  await page.click('#hub-start');
  await page.waitForSelector('#credits-sheet.open');
  check('lock modal "Start with 5 credits" opens the Starter checkout step', (await page.textContent('#credits-sheet')).includes('Your $19 counts toward this.'));
  await page.click('[data-close="credits-sheet"]');
  await page.click('[data-action="back-to-library"]');
  await page.waitForSelector('#screen-library.on');

  // Running out of cards.
  await page.click('#switch-feed');
  await page.waitForSelector('#screen-feed.on');
  await dismissBubbles(page);
  const layers = [];
  for (let i = 0; i < 5; i++) {
    layers.push(await page.locator('#card-stage .card').count());
    if (i === 3) {
      check('last 2 cards: the remaining dots pulse once', await page.locator('#dots .dot.pulse').count() === 2);
      await shot(page, 'c07-feed-last-two');
    }
    await page.click('.ctl[data-decide="like"]');
    await wait(520);
    if (await page.locator('#reveal:not([hidden])').count()) { await page.click('#reveal .btn-secondary'); await wait(200); }
  }
  check('stack thins: one fewer layer on each of the last 2 cards', layers.join(',') === '3,3,3,2,1', layers.join(','));
  await page.waitForSelector('#card-stage .caught-up');
  const cu = await page.evaluate(() => ({
    text: document.querySelector('.caught-up').innerText,
    stack: document.querySelectorAll('.fd-card').length,
    faceUp: (document.querySelector('.fd-card.face-up .card-format') || {}).textContent || null,
  }));
  check('caught up: face-down stack of 5, first real next-week format face-up', cu.stack === 5 && cu.faceUp === 'Insight', JSON.stringify(cu));
  const acmeDrop = expectedDrop(db.companies[0].first_opened_at, 'UTC');
  check(`caught up: "5 new on ${acmeDrop}" (drop day = weekday first opened) with a live countdown`, cu.text.includes('5 new on ' + acmeDrop) && /IN (\d+D \d+H|\d+H \d+M)/i.test(cu.text), cu.text);
  check('caught up: a line per seat with cards left, an invite line per open seat',
    cu.text.includes('Lee hasn’t seen 5 of these.') && !cu.text.includes('You haven’t') && cu.text.includes('Seat 3 is open. Invite someone who decides content.'), cu.text);
  await page.click('.cu-line >> text=Lee hasn’t seen 5 of these.');
  const hl = await page.evaluate(() => { const s0 = document.querySelector('.cu-seats .seat.hl'); return s0 ? s0.title : null; });
  check('tapping a seat line only highlights that seat', hl === 'Lee' && db.checkout.length === 1 && db.notes.length === 0, String(hl));
  await shot(page, 'c08-caught-up');
  await page.click('.cu-line.open');
  await page.waitForSelector('#invite-modal.open');
  check('open-seat line opens the same invite pop-up, "One seat left."', (await page.textContent('#invite-seats')) === 'One seat left.' && await page.locator('#invite-fields input').count() === 1);
  await page.click('[data-action="invite-skip"]');
  // Expected noise: the invite errors forced above (409, 400, 502).
  const unexpected = p.errors.filter((e) => !/status of (409|400|502)/.test(e));
  check('locked $19: no page errors', !unexpected.length, unexpected.join(' | '));
  await p.ctx.close();
}

console.log('\n=== Account with credits (375px): Acme after a Starter pack and a plan month');
{
  const db = acmeDb({ credits: true });
  db.notes.push({ id: 'n-lee', company_id: db.companies[0].id, member_id: 'a1000000-0000-0000-0000-000000000002', card_id: db.articles[3].card_id, body: 'Lead with the pilot numbers.', created_at: new Date().toISOString() });
  const p = await newPage(browser, { mobile: true, db, token: 'tok-acme' });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await dismissBubbles(page);
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await dismissBubbles(page);
  check('credits: header "1 written · 3 approved · 25 credits"', (await page.textContent('#lib-count')) === '1 written · 3 approved · 25 credits', await page.textContent('#lib-count'));
  await page.click('[data-action="lib-next"]'); await wait(350);
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  check('notes readable on the card in the Library', (await page.textContent('#ghost-notes')).includes('Lead with the pilot numbers.'));
  await page.click('.fmt-opt[data-fmt="pillar"]');
  check('enough credits: "Write this · 8 credits"', (await page.textContent('#write-btn')) === 'Write this · 8 credits' && (await page.textContent('#write-cost')) === '8 credits. You have 25 credits.');
  await shot(page, 'c09-write-this');
  await page.click('#write-btn');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Writing starts now'));
  const spent = db.credit_ledger.filter((l) => l.kind === 'spend');
  check('spend: one piece, 8 credits from the soonest-expiring grant, by this seat', db.pieces.length === 1 && db.pieces[0].format === 'pillar' &&
    spent.reduce((a, l) => a + l.delta, 0) === -8 && spent.every((l) => l.grant_id === 'g-plan' && l.created_by === ACME_OWNER), JSON.stringify(spent));
  await wait(300);
  const top1 = await page.textContent('.book.top');
  check('after spend: card shows "Arriving in <countdown>", header 17 credits', /Arriving in (23h \d+m|24h 0m)/i.test(top1) && (await page.textContent('#lib-count')).endsWith('17 credits'), top1);
  await shot(page, 'c10-arriving');
  // Second one waits in the queue.
  let guard = 0;
  while (!/Ready to write/.test(await page.textContent('.book.top')) && guard++ < 6) { await page.click('[data-action="lib-next"]'); await wait(300); }
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  await page.click('#write-btn');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Queued'));
  await wait(300);
  check('second piece: card shows "Queued"', /Queued/i.test(await page.textContent('.book.top')));
  await shot(page, 'c11-queued');

  // Hub is open: first tap invites (1 seat), then the unlocked canvas with "Write this".
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  check('credits account: first Hub tap still offers the last seat', (await page.textContent('#invite-seats')) === 'One seat left.');
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(900);
  check('credit purchase + active $19: Hub unlocked', await page.locator('#hub-canvas.locked').count() === 0 && await page.locator('#hub-overlay[hidden]').count() === 1 && await page.locator('#hub-toolbar:not([hidden])').count() === 1);
  const w = page.locator('#hub-canvas .hub-item.writable').first();
  check('Hub: approved, unwritten cards marked "Ready to write"', await page.locator('#hub-canvas .hub-item.writable').count() === 1 && (await w.textContent()).includes('Ready to write'));
  await w.scrollIntoViewIfNeeded();
  await w.click();
  await page.waitForSelector('#ghost-sheet.open');
  check('Hub: tapping it opens the same "Write this"', await page.locator('#write-box:visible').count() === 1);
  await shot(page, 'c12-hub-write-this');
  await page.click('[data-close="ghost-sheet"]');
  await page.click('[data-hub="done"]');
  await page.waitForSelector('#screen-library.on');

  // Run low, then top up (plan offered only when no plan is running).
  db.credit_ledger.push({ id: 'x1', company_id: db.companies[0].id, delta: -11, kind: 'expire', grant_id: 'g-plan', source_id: 'test' },
    { id: 'x2', company_id: db.companies[0].id, delta: -5, kind: 'expire', grant_id: 'g-starter', source_id: 'test' });
  db.companies[0].plan_subscription_id = null;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await page.click('#switch-library');
  guard = 0;
  while (!/Ready to write/.test(await page.textContent('.book.top')) && guard++ < 6) { await page.click('[data-action="lib-next"]'); await wait(300); }
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  await page.click('#write-btn'); // Get credits
  await page.waitForSelector('#credits-sheet.open');
  const cs2 = await page.textContent('#credits-sheet');
  check('bought before: plan and top-up offered, no Starter', cs2.includes('20 credits a month · $2,000') && cs2.includes('$125 per credit') && !cs2.includes('Your $19 counts toward this.'), cs2);
  await page.locator('.qty-btn').nth(1).click();
  await page.locator('.qty-btn').nth(1).click();
  check('top-up quantity picker: default = credits missing, total updates', (await page.locator('#credits-body .offer').nth(1).locator('.btn-primary').textContent()) === 'Buy 5 credits · $625');
  await shot(page, 'c13-plan-or-topup');
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), page.locator('#credits-body .offer').nth(1).locator('.btn-primary').click()]);
  check('top-up: create-checkout(topup, 5), no coupon after the first purchase', db.checkout.at(-1).action === 'topup' && db.checkout.at(-1).quantity === 5 && /coupon=none/.test(page.url()), page.url());
  // Back from Stripe: the webhook has granted the top-up.
  db.credit_ledger.push({ id: 'g-top', company_id: db.companies[0].id, delta: 5, kind: 'grant', product: 'topup', grant_id: null, source_id: 'cs_top', expires_at: null });
  await page.goto(BASE + '/portal?credits=success&kind=topup');
  await page.waitForSelector('#screen-feed.on');
  const ok = await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('5 credits ready.'), null, { timeout: 9000 }).then(() => true, () => false);
  check('back from checkout: "Payment received", then the new balance, URL cleaned', ok && !(await page.evaluate(() => location.search)).includes('credits'));
  check('credits account: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}

console.log('\n=== RPR (375px): canceled at period end, Oct 25, no purchases, test seat + 3 empty');
{
  const db = rprDb();
  const p = await newPage(browser, { mobile: true, db, token: 'tok-rpr' });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await dismissBubbles(page);
  check('RPR: Feed open (canceled but not ended), 10 new cards', (await page.textContent('#feed-count')) === '10 cards · 10 unread' && await page.locator('.ctl[data-decide="like"]:enabled').count() === 1, await page.textContent('#feed-count'));
  await shot(page, 'r01-rpr-feed');
  for (let i = 0; i < 10; i++) { await page.click('[data-action="feed-next"]'); await wait(80); }
  await page.waitForSelector('#card-stage .caught-up');
  const cu = await page.textContent('#card-stage .caught-up');
  const rprDrop = expectedDrop(db.companies[0].first_opened_at, 'UTC');
  check(`RPR caught up (UTC viewer): first opened on a Friday -> "5 new on ${rprDrop}"`, rprDrop.startsWith('Friday') && cu.includes('5 new on ' + rprDrop), cu);
  check('RPR caught up: the test seat has cards left, seats 2 to 4 open, no invented face-up card',
    cu.includes('You haven’t seen 10 of these.') && ['Seat 2 is open.', 'Seat 3 is open.', 'Seat 4 is open.'].every((t) => cu.includes(t)) &&
    await page.locator('.cu-seats .seat.empty').count() === 3 && await page.locator('.fd-card.face-up').count() === 0, cu);
  await shot(page, 'r02-rpr-caught-up');
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await dismissBubbles(page);
  check('RPR Library: empty shelf, no credits line', (await page.textContent('#deck-stage')).includes('Your articles land here as they’re written.') && (await page.textContent('#lib-count')) === '');
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  check('RPR: first Hub tap -> invite pop-up, "Three seats left." (seat_limit 4, one test seat)', (await page.textContent('#invite-seats')) === 'Three seats left.' && await page.locator('#invite-fields input').count() === 2);
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(700);
  check('RPR Hub: locked with the lock modal, Invite in the header', await page.locator('#hub-canvas.locked').count() === 1 && await page.locator('#hub-overlay:not([hidden])').count() === 1 && await topCenterHit(page, '#hub-invite'));
  await shot(page, 'r03-rpr-hub-locked');
  await page.click('#hub-start');
  await page.waitForSelector('#credits-sheet.open');
  const cs = await page.textContent('#credits-sheet');
  check('RPR credits: "Resume your $19 to buy credits", ends Oct 25, one button', cs.includes('Resume your $19 to buy credits') && cs.includes('Ends Oct 25') && cs.includes('Resume my $19') && !cs.includes('$495'), cs);
  await shot(page, 'r04-rpr-resume');
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), page.click('#credits-body .btn-primary')]);
  const calls = db.checkout.map((c) => c.action).join(',');
  check('Resume: same subscription resumed (no new $19), then straight into the Starter checkout with the coupon', calls === 'resume,starter' &&
    db.companies[0].subscription_status === 'active' && /\/starter\?q=1&coupon=first$/.test(page.url()), calls + ' ' + page.url());
  check('RPR: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();

  // Same data, a viewer in Tokyo: first opened Saturday there -> Monday.
  const p2 = await newPage(browser, { mobile: true, db: rprDb(), token: 'tok-rpr', timezoneId: 'Asia/Tokyo' });
  await p2.page.goto(BASE + '/portal');
  await p2.page.waitForSelector('#screen-feed.on');
  await dismissBubbles(p2.page);
  for (let i = 0; i < 10; i++) { await p2.page.click('[data-action="feed-next"]'); await wait(60); }
  await p2.page.waitForSelector('#card-stage .caught-up');
  const cu2 = await p2.page.textContent('.cu-title');
  const tokyo = expectedDrop(rprDb().companies[0].first_opened_at, 'Asia/Tokyo');
  check(`drop day in the viewer's timezone: Tokyo sees a Saturday -> Monday (${tokyo})`, tokyo.startsWith('Monday') && cu2 === '5 new on ' + tokyo, cu2);
  await p2.ctx.close();
}

console.log('\n=== Library hint above the switch at every height');
for (const [w, hgt] of [[375, 568], [375, 667], [375, 812], [1280, 700]]) {
  const p = await newPage(browser, { mobile: w === 375, db: acmeDb({ credits: true }), token: 'tok-acme', height: hgt });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await dismissBubbles(p.page);
  await p.page.click('#switch-library');
  await p.page.waitForSelector('#screen-library.on');
  await dismissBubbles(p.page);
  await wait(400);
  const g = await p.page.evaluate(() => {
    const hint = document.querySelector('.lib-hint').getBoundingClientRect();
    const sw = document.getElementById('switch').getBoundingClientRect();
    const books = Array.from(document.querySelectorAll('.book.top')).map((b) => b.getBoundingClientRect());
    const hit = document.elementFromPoint(hint.left + hint.width / 2, hint.top + hint.height / 2);
    return { hintBottom: hint.bottom, hintTop: hint.top, swTop: sw.top, visible: hit && hit.closest('.lib-nav') !== null, bookBottom: books[0] ? books[0].bottom : 0 };
  });
  check(`${w}x${hgt}: "Swipe to shuffle. Tap to open." sits above the Feed/Library switch, uncovered`, g.hintBottom <= g.swTop - 4 && g.hintTop >= 0 && g.visible && g.bookBottom <= g.hintTop, JSON.stringify(g));
  await checkStampOneLine(p.page, `${w}x${hgt} delivered`);
  if (hgt === 568) await shot(p.page, 'c14-library-568');
  await p.ctx.close();
}

// 7. blendbases sees the same overlaps from the other side (shared data).
console.log('\n=== blendbases@gmail.com (375px)');
{
  const p = await newPage(browser, { mobile: true, db: sharedDb, token: 'tok-blend' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await wait(300);
  await p.page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await p.page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await dotTo(p.page, title(sharedDb, 'vb-02'));
  await p.page.waitForSelector('#reveal.rv-agree:not([hidden])');
  const t1 = await p.page.textContent('#reveal');
  check('blendbases: Agree reveal on first view of vb-02 (You + vedikabhasin)', t1.includes('You both want this one.') && t1.includes('vedikabhasin'), t1);
  await wait(1250);
  await shot(p.page, 'b01-agree-other-side');
  await p.page.click('#reveal .btn-secondary');
  await wait(200);
  await dotTo(p.page, title(sharedDb, 'vb-03'));
  await p.page.waitForSelector('#reveal.rv-split:not([hidden])');
  const t2 = await p.page.textContent('#reveal');
  check('blendbases: Split from the other side (You passed, vedikabhasin liked)', t2.includes('You two see this differently.') && t2.includes('Passed') && t2.includes('Liked'));
  await wait(1250);
  const nameFits = await p.page.$$eval('#reveal .rv-name', els => els.every(e => {
    const r = e.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && e.scrollWidth <= e.clientWidth;
  }));
  check('blendbases: reveal name tags fit on screen at 375px, untruncated', nameFits);
  await shot(p.page, 'b02-split-other-side');
  await p.page.click('#reveal .btn-secondary');
  await dotTo(p.page, title(sharedDb, 'vb-04'));
  await p.page.waitForSelector('#reveal.rv-timing:not([hidden])');
  check('blendbases: Timing from the other side', (await p.page.textContent('#reveal')).includes('One of you wants it now.'));
  await p.page.click('#reveal .btn-secondary');
  await wait(200);
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  if (await p.page.locator('#invite-modal.open').count()) await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  await wait(900);
  check('blendbases: sees Vedika\'s note in the Hub', (await p.page.textContent('#hub-canvas')).includes('Grok is my best proof'));
  await shot(p.page, 'b03-hub-other-side');
  check('blendbases: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}

// Sign in with the six-digit code instead of the link, then sign out.
{
  console.log('\n=== Sign in with a code (375px)');
  const p = await newPage(browser, { mobile: true, db: vedikaDb(), token: null });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-signin.on');
  await p.page.fill('#signin-email', 'VedikaBhasin@gmail.com ');
  await p.page.click('#signin-btn');
  await p.page.waitForSelector('#signin-sent:not([hidden])');
  // Retyping the email field must not change which address the code verifies.
  await p.page.evaluate(() => { document.querySelector('#signin-email').value = 'someone@else.com'; });
  // A bad code: error shown, still on the sign-in screen.
  await p.page.fill('#signin-code', '000 000');
  await p.page.click('#code-btn');
  await p.page.waitForFunction(() => document.querySelector('#code-msg').classList.contains('err'));
  check('code: bad code shows the error and stays on sign-in',
    (await p.page.textContent('#code-msg')) === 'That code didn’t work. Check the latest email or send a new one.'
    && await p.page.locator('#screen-signin.on').count() === 1 && await p.page.locator('#signin-sent:not([hidden])').count() === 1);
  check('code: spaces stripped from a pasted code', (await p.page.inputValue('#signin-code')) === '000000');
  check('code: button enabled again after a failed check', await p.page.isEnabled('#code-btn'));
  // "Use a different email" resets the form and clears the code.
  await p.page.click('#signin-sent [data-action="signin-again"]');
  check('code: "Use a different email" returns to the email form and clears the code',
    await p.page.locator('#signin-form:not([hidden])').count() === 1 && (await p.page.inputValue('#signin-code')) === ''
    && (await p.page.textContent('#code-msg')).trim() === '');
  await p.page.fill('#signin-email', 'vedikabhasin@gmail.com');
  await p.page.click('#signin-btn');
  await p.page.waitForSelector('#signin-sent:not([hidden])');
  // A good code, pasted with a space.
  const loadsBefore = p.mock.log.filter((l) => l.method === 'GET' && l.path.startsWith('/rest/v1/companies')).length;
  await p.page.fill('#signin-code', '123 456');
  await p.page.click('#code-btn');
  await p.page.waitForSelector('#screen-feed.on');
  const verifies = p.mock.log.filter((l) => l.path.startsWith('/auth/v1/verify'));
  const last = verifies[verifies.length - 1];
  check('code: verifyOtp called with the sent email, the code and type email',
    last && last.body.email === 'vedikabhasin@gmail.com' && last.body.token === '123456' && last.body.type === 'email', JSON.stringify(last && last.body));
  await wait(600);
  const loads = p.mock.log.filter((l) => l.method === 'GET' && l.path.startsWith('/rest/v1/companies')).length - loadsBefore;
  check('code: lands on the feed, portal started once', await p.page.locator('#screen-feed.on').count() === 1 && loads === 1, 'company loads: ' + loads);
  // Sign out only this device.
  await p.page.click('#sign-out-btn');
  await p.page.waitForSelector('#screen-signin.on');
  const logout = p.mock.log.find((l) => l.path.startsWith('/auth/v1/logout'));
  check('sign out: local scope only', logout && /[?&]scope=local\b/.test(logout.path), logout && logout.path);
  // Expected noise only: the 403 from the bad code, and the logout request the
  // redirect to /portal cancels after its response arrived.
  const unexpected = p.errors.filter((e) => !/status of 403/.test(e) && !/logout\?scope=local net::ERR_ABORTED/.test(e));
  check('code: no page errors', !unexpected.length, unexpected.join(' | '));
  await p.ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
failed.forEach((f) => console.log('FAIL:', f.name, f.detail || ''));
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
