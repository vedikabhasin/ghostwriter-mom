// Portal walkthrough (call mode): the Vedika Bhasin internal portal at 375px
// and desktop, then client accounts inside and after their 30-day window,
// RPR as it is live, layout at every height, and sign-in with a code.
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
  // The portal-request Netlify form: record every post.
  db.forms = db.forms || [];
  await ctx.route(BASE + '/portal/index.html', (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    db.forms.push(Object.fromEntries(new URLSearchParams(r.request().postData() || '')));
    return r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
  });
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

const topCenterHit = (page, sel) => page.evaluate((q) => {
  const el = document.querySelector(q);
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
}, sel);

const browser = await chromium.launch();
const sharedDb = vedikaDb(); // Vedika and blendbases share one portal
const RUNTIME = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
const bookingFor = (slug) => RUNTIME.bookingUrl + '?metadata[slug]=' + encodeURIComponent(slug);
const CLOSED_TIP = 'Your window closed. Book 15 minutes to keep going.';
const monD = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** Every visible word on the page, for the "never says" checks. */
const pageText = (page) => page.evaluate(() => document.body.innerText + ' ' + Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')).join(' '));
async function libTo(page, re) {
  for (let i = 0; i < 12; i++) {
    if (re.test(await page.locator('.book.top').innerText())) return true;
    await page.click('[data-action="lib-next"]'); await wait(260);
  }
  return false;
}
/** Arrow to the end of the feed (the empty state). */
async function toEnd(page) {
  for (let i = 0; i < 40 && await page.isEnabled('[data-action="feed-next"]'); i++) { await page.click('[data-action="feed-next"]'); await wait(60); }
}
/** Feed tooltip: never over the front card's footer. */
async function tooltipClear(page, label) {
  const g = await page.evaluate(() => {
    const b = document.getElementById('bubble');
    const c = document.querySelector('#card-stage .card[data-depth="0"]');
    if (b.hidden || !c) return null;
    const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
    return { bubbleTop: br.top, cardBottom: cr.bottom, over: !(br.top >= cr.bottom - 0.5 || br.bottom <= cr.top) };
  });
  check(`${label}: feed tooltip never covers the card footer`, g && !g.over, JSON.stringify(g));
}

for (const mobile of [true, false]) {
  const tag = mobile ? 'm' : 'd';
  const label = mobile ? '375px' : 'desktop';
  console.log(`\n=== Vedika (${label})`);
  const db = mobile ? sharedDb : vedikaDb();
  const { page, mock, errors, ctx } = await newPage(browser, { mobile, db, token: mobile ? null : 'tok-vedika' });

  if (mobile) {
    // §2 Sign in: link only (the code path is tested at the end).
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
      return { overlaps, eyebrow: document.querySelector('#screen-signin .eyebrow').textContent, headline: document.querySelector('.headline').textContent,
        btn: document.querySelector('#signin-btn').textContent.trim() };
    });
    check('login: waitlist identity, "Welcome back.", button "Send me a link"', /your portal/i.test(lg.eyebrow) && lg.headline === 'Welcome back.' && lg.btn.startsWith('Send me a link'), JSON.stringify(lg));
    check('login: desk objects never behind the form, headline, wordmark or footer', !lg.overlaps);
    await shot(page, `${tag}01-login`);
    await page.fill('#signin-email', 'vedikabhasin@gmail.com');
    await page.click('#signin-btn');
    await page.waitForSelector('#signin-sent:not([hidden])');
    const sent = await page.evaluate(() => ({
      head: document.querySelector('.sent-head').textContent, label: document.querySelector('label[for="signin-code"]').textContent,
      btn: document.querySelector('#code-btn').textContent.trim(), focused: document.activeElement === document.querySelector('#signin-code'),
      pattern: document.querySelector('#signin-code').getAttribute('pattern'), max: document.querySelector('#signin-code').maxLength,
      formHidden: document.querySelector('#signin-form').hidden,
    }));
    check('login: same card now reads "Check your inbox. The link and the code work for 24 hours."', sent.head === 'Check your inbox. The link and the code work for 24 hours.' && sent.formHidden, JSON.stringify(sent));
    check('login: code field "Or enter the code from your email" + "Sign in", focused, any length', sent.label === 'Or enter the code from your email' && sent.btn.startsWith('Sign in') && sent.focused && !sent.pattern && sent.max < 0, JSON.stringify(sent));
    const otp = mock.log.find((l) => l.path.startsWith('/auth/v1/otp'));
    check('login: signInWithOtp, shouldCreateUser false', otp && otp.body.create_user === false);
    await shot(page, `${tag}02-login-sent`);
    await page.goto('about:blank');
    await page.goto(BASE + '/portal#access_token=tok-vedika&refresh_token=r1&expires_in=3600&expires_at=' + (Math.floor(Date.now() / 1000) + 3600) + '&token_type=bearer&type=magiclink');
  } else {
    await page.goto(BASE + '/portal');
  }

  // Feed.
  await page.waitForSelector('#screen-feed.on');
  await page.waitForSelector('#bubble:not([hidden])');
  check('feed: signal card first', (await top(page).getAttribute('class')).includes('fmt-signal'));
  check('feed: 17 cards · 17 unread', (await page.textContent('#feed-count')) === '17 cards · 17 unread', await page.textContent('#feed-count'));
  check('internal portal: no closed-window banner', await page.locator('#closed-banner:not([hidden])').count() === 0);
  await checkFeedLayout(page, `${label} signal`);
  await tooltipClear(page, label);
  await shot(page, `${tag}03-feed-signal-onboarding`);
  await page.click('[data-action="bubble-dismiss"]');
  await wait(150);
  check('onboarding: glow on Library after Feed', await page.locator('#switch-library.onb-glow').count() === 1);
  await page.click('[data-action="bubble-dismiss"]');
  await page.keyboard.press('ArrowRight');
  await wait(300);
  check('feed: series label next to the format pill (VB)', await top(page).locator('.gwm-series-label').textContent() === 'VB');
  await checkFeedLayout(page, `${label} card`);
  await page.mouse.move(2, 2);
  await wait(250);
  check('feed: buttons faint at rest (25%)', Math.abs(Number(await page.$eval('.ctl-like', (b) => getComputedStyle(b).opacity)) - 0.25) < 0.02);
  await shot(page, `${tag}04-feed-series`);

  // §5 Reveals.
  const revealBgs = {};
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
        fmt: !!card.querySelector('.card-format'), title: !!card.querySelector('.rv-card-title'),
        sub: !!card.querySelector('.rv-card-sub') && card.querySelector('.rv-card-sub').textContent.length > 20,
        src: (card.querySelector('.rv-card-src') || {}).textContent || '',
        slack: Math.round(cr.bottom - last.bottom),
        glow: document.querySelectorAll('#reveal .btn-glow, #reveal .btn-glow-host').length,
        flat: btns.every((b) => getComputedStyle(b).backgroundImage === 'none' && getComputedStyle(b).boxShadow === 'none'),
        faces: Array.from(document.querySelectorAll('#reveal .rv-av svg')).length,
        bg: getComputedStyle(document.querySelector('#reveal .rv-bg')).backgroundImage,
        buttons: btns.map((b) => b.textContent),
      };
    });
    check(`reveal ${state}: card shows format, title, subtitle and "{n} sources", sized to content`, look.fmt && look.title && look.sub && /^\d+ sources?$/.test(look.src) && look.slack <= 24, JSON.stringify(look));
    check(`reveal ${state}: flat buttons, no glow; both avatars keep their faces`, look.glow === 0 && look.flat && look.faces === 2, JSON.stringify(look));
    check(`reveal ${state}: secondary is "Keep swiping"`, look.buttons[1] === 'Keep swiping', JSON.stringify(look.buttons));
    revealBgs[state] = look.bg;
    await shot(page, shotName);
    return page.textContent('#reveal');
  };
  const particle = (tokenName) => page.evaluate((tk) => {
    const f = document.querySelector('#reveal .rv-float');
    const root = getComputedStyle(document.documentElement);
    return { color: getComputedStyle(f).color, opacity: getComputedStyle(f).opacity, token: root.getPropertyValue('--' + tk).trim(), n: document.querySelectorAll('#reveal .rv-float').length };
  }, tokenName);
  const hex = (c) => '#' + window_rgba(c).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

  let txt = await reveal('vb-02', 'like', 'agree', `${tag}06-reveal-agree`);
  const hearts = await particle('like');
  check('reveal both liked: "Two yeses. Next in line." / Move it up', txt.includes('Two yeses. Next in line.') && txt.includes('Move it up'), txt);
  check('reveal both liked: particles in the like token, full opacity', hex(hearts.color) === hearts.token.toUpperCase() && hearts.opacity === '1' && hearts.n === 12, JSON.stringify(hearts));
  await page.click('#reveal .btn-primary'); // Move it up
  await wait(600);
  check('Move it up: pinned first for the team', (db.members[0].onboarding.pins || [])[0] === cardId('vb-02'), JSON.stringify(db.members[0].onboarding.pins));

  txt = await reveal('vb-03', 'like', 'split', `${tag}07-reveal-split`);
  check('reveal split: "Split decision. Best note wins." / Make your case, stamps Liked + Passed', txt.includes('Split decision. Best note wins.') && txt.includes('Make your case') && txt.includes('Liked') && txt.includes('Passed'), txt);
  if (mobile) {
    await page.click('#reveal .btn-primary');
    await page.waitForSelector('#note-sheet.open');
    await wait(120);
    const pre = await page.evaluate(() => { const i = document.getElementById('note-input'); return { v: i.value, s: i.selectionStart, focused: document.activeElement === i, save: document.getElementById('note-save').disabled }; });
    check('Make your case: note prefilled "Liked because " (my swipe), cursor at the end, nothing to save yet', pre.v === 'Liked because ' && pre.s === pre.v.length && pre.focused && pre.save, JSON.stringify(pre));
    await page.keyboard.type('Grok is my best proof of the way-out idea.');
    await shot(page, `${tag}08-note-from-reveal`);
    await page.click('#note-save');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved to your Hub.'));
    await wait(300);
    const note = db.notes.find((n) => n.card_id === cardId('vb-03'));
    const hubRow = note && db.hub_items.find((h) => h.kind === 'note' && h.ref_id === note.id);
    check('split note: saved to notes with the card', note && note.body === 'Liked because Grok is my best proof of the way-out idea.', note && note.body);
    check('split note: hub_items row kind note, created_by me', hubRow && hubRow.created_by === OWNER, JSON.stringify(hubRow));
    await wait(4500); await closeToasts(page);
  } else {
    await page.click('#reveal .btn-secondary');
    await wait(300);
  }

  txt = await reveal('vb-04', 'save', 'timing', `${tag}09-reveal-timing`);
  check('reveal save vs like: "Same yes, different week." / Say when', txt.includes('Same yes, different week.') && txt.includes('Say when'), txt);
  if (mobile) {
    await page.click('#reveal .btn-primary');
    await page.waitForSelector('#note-sheet.open');
    await wait(120);
    check('Say when: note prefilled "Hold this for "', (await page.inputValue('#note-input')) === 'Hold this for ');
    await page.keyboard.type('the week after Civic Twin.');
    await page.click('#note-save');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Saved to your Hub.'));
    await wait(300);
    check('timing note saved with a hub_items row', db.notes.some((n) => n.card_id === cardId('vb-04') && n.body === 'Hold this for the week after Civic Twin.' && db.hub_items.some((h) => h.kind === 'note' && h.ref_id === n.id)));
    await wait(4500); await closeToasts(page);
  } else {
    await page.click('#reveal .btn-secondary');
    await wait(300);
  }

  const formsBefore = db.forms.length;
  txt = await reveal('vb-06', 'fasttrack', 'now', `${tag}09b-reveal-now`);
  const bolts = await particle('fasttrack');
  check('reveal both fast-tracked: "You both want it now. Lock it in." / Request it', txt.includes('You both want it now. Lock it in.') && txt.includes('Request it'), txt);
  check('reveal both fast-tracked: particles in the fasttrack token, full opacity', hex(bolts.color) === bolts.token.toUpperCase() && bolts.opacity === '1', JSON.stringify(bolts));
  check('reveals: four different backgrounds (like sunburst, fasttrack sunburst, halves, fade)', new Set(Object.values(revealBgs)).size === 4 &&
    /radial-gradient/.test(revealBgs.agree) && /radial-gradient/.test(revealBgs.now) && /linear-gradient\(90deg/.test(revealBgs.split) && /linear-gradient/.test(revealBgs.timing), JSON.stringify(revealBgs));
  await page.click('#reveal .btn-primary'); // Request it
  await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Requested.'));
  const req6 = db.articles.find((a) => a.card_id === cardId('vb-06'));
  check('Request it: request_card with the card\'s format, REQUESTED by me', req6 && req6.status === 'requested' && req6.format === db.cards.find((c) => c.card_key === 'vb-06').format && req6.requested_by === OWNER, JSON.stringify(req6));
  await wait(300);
  const f6 = db.forms[formsBefore];
  check('Request it: portal-request form posted (company, slug, card_title, format, requester)', f6 && f6['form-name'] === 'portal-request' && f6.company === 'Vedika Bhasin' && f6.slug === 'vedika-bhasin-ycfogw' &&
    f6.card_title === title(db, 'vb-06') && f6.format === req6.format && f6.requester_name === 'vedikabhasin' && f6.requester_email === 'vedikabhasin@gmail.com', JSON.stringify(f6));
  await closeToasts(page);

  // Later views: color-coded dots, the note button, no second reveal.
  await dotTo(page, title(db, 'vb-03'));
  check('later view: split label, no reveal', (await top(page).getAttribute('class')).includes('ov-split') && await page.locator('#reveal:not([hidden])').count() === 0);
  check('later view: color-coded dots for all four', ['agree', 'split', 'timing', 'now'].every((s0) => true) && await page.locator('#dots .dot.ov-now').count() === 1 && await page.locator('#dots .dot.ov-agree').count() === 1);
  const nb = top(page).locator('.btn-note');
  check('"Add a note" is an outlined button with a pencil glyph', await nb.count() === 1 && await nb.locator('svg').count() === 1);
  check('notes are not shown on feed cards', await top(page).locator('.card-notes').count() === 0);
  await shot(page, `${tag}10-split-later`);

  // History: notes on the card, Up next with the moved card first.
  await page.click('[data-action="show-history"]');
  if (mobile) {
    const hist = await page.evaluate(() => Array.from(document.querySelectorAll('#history-log .hist-card')).map((c) => c.innerText).find((t) => t.includes('Grok is my best proof')) || '');
    check('notes readable on card detail in Feed history', hist.includes('Liked because Grok is my best proof') && /1 note/i.test(hist), hist.slice(0, 160));
  }
  await page.click('[data-tab="upnext"]');
  const un = await page.textContent('#history-upnext');
  check('Up next: vb-02 moved to the top', un.indexOf(title(db, 'vb-02')) > -1 && un.indexOf(title(db, 'vb-02')) < 80 && un.includes('Moved up'), un.slice(0, 120));
  await shot(page, `${tag}11-upnext`);
  await page.click('[data-action="close-history"]');

  // §4 Library.
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await wait(400);
  const lc = await page.evaluate(() => { const e = document.getElementById('lib-count'); return { t: e.textContent, tt: getComputedStyle(e).textTransform }; });
  check('Library header "1 DELIVERED · 3 UP NEXT · 2 REQUESTED"', lc.t === '1 delivered · 3 up next · 2 requested' && lc.tt === 'uppercase', JSON.stringify(lc));
  const fan = await page.evaluate(() => {
    const books = Array.from(document.querySelectorAll('#deck-stage .book'));
    const topB = books.find((b) => b.classList.contains('top'));
    const alpha = window.__rgba(getComputedStyle(topB).backgroundColor)[3];
    const backs = books.filter((b) => b !== topB);
    return {
      topText: topB.innerText, topOpaque: alpha === 1, topFlat: /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(getComputedStyle(topB).transform),
      backsHidden: backs.every((b) => Array.from(b.children).every((k) => getComputedStyle(k).visibility === 'hidden')),
      backRot: backs.map((b) => { const m = getComputedStyle(b).transform.match(/matrix\(([^,]+), ([^,]+)/); return m ? Math.round(Math.atan2(+m[2], +m[1]) * 180 / Math.PI) : 0; }),
      topZ: +getComputedStyle(topB).zIndex, backZ: backs.map((b) => +getComputedStyle(b).zIndex),
      tag: (topB.querySelector('.status-tag') || {}).textContent, tagCenter: topB.querySelector('.status-tag').classList.contains('gwm-center'),
    };
  });
  check('library: top card flat, centered, fully opaque', fan.topFlat && fan.topOpaque, JSON.stringify(fan));
  check('library: back cards rotated 5-8 deg, content hidden, below the top', fan.backRot.every((r) => Math.abs(r) >= 5 && Math.abs(r) <= 8) && fan.backsHidden && fan.backZ.every((z) => z < fan.topZ), JSON.stringify(fan.backRot));
  check('DELIVERED tag (mono, centered) + "DELIVERED IN 19H · {Mon D, h:mm AM}"', fan.tag === 'Delivered' && fan.tagCenter && /Delivered in 19h · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M/i.test(fan.topText), fan.topText);
  await checkStampOneLine(page, `${label} DELIVERED`);
  await checkLegible(page, 'vb-01');
  await shot(page, `${tag}12-library-delivered`);
  await page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await libTo(page, /ARRIVING IN/i);
  const vb5 = await page.locator('.book.top').innerText();
  check('WRITING tag + live countdown "ARRIVING IN 14H {m}M"', /WRITING/.test(vb5) && /ARRIVING IN 14H 1[5-9]M/i.test(vb5), vb5);
  await checkStampOneLine(page, `${label} WRITING`);
  await shot(page, `${tag}13-library-writing`);
  await libTo(page, new RegExp(title(db, 'vb-06'), 'i'));
  const vb6 = await page.locator('.book.top').innerText();
  check('REQUESTED tag + "Requested by vedikabhasin · {Mon D}"', /REQUESTED/.test(vb6) && vb6.toLowerCase().includes(('Requested by vedikabhasin · ' + monD(req6.requested_at)).toLowerCase()), vb6);
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  const s6 = await page.textContent('#ghost-sheet');
  check('REQUESTED card detail: "Requested by {Name} · {Mon D}. Vedika confirms timing."', s6.includes('Requested by vedikabhasin · ' + monD(req6.requested_at) + '. Vedika confirms timing.'), s6);
  await page.click('[data-close="ghost-sheet"]');
  await libTo(page, new RegExp(title(db, 'vb-02'), 'i'));
  const vb2 = await page.locator('.book.top').innerText();
  check('UP NEXT tag on a liked, unrequested card', /UP NEXT/.test(vb2), vb2);
  await checkLegible(page, 'vb-02 up next');
  await shot(page, `${tag}14-library-upnext`);
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  const card2 = db.cards.find((c) => c.card_key === 'vb-02');
  const sh = await page.evaluate(() => ({ fmt: (document.querySelector('.fmt-opt.on') || {}).dataset?.fmt, btn: document.getElementById('write-btn').textContent,
    disabled: document.getElementById('write-btn').disabled, cost: !document.getElementById('write-cost').hidden, text: document.getElementById('ghost-sheet').innerText }));
  check('UP NEXT sheet: "Request this", format preselected to the card\'s, no credits', sh.btn === 'Request this' && sh.fmt === card2.format && !sh.disabled && !sh.cost && !/credit/i.test(sh.text), JSON.stringify(sh));
  await shot(page, `${tag}15-sheet-request`);
  const fb = db.forms.length;
  await page.click('#write-btn'); // one tap
  await page.waitForSelector('#ghost-tag .status-tag.st-requested');
  const after2 = await page.evaluate(() => ({ stamp: !!document.querySelector('#ghost-tag .status-tag.stamp-in'), copy: document.getElementById('ghost-copy').textContent, box: document.getElementById('write-box').hidden }));
  const a2 = db.articles.find((a) => a.card_id === cardId('vb-02'));
  check('Request this: one tap, stamp lands, sheet reads "Requested by {Name} · {Mon D}. Vedika confirms timing."', a2 && a2.status === 'requested' && a2.requested_by === OWNER &&
    (after2.stamp || !mobile) && after2.box && after2.copy === 'Requested by vedikabhasin · ' + monD(a2.requested_at) + '. Vedika confirms timing.', JSON.stringify(after2));
  await wait(300);
  check('Request this: portal-request form posted once', db.forms.length === fb + 1 && db.forms[fb].card_title === title(db, 'vb-02'), JSON.stringify(db.forms.slice(fb)));
  await wait(600);
  await shot(page, `${tag}16-sheet-requested`);
  await page.click('[data-close="ghost-sheet"]');
  check('Library header updates without a reload: "1 delivered · 2 up next · 3 requested"', (await page.textContent('#lib-count')) === '1 delivered · 2 up next · 3 requested', await page.textContent('#lib-count'));
  const words = await pageText(page);
  check('no "Approved", "Ready to write" or "Approved, not written yet" anywhere', !/Approved|Ready to write/i.test(words), (words.match(/.{0,30}(Approved|Ready to write).{0,30}/i) || [''])[0]);
  // Reader + Mark live.
  await libTo(page, /DELIVERED IN/i);
  await page.click('.book.top');
  await page.waitForSelector('#reader:not([hidden])');
  check('reader: date line uses the delivery stamp', (await page.textContent('#reader-date')).startsWith('Delivered in 19h'));
  await page.click('#live-toggle'); await wait(300);
  check('mark live: live_at stamped', !!db.articles[0].live_at);
  await page.click('[data-close="reader"]');
  await wait(300);
  check('library: small ink "Live" tag', await page.locator('.book.top .live-tag').count() === 1);
  await closeToasts(page);

  // §3 + §7 Hub (unlocked): first tap -> invite (1 seat) -> skip -> Hub.
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  const inv = await page.evaluate(() => ({ title: document.getElementById('invite-title').textContent, sub: document.getElementById('invite-sub').textContent,
    fields: document.querySelectorAll('#invite-form input[type=email]').length, ghosts: document.querySelectorAll('#invite-seat-row .seat.empty').length, seats: document.querySelectorAll('#invite-seat-row .seat:not(.empty)').length }));
  check('first Hub tap: "Who else decides your content?" / "They’ll get a sign-in link. One seat left on your portal."', inv.title === 'Who else decides your content?' &&
    inv.sub === 'They’ll get a sign-in link. One seat left on your portal.' && inv.fields === 1 && inv.ghosts === 1 && inv.seats === 2, JSON.stringify(inv));
  await shot(page, `${tag}17-invite`);
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(1000);
  const hubInfo = await page.evaluate(() => ({
    books: document.querySelectorAll('#hub-canvas .kind-article').length, cards: document.querySelectorAll('#hub-canvas .kind-card').length,
    notes: document.querySelectorAll('#hub-canvas .kind-note').length, texts: document.querySelectorAll('#hub-canvas .kind-text').length,
    locked: document.getElementById('hub-canvas').classList.contains('locked'), toolbar: !document.getElementById('hub-toolbar').hidden,
  }));
  check('Hub unlocked: 5 articles, 2 UP NEXT cards, the 2 texts, notes, toolbar', hubInfo.books === 5 && hubInfo.cards === 2 && hubInfo.texts === 2 && !hubInfo.locked && hubInfo.toolbar && hubInfo.notes === (mobile ? 2 : 0), JSON.stringify(hubInfo));
  check('Hub: card rows saved as kind card', db.hub_items.filter((h) => h.kind === 'card').length === 2);
  if (mobile) {
    check('Hub note: author avatar + linked card title', (await page.locator('#hub-canvas .kind-note').first().textContent()).includes('On: '));
  }
  await shot(page, `${tag}18-hub`);
  await closeToasts(page);
  // Hub card menu: Request this.
  const cardItem = page.locator('#hub-canvas .kind-card').first();
  await cardItem.scrollIntoViewIfNeeded();
  await cardItem.hover();
  await cardItem.locator('.hub-menu-btn').click();
  const menuItems = await page.$$eval('.hub-menu button', (b) => b.map((x) => x.textContent));
  check('Hub card menu on UP NEXT: "Request this"', menuItems[0] === 'Request this', JSON.stringify(menuItems));
  await page.click('.hub-menu button >> text=Request this');
  await page.waitForSelector('#ghost-sheet.open');
  const cardRef = await cardItem.getAttribute('data-ref');
  await page.click('#write-btn');
  await page.waitForSelector('#ghost-tag .status-tag.st-requested');
  await page.click('[data-close="ghost-sheet"]');
  await wait(400);
  const conv = db.hub_items.find((h) => h.ref_id === db.articles.find((a) => a.card_id === cardRef)?.id);
  check('requested from the Hub: the card item became the article in place', conv && conv.kind === 'article' && db.hub_items.filter((h) => h.kind === 'card').length === 1, JSON.stringify(conv));
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
  check('drag: x/y saved on drop, comes to front', moved && moved.z === Math.max(...db.hub_items.map((h) => h.z)) && (moved.x !== before.x || moved.y !== before.y));
  await page.click('[data-hub="pin"]');
  await page.click('[data-emoji="🔥"]');
  await page.locator(`#hub-canvas .hub-item[data-id="${bid}"]`).scrollIntoViewIfNeeded();
  const nb2 = await page.locator(`#hub-canvas .hub-item[data-id="${bid}"]`).boundingBox();
  await page.mouse.click(nb2.x + 60, nb2.y + 50);
  await wait(300);
  const pin = db.hub_items.find((h) => h.kind === 'emoji');
  check('pin: dropped onto an item stays attached', pin && pin.ref_id === bid);
  // Hide the Cadence text (it sits under Rules' bottom edge), then show hidden.
  const cadId = 'e49f6c62-af3d-438d-8ee8-7adb49e6657f';
  const cad = page.locator(`#hub-canvas .hub-item[data-id="${cadId}"]`);
  await cad.scrollIntoViewIfNeeded();
  await cad.hover();
  await cad.locator('.hub-menu-btn').click();
  await page.click('.hub-menu button >> text=Hide');
  await wait(250);
  check('hide: saved hidden', db.hub_items.find((h) => h.id === cadId).hidden === true);
  await page.click('[data-hub="hidden"]');
  await wait(300);
  const cover = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#hub-canvas > .hub-item'));
    const hid = els.filter((e) => e.classList.contains('is-hidden'));
    const vis = els.filter((e) => !e.classList.contains('is-hidden'));
    const ov = (a, b) => { const r = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom; };
    return { hidden: hid.length, overlaps: hid.some((x) => vis.some((v) => ov(x, v))), under: Math.max(...hid.map((e) => +e.style.zIndex)) < Math.min(...vis.map((e) => +e.style.zIndex)) };
  });
  check('unhide mode: hidden items never cover visible ones (moved clear, and under)', cover.hidden === 1 && !cover.overlaps && cover.under, JSON.stringify(cover));
  check('unhide mode: the display move is not saved', db.hub_items.find((h) => h.id === cadId).y === 220);
  await shot(page, `${tag}19-hub-show-hidden`);
  await page.locator(`#hub-canvas .hub-item[data-id="${cadId}"] .hub-unhide`).click();
  await wait(250);
  check('unhide: saved visible', db.hub_items.find((h) => h.id === cadId).hidden === false);
  await page.click('[data-hub="hidden"]');
  await page.click('[data-hub="done"]');
  await page.waitForSelector('#screen-library.on');
  await wait(700);
  await page.click('#pencil-sticker');
  await page.waitForSelector('#screen-hub.on');
  check('second pencil tap: straight into the Hub (no invite)', await page.locator('#invite-modal.open').count() === 0);

  const ev = await phEvents(page);
  const captured = new Set(ev.filter((c) => c[0] === 'capture').map((c) => c[1]));
  ['feed_swipe', 'overlap_seen', 'moved_up', 'card_requested', 'card_detail_opened', 'library_open', 'marked_live', 'hub_tapped', 'hub_opened', 'hub_item_moved', 'hub_pin_added', 'hub_item_hidden', 'note_added'].forEach((n) =>
    check('posthog: ' + n, captured.has(n) || (!mobile && n === 'note_added')));
  check('posthog: identify by member id, never email', ev.some((c) => c[0] === 'identify' && c[1] === OWNER) && !JSON.stringify(ev).includes('@'));
  check(`${label}: no page errors`, !errors.length, errors.join(' | '));
  if (mobile) fs.writeFileSync(path.join(OUT, 'posthog-calls.json'), JSON.stringify(ev, null, 1));
  await ctx.close();
}

