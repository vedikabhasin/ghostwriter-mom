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
import { vedikaDb, USERS, OWNER, MEMBER, cardId } from './fixture-vedika.mjs';
import { createMock } from './sb-mock.mjs';

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

async function newPage(browser, { mobile, db, token, reduced }) {
  const ctx = await browser.newContext(Object.assign(mobile
    ? { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false }
    : { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }, reduced ? { reducedMotion: 'reduce' } : {}));
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
    await shot(page, shotName);
    return page.textContent('#reveal');
  };
  let txt = await reveal('vb-02', 'like', 'agree', `${tag}06-reveal-agree`);
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
  await checkLegible(page, 'vb-01');
  await shot(page, `${tag}12-library-delivered`);
  await page.click('[data-action="bubble-dismiss"]').catch(() => {});
  await page.click('[data-action="lib-next"]');
  await wait(400);
  const bx = await page.locator('.book.top').innerText();
  check('library: bx-01 ghost, "Approved" stamp + "Approved · not written yet"', bx.includes('APPROVED') && bx.toLowerCase().includes('approved · not written yet'), bx);
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
  check('ghost tap: "Approved, not written yet. Credits open soon." + Notify me', (await page.textContent('#ghost-sheet')).includes('Approved, not written yet. Credits open soon.') && await page.locator('#notify-btn:visible').count() === 1);
  await page.click('[data-close="ghost-sheet"]');
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
  check('first pencil tap: invite pop-up with one field (1 free seat)', await page.locator('#invite-fields input').count() === 1 && (await page.textContent('#invite-sub')).includes('One seat left'));
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
  check('?hub=locked: overlay copy', (await p.page.textContent('#hub-overlay')).includes('Your notes, articles, and ideas, in one place. Unlocks with your first credit pack.'));
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
