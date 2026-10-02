// The swipe2 template end to end in Chromium.
//   node tests/sales/swipe2.test.mjs
// Serves the repo with the generated _redirects and answers Supabase with a
// stateful in-memory stand-in for log_swipe / get_collab_state /
// set_collab_pick / submit_approval, keyed by slug and shared by every
// browser context (each context is another device). Records Netlify form
// posts. Screenshots land in OUT (default tests/sales/shots).
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
// A real-style lead (template routes never notify): a temporary copy of the
// swipe2template config under another slug, removed at the end.
const TEMP = path.join(ROOT, 'clients/beacon-swipe2-test.json');
const tplConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients/swipe2template.json'), 'utf8'));
fs.writeFileSync(TEMP, JSON.stringify({ ...tplConfig, slug: 'beacon-swipe2-test' }, null, 2) + '\n');
const cleanup = () => { try { fs.unlinkSync(TEMP); } catch (_) {} execFileSync('node', ['validate-feeds.js'], { cwd: ROOT, stdio: 'ignore' }); };
process.on('exit', () => { try { fs.unlinkSync(TEMP); } catch (_) {} });
execFileSync('node', ['validate-feeds.js'], { cwd: ROOT, stdio: 'ignore' });

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 600))); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- site
const PORT = 8983, BASE = 'http://localhost:' + PORT;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const rules = fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
const forms = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE), p = decodeURIComponent(u.pathname);
  if (req.method === 'POST') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { forms.push(Object.fromEntries(new URLSearchParams(b))); res.end('ok'); }); return; }
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

// ---- database stand-in
const SLUG = 'beacon-swipe2-test';
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', SLUG + '.json'), 'utf8'));
const title = (id) => CONFIG.cards.find((c) => c.id === id).title;
const db = {};
const co = (slug) => (db[slug] = db[slug] || { decisions: {}, log: [], pick: null, approvals: [] });
const rpcLog = [];
function rpc(name, a) {
  rpcLog.push({ name, ...a });
  const c = co(a.p_slug);
  switch (name) {
    case 'log_swipe': c.log.push({ card_key: a.p_card_key, action: a.p_action, created_at: new Date().toISOString() }); c.decisions[a.p_card_key] = a.p_action; return null;
    case 'get_collab_state': return { decisions: CONFIG.cards.filter((x) => c.decisions[x.id]).map((x) => ({ card_key: x.id, action: c.decisions[x.id] })), log: c.log, pick: c.pick && { ...c.pick, created: undefined }, approval: c.approvals.at(-1) || null };
    case 'set_collab_pick': {
      if (c.pick) return { ...c.pick, created: false };
      const now = Date.now();
      c.pick = { card_key: a.p_card_key, picked_at: new Date(now).toISOString(), deliver_by: new Date(now + 864e5).toISOString(), vedi_reactions: a.p_vedi_reactions || {} };
      return { ...c.pick, created: true };
    }
    case 'submit_approval': c.approvals.push({ card_key: a.p_free_card_key, approved_at: new Date().toISOString() }); return 'ap';
    default: return null;
  }
}

const browser = await chromium.launch();
async function device(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  await ctx.route('https://esm.sh/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: BUNDLE }));
  await ctx.route(/posthog\.com|fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await ctx.route('https://cal.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Cal</title>' }));
  await ctx.route('https://*.supabase.co/**', (r) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: cors });
    const name = new URL(r.request().url()).pathname.split('/').pop();
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(rpc(name, JSON.parse(r.request().postData() || '{}'))) });
  });
  if (opts.local) await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, ['gwm-swipe-' + SLUG, JSON.stringify(opts.local)]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const events = [];
  await page.exposeFunction('__phSink', (n, p) => events.push({ name: n, props: p }));
  await page.addInitScript(() => {
    const hook = () => { const p = window.posthog; if (!Array.isArray(p) || p.__hooked) return; p.__hooked = true; const op = p.push;
      p.push = function (x) { try { if (x && x[0] === 'capture') window.__phSink(x[1], x[2]); } catch (_) {} return op.apply(this, arguments); }; };
    document.addEventListener('DOMContentLoaded', hook); setTimeout(hook, 0);
  });
  return { ctx, page, errors, events };
}
const swipe = async (page, dir) => {
  const b = await page.locator('#card-stage .card[data-depth="0"]').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + (dir === 'right' ? 260 : -260), b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
};
const dots = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#feed-dots .dot')).map((d) => d.className.replace('dot', '').trim() || 'todo'));
const reveal = (page) => page.evaluate(() => { const r = document.getElementById('reveal'); if (r.hidden) return null;
  return { cls: r.className, line: r.querySelector('.rv-line').textContent, names: Array.from(r.querySelectorAll('.rv-name')).map((n) => n.innerText), stamps: Array.from(r.querySelectorAll('.rv-stamp')).map((n) => n.innerText),
    floaters: r.querySelectorAll('.rv-float').length, buttons: r.querySelectorAll('button').length, card: (r.querySelector('.rv-card-title') || {}).textContent, ghost: !!r.querySelector('.rv-left .av-svg'), rays: getComputedStyle(r.querySelector('.rv-bg'), '::before').display }; });