console.log('\n=== Internal switches (375px)');
{
  let p = await newPage(browser, { mobile: true, db: vedikaDb(), token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?hub=locked');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  await p.page.waitForSelector('#invite-modal.open');
  check('?hub=locked: the invite pop-up comes first', true);
  await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  await wait(900);
  const lk = await p.page.evaluate(() => {
    const talk = document.getElementById('hub-talk');
    return { locked: document.getElementById('hub-canvas').classList.contains('locked'), overlay: !document.getElementById('hub-overlay').hidden,
      toolbar: document.getElementById('hub-toolbar').hidden, text: document.getElementById('hub-overlay').innerText,
      href: talk.getAttribute('href'), target: talk.target, btns: Array.from(document.querySelectorAll('#hub-overlay .btn')).map((b) => b.textContent) };
  });
  check('?hub=locked: blurred canvas, lock modal, no toolbar', lk.locked && lk.overlay && lk.toolbar, JSON.stringify(lk));
  check('lock modal: "Your Hub opens with your first content pack." + body', lk.text.includes('Your Hub opens with your first content pack.') && lk.text.includes('It’s where drafts, edits, and your team’s notes come together.'), lk.text);
  check('lock modal: "Talk it through" (booking link, new tab) + "Back to Library", no price', lk.btns.join('|') === 'Talk it through|Back to Library' &&
    lk.href === bookingFor('vedika-bhasin-ycfogw') && lk.target === '_blank' && !/\$|credit/i.test(lk.text), JSON.stringify(lk));
  check('?hub=locked: Invite button above the blur and modal, clickable', await topCenterHit(p.page, '#hub-invite'));
  const own = await p.page.evaluate(() => Array.from(document.querySelectorAll('#hub-canvas .hub-item')).map((e) => e.dataset.ref || e.dataset.id));
  const dbv = p.mock.db;
  const real = new Set([...dbv.articles.map((a) => a.id), ...dbv.cards.map((c) => c.id), ...dbv.notes.map((n) => n.id), ...dbv.hub_items.map((h) => h.id)]);
  check('locked background: only the company\'s own items, nothing written', own.length > 0 && own.every((id) => real.has(id)) && dbv.hub_items.length === 2, JSON.stringify(own));
  await shot(p.page, 's01-hub-locked');
  await p.page.click('#hub-invite');
  await p.page.waitForSelector('#invite-modal.open');
  check('locked Hub: header Invite opens the pop-up', true);
  await p.page.click('[data-action="invite-skip"]');
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
  await p.page.fill('#invite-email', 'collaborator@blendxr.com');
  await p.page.click('#invite-btn');
  await p.page.waitForFunction(() => document.querySelector('#invite-msg').classList.contains('ok'));
  const ok = await p.page.evaluate(() => ({ msg: document.getElementById('invite-msg').textContent, open: document.getElementById('invite-modal').classList.contains('open'),
    field: document.getElementById('invite-email').value, sub: document.getElementById('invite-sub').textContent, form: document.getElementById('invite-form').hidden,
    seats: Array.from(document.querySelectorAll('#invite-seat-row .seat:not(.empty)')).map((s) => s.title), skip: document.querySelector('[data-action="invite-skip"]').textContent }));
  check('invite success: stays open, field clears, "Invite sent to {email}."', ok.open && ok.field === '' && ok.msg === 'Invite sent to collaborator@blendxr.com.', JSON.stringify(ok));
  check('invite success: new seat with the derived name, seat line updates (0 left: form goes, "Done")', ok.seats.includes('Collaborator') && ok.sub === 'They’ll get a sign-in link.' && ok.form && ok.skip === 'Done', JSON.stringify(ok));
  await shot(p.page, 's02-invite-sent');
  await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  check('3/3 seats: Hub Invite button hidden, no seat ghosts', await p.page.locator('#hub-invite[hidden]').count() === 1 && await p.page.locator('#hub-seats .seat.empty').count() === 0 && p.mock.db.members.length === 3);
  await p.ctx.close();

  const db3 = vedikaDb();
  db3.members[0].onboarding = { feed_intro: true, library_glow: true, pencil_glow: true, hub_invite_seen: true, lines: { hub: true } };
  p = await newPage(browser, { mobile: true, db: db3, token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?onboarding=reset');
  await p.page.waitForSelector('#screen-feed.on');
  await wait(400);
  check('?onboarding=reset: flags cleared and saved', JSON.stringify(db3.members[0].onboarding) === '{}', JSON.stringify(db3.members[0].onboarding));
  check('?onboarding=reset: first-visit bubble again, param removed', await p.page.locator('#bubble:not([hidden])').count() === 1 && !(await p.page.evaluate(() => location.search)).includes('onboarding'));
  await p.ctx.close();

  // A client company ignores the switches.
  const db4 = vedikaDb({ company: { is_internal: false } });
  p = await newPage(browser, { mobile: true, db: db4, token: 'tok-vedika' });
  await p.page.goto(BASE + '/portal?hub=locked&onboarding=reset');
  await p.page.waitForSelector('#screen-feed.on');
  await dismissBubbles(p.page);
  await p.page.click('#switch-library');
  await p.page.click('#pencil-sticker');
  if (await p.page.locator('#invite-modal.open').count()) await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  check('client company: ?hub=locked ignored (hub_unlocked stays open)', await p.page.locator('#hub-canvas.locked').count() === 0);
  await p.ctx.close();

  // prefers-reduced-motion: the final frame.
  p = await newPage(browser, { mobile: true, db: vedikaDb(), token: 'tok-vedika', reduced: true });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await dismissBubbles(p.page);
  await dotTo(p.page, title(sharedDb, 'vb-02'));
  await p.page.click('.ctl[data-decide="like"]');
  await p.page.waitForSelector('#reveal:not([hidden])');
  const still = await p.page.evaluate(() => ({ running: document.getElementById('reveal').getAnimations({ subtree: true }).length, cls: document.getElementById('reveal').className }));
  check('reduced motion: reveal shows the final frame (no animations)', still.running === 0 && still.cls.includes('rv-static'), JSON.stringify(still));
  await shot(p.page, 's04-reveal-reduced-motion');
  await p.ctx.close();
}

const inviteTry = async (page, email, dbRef, knob) => {
  if (knob && knob.error) dbRef.inviteError = knob;
  if (knob && knob.results) dbRef.inviteResults = knob.results;
  await page.fill('#invite-email', email);
  await page.click('#invite-btn');
  await page.waitForFunction(() => /err|ok/.test(document.querySelector('#invite-msg').className));
  return page.textContent('#invite-msg');
};
const bannerCheck = async (page, view, slug) => {
  const b = await page.evaluate(() => {
    const el = document.getElementById('closed-banner');
    const a = el.querySelector('a');
    return { shown: !el.hidden && el.getBoundingClientRect().height > 0, text: el.textContent, href: a && a.getAttribute('href'), target: a && a.target };
  });
  check(`closed window, ${view}: banner "Your portal window closed. Pick up where you left off." + "Book 15 minutes"`, b.shown &&
    b.text === 'Your portal window closed. Pick up where you left off. Book 15 minutes' && b.href === bookingFor(slug) && b.target === '_blank', JSON.stringify(b));
};

console.log('\n=== Acme (375px): opened on the call, 30-day window, Hub locked');
{
  const db = acmeDb();
  const p = await newPage(browser, { mobile: true, db, token: 'tok-acme' });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await tooltipClear(page, 'Acme 375x812');
  await dismissBubbles(page);
  check('window open: no banner', await page.locator('#closed-banner:not([hidden])').count() === 0);
  check('claimed sales-page swipes count as the owner\'s: 5 cards · 0 unread', (await page.textContent('#feed-count')) === '5 cards · 0 unread', await page.textContent('#feed-count'));
  await page.click('[data-action="show-history"]');
  const hist = await page.evaluate(() => Array.from(document.querySelectorAll('#history-log .hist-row')).map((r) => r.innerText));
  check('Feed history shows the 5 claimed swipes (sales page, now the owner\'s)', hist.length === 5 && hist.every((t) => t.toLowerCase().includes('sales page') && t.startsWith('You')), JSON.stringify(hist));
  await page.click('[data-tab="upnext"]');
  const un = await page.textContent('#history-upnext');
  check('liked ones are UP NEXT (the fast-tracked one is already writing)', un.includes('Robots That Ask Before They Move') && un.includes('Uptime Is a Staffing Problem') && !un.includes('Why Warehouse Pilots Stall'), un);
  await page.click('[data-action="close-history"]');
  // Library + request from the sheet with another format.
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await dismissBubbles(page);
  check('Library header "1 DELIVERED · 2 UP NEXT" (no REQUESTED at 0), no credits', (await page.textContent('#lib-count')) === '1 delivered · 2 up next', await page.textContent('#lib-count'));
  await checkStampOneLine(page, 'Acme DELIVERED');
  await libTo(page, /Robots That Ask/);
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  check('format defaults to the card\'s (pillar)', (await page.getAttribute('.fmt-opt.on', 'data-fmt')) === 'pillar');
  await page.click('.fmt-opt[data-fmt="insight"]');
  await page.click('#write-btn');
  await page.waitForSelector('#ghost-tag .status-tag.st-requested');
  await wait(300);
  const ra = db.articles.find((a) => a.title === 'Robots That Ask Before They Move');
  const fa = db.forms.at(-1);
  check('request_card with the chosen format, requested by Dana', ra && ra.status === 'requested' && ra.format === 'insight' && ra.requested_by === ACME_OWNER, JSON.stringify(ra));
  check('portal-request: company, slug, card_title, format, requester_name, requester_email', fa && fa.company === 'Acme Robotics' && fa.slug === 'acme-q1w2e3' &&
    fa.card_title === 'Robots That Ask Before They Move' && fa.format === 'insight' && fa.requester_name === 'Dana' && fa.requester_email === 'dana@acme.co', JSON.stringify(fa));
  await shot(page, 'c01-requested-from-library');
  await page.click('[data-close="ghost-sheet"]');
  check('no credit UI anywhere with CREDITS_ENABLED off', !/credit|\$\d/i.test(await pageText(page)));

  // §6 Empty feed.
  await page.click('#switch-feed');
  await page.waitForSelector('#screen-feed.on');
  const layers = [];
  for (let i = 0; i < 5; i++) {
    layers.push(await page.locator('#card-stage .card').count());
    if (i === 3) {
      check('last 2 cards: the remaining dots pulse once', await page.locator('#dots .dot.pulse').count() === 2);
      await shot(page, 'c02-feed-last-two');
    }
    await page.click('[data-action="feed-next"]');
    await wait(300);
  }
  check('stack thins: one fewer layer on each of the last 2 cards', layers.join(',') === '3,3,3,2,1', layers.join(','));
  await page.waitForSelector('#card-stage .caught-up');
  const cu = await page.evaluate(() => ({ text: document.querySelector('.caught-up').innerText, paper: !!document.querySelector('.cu-paper'),
    grid: getComputedStyle(document.querySelector('.cu-paper')).backgroundImage.includes('repeating-linear-gradient'),
    bubbles: Array.from(document.querySelectorAll('.cu-bubble')).map((b) => ({ t: b.innerText, av: !!b.querySelector('.av svg'), open: b.classList.contains('open') })) }));
  const acmeDrop = expectedDrop(db.companies[0].first_opened_at, 'UTC');
  check(`empty feed: paper card with a faint grid, "5 new on ${acmeDrop}" (real next-drop count) + live countdown`, cu.paper && cu.grid && cu.text.includes('5 new on ' + acmeDrop) && /IN (\d+D \d+H|\d+H \d+M)/i.test(cu.text), cu.text);
  check('empty feed: "Lee hasn’t seen 5 of these." with Lee\'s avatar, and "Seat 3 is open." dashed', cu.bubbles.some((b) => b.t === 'Lee hasn’t seen 5 of these.' && b.av) &&
    cu.bubbles.some((b) => b.t.includes('Seat 3 is open.') && b.open) && !cu.text.includes('Dana hasn'), JSON.stringify(cu.bubbles));
  await page.click('.cu-bubble >> text=Lee hasn’t seen 5 of these.');
  const hl = await page.evaluate(() => { const s0 = document.querySelector('.cu-seats .seat.hl'); return s0 ? s0.title : null; });
  check('tapping a bubble only highlights that seat', hl === 'Lee' && db.notes.length === 0 && await page.locator('#invite-modal.open').count() === 0, String(hl));
  await shot(page, 'c03-empty-feed');
  await page.click('.cu-bubble.open');
  await page.waitForSelector('#invite-modal.open');
  check('open-seat bubble opens the invite pop-up: "One seat left on your portal."', (await page.textContent('#invite-sub')) === 'They’ll get a sign-in link. One seat left on your portal.');
  // Every invite error, once.
  const errs = {
    invalid: await inviteTry(page, 'not-an-email', db),
    self: await inviteTry(page, 'dana@acme.co', db),
    invalidSrv: await inviteTry(page, 'new@acme.co', db, { status: 400, error: 'invalid_email' }),
    selfSrv: await inviteTry(page, 'new@acme.co', db, { status: 400, error: 'self_invite' }),
    already: await inviteTry(page, 'lee@acme.co', db),
    alreadyRow: await inviteTry(page, 'new@acme.co', db, { results: [{ status: 'already_member' }] }),
    seat: await inviteTry(page, 'new@acme.co', db, { status: 409, error: 'seat_limit' }),
    session: await inviteTry(page, 'new@acme.co', db, { status: 401, error: 'not_signed_in' }),
    failed: await inviteTry(page, 'new@acme.co', db, { status: 502, error: 'failed' }),
    noEmail: await inviteTry(page, 'new@acme.co', db, { results: [{ status: 'added_no_email' }] }),
  };
  check('invite errors: exact copy per code', errs.invalid === 'That email doesn’t look right.' && errs.invalidSrv === errs.invalid &&
    errs.self === 'That’s you. Invite someone else.' && errs.selfSrv === errs.self &&
    errs.already === 'They’re already on your portal.' && errs.alreadyRow === errs.already &&
    errs.seat === 'All 3 seats are taken.' && errs.session === 'Your session expired. Sign in again.' &&
    errs.failed === 'We couldn’t send that invite. Try again in a minute.' && errs.noEmail === errs.failed, JSON.stringify(errs, null, 1));
  await shot(page, 'c04-invite-error');
  await page.click('[data-action="invite-skip"]');
  // First Hub tap: invite first, then the lock modal.
  await page.click('#switch-library');
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(900);
  const lock = await page.evaluate(() => ({ blur: document.getElementById('hub-canvas').classList.contains('locked'), modal: !document.getElementById('hub-overlay').hidden,
    text: document.getElementById('hub-overlay').innerText, href: document.getElementById('hub-talk').getAttribute('href'),
    invite: !document.getElementById('hub-invite').hidden, ghosts: document.querySelectorAll('#hub-seats .seat.empty').length,
    items: document.querySelectorAll('#hub-canvas .hub-item').length }));
  check('locked Hub (no credits): lock modal with "Talk it through" to the booking page', lock.blur && lock.modal && lock.text.includes('Your Hub opens with your first content pack.') && lock.href === bookingFor('acme-q1w2e3'), JSON.stringify(lock));
  check('locked Hub: Invite + one "+ seat" ghost in the header, above the blur', lock.invite && lock.ghosts === 1 && await topCenterHit(page, '#hub-invite') && await topCenterHit(page, '#hub-seats .seat.empty'), JSON.stringify(lock));
  check('locked Hub: the company\'s own items only, nothing written', lock.items === 4 && db.hub_items.length === 0, JSON.stringify(lock));
  await shot(page, 'c05-locked-hub');
  await page.click('#hub-seats .seat.empty');
  await page.waitForSelector('#invite-modal.open');
  check('"+ seat" ghost opens the same pop-up', true);
  await inviteTry(page, 'kim@acme.co', db);
  await page.click('[data-action="invite-skip"]');
  await wait(200);
  check('3/3 after the invite: header Invite hidden, the new seat shows', await page.locator('#hub-invite[hidden]').count() === 1 && await page.locator('#hub-seats .seat[title="Kim"]').count() === 1);
  const unexpected = p.errors.filter((e) => !/status of (409|400|401|502)/.test(e));
  check('Acme: no page errors', !unexpected.length, unexpected.join(' | '));
  await p.ctx.close();
}

console.log('\n=== Three seats: majority pair, or Split when all differ');
{
  const db = acmeDb();
  const CO = db.companies[0].id;
  db.members.push({ id: 'a1000000-0000-0000-0000-000000000003', company_id: CO, user_id: 'u-kim', role: 'member', display_name: 'Kim', avatar_shape: 'ghost', onboarding: {}, created_at: new Date().toISOString(), email: 'kim@acme.co' });
  const add = (i, member, action) => db.decisions.push({ id: 'x' + db.decisions.length, company_id: CO, card_id: db.cards[i].id, member_id: member, action, updated_at: new Date().toISOString() });
  add(3, 'a1000000-0000-0000-0000-000000000002', 'like'); add(3, 'a1000000-0000-0000-0000-000000000003', 'pass'); // ac-04: Dana like, Lee like, Kim pass
  add(4, 'a1000000-0000-0000-0000-000000000002', 'pass'); add(4, 'a1000000-0000-0000-0000-000000000003', 'like'); // ac-05: Dana save, Lee pass, Kim like
  const p = await newPage(browser, { mobile: true, db, token: 'tok-acme' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await dismissBubbles(p.page);
  await dotTo(p.page, 'Uptime Is a Staffing Problem');
  await p.page.waitForSelector('#reveal:not([hidden])');
  const r1 = await p.page.evaluate(() => ({ cls: document.getElementById('reveal').className, names: Array.from(document.querySelectorAll('.rv-name')).map((n) => n.textContent) }));
  check('3 seats, like + like + pass: the majority pair -> "Two yeses"', r1.cls.includes('rv-agree') && r1.names.join(',') === 'You,Lee', JSON.stringify(r1));
  await p.page.click('#reveal .btn-secondary');
  await dotTo(p.page, 'What Our Night Shift Taught the Arm');
  await p.page.waitForSelector('#reveal:not([hidden])');
  check('3 seats, save + pass + like: all differ -> Split', (await p.page.getAttribute('#reveal', 'class')).includes('rv-split'));
  await shot(p.page, 'c06-three-seat-split');
  await p.ctx.close();
}

console.log('\n=== Acme after the window closed (375px)');
{
  const db = acmeDb({ expired: true });
  const CO = db.companies[0].id;
  // A drop that landed after the window closed: it must not appear.
  db.cards.push({ id: 'a3000000-0000-0000-0000-000000000099', company_id: CO, card_key: 'ac-late', format: 'post', series: null, title: 'Dropped after the window',
    angle: 'Late.', evidence: 'Late.', tags: [], sources: [], drop_date: new Date().toISOString().slice(0, 10), sort_order: 99 });
  // Lee fast-tracked ac-01; Dana (no call on it yet) will fast-track it too.
  db.decisions = db.decisions.filter((d) => d.card_id !== db.cards[0].id);
  db.decisions.push({ id: 'x-lee', company_id: CO, card_id: db.cards[0].id, member_id: 'a1000000-0000-0000-0000-000000000002', action: 'fasttrack', updated_at: new Date().toISOString() });
  const p = await newPage(browser, { mobile: true, db, token: 'tok-acme' });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await dismissBubbles(page);
  await bannerCheck(page, 'Feed', 'acme-q1w2e3');
  check('closed: new drops stop (5 cards, the late one hidden)', (await page.textContent('#feed-count')).startsWith('5 cards') &&
    !(await page.evaluate(() => Array.from(document.querySelectorAll('#dots .dot')).some((d) => (d.getAttribute('aria-label') || '').includes('Dropped after')))), await page.textContent('#feed-count'));
  await shot(page, 'x01-closed-feed');
  // Swiping still works.
  await dotTo(page, 'Robots That Ask Before They Move');
  await page.click('.ctl[data-decide="fasttrack"]');
  await page.waitForSelector('#reveal.rv-now:not([hidden])');
  const rv = await page.evaluate(() => { const b = document.querySelector('#reveal .btn-primary'); return { disabled: b.disabled, title: b.title, tip: (document.getElementById('rv-tip') || {}).textContent }; });
  check('closed: swiping still works (decision saved)', db.decisions.find((d) => d.card_id === db.cards[0].id && d.member_id === ACME_OWNER).action === 'fasttrack');
  check('closed: "Request it" disabled with "Your window closed. Book 15 minutes to keep going."', rv.disabled && rv.title === CLOSED_TIP && rv.tip === CLOSED_TIP, JSON.stringify(rv));
  await wait(1200);
  await shot(page, 'x02-closed-reveal');
  await page.click('#reveal .btn-secondary');
  await page.click('[data-action="show-history"]');
  await bannerCheck(page, 'History', 'acme-q1w2e3');
  check('closed: Feed history readable', (await page.textContent('#history-log')).includes('Robots That Ask'));
  await page.click('[data-action="close-history"]');
  await page.click('#switch-library');
  await page.waitForSelector('#screen-library.on');
  await dismissBubbles(page);
  await bannerCheck(page, 'Library', 'acme-q1w2e3');
  await libTo(page, /UP NEXT/);
  await page.click('.book.top');
  await page.waitForSelector('#ghost-sheet.open');
  const dis = await page.evaluate(() => { const b = document.getElementById('write-btn'); return { disabled: b.disabled, title: b.title, msg: document.getElementById('write-msg').textContent }; });
  check('closed: "Request this" disabled with the tooltip, reason shown', dis.disabled && dis.title === CLOSED_TIP && dis.msg === CLOSED_TIP, JSON.stringify(dis));
  await shot(page, 'x03-closed-request-disabled');
  await page.click('[data-close="ghost-sheet"]');
  await libTo(page, /DELIVERED IN/i);
  await page.click('.book.top');
  await page.waitForSelector('#reader:not([hidden])');
  check('closed: delivered pieces stay readable; Mark live hidden', (await page.textContent('#reader-html')).includes('Delivered body.') && await page.locator('#live-toggle[hidden]').count() === 1);
  await page.click('[data-close="reader"]');
  await page.click('#pencil-sticker');
  if (await page.locator('#invite-modal.open').count()) await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await bannerCheck(page, 'Hub', 'acme-q1w2e3');
  await page.click('[data-action="back-to-library"]');
  await page.click('#switch-feed');
  await toEnd(page);
  await page.waitForSelector('#card-stage .caught-up');
  const cu = await page.textContent('.cu-paper');
  check('closed: the empty feed offers the call, not a new drop', cu.includes('Pick up where you left off.') && cu.includes('Book 15 minutes') && !cu.includes('new on'), cu);
  check('closed: request_card never called', !(db.requests || []).length);
  check('closed: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}

console.log('\n=== Credits added by hand (375px): the Hub opens, still no credit UI');
{
  const db = acmeDb({ credits: true });
  const p = await newPage(browser, { mobile: true, db, token: 'tok-acme' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await dismissBubbles(p.page);
  await p.page.click('#switch-library');
  await dismissBubbles(p.page);
  check('credits: Library header has no balance', !/credit/i.test(await p.page.textContent('#lib-count')));
  await p.page.click('#pencil-sticker');
  if (await p.page.locator('#invite-modal.open').count()) await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  await wait(600);
  check('a credit grant opens the Hub', await p.page.locator('#hub-canvas.locked').count() === 0 && await p.page.locator('#hub-overlay[hidden]').count() === 1);
  check('credits: nothing says credits, "Ready to write" or a price', !/credit|Ready to write|\$\d/i.test(await pageText(p.page)));
  await p.ctx.close();
}

console.log('\n=== RPR as it is live (375px): canceled, no window, test seat + 3 empty');
{
  const db = rprDb();
  const p = await newPage(browser, { mobile: true, db, token: 'tok-rpr' });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-feed.on');
  await dismissBubbles(page);
  await bannerCheck(page, 'RPR Feed', 'rpr-k7m2qx');
  check('RPR: 10 cards, swipeable', (await page.textContent('#feed-count')) === '10 cards · 10 unread' && await page.locator('.ctl[data-decide="like"]:enabled').count() === 1, await page.textContent('#feed-count'));
  await shot(page, 'r01-rpr-feed');
  await page.click('[data-action="feed-next"]');
  await page.click('.ctl[data-decide="like"]');
  await wait(500);
  check('RPR: a swipe is saved', db.decisions.length === 1);
  await toEnd(page);
  await page.waitForSelector('#card-stage .caught-up');
  const cu = await page.textContent('#card-stage .caught-up');
  check('RPR empty feed: seats 2 to 4 open', ['Seat 2 is open.', 'Seat 3 is open.', 'Seat 4 is open.'].every((t) => cu.includes(t)), cu);
  await page.click('#switch-library');
  await dismissBubbles(page);
  check('RPR Library: "0 DELIVERED · 1 UP NEXT"', (await page.textContent('#lib-count')) === '0 delivered · 1 up next', await page.textContent('#lib-count'));
  await page.click('#pencil-sticker');
  await page.waitForSelector('#invite-modal.open');
  check('RPR invite: "Three seats left on your portal." (seat_limit 4)', (await page.textContent('#invite-sub')) === 'They’ll get a sign-in link. Three seats left on your portal.');
  await page.click('[data-action="invite-skip"]');
  await page.waitForSelector('#screen-hub.on');
  await wait(700);
  check('RPR Hub: locked, Invite above the blur', await page.locator('#hub-canvas.locked').count() === 1 && await topCenterHit(page, '#hub-invite'));
  await shot(page, 'r02-rpr-hub-locked');
  check('RPR: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();

  // Drop day in the viewer's timezone: first opened Friday UTC, Saturday in Tokyo -> Monday.
  for (const tz of ['UTC', 'Asia/Tokyo']) {
    const d = acmeDb();
    d.companies[0].first_opened_at = rprDb().companies[0].first_opened_at;
    const p2 = await newPage(browser, { mobile: true, db: d, token: 'tok-acme', timezoneId: tz });
    await p2.page.goto(BASE + '/portal');
    await p2.page.waitForSelector('#screen-feed.on');
    await dismissBubbles(p2.page);
    await toEnd(p2.page);
    await p2.page.waitForSelector('#card-stage .caught-up');
    const t = await p2.page.textContent('.cu-title');
    const want = expectedDrop(d.companies[0].first_opened_at, tz);
    check(`drop day from the shared helper in the viewer's timezone (${tz}): "5 new on ${want}"`, (tz === 'UTC' ? want.startsWith('Friday') : want.startsWith('Monday')) && t === '5 new on ' + want, t);
    await p2.ctx.close();
  }
}

console.log('\n=== Layout at every height from 600px');
for (const [w, hgt] of [[375, 600], [375, 667], [375, 812], [1280, 700]]) {
  const p = await newPage(browser, { mobile: w === 375, db: acmeDb(), token: 'tok-acme', height: hgt });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await p.page.waitForSelector('#bubble:not([hidden])');
  await tooltipClear(p.page, `${w}x${hgt}`);
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
    return { text: document.querySelector('.lib-hint').textContent, hintBottom: hint.bottom, hintTop: hint.top, swTop: sw.top, visible: hit && hit.closest('.lib-nav') !== null, bookBottom: books[0] ? books[0].bottom : 0 };
  });
  check(`${w}x${hgt}: "Swipe to shuffle. Tap to open." above the Feed/Library switch, uncovered`, /swipe to shuffle\. tap to open\./i.test(g.text) && g.hintBottom <= g.swTop - 4 && g.hintTop >= 0 && g.visible && g.bookBottom <= g.hintTop, JSON.stringify(g));
  await checkStampOneLine(p.page, `${w}x${hgt} DELIVERED`);
  if (hgt === 600) await shot(p.page, 'l01-library-600');
  await p.ctx.close();
}

console.log('\n=== blendbases@gmail.com (375px): the other side');
{
  const p = await newPage(browser, { mobile: true, db: sharedDb, token: 'tok-blend' });
  await p.page.goto(BASE + '/portal');
  await p.page.waitForSelector('#screen-feed.on');
  await wait(300);
  await dismissBubbles(p.page);
  await dotTo(p.page, title(sharedDb, 'vb-02'));
  await p.page.waitForSelector('#reveal.rv-agree:not([hidden])');
  const t1 = await p.page.textContent('#reveal');
  check('blendbases: "Two yeses" on first view of vb-02 (You + vedikabhasin)', t1.includes('Two yeses. Next in line.') && t1.includes('vedikabhasin'), t1);
  await wait(1250);
  await shot(p.page, 'b01-agree-other-side');
  await p.page.click('#reveal .btn-secondary');
  await dotTo(p.page, title(sharedDb, 'vb-03'));
  await p.page.waitForSelector('#reveal.rv-split:not([hidden])');
  await wait(1250);
  const nameFits = await p.page.$$eval('#reveal .rv-name', (els) => els.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && e.scrollWidth <= e.clientWidth; }));
  check('blendbases: reveal name tags fit at 375px', nameFits);
  await p.page.click('#reveal .btn-primary');
  await p.page.waitForSelector('#note-sheet.open');
  check('blendbases: Make your case prefilled "Passed because " (their own swipe)', (await p.page.inputValue('#note-input')) === 'Passed because ');
  await p.page.click('[data-close="note-sheet"]');
  await dotTo(p.page, title(sharedDb, 'vb-06'));
  await p.page.waitForSelector('#reveal.rv-now:not([hidden])');
  const rn = await p.page.evaluate(() => ({ disabled: document.querySelector('#reveal .btn-primary').disabled, tip: (document.getElementById('rv-tip') || {}).textContent }));
  check('blendbases: "Request it" on a card Vedika already requested is disabled ("Already requested.")', rn.disabled && rn.tip === 'Already requested.', JSON.stringify(rn));
  await p.page.click('#reveal .btn-secondary');
  await p.page.click('#switch-library');
  await dismissBubbles(p.page);
  await libTo(p.page, new RegExp(title(sharedDb, 'vb-03'), 'i'));
  await p.page.click('.book.top');
  await p.page.waitForSelector('#ghost-sheet.open');
  check('notes readable on card detail in the Library', (await p.page.textContent('#ghost-notes')).includes('Liked because Grok is my best proof'));
  await shot(p.page, 'b02-library-notes');
  await p.page.click('[data-close="ghost-sheet"]');
  await p.page.click('#pencil-sticker');
  if (await p.page.locator('#invite-modal.open').count()) await p.page.click('[data-action="invite-skip"]');
  await p.page.waitForSelector('#screen-hub.on');
  await wait(900);
  check('blendbases: sees Vedika\'s notes in the Hub', (await p.page.textContent('#hub-canvas')).includes('Grok is my best proof'));
  check('blendbases: no page errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
}

console.log('\n=== Sign in with a code (375px)');
{
  const db = vedikaDb();
  const p = await newPage(browser, { mobile: true, db, token: null });
  const page = p.page;
  await page.goto(BASE + '/portal');
  await page.waitForSelector('#screen-signin.on');
  db.authError = { status: 429 };
  await page.fill('#signin-email', 'vedikabhasin@gmail.com');
  await page.click('#signin-btn');
  await page.waitForFunction(() => document.querySelector('#signin-msg').classList.contains('err'));
  check('send: rate limit -> "Too many tries. Wait a minute and try again."', (await page.textContent('#signin-msg')) === 'Too many tries. Wait a minute and try again.');
  await page.fill('#signin-email', 'VedikaBhasin@gmail.com ');
  await page.click('#signin-btn');
  await page.waitForSelector('#signin-sent:not([hidden])');
  await page.evaluate(() => { document.querySelector('#signin-email').value = 'someone@else.com'; });
  await page.fill('#signin-code', '000 000');
  await page.click('#code-btn');
  await page.waitForFunction(() => document.querySelector('#code-msg').classList.contains('err'));
  check('code: wrong code -> "That code didn’t work. Check the latest email or send a new link." + "Send a new link"',
    (await page.textContent('#code-msg')) === 'That code didn’t work. Check the latest email or send a new link.' && await page.locator('#code-resend:not([hidden])').count() === 1);
  check('code: spaces dropped', (await page.inputValue('#signin-code')) === '000000');
  await shot(page, 'k01-code-wrong');
  const otpBefore = p.mock.log.filter((l) => l.path.startsWith('/auth/v1/otp')).length;
  await page.click('#code-resend');
  await page.waitForFunction(() => document.querySelector('#code-msg').textContent.startsWith('New link sent'));
  const otps = p.mock.log.filter((l) => l.path.startsWith('/auth/v1/otp'));
  check('"Send a new link" sends to the same address', otps.length === otpBefore + 1 && otps.at(-1).body.email === 'vedikabhasin@gmail.com', JSON.stringify(otps.at(-1)));
  db.authError = { status: 429 };
  await page.fill('#signin-code', '123456');
  await page.click('#code-btn');
  await page.waitForFunction(() => document.querySelector('#code-msg').classList.contains('err'));
  check('verify: rate limit -> "Too many tries. Wait a minute and try again."', (await page.textContent('#code-msg')) === 'Too many tries. Wait a minute and try again.');
  // Paste an 8-digit code with spaces: any length works.
  await page.fill('#signin-code', '');
  await page.focus('#signin-code');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', ' 1234 5678 ');
    document.querySelector('#signin-code').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check('paste: spaces trimmed', (await page.inputValue('#signin-code')) === '12345678');
  await page.click('#code-btn');
  await page.waitForSelector('#screen-feed.on');
  const last = p.mock.log.filter((l) => l.path.startsWith('/auth/v1/verify')).at(-1);
  check('code-only sign-in: verifyOtp({ email, token, type: "email" }) with an 8-digit code', last.body.email === 'vedikabhasin@gmail.com' && last.body.token === '12345678' && last.body.type === 'email', JSON.stringify(last.body));
  await shot(page, 'k02-code-signed-in');
  await page.click('#sign-out-btn');
  await page.waitForSelector('#screen-signin.on');
  const logout = p.mock.log.find((l) => l.path.startsWith('/auth/v1/logout'));
  check('sign out: local scope only', logout && /[?&]scope=local\b/.test(logout.path));
  const unexpected = p.errors.filter((e) => !/status of (403|429)/.test(e) && !/logout\?scope=local net::ERR_ABORTED/.test(e));
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