console.log('\n=== Device A: intro, three swipes with live reactions, final screen');
let deliverText = '';
{
  const { ctx, page, errors, events } = await device();
  await page.goto(BASE + '/' + SLUG + '?ph_debug=1');
  await page.waitForSelector('[data-action="start"]', { state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('screen-loading').classList.contains('on'));
  await wait(900);
  const intro = await page.evaluate(() => ({ eyebrow: document.querySelector('.intro-eyebrow').innerText.trim(), co: document.querySelector('.intro-company').innerText.trim(), hello: document.querySelector('.intro-hello').innerText.trim(),
    bold: Array.from(document.querySelectorAll('#intro-offer strong')).map((b) => b.textContent), all: document.getElementById('intro-offer').textContent,
    lines: Array.from(document.querySelectorAll('#intro-offer .intro-line')).map((e) => e.textContent), muted: document.querySelector('#intro-offer .intro-muted').textContent,
    small: parseFloat(getComputedStyle(document.querySelector('#intro-offer .intro-muted')).fontSize) < parseFloat(getComputedStyle(document.getElementById('intro-offer')).fontSize) }));
  check('intro: greeting, "3 DIRECTIONS FOR {company}", button', intro.eyebrow === '3 DIRECTIONS FOR' && intro.co === CONFIG.company && intro.hello === 'Hi ' + CONFIG.contactFirstName + '.', intro);
  check('intro: one paragraph, word for word', intro.all.startsWith('Ghostwriter Mom turns search and AI-citation gaps into technical articles. 3 directions from your product pages, press, and audience searches. Written and edited by a human within 24 hours, no unreviewed AI draft.') && !intro.lines.length, intro.all);
  check('intro: the two phrases in bold', JSON.stringify(intro.bold) === JSON.stringify(['search and AI-citation gaps into technical articles', 'Written and edited by a human within 24 hours']), intro.bold);
  check('intro: small muted call line with lockedCount', intro.muted === 'A 15 min call unlocks your portal and 7 more directions. 5 new directions each week.' && intro.small, intro.muted);
  await page.screenshot({ path: OUT + '/s01-intro.jpg', type: 'jpeg', quality: 80 });
  await page.click('[data-action="show-info"]'); await wait(300);
  const infoIntro = await page.evaluate(() => ({ p: Array.from(document.querySelectorAll('#info-portal p')).map((x) => x.textContent), dl: document.querySelector('#info-scrim dl').hidden }));
  check('"i" on the intro: the portal text', JSON.stringify(infoIntro.p) === JSON.stringify(['Turns search and AI-citation gaps into technical articles, written and edited by a human for your brand in 24 hours. Not an unreviewed AI draft. No brief, no prompt, no calls needed.',
    'A 15 min call unlocks your portal with 7 more directions. 5 new ones each week.']) && infoIntro.dl, infoIntro);
  await page.click('[data-action="close-info"]'); await wait(300);

  await page.click('[data-action="start"]');
  await page.waitForSelector('#card-stage .card[data-depth="0"]');
  await wait(900);
  check('3 progress dots, first is current, no "1 OF 3"', JSON.stringify(await dots(page)) === '["current","todo","todo"]' && !/\b1 of 3\b/i.test(await page.innerText('#screen-feed')), await dots(page));
  const hint1 = await page.evaluate(() => { const c = document.querySelector('#card-stage .card[data-depth="0"]'); const h = c && c.querySelector('.ghost-hint'); return h && !h.hidden && c.classList.contains('hint-visible') ? h.innerText.trim() : null; });
  check('first card, step 1: "Tap card to expand." in the card', hint1 === 'Tap card to expand.', hint1);
  await page.screenshot({ path: OUT + '/s02a-card-tap-hint.jpg', type: 'jpeg', quality: 80 });
  await wait(2700);
  const hint2 = await page.evaluate(() => { const c = document.querySelector('#card-stage .card[data-depth="0"]'); const h = c && c.querySelector('.ghost-hint'); return h && !h.hidden && c.classList.contains('hint-visible') ? h.innerText.trim() : null; });
  check('no tap for ~2.5s: step 2 "Swipe to decide. Vedika reacts as you go."', hint2 === 'Swipe to decide. Vedika reacts as you go.', hint2);
  check('no dark bubble on the feed', await page.locator('#gwk-bubble:not([hidden])').count() === 0);
  const ctl = await page.evaluate(() => Object.fromEntries(['pass', 'save', 'super', 'like'].map((a) => { const b = document.querySelector(`.feed-controls [data-action="${a}"]`); const s = getComputedStyle(b);
    return [a, { label: b.querySelector('.ctl-label').textContent, opacity: s.opacity, pe: s.pointerEvents, lock: !!b.querySelector('.ctl-lock') }]; })));
  check('Keep / Pass labels; save and fast-track at 0.35, not clickable, lock icon', ctl.like.label === 'Keep' && ctl.pass.label === 'Pass' && ['save', 'super'].every((k) => ctl[k].opacity === '0.35' && ctl[k].pe === 'none' && ctl[k].lock), ctl);
  await page.screenshot({ path: OUT + '/s02-card-swipe-hint.jpg', type: 'jpeg', quality: 80 });

  // Card 1: keep. Vedika liked it -> the match moment ~700ms later.
  await swipe(page, 'right');
  await wait(450);
  check('no reaction before ~700ms', (await reveal(page)) === null);
  await page.waitForSelector('#reveal:not([hidden])', { timeout: 1500 });
  await wait(1250);
  const m = await reveal(page);
  check('match: YOU (ghost) LIKED + VEDIKABHASIN LIKED, tilted card, headline, rays + 12 hearts, no buttons', m && /rv-agree/.test(m.cls) && m.line === 'You both want this one.' &&
    m.names.join() === 'YOU,VEDIKABHASIN' && m.stamps.join() === 'LIKED,LIKED' && m.ghost && m.floaters === 12 && m.buttons === 0 && m.card === title('c1') && m.rays !== 'none', m);
  await page.screenshot({ path: OUT + '/s03-match.jpg', type: 'jpeg', quality: 80 });
  // A swipe while the moment plays does nothing.
  await page.waitForSelector('#reveal', { state: 'hidden', timeout: 3000 });
  check('match auto-advances after ~2s', true);
  check('dot 1 done with a match ring', (await dots(page))[0] === 'unread ov-agree', await dots(page));
  // The feed's Log after one swipe: the portal Log with both seats.
  await page.click('#screen-feed [data-action="show-history"]');
  await page.waitForSelector('#screen-history.on');
  const hl = await page.evaluate(() => ({ count: document.getElementById('hist-log-count').textContent, rows: Array.from(document.querySelectorAll('#history-log .log-row')).map((r) =>
    (r.querySelector('.result-chip') || {}).innerText + '|' + Array.from(r.querySelectorAll('.hist-row')).map((x) => x.querySelector('.who').innerText.trim() + ':' + x.querySelector('.pill').innerText).join(',')) }));
  check('feed Log after the first swipe: "1 call logged.", MATCH, both seats', hl.count === '1 call logged.' && JSON.stringify(hl.rows) === JSON.stringify(['MATCH|Sam:LIKED,vedikabhasin:LIKED']), hl);
  await wait(900);
  await page.screenshot({ path: OUT + '/s03b-feed-log.jpg', type: 'jpeg', quality: 80 });
  await page.click('[data-action="close-history"]');
  await page.waitForSelector('#screen-feed.on');
  await wait(400);

  // Card 2: pass. Vedika liked it -> split.
  await swipe(page, 'left');
  await page.waitForSelector('#reveal:not([hidden])', { timeout: 1500 });
  await wait(1250);
  const sp = await reveal(page);
  check('split: PASSED vs LIKED, "Split decision.", no rays, no hearts', sp && /rv-split/.test(sp.cls) && sp.line === 'Split decision.' && sp.stamps.join() === 'PASSED,LIKED' && sp.floaters === 0 && sp.buttons === 0, sp);
  await page.screenshot({ path: OUT + '/s04-split.jpg', type: 'jpeg', quality: 80 });
  await page.click('#reveal');
  check('tap continues', await page.locator('#reveal').isHidden());
  await wait(300);

  // Card 3: pass. Vedika passed too -> a small PASS toast, no overlay.
  await swipe(page, 'left');
  await page.waitForFunction(() => !document.getElementById('gwk-toast').hidden, null, { timeout: 1500 });
  check('both passed: PASS toast only', (await page.textContent('#gwk-toast')) === 'PASS' && (await reveal(page)) === null);
  await page.waitForSelector('#screen-final.on', { timeout: 4000 });
  await wait(700);

  // Auto-pick: writeOn c3, c1, c2 -> the only Match is c1.
  const p = db[SLUG].pick;
  check('auto-pick: first Match in writeOn order (c1), stored once with deliver_by = +24h and the reactions', p && p.card_key === 'c1' &&
    Math.abs((new Date(p.deliver_by) - new Date(p.picked_at)) / 36e5 - 24) < 0.01 && JSON.stringify(p.vedi_reactions) === JSON.stringify(CONFIG.vediReactions), p);
  check('approval + article created once, Netlify approvals posted once', db[SLUG].approvals.length === 1 && forms.filter((f) => f['form-name'] === 'approvals').length === 1 &&
    forms.find((f) => f['form-name'] === 'approvals').cardTitle === title('c1'), { approvals: db[SLUG].approvals, forms });
  const collapsed = await page.evaluate(() => ({ hidden: document.getElementById('final-log').hidden, expanded: document.getElementById('final-log-toggle').getAttribute('aria-expanded') }));
  check('Log collapsed by default', collapsed.hidden === true && collapsed.expanded === 'false', collapsed);
  await page.screenshot({ path: OUT + '/s05-final.jpg', type: 'jpeg', quality: 80, fullPage: true });
  await page.click('#final-log-toggle'); await wait(300);
  check('Log opens on tap', !(await page.evaluate(() => document.getElementById('final-log').hidden)));
  const f = JSON.parse((await page.evaluate(() => JSON.stringify((() => {
    const s = document.getElementById('screen-final');
    const sections = Array.from(s.querySelectorAll('.pd-section')).map((x) => x.querySelector('.pd-h').innerText.replace(/\s+/g, ' ').trim());
    const over = Array.from(s.querySelectorAll('#final-log .log-row')).some((r) => r.scrollWidth > r.clientWidth + 1 || Array.from(r.querySelectorAll('*')).some((el) => el.getBoundingClientRect().right > r.getBoundingClientRect().right + 1));
    return { arrive: document.getElementById('final-arrive').textContent, inside: !!s.querySelector('.portal-p'), redH: s.querySelector('.gwk-redacted').getBoundingClientRect().height, sections,
      log: Array.from(s.querySelectorAll('#final-log .log-row')).map((r) => r.querySelector('.hist-title').textContent + '|' + r.querySelector('.result-chip').innerText + '|' + r.querySelectorAll('.history-src-chip').length +
        '|' + Array.from(r.querySelectorAll('.hist-row')).map((x) => x.querySelector('.who').innerText.trim() + ':' + x.querySelector('.pill').innerText + ':' + !!x.querySelector('.av svg')).join(',')),
      captions: Array.from(s.querySelectorAll('.pd-caption')).map((c) => c.textContent),
      signalsText: s.querySelector('.gwk-redacted').innerText.trim(), signalsBlur: getComputedStyle(s.querySelector('.gwk-redacted .sk')).filter, redaction: s.querySelectorAll('.gwk-redacted .rd').length, signalsLock: !!s.querySelector('.gwk-redacted .gwk-lock svg'),
      libOpacity: getComputedStyle(s.querySelector('.gwk-lib-stack .gwk-lib-books')).opacity, more: s.querySelector('.gwk-lib-label').textContent, hubPencil: !!s.querySelector('#final-hub-tile .pd-hub-pencil'), hubLock: !!s.querySelector('#final-hub-tile .pd-hub-lock'), stickies: s.querySelectorAll('#final-hub-tile .pd-hub-sticky').length,
      cta: document.getElementById('final-unlock').innerText.replace(/\s+/g, ' ').trim(), text: s.innerText, inputs: s.querySelectorAll('input').length, over,
      metaTime: Array.from(s.querySelectorAll('#final-log .log-row')).every((r) => !!r.querySelector('.log-meta .when') && !r.querySelector('.hist-row .when')) };
  })()))).replace(/\u00a0/g, ' '));
  // (Non-breaking spaces keep short last words and the date together; compare as plain spaces.)
  deliverText = f.arrive;
  check('top line: "Your article, {title}, lands in your inbox by {date}. It\'s yours either way."', new RegExp('^Your article, ' + title('c1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ', lands in your inbox by .+\\. It\'s yours either way\\.$').test(f.arrive) && !f.inside && !/what your team gets inside/i.test(f.text), f.arrive);
  check('Signals box at half height (43px)', Math.round(f.redH) === 43, f.redH);
  check('PORTAL frame order: Log, Signals NEW, then Library and Hub in one frame; no Feed', f.sections.join(' / ').toUpperCase() === 'LOG 3 CALLS LOGGED / SIGNALS NEW / LIBRARY NEW', f.sections);
  check('Log: time on the meta line, nothing overflows the row at 390px', f.metaTime && !f.over, f);
  check('Log (portal style): newest first, MATCH / SPLIT / PASS, sources', f.log.length === 3 && f.log[0].startsWith(title('c3') + '|PASS|') && f.log[1].includes('|SPLIT|') && f.log[2].startsWith(title('c1') + '|MATCH|') && f.log.every((r) => +r.split('|')[2] > 0), f.log);
  check('Log seats: the visitor and vedikabhasin on every row, each with an avatar and a pill', f.log[2].endsWith('|Sam:LIKED:true,vedikabhasin:LIKED:true') && f.log[1].endsWith('|Sam:PASSED:true,vedikabhasin:LIKED:true') && f.log[0].endsWith('|Sam:PASSED:true,vedikabhasin:PASSED:true'), f.log);
  check('captions: Signals, and Library / Hub "Your team\'s collections and drafting board."', JSON.stringify(f.captions) === JSON.stringify(['Where you rank, and who AI cites instead.', "Your team's collections and drafting board."]), f.captions);
  check('Signals: no text at all, blurred skeleton, redaction bars, lock', f.signalsText === '' && /blur/.test(f.signalsBlur) && f.redaction === 2 && f.signalsLock, f);
  check('Library: locked stack at 0.5 + "7 more directions"', f.libOpacity === '0.5' && f.more === '7 more directions', f);
  check('Hub: sticky notes around the locked pencil', f.hubPencil && f.hubLock && f.stickies >= 2, f);
  check('CTA "UNLOCK YOUR PORTAL · BOOK 15 MINS"; no email field, no Send my article, no Unlock portal now, no seats, no Feed', f.cta.replace(/\s*→$/, '') === 'UNLOCK YOUR PORTAL · BOOK 15 MINS' && f.inputs === 0 &&
    !/send my article|unlock portal now|seat|\bfeed\b/i.test(f.text), f.cta);
  await page.screenshot({ path: OUT + '/s05b-final-log-open.jpg', type: 'jpeg', quality: 80, fullPage: true });

  const tips = {}, wiggles = {};
  for (const k of ['signals', 'library', 'more']) {
    await page.click(`[data-lock="${k}"]`); await wait(150);
    tips[k] = await page.evaluate(() => { const b = document.getElementById('gwk-bubble'); return b.hidden ? null : b.textContent; });
    wiggles[k] = await page.evaluate((key) => !!document.querySelector(`[data-lock="${key}"] .gwk-lock.wiggle`), k);
  }
  // Library and Hub take turns.
  await page.waitForFunction(() => document.getElementById('libhub-name').textContent === 'Hub', null, { timeout: 5000 });
  check('Library and Hub swap in the same frame', await page.evaluate(() => document.querySelector('[data-pane="hub"]').classList.contains('on') && !document.querySelector('[data-pane="library"]').classList.contains('on')));
  await wait(500);
  await page.screenshot({ path: OUT + '/s05c-final-hub.jpg', type: 'jpeg', quality: 80 });
  await page.click('[data-lock="hub"]'); await wait(150);
  tips.hub = await page.evaluate(() => { const b = document.getElementById('gwk-bubble'); return b.hidden ? null : b.textContent; });
  wiggles.hub = await page.evaluate(() => !!document.querySelector('#final-hub-tile .pd-hub-lock.wiggle'));
  check('a tapped lock wiggles', Object.values(wiggles).every(Boolean), wiggles);
  const lockPos = await page.evaluate(() => { const l = document.querySelector('[data-lock="signals"] .gwk-lock'); return getComputedStyle(l).transform; });
  check('the wiggle keeps the lock centred (rotate only)', /matrix\(1, 0, 0, 1, -13, -13\)/.test(lockPos), lockPos);
  check('tap a locked item: its tooltip', tips.signals === 'Opens after your onboarding call.' && tips.library === 'Every article, from up next to delivered.' &&
    tips.hub === 'Opens with your first content pack.' && tips.more === 'Opens when you unlock the portal.', tips);
  await page.click('[data-lock="library"]'); await wait(200);
  await page.screenshot({ path: OUT + '/s06-locked-tip.jpg', type: 'jpeg', quality: 80 });
  check('no "See your log" link under the button', !/see your log/i.test(await page.innerText('#screen-final')) && await page.locator('#screen-final [data-action="final-see-log"]').count() === 0);
  await page.click('[data-action="show-info"]'); await wait(300);
  const info = await page.evaluate(() => Array.from(document.querySelectorAll('#info-portal p')).map((p) => p.textContent));
  check('opening the "i" panel closes a locked-item tooltip', await page.locator('#gwk-bubble:not([hidden])').count() === 0);
  check('"i": "technical articles, written and edited by a human" in bold', await page.evaluate(() => Array.from(document.querySelectorAll('#info-portal strong')).map((b) => b.textContent).join('|')) === 'technical articles, written and edited by a human');
  check('"i" on the final screen: the same portal text', JSON.stringify(info) === JSON.stringify(['Turns search and AI-citation gaps into technical articles, written and edited by a human for your brand in 24 hours. Not an unreviewed AI draft. No brief, no prompt, no calls needed.',
    'A 15 min call unlocks your portal with 7 more directions. 5 new ones each week.']) && await page.evaluate(() => document.querySelector('#info-scrim dl').hidden), info);
  await page.screenshot({ path: OUT + '/s07-info.jpg', type: 'jpeg', quality: 80 });
  await page.click('[data-action="close-info"]'); await wait(200);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#final-unlock')]);
  await popup.waitForLoadState().catch(() => {});
  check('CTA opens cal.com/vedika/ghostwriter-mom', popup.url().startsWith('https://cal.com/vedika/ghostwriter-mom'), popup.url());
  const names = events.map((e) => e.name);
  for (const e of ['page_open', 'deal_me_in', 'first_swipe', 'match_seen', 'split_seen', 'swipe_complete', 'article_auto_picked', 'log_viewed', 'unlock_clicked']) check('PostHog: ' + e, names.includes(e), names);
  const pr = events.find((e) => e.name === 'match_seen').props;
  check('PostHog props on events: template, slug, lead_type, cards_count, flow', pr.template === 'swipe2' && pr.slug === SLUG && pr.lead_type === 'warm' && pr.cards_count === 3 && !!pr.flow, pr);
  check('Device A: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Device B (a colleague on the same link)');
{
  const { ctx, page, errors } = await device();
  await page.goto(BASE + '/' + SLUG);
  await page.waitForSelector('#screen-final.on', { timeout: 8000 });
  await wait(500);
  await page.click('#final-log-toggle');
  const v = await page.evaluate(() => ({ arrive: document.getElementById('final-arrive').textContent, log: Array.from(document.querySelectorAll('#final-log .result-chip')).map((c) => c.innerText).join(), seats: document.querySelectorAll('#final-log .hist-row').length }));
  check('opens on the final screen: same pick, same delivery time, same log with both seats', v.arrive.replace(/\u00a0/g, ' ') === deliverText && v.log === 'PASS,SPLIT,MATCH' && v.seats === 6, v);
  check('no second pick, no second approval or notification', rpcLog.filter((r) => r.name === 'set_collab_pick').length === 1 && db[SLUG].approvals.length === 1 && forms.filter((f) => f['form-name'] === 'approvals').length === 1);
  check('Device B: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Device C: swipes only in this browser are migrated on first load');
{
  delete db[SLUG];
  const brief = (id) => ({ id, format: CONFIG.cards.find((c) => c.id === id).format, title: title(id) });
  const local = { cardIndex: 2, liked: [brief('c1')], passed: [brief('c2')], saved: [], superLiked: null, onboardingDone: { t: true, h: true, v: true, tip: true },
    events: [{ cardId: 'c1', action: 'like', timestamp: '2026-10-01T09:00:00Z' }, { cardId: 'c2', action: 'pass', timestamp: '2026-10-01T09:00:05Z' }] };
  const { ctx, page, errors } = await device({ local });
  await page.goto(BASE + '/' + SLUG);
  await page.waitForSelector('#screen-feed.on', { timeout: 8000 });
  await wait(600);
  check('cached swipes written to the database, in order', db[SLUG] && db[SLUG].log.map((l) => l.card_key + ':' + l.action).join() === 'c1:like,c2:pass', db[SLUG]);
  check('resumes on card 3 (third dot current)', (await dots(page))[2] === 'current', await dots(page));
  check('Device C: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Device D: prefers-reduced-motion');
{
  delete db[SLUG];
  const { ctx, page, errors } = await device({ reduced: true });
  await page.goto(BASE + '/' + SLUG);
  await page.waitForSelector('[data-action="start"]', { state: 'visible' });
  await page.click('[data-action="start"]');
  await page.waitForSelector('#card-stage .card[data-depth="0"]');
  await wait(500);
  // Tap path: tapping the card opens it; closing it shows the swipe step.
  await page.click('#card-stage .card[data-depth="0"] .card-title, #card-stage .card[data-depth="0"] h2', { timeout: 3000 }).catch(() => page.mouse.click(195, 400));
  await page.waitForSelector('.sheet-scrim.open', { timeout: 3000 });
  await page.keyboard.press('Escape'); await wait(500);
  check('tap the card, close it: step 2 "Swipe to decide. Vedika reacts as you go."', await page.evaluate(() => { const c = document.querySelector('#card-stage .card[data-depth="0"]'); const h = c && c.querySelector('.ghost-hint'); return h && !h.hidden && c.classList.contains('hint-visible') ? h.innerText.trim() : null; }) === 'Swipe to decide. Vedika reacts as you go.', await page.evaluate(() => { const c = document.querySelector('#card-stage .card[data-depth="0"]'); const h = c && c.querySelector('.ghost-hint'); return h && !h.hidden && c.classList.contains('hint-visible') ? h.innerText.trim() : null; }));
  await page.click('.feed-controls [data-action="like"]');
  await page.waitForSelector('#reveal:not([hidden])', { timeout: 2000 });
  const r = await reveal(page);
  const still = await page.evaluate(() => document.getAnimations().filter((a) => document.getElementById('reveal').contains(a.effect && a.effect.target)).length);
  check('reduced motion: like the portal, the whole scene (rays + 12 hearts) held still', r && /rv-static/.test(r.cls) && r.floaters === 12 && r.rays !== 'none' && still === 0, { r, still });
  check('Device D: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== The /swipe2template preview never notifies');
{
  const { ctx, page, errors } = await device();
  const before = forms.filter((f) => f['form-name'] === 'approvals').length;
  await page.goto(BASE + '/swipe2template');
  await page.waitForSelector('[data-action="start"]', { state: 'visible' });
  await page.click('[data-action="start"]');
  await page.waitForSelector('#card-stage .card[data-depth="0"]');
  for (let i = 0; i < 3; i++) { await wait(500); await page.click('.feed-controls [data-action="pass"]'); await wait(900); if (await page.locator('#reveal:not([hidden])').count()) await page.click('#reveal'); }
  await page.waitForSelector('#screen-final.on', { timeout: 5000 });
  await wait(500);
  check('preview reaches the final screen, sends no approval and no Netlify approvals post', forms.filter((f) => f['form-name'] === 'approvals').length === before && !(db.swipe2template && db.swipe2template.approvals.length));
  check('preview: no page errors', !errors.length, errors);
  await ctx.close();
}

console.log('\n=== Copy rules');
{
  const html = fs.readFileSync(path.join(ROOT, 'templates/swipe2.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('swipe2: no em dash in markup or strings', !/—/.test(html));
  check('swipe2 config: lead formats only', CONFIG.cards.every((c) => /^(long_form|short_insight|linkedin_post)$/.test(c.format)));
}

await browser.close(); server.close();
cleanup();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
