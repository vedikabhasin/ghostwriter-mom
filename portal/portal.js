// -----------------------------------------------------------------------------
// ghostwriter.mom portal. Three places: Feed, Library, and the Library's design
// mode, the Hub. Reads through RLS as the signed-in member; writes through RLS
// (notes, hub_items, members.onboarding) or RPCs (portal_decide,
// portal_set_live, request_card), plus the invite-member edge function.
//
// Call mode: access runs on portal_active() (internal, an active
// subscription, or the portal_access_until window). When the window closes
// the portal stays readable and swipeable; requests and new drops stop and a
// banner offers a 15-minute call. Every gate reads account state from
// portal_account(), never ids or names. Credits code stays behind
// CREDITS_ENABLED.
//
// Colors, type and motion come from /styles/tokens.css; date formats from
// /portal/lib.js (copied from swipe.html); the mascot from /portal/avatars.js.
// -----------------------------------------------------------------------------
import { $, $all, h, prefersReduced, fmtWhen, fmtDay, hoursBetween, todayStr, countdownLong, fmtWeekday, dateStr } from '/portal/lib.js';
import { nextDropDate } from '/shared/drop-day.js';
import { avatarSVG, pencilSVG, ICONS } from '/portal/avatars.js';
import { showReveal, closeReveal, isRevealOpen } from '/portal/reveal.js';
import { initHub, enterHub, refreshHub, articleRects, slotForNewItem } from '/portal/hub.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.45.0';
const SWIPE_T = 90;
const VERT_T = 100;
const NOTE_MAX = 280;
const WANTS_WRITTEN = 'wants_written';
// What Stripe charges (display only; the prices live in Stripe).
const PRICE_TEXT = { starter: '$495', plan: '$2,000', topupEach: 125 };
const POSITIVE = ['like', 'fasttrack'];
const ACTION_LABEL = { like: 'Liked', pass: 'Passed', save: 'Saved', fasttrack: 'Fast-track' };
const FMT_LABEL = { pillar: 'Pillar', insight: 'Insight', post: 'Post' };
const SPRING = 'cubic-bezier(0.34,1.56,0.64,1)';
const PARAMS = new URLSearchParams(location.search);
const OV_LABEL = { agree: 'Agree', now: 'Now', split: 'Split', timing: 'Timing' };

// Credits are frozen for the call-mode pivot. Every credit-numbered chip, copy
// line, and admin panel is gated on this constant; flip when the credits flow
// is thawed. Nothing that reads it should assume a schema; the flag is the
// only source of truth.
const CREDITS_ENABLED = false;

// Card statuses (articles.status after 20260928000011_call_mode.sql, plus
// up_next, which is derived and never stored):
//   up_next    liked or fast-tracked, nothing requested
//   requested  someone asked for it (request_card); no clock yet
//   writing    the 24-hour clock is running
//   delivered  written and in the Library
const STATUS_TAG = { up_next: 'Up next', requested: 'Requested', writing: 'Writing', delivered: 'Delivered' };
const isGhostStatus = (s) => s !== 'delivered';
const isLive        = (a) => !!a && !!a.live_at;
const CLOSED_TIP = 'Your window closed. Book 15 minutes to keep going.';

// -- State --------------------------------------------------------------------
let runtime = { supabaseUrl: '', supabaseAnonKey: '', posthogKey: '', posthogHost: 'https://us.i.posthog.com', bookingUrl: '', writerName: '' };
let sb = null;
let ph = { capture() {}, identify() {}, group() {}, register() {}, reset() {} };
const S = {
  session: null, me: null, company: null, members: [], cards: [], decisions: [], events: [],
  signal: null, articles: [], notes: [], hubItems: [], pieces: [], account: null, expired: false,
  view: 'loading', feedIndex: 0, items: [], libOrder: [], onb: {}, loaded: false,
  forceHub: null, // internal testing switch: 'locked' | 'invite'
};
const seenOverlap = new Set();

// -- Analytics ----------------------------------------------------------------
function track(name, props) { try { ph.capture(name, Object.assign({ surface: 'portal' }, props || {})); } catch (_) {} }
function initPosthog() {
  if (!runtime.posthogKey || runtime.posthogKey === 'REPLACE_ME' || !window.posthog) return;
  try {
    window.posthog.init(runtime.posthogKey, {
      api_host: runtime.posthogHost || 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      disable_session_recording: true,
      capture_pageview: true,
      autocapture: false,
    });
    ph = window.posthog;
  } catch (_) {}
}

// -- Views --------------------------------------------------------------------
function show(view) {
  S.view = view;
  // An interrupted swipe can leave these on and the next view unscrollable.
  document.body.classList.remove('is-dragging', 'touching', 'dir-like', 'dir-pass', 'dir-save', 'dir-fasttrack');
  document.body.setAttribute('data-view', view);
  $all('.screen').forEach((s) => s.classList.toggle('on', s.id === 'screen-' + view));
  $('#switch').hidden = !(S.loaded && (view === 'feed' || view === 'library'));
  $('#switch-feed').classList.toggle('active', view === 'feed');
  $('#switch-library').classList.toggle('active', view === 'library');
  $('#switch-feed').setAttribute('aria-current', view === 'feed' ? 'page' : 'false');
  $('#switch-library').setAttribute('aria-current', view === 'library' ? 'page' : 'false');
  $('#sign-out-btn').hidden = !S.session;
  $('#closed-banner').hidden = !(S.loaded && S.expired && view !== 'signin' && view !== 'loading' && view !== 'nolink');
  if (view !== 'feed') setFormatTint(null);
  if (view !== 'library') stopCountdowns();
  hideBubble();
  window.scrollTo(0, 0);
}
function setFormatTint(format) {
  const t = $('#tint-format');
  if (!format || !FMT_LABEL[format]) { t.setAttribute('data-on', '0'); return; }
  document.documentElement.style.setProperty('--tint-format', `color-mix(in srgb, var(--f-${format}) 30%, transparent)`);
  t.setAttribute('data-on', '1');
}
function setActionTint(action, strength) {
  document.documentElement.style.setProperty('--tint-action', action ? `color-mix(in srgb, var(--${action}) 50%, transparent)` : 'transparent');
  document.documentElement.style.setProperty('--tint-action-strength', String(strength || 0));
}

// -- Toasts -------------------------------------------------------------------
// A plain confirmation replaces a plain one on screen; first-time lines queue
// so each is read in full.
const toastQueue = [];
let toastCurrent = null;
function toast(text, opts) {
  const t = Object.assign({ text, kind: 'toast', ms: 2600 }, opts || {});
  if (!toastCurrent || (toastCurrent.kind === 'toast' && t.kind === 'toast')) {
    toastQueue.unshift(t);
    nextToast();
  } else toastQueue.push(t);
}
function nextToast() {
  const t = toastQueue.shift();
  const box = $('#toast');
  if (!t) { toastCurrent = null; box.hidden = true; return; }
  toastCurrent = t;
  box.className = 'toast' + (t.kind === 'line' ? ' line' : '');
  box.textContent = t.text;
  if (t.action) {
    const b = h('button', 'gwm-btn', t.action.label);
    b.type = 'button';
    b.addEventListener('click', () => { t.action.fn(); clearTimeout(box._t); nextToast(); });
    box.appendChild(b);
  }
  box.hidden = false;
  clearTimeout(box._t);
  box._t = setTimeout(nextToast, t.ms);
}

// -- Onboarding flags (members.onboarding) ------------------------------------
let onbTimer = null;
function saveOnb(now) {
  clearTimeout(onbTimer);
  const run = () => sb.from('members').update({ onboarding: S.onb }).eq('id', S.me.id).then(({ error }) => {
    if (error) console.warn('[portal] onboarding save failed', error.message);
  });
  if (now) return run();
  onbTimer = setTimeout(run, 250);
}
function setFlag(key) { if (S.onb[key]) return; S.onb[key] = true; saveOnb(); }
/** First-time event lines. Each shows once per member. */
function firstLine(key, text, opts) {
  S.onb.lines = S.onb.lines || {};
  if (S.onb.lines[key]) return false;
  S.onb.lines[key] = true;
  saveOnb();
  toast(text, Object.assign({ kind: 'line', ms: 4200 }, opts || {}));
  return true;
}

// Onboarding bubble anchored to an element.
let bubbleKey = null;
function showBubble(key, target, text, place) {
  if (!target) return;
  const b = $('#bubble');
  bubbleKey = key;
  $('#bubble-text').textContent = text;
  b.hidden = false;
  b.className = 'bubble ' + (place === 'below' ? 'below' : 'above');
  const r = target.getBoundingClientRect();
  const bw = b.offsetWidth, bh = b.offsetHeight;
  const left = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 12);
  const top = place === 'below' ? r.bottom + 12 : r.top - bh - 12;
  b.style.left = left + 'px';
  b.style.top = Math.max(8, top) + 'px';
  b.style.setProperty('--arrow-x', Math.min(bw - 16, Math.max(16, r.left + r.width / 2 - left)) + 'px');
}
function hideBubble() { $('#bubble').hidden = true; bubbleKey = null; }
function dismissBubble() {
  const k = bubbleKey;
  hideBubble();
  if (k === 'feed_intro') { setFlag('feed_intro'); runOnboarding(); }
  else if (k === 'library_glow') { setFlag('library_glow'); $('#switch-library').classList.remove('onb-glow'); }
  else if (k === 'pencil_glow') { setFlag('pencil_glow'); $('#pencil-sticker').classList.remove('onb-glow'); }
}
/** First visit: Feed, then a glow on Library, then a glow on the pencil. */
function runOnboarding() {
  if (isRevealOpen()) return;
  const o = S.onb;
  $('#switch-library').classList.toggle('onb-glow', !!o.feed_intro && !o.library_glow);
  $('#pencil-sticker').classList.toggle('onb-glow', !!o.library_glow && !o.pencil_glow);
  requestAnimationFrame(() => {
    if (S.view === 'feed' && !o.feed_intro) {
      // Below the dots: the bubble never sits over the card's footer.
      showBubble('feed_intro', $('#dots'), 'Your feed is live. Swipe to decide, tap a dot to jump.', 'below');
    } else if (S.view === 'feed' && !o.library_glow) {
      showBubble('library_glow', $('#switch-library'), 'Your articles live in the Library.', 'above');
    } else if (S.view === 'library' && o.library_glow && !o.pencil_glow) {
      showBubble('pencil_glow', $('#pencil-sticker'), 'Tap the pencil to open your Hub.', 'below');
    }
  });
}

// -- Account: access window, Hub access, credits (portal_account) ---------------
const credits = (n) => n + (n === 1 ? ' credit' : ' credits');
function costOf(fmt) {
  const c = S.account && S.account.costs;
  return c && Number.isFinite(c[fmt]) ? c[fmt] : null;
}
function balance() { return (S.account && S.account.balance) || 0; }
function hubOpen() { return !!(S.account && S.account.hub_access); }
async function refreshAccount() {
  const [acct, pieces] = await Promise.all([
    sb.rpc('portal_account', { p_company_id: S.company.id }),
    sb.from('pieces').select('id,article_id,card_id,format,cost,status,position,queued_at,writing_at,deliver_by,delivered_at').eq('company_id', S.company.id),
  ]);
  if (acct.error) console.warn('[portal] account failed', acct.error.message); else S.account = acct.data;
  if (pieces.error) console.warn('[portal] pieces failed', pieces.error.message); else S.pieces = pieces.data;
}
async function refreshArticles() {
  const { data, error } = await sb.from('articles').select(ARTICLE_COLS).eq('company_id', S.company.id);
  if (!error) S.articles = data;
}
const ARTICLE_COLS = 'id,card_id,format,title,status,body_html,google_doc_url,requested_at,requested_by,deliver_by,delivered_at,live_at,created_at';

/** portal_active(company), from portal_account(). If that call failed, only
 *  the flags this member can read decide: internal, or an open window. */
function portalActive() {
  if (S.account && typeof S.account.portal_active === 'boolean') return S.account.portal_active;
  const c = S.company || {};
  return !!(c.is_internal || (c.portal_access_until && new Date(c.portal_access_until) > new Date()));
}
/** The walkthrough booking link, tagged with the company slug. */
function bookingUrl() {
  const base = String(runtime.bookingUrl || '');
  if (!/^https:\/\//i.test(base)) return '';
  return base + (base.includes('?') ? '&' : '?') + 'metadata[slug]=' + encodeURIComponent(S.company.slug);
}
function bookingLink(text) {
  const a = h('a', 'book-link', text || 'Book 15 minutes');
  const url = bookingUrl();
  if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  a.addEventListener('click', () => track('booking_opened', { from: S.view }));
  return a;
}
/** Local "YYYY-MM-DD" the window closed on; new drops stop after it. */
function closedDay() {
  const c = S.company || {};
  const end = c.portal_access_until || c.subscription_ends_at;
  return end ? dateStr(new Date(end)) : todayStr();
}
/** Slim banner on every view once the window has closed. */
function renderClosedBanner() {
  const b = $('#closed-banner');
  b.textContent = '';
  if (!S.expired) return;
  b.append(document.createTextNode('Your portal window closed. Pick up where you left off. '), bookingLink('Book 15 minutes'));
}
/** "{Writer} confirms timing." The writer's name comes from runtime config. */
function confirmLine() { return runtime.writerName ? runtime.writerName + ' confirms timing.' : 'We confirm timing.'; }

// -- Seats ----------------------------------------------------------------------
// Seats come from the account (companies.seat_limit, 3 unless raised).
function seatLimit() { return (S.company && S.company.seat_limit) || 3; }
function seatsLeft() { return Math.max(0, seatLimit() - S.members.length); }
const NUM_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
function seatLine(n) {
  if (n <= 0) return '';
  return (NUM_WORD[n] || String(n)) + (n === 1 ? ' seat' : ' seats') + ' left on your portal.';
}
const allTaken = () => 'All ' + seatLimit() + ' seats are taken.';
/** A monster per member, a dashed "+ seat" ghost per open seat. The ghosts
 *  open the invite pop-up. */
function renderSeats(wrap) {
  wrap.textContent = '';
  for (let i = 0; i < Math.max(seatLimit(), S.members.length); i++) {
    const m = S.members[i];
    if (m) {
      const s0 = h('span', 'seat');
      s0.dataset.member = m.id;
      s0.appendChild(avatarEl(m));
      s0.title = displayName(m);
      wrap.appendChild(s0);
    } else {
      const g = h('button', 'seat empty gwm-center', '+');
      g.type = 'button';
      g.dataset.seat = String(i + 1);
      g.dataset.action = 'invite';
      g.title = 'Seat ' + (i + 1) + ' is open';
      g.setAttribute('aria-label', 'Seat ' + (i + 1) + ' is open. Invite someone.');
      wrap.appendChild(g);
    }
  }
}
function renderHubHead() {
  renderSeats($('#hub-seats'));
  $('#hub-invite').hidden = !seatsLeft();
}

// -- People -------------------------------------------------------------------
function owner() { return S.members.find((m) => m.role === 'owner') || null; }
function memberById(id) { return S.members.find((m) => m.id === id) || null; }
function displayName(m) {
  if (!m) return (S.company && S.company.contact_first_name) || 'Owner';
  if (m.display_name) return m.display_name;
  if (m.role === 'owner' && S.company && S.company.contact_first_name) return S.company.contact_first_name;
  return m.id === (S.me && S.me.id) ? 'You' : 'Teammate';
}
function nameOrYou(m) { return m && S.me && m.id === S.me.id ? 'You' : displayName(m); }
function avatarEl(member, lg) {
  const s = h('span', 'av' + (lg ? ' lg' : ''));
  s.innerHTML = avatarSVG(member || {}, lg ? 27 : 20);
  s.title = displayName(member);
  return s;
}
// Sales-page swipes (member_id null) belong to the owner.
function ownerStandIn() {
  return owner() || { id: 'owner', role: 'owner', display_name: (S.company && S.company.contact_first_name) || 'Owner', avatar_shape: 'ghost' };
}
function eventMember(memberId) { return memberId ? (memberById(memberId) || { id: memberId }) : ownerStandIn(); }

// -- Decisions + overlaps -----------------------------------------------------
// memberId -> action for one card. The null (sales page) row counts as the
// owner's unless the owner has since decided in the portal.
function teamDecisions(cardId) {
  const map = new Map();
  let anon = null;
  S.decisions.forEach((d) => {
    if (d.card_id !== cardId) return;
    if (d.member_id) map.set(d.member_id, d.action); else anon = d.action;
  });
  if (anon) {
    const o = ownerStandIn();
    if (!map.has(o.id)) map.set(o.id, anon);
  }
  return map;
}
function myAction(cardId) { return teamDecisions(cardId).get(S.me.id) || null; }
/** The reveal state for two actions:
 *    like+like, fasttrack+like          agree   "Two yeses."
 *    fasttrack+fasttrack                now     "You both want it now."
 *    like|fasttrack|save + pass         split
 *    like|fasttrack + save              timing  "Same yes, different week."
 *    pass+pass, save+save               nothing */
function pairState(x, y) {
  if (x === y) return x === 'like' ? 'agree' : x === 'fasttrack' ? 'now' : null;
  const set = new Set([x, y]);
  if (set.has('pass')) return 'split';
  if (set.has('save')) return 'timing';
  return 'agree';
}
/** Two seats: that pair. Three or more: the majority pair (two with the same
 *  action), or Split when every action differs. The viewer's own row comes
 *  first whenever it is part of the pair. */
function overlap(cardId) {
  const entries = Array.from(teamDecisions(cardId).entries());
  if (entries.length < 2) return null;
  entries.sort((a, b) => (b[0] === S.me.id) - (a[0] === S.me.id));
  const m = (e) => (e[0] === 'owner' ? ownerStandIn() : memberById(e[0]) || { id: e[0] });
  let pair = null, state = null;
  if (entries.length === 2) {
    pair = entries;
    state = pairState(entries[0][1], entries[1][1]);
  } else {
    const by = new Map();
    entries.forEach((e) => { if (!by.has(e[1])) by.set(e[1], []); by.get(e[1]).push(e); });
    const major = Array.from(by.values()).find((list) => list.length >= 2);
    if (major) {
      pair = major.slice(0, 2);
      state = pairState(pair[0][1], pair[1][1]);
    } else {
      // All different: the viewer (or the first) against the opposite call.
      const first = entries[0];
      const other = entries.slice(1).find((e) => (e[1] === 'pass') !== (first[1] === 'pass')) || entries[1];
      pair = [first, other];
      state = 'split';
    }
  }
  if (!state) return null;
  return { state, a: m(pair[0]), aAction: pair[0][1], b: m(pair[1]), bAction: pair[1][1] };
}
/** Cards any member moved up from an Agree reveal (members.onboarding.pins),
 *  with when, so the latest "Move it up" is first. */
function pinnedCards() {
  const map = new Map();
  S.members.forEach((m) => {
    const onb = m.id === S.me.id ? S.onb : m.onboarding || {};
    const at = onb.pinned_at || {};
    (onb.pins || []).forEach((id, i) => {
      const t = at[id] ? Date.parse(at[id]) : -i;
      if (!map.has(id) || t > map.get(id)) map.set(id, t);
    });
  });
  return map;
}
function articleFor(cardId) { return S.articles.find((a) => a.card_id === cardId) || null; }
/** UP NEXT: liked or fast-tracked by anyone, nothing requested. Moved-up
 *  cards first (latest first), then Agree cards, then by how many yeses. */
function upNext() {
  const written = new Set(S.articles.map((a) => a.card_id).filter(Boolean));
  const pins = pinnedCards();
  return feedCards()
    .filter((c) => !written.has(c.id))
    .map((c) => {
      const acts = Array.from(teamDecisions(c.id).values());
      const pos = acts.filter((a) => POSITIVE.includes(a)).length;
      const ft = acts.filter((a) => a === 'fasttrack').length;
      const pass = acts.filter((a) => a === 'pass').length;
      const ov = overlap(c.id);
      const pinned = pins.has(c.id);
      const score = (ov && (ov.state === 'agree' || ov.state === 'now') ? 100 : 0) + pos * 10 + ft * 5 - pass * 4;
      return { card: c, score, pos, ov, pinned, pinAt: pinned ? pins.get(c.id) : null };
    })
    .filter((x) => x.pos > 0)
    .sort((a, b) => (b.pinned - a.pinned) || (a.pinned && b.pinned ? b.pinAt - a.pinAt : 0) || (b.score - a.score));
}

// -- Overlap reveal -----------------------------------------------------------
// Once per card per member (members.onboarding.reveals), the first time the
// member views a card with an overlap, or right after their swipe creates one.
function revealSeen(cardId) { return !!(S.onb.reveals && S.onb.reveals[cardId]); }
/** Note prefill for "Make your case": from the viewer's own swipe. */
const CASE_PREFIX = { like: 'Liked because ', fasttrack: 'Liked because ', pass: 'Passed because ', save: 'Saved because ' };
const CASE_PREFIXES = Object.values(CASE_PREFIX).concat('Hold this for ');
function maybeReveal(card) {
  const ov = overlap(card.id);
  if (!ov || isRevealOpen() || revealSeen(card.id)) return false;
  if (document.querySelector('.sheet-scrim.open, .modal-scrim.open') || !$('#reader').hidden) return false;
  // Only members who have called this card see its reveal.
  if (!myAction(card.id)) return false;
  S.onb.reveals = Object.assign({}, S.onb.reveals, { [card.id]: ov.state });
  // The reveal carries the Agree / Split first-time lines.
  S.onb.lines = Object.assign({}, S.onb.lines);
  if (ov.state === 'agree' || ov.state === 'split') S.onb.lines[ov.state] = true;
  saveOnb();
  let left = { member: ov.a, action: ov.aAction }, right = { member: ov.b, action: ov.bAction };
  if (ov.b.id === S.me.id) [left, right] = [right, left];
  left.name = nameOrYou(left.member);
  right.name = nameOrYou(right.member);
  hideBubble();
  track('overlap_seen', { state: ov.state, card_id: card.id, reveal: true });
  seenOverlap.add(card.id + ov.state);
  const requested = !!articleFor(card.id);
  const locked = ov.state === 'now' && (!portalActive() || requested);
  showReveal({
    state: ov.state, left, right,
    card: { format: card.format, series: card.series, title: card.title, angle: card.angle, sources: card.sources },
    primaryDisabled: locked,
    primaryTip: locked ? (requested ? 'Already requested.' : CLOSED_TIP) : '',
    onPrimary: () => {
      if (ov.state === 'agree') return moveUp(card);
      if (ov.state === 'now') return requestFromReveal(card);
      if (ov.state === 'timing') return openNoteSheet(card, 'Hold this for ');
      return openNoteSheet(card, CASE_PREFIX[myAction(card.id)] || '');
    },
    onClose: () => track('reveal_dismissed', { state: ov.state }),
    onDismiss: () => setTimeout(() => {
      const cur = S.items[S.feedIndex];
      if (S.view === 'feed' && cur && cur.kind === 'card') maybeReveal(cur.card);
      runOnboarding();
    }, 80),
  });
  return true;
}
function moveUp(card) {
  const pins = (S.onb.pins || []).filter((id) => id !== card.id);
  // Latest move goes to the very top of UP NEXT.
  S.onb.pins = [card.id].concat(pins);
  S.onb.pinned_at = Object.assign({}, S.onb.pinned_at, { [card.id]: new Date().toISOString() });
  saveOnb();
  track('moved_up', { card_id: card.id });
  toast('Moved to the top of Up next.');
}
async function requestFromReveal(card) {
  const a = await requestCard(card, card.format, 'reveal');
  if (a) toast('Requested. ' + confirmLine());
}

// -- Feed ---------------------------------------------------------------------
function feedCards() {
  // Once the window closes, new weekly drops stop appearing.
  const t = S.expired ? [todayStr(), closedDay()].sort()[0] : todayStr();
  return S.cards
    .filter((c) => c.drop_date && c.drop_date <= t)
    .sort((a, b) => (a.drop_date < b.drop_date ? 1 : a.drop_date > b.drop_date ? -1 : a.sort_order - b.sort_order));
}
function buildItems() {
  const cards = feedCards();
  const latest = cards.length ? cards[0].drop_date : null;
  S.items = [];
  if (S.signal) S.items.push({ kind: 'signal', signal: S.signal });
  cards.forEach((c) => S.items.push({ kind: 'card', card: c, isNew: c.drop_date === latest }));
  // After the last card, the empty slot becomes the caught-up state.
  if (cards.length) S.items.push({ kind: 'end' });
  S.feedIndex = Math.min(S.feedIndex, Math.max(0, S.items.length - 1));
}
function renderFeed() {
  const stage = $('#card-stage');
  stage.textContent = '';
  const cards = S.items.filter((i) => i.kind === 'card');
  const unread = cards.filter((i) => !myAction(i.card.id)).length;
  $('#feed-count').textContent = cards.length + (cards.length === 1 ? ' card' : ' cards') + ' · ' + unread + ' unread';

  stopFeedTimer();
  if (!S.items.length) {
    stage.appendChild(h('p', 'lib-empty', 'Your first drop lands soon.'));
    renderDots(); renderControls(); return;
  }
  if (S.items[S.feedIndex].kind === 'end') {
    stage.style.height = '';
    if (peekObserver) peekObserver.disconnect();
    stage.appendChild(buildCaughtUp());
    setFormatTint(null);
    renderDots(); renderControls();
    return;
  }
  // The stack thins toward the end: a peek layer only for cards still to come.
  const els = [];
  for (let d = 2; d >= 0; d--) {
    const item = S.items[S.feedIndex + d];
    if (!item || item.kind === 'end') continue;
    const el = buildFeedCard(item, d);
    stage.appendChild(el);
    els[d] = el;
  }
  // Peek cards match the front card exactly: same width, center, origin and
  // height; only their vertical offset and opacity differ. The front card can
  // grow after fonts load, so keep them in step.
  syncPeeks(els);
  if (peekObserver) peekObserver.disconnect();
  if (window.ResizeObserver) { peekObserver = new ResizeObserver(() => syncPeeks(els)); peekObserver.observe(els[0]); }
  const cur = S.items[S.feedIndex];
  setFormatTint(cur.kind === 'card' ? cur.card.format : null);
  if (cur.kind === 'card') noticeOverlap(cur.card);
  renderDots();
  renderControls();
  pulseLastDots();
}
// Reaching the last two cards: the remaining dots pulse once.
let pulsed = false;
function pulseLastDots() {
  const cardIdx = S.items.map((it, i) => (it.kind === 'card' ? i : -1)).filter((i) => i >= 0);
  const left = cardIdx.filter((i) => i >= S.feedIndex).length;
  if (pulsed || !left || left > 2 || prefersReduced) return;
  pulsed = true;
  cardIdx.filter((i) => i >= S.feedIndex).forEach((i) => { const d = $('#dots').children[i]; if (d) d.classList.add('pulse'); });
}
let feedTimer = null;
function stopFeedTimer() { clearInterval(feedTimer); feedTimer = null; }
/** Cards in this drop a member hasn't decided on yet. */
function unseenBy(m) {
  return feedCards().filter((c) => !teamDecisions(c.id).has(m.id)).length;
}
/** The next drop, strictly after today, from the shared drop-day helper. */
function nextDropDay() {
  const t = new Date();
  const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  return nextDropDate(S.company.first_opened_at || S.company.created_at, tomorrow);
}
/** How many cards the next drop brings: the real count if they exist. */
function nextDropCount() {
  const upcoming = S.cards.filter((c) => c.drop_date && c.drop_date > todayStr());
  if (!upcoming.length) return 5;
  const first = upcoming.map((c) => c.drop_date).sort()[0];
  return upcoming.filter((c) => c.drop_date === first).length;
}
function buildCaughtUp() {
  const box = h('div', 'caught-up');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'All caught up');
  // A paper card with the next drop and a live countdown.
  const paper = h('div', 'cu-paper');
  if (S.expired) {
    paper.appendChild(h('p', 'cu-title', 'Pick up where you left off.'));
    const p0 = h('p', 'cu-sub');
    p0.appendChild(bookingLink('Book 15 minutes'));
    paper.appendChild(p0);
  } else {
    const when = nextDropDay();
    paper.appendChild(h('p', 'cu-title', nextDropCount() + ' new on ' + fmtWeekday(when)));
    const tick = () => 'In ' + (countdownLong(when) || 'a moment');
    const cd = h('p', 'cu-count gwm-mono-tag', tick());
    cd.id = 'cu-count';
    paper.appendChild(cd);
    feedTimer = setInterval(() => { const el = $('#cu-count'); if (el) el.textContent = tick(); }, 30000);
  }
  box.appendChild(paper);

  const seats = h('div', 'seats cu-seats');
  renderSeats(seats);
  box.appendChild(seats);
  const lines = h('div', 'cu-lines');
  S.members.forEach((m) => {
    if (m.id === S.me.id) return;
    const n = unseenBy(m);
    if (!n) return;
    const b = h('button', 'cu-bubble');
    b.type = 'button';
    b.appendChild(avatarEl(m));
    b.appendChild(h('span', 'cu-say', displayName(m) + ' hasn’t seen ' + n + ' of these.'));
    // Sends nothing: it only points at that seat.
    b.addEventListener('click', () => {
      $all('.seat.hl', box).forEach((x) => x.classList.remove('hl'));
      const seat = seats.querySelector(`[data-member="${m.id}"]`);
      if (seat) { void seat.offsetWidth; seat.classList.add('hl'); }
    });
    lines.appendChild(b);
  });
  for (let i = S.members.length; i < seatLimit(); i++) {
    const b = h('button', 'cu-bubble open');
    b.type = 'button';
    b.appendChild(h('span', 'cu-ghost gwm-center', '+'));
    b.appendChild(h('span', 'cu-say', 'Seat ' + (i + 1) + ' is open.'));
    b.addEventListener('click', () => openInvite(null));
    lines.appendChild(b);
  }
  box.appendChild(lines);
  return box;
}
let peekObserver = null;
function syncPeeks(els) {
  const hgt = els[0].getBoundingClientRect().height;
  [els[1], els[2]].forEach((el) => { if (el) el.style.height = hgt + 'px'; });
  $('#card-stage').style.height = (hgt + 12) + 'px';
}
function buildFeedCard(item, depth) {
  const el = h('div', 'card');
  el.setAttribute('data-depth', String(depth));
  if (depth > 0) el.setAttribute('aria-hidden', 'true');
  if (item.kind === 'signal') {
    el.classList.add('fmt-signal');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Signal');
    const head = h('div', 'card-head');
    head.appendChild(h('span', 'gwm-marker', 'Signal'));
    head.appendChild(h('span', 'signal-dot'));
    el.appendChild(head);
    el.appendChild(h('p', 'signal-body', item.signal.text));
    el.appendChild(h('p', 'signal-meta', (item.signal.source || '') + (item.signal.signal_date ? ' · ' + fmtDay(item.signal.signal_date) : '')));
    el.appendChild(h('span', 'signal-hint', 'Swipe for this week’s cards →'));
    if (depth === 0) attachCardGestures(el, item);
    return el;
  }
  const c = item.card;
  const fmt = String(c.format || 'post').toLowerCase();
  el.classList.add('fmt-' + fmt);
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', (FMT_LABEL[fmt] || 'Card') + (c.series ? ' · ' + c.series : '') + ': ' + c.title);
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (tags.some((t) => String(t).toLowerCase() === 'refresh')) el.classList.add('has-refresh');

  const head = h('div', 'card-head');
  head.appendChild(h('span', 'card-format gwm-center gwm-mono-tag', FMT_LABEL[fmt] || fmt));
  if (c.series) head.appendChild(h('span', 'gwm-series-label', c.series));
  if (item.isNew) head.appendChild(h('span', 'gwm-marker', 'New this week'));
  const ov = depth === 0 ? overlap(c.id) : null;
  if (ov) {
    el.classList.add('ov-' + ov.state);
    const lab = h('span', 'ov-label gwm-center ' + ov.state);
    const avs = h('span', 'avs');
    avs.appendChild(avatarEl(ov.a)); avs.appendChild(avatarEl(ov.b));
    lab.appendChild(avs);
    lab.appendChild(document.createTextNode(OV_LABEL[ov.state]));
    lab.setAttribute('aria-label', ov.state + ': ' + displayName(ov.a) + ' ' + ACTION_LABEL[ov.aAction].toLowerCase() + ', ' + displayName(ov.b) + ' ' + ACTION_LABEL[ov.bAction].toLowerCase());
    head.appendChild(lab);
  }
  el.appendChild(head);

  el.appendChild(h('h2', 'card-title', c.title));
  el.appendChild(h('p', 'card-angle', c.angle));
  if (c.evidence) el.appendChild(h('p', 'proof', c.evidence));
  const tagWrap = h('div', 'card-tags');
  tags.filter((t) => String(t).toLowerCase() !== 'refresh').forEach((t) => tagWrap.appendChild(h('span', 'card-tag', t)));
  el.appendChild(tagWrap);

  if (depth === 0 && ov && (ov.state === 'split' || ov.state === 'timing')) {
    const nb = h('button', 'btn-note gwm-btn');
    nb.type = 'button';
    nb.innerHTML = ICONS.pencil;
    nb.appendChild(h('span', null, 'Add a note'));
    stopDrag(nb);
    const pre = ov.state === 'timing' ? 'Hold this for ' : CASE_PREFIX[myAction(c.id)] || '';
    nb.addEventListener('click', (e) => { e.stopPropagation(); openNoteSheet(c, pre); });
    el.appendChild(nb);
  }

  // One "Sources · N" button per card (as on the sales page) opens the sheet.
  const sources = Array.isArray(c.sources) ? c.sources : [];
  if (sources.length) {
    const sw = h('div', 'card-sources');
    const b = h('button', 'src-btn');
    b.type = 'button';
    b.setAttribute('aria-label', 'Open ' + sources.length + (sources.length === 1 ? ' source.' : ' sources.'));
    b.append(h('span', 'src-btn-label', 'Sources'), h('span', 'src-btn-count', sources.length));
    stopDrag(b);
    b.addEventListener('click', (e) => { e.stopPropagation(); openSourceSheet(c); });
    sw.appendChild(b);
    el.appendChild(sw);
  }

  const mine = myAction(c.id);
  if (mine && depth === 0) {
    const st = h('span', 'card-stamp gwm-center ' + mine, ACTION_LABEL[mine]);
    st.setAttribute('aria-label', 'Your call: ' + ACTION_LABEL[mine]);
    el.appendChild(st);
  }
  if (depth === 0) {
    ['like', 'pass', 'save', 'fasttrack'].forEach((a) => {
      const s = h('span', 'drag-stamp gwm-center ' + a, ACTION_LABEL[a]);
      s.setAttribute('aria-hidden', 'true');
      el.appendChild(s);
    });
    attachCardGestures(el, item);
  }
  return el;
}
function stopDrag(el) {
  ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'mousedown'].forEach((t) =>
    el.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));
}
function renderDots() {
  const wrap = $('#dots');
  wrap.textContent = '';
  S.items.forEach((item, i) => {
    if (item.kind === 'end') return;
    const d = h('button', 'dot');
    d.type = 'button';
    d.setAttribute('role', 'tab');
    d.dataset.index = String(i);
    if (item.kind === 'signal') {
      d.classList.add('signal');
      d.setAttribute('aria-label', 'Signal');
    } else {
      const read = !!myAction(item.card.id);
      if (!read) d.classList.add('unread');
      const ov = overlap(item.card.id);
      if (ov) d.classList.add('ov-' + ov.state);
      d.setAttribute('aria-label', 'Card ' + (i + (S.signal ? 0 : 1)) + ': ' + item.card.title + (read ? '' : ' (unread)') + (ov ? ' · ' + ov.state : ''));
    }
    if (i === S.feedIndex) { d.classList.add('current'); d.setAttribute('aria-selected', 'true'); }
    else d.setAttribute('aria-selected', 'false');
    wrap.appendChild(d);
  });
  const cur = wrap.children[S.feedIndex];
  if (cur) wrap.scrollLeft = cur.offsetLeft - wrap.clientWidth / 2 + cur.offsetWidth / 2;
  $('[data-action="feed-prev"]').disabled = S.feedIndex <= 0;
  $('[data-action="feed-next"]').disabled = S.feedIndex >= S.items.length - 1;
}
function renderControls() {
  const item = S.items[S.feedIndex];
  const isCard = item && item.kind === 'card';
  const mine = isCard ? myAction(item.card.id) : null;
  $all('#feed-controls .ctl').forEach((b) => {
    b.disabled = !isCard;
    const on = b.dataset.decide === mine;
    b.classList.toggle('is-current', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function goTo(i, via) {
  if (i < 0 || i >= S.items.length || i === S.feedIndex) return;
  S.feedIndex = i;
  renderFeed();
  if (via) track('dot_jump', { to_index: i, via });
}
function noticeOverlap(card) {
  const ov = overlap(card.id);
  if (!ov) return;
  if (maybeReveal(card)) return;
  if (!seenOverlap.has(card.id + ov.state)) {
    seenOverlap.add(card.id + ov.state);
    track('overlap_seen', { state: ov.state, card_id: card.id });
  }
}

// Card gestures: the sales-page swipe. Right like, left pass, up fast-track,
// down save. On the signal card any swipe just moves on.
let drag = null;
function attachCardGestures(el, item) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    // Scrolling the proof or tapping Sources never starts a swipe.
    if (e.target.closest('button, a, .src-btn, .proof')) return;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, el, item, moved: false };
    el.classList.add('dragging');
    document.body.classList.add('is-dragging', 'touching');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(drag.dx, drag.dy) < 6) return;
    drag.moved = true;
    const rot = Math.max(-18, Math.min(18, drag.dx / 12));
    el.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px) rotate(' + rot + 'deg)';
    if (drag.item.kind !== 'card') return;
    const horiz = Math.abs(drag.dx) > Math.abs(drag.dy);
    const dir = horiz ? (drag.dx > 0 ? 'like' : 'pass') : (drag.dy < 0 ? 'fasttrack' : 'save');
    const mag = horiz ? Math.abs(drag.dx) : Math.abs(drag.dy);
    const strength = Math.min(1, mag / 160);
    ['like', 'pass', 'save', 'fasttrack'].forEach((a) => {
      el.classList.toggle('ind-' + a, a === dir && strength > 0.15);
      document.body.classList.toggle('dir-' + a, a === dir && strength > 0.15);
    });
    setActionTint(dir, strength);
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    el.classList.remove('dragging', 'ind-like', 'ind-pass', 'ind-save', 'ind-fasttrack');
    document.body.classList.remove('is-dragging', 'dir-like', 'dir-pass', 'dir-save', 'dir-fasttrack');
    setTimeout(() => document.body.classList.remove('touching'), 1400);
    setActionTint(null, 0);
    if (!e || e.type === 'pointercancel') { el.style.transform = ''; return; }
    const { dx, dy } = d;
    let action = null;
    if (dy < -VERT_T && Math.abs(dx) < SWIPE_T * 1.2) action = 'fasttrack';
    else if (dy > VERT_T && Math.abs(dy) > Math.abs(dx)) action = 'save';
    else if (dx > SWIPE_T && Math.abs(dx) > Math.abs(dy)) action = 'like';
    else if (dx < -SWIPE_T && Math.abs(dx) > Math.abs(dy)) action = 'pass';
    if (!action) { el.style.transform = ''; return; }
    if (d.item.kind === 'signal') {
      if (action === 'pass' && S.feedIndex > 0) { el.style.transform = ''; goTo(S.feedIndex - 1); return; }
      exitThen(el, action, () => goTo(S.feedIndex + 1));
      return;
    }
    decide(action, 'swipe');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
function exitThen(el, action, fn) {
  el.style.transform = '';
  void el.offsetWidth;
  el.classList.add({ like: 'exit-right', pass: 'exit-left', fasttrack: 'exit-up', save: 'exit-down' }[action]);
  setTimeout(fn, prefersReduced ? 0 : 360);
}

async function decide(action, via) {
  const item = S.items[S.feedIndex];
  if (!item || item.kind !== 'card') return;
  const card = item.card;
  const prev = myAction(card.id);
  const top0 = $('#card-stage .card[data-depth="0"]');
  const advance = () => { if (S.feedIndex < S.items.length - 1) S.feedIndex += 1; renderFeed(); };
  if (prev === action) {
    // Same call again: nothing to record, just move on.
    return top0 ? exitThen(top0, action, advance) : advance();
  }
  const before = overlap(card.id);
  const nowIso = new Date().toISOString();

  // Optimistic local update.
  const snapshot = S.decisions.slice();
  const row = S.decisions.find((d) => d.card_id === card.id && d.member_id === S.me.id);
  if (row) { row.action = action; row.updated_at = nowIso; }
  else S.decisions.push({ card_id: card.id, member_id: S.me.id, action, updated_at: nowIso });
  const ev = { id: 'local-' + Date.now(), card_id: card.id, member_id: S.me.id, action, source: 'portal', created_at: nowIso };
  S.events.push(ev);

  const after = overlap(card.id);
  const createsOverlap = after && (!before || before.state !== after.state);
  // The swipe that creates an overlap reveals it straight away; the next
  // card waits until the reveal closes.
  const next = () => { if (createsOverlap) maybeReveal(card); advance(); };
  if (top0) exitThen(top0, action, next); else next();

  track('feed_swipe', { action, via: via || 'button', card_id: card.id, format: card.format, series: card.series || undefined, changed: !!prev && prev !== action });
  if (prev && prev !== action) {
    track('decision_changed', { from: prev, to: action, card_id: card.id });
    firstLine('changed', 'Changed your mind? Swipe back anytime. We track the final call.');
  }

  const { error } = await sb.rpc('portal_decide', { p_card_id: card.id, p_action: action });
  if (error) {
    console.warn('[portal] decide failed', error.message);
    S.decisions = snapshot;
    S.events = S.events.filter((e) => e !== ev);
    renderFeed();
    toast('That didn’t save. Try again.');
  }
}

// -- Sources sheet (sales page) -----------------------------------------------
function openSourceSheet(card) {
  $('#src-sheet-title').textContent = card.title || '';
  const list = $('#src-sheet-list');
  list.textContent = '';
  (card.sources || []).forEach((src, i) => {
    const li = h('li', 'sheet-item');
    const body = h('div', 'sheet-body');
    const a = h('a', 'sheet-title-link', src.title || src.url || '');
    const url = String(src.url || '');
    if (/^https?:\/\//i.test(url)) a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    body.append(a, h('div', 'sheet-pub', src.publisher || ''), h('div', 'sheet-url', url));
    li.append(h('span', 'sheet-num gwm-center', i + 1), body);
    list.appendChild(li);
  });
  openScrim('src-sheet');
}
function openScrim(id) { $('#' + id).classList.add('open'); }
function closeScrim(id) {
  const el = $('#' + id);
  if (id === 'reader') { el.hidden = true; document.body.style.overflow = ''; return; }
  el.classList.remove('open');
}

// -- Notes ---------------------------------------------------------------------
// A note goes to notes AND gets a hub_items row, so it appears in the Hub
// (and only there).
let noteCard = null;
function openNoteSheet(card, prefill) {
  noteCard = card;
  $('#note-sheet-title').textContent = card.title;
  const input = $('#note-input');
  input.value = prefill || '';
  $('#note-count').textContent = input.value.length + ' / ' + NOTE_MAX;
  $('#note-save').disabled = true;
  openScrim('note-sheet');
  // Cursor at the end of the prefill.
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
}
async function saveNote() {
  const body = $('#note-input').value.trim().slice(0, NOTE_MAX);
  if (!body || !noteCard || CASE_PREFIXES.includes(body + ' ')) return;
  const btn = $('#note-save');
  btn.disabled = true;
  const { data, error } = await sb.from('notes')
    .insert({ company_id: S.company.id, member_id: S.me.id, card_id: noteCard.id, body })
    .select('id,member_id,card_id,body,created_at').single();
  btn.disabled = false;
  if (error) { toast('That didn’t save. Try again.'); return; }
  S.notes.push(data);
  closeScrim('note-sheet');
  track('note_added', { card_id: noteCard.id, length: body.length });
  toast('Saved to your Hub.');
  firstLine('note', 'Your note is waiting in the Hub.');
  const pos = slotForNewItem(S.hubItems, data.id);
  const z = S.hubItems.reduce((m, i) => Math.max(m, i.z || 0), 0) + 1;
  const hub = await sb.from('hub_items')
    .insert({ company_id: S.company.id, kind: 'note', ref_id: data.id, x: pos.x, y: pos.y, rotation: pos.rotation, z, hidden: false, created_by: S.me.id })
    .select('*').single();
  if (hub.error) console.warn('[portal] hub item for note failed', hub.error.message);
  else S.hubItems.push(hub.data);
}

// -- History -------------------------------------------------------------------
function renderHistory(tab) {
  tab = tab || 'log';
  $all('.hist-tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#history-log').hidden = tab !== 'log';
  $('#history-upnext').hidden = tab !== 'upnext';

  const log = $('#history-log');
  log.textContent = '';
  const byCard = new Map();
  // Card-level decisions only (like, pass, save, fast-track).
  S.events.filter((e) => e.card_id && ACTION_LABEL[e.action]).forEach((e) => {
    if (!byCard.has(e.card_id)) byCard.set(e.card_id, []);
    byCard.get(e.card_id).push(e);
  });
  const cardById = new Map(S.cards.map((c) => [c.id, c]));
  // Cards with only notes still get a box: notes are readable at $19.
  S.notes.forEach((n) => { if (n.card_id && n.body !== WANTS_WRITTEN && !byCard.has(n.card_id)) byCard.set(n.card_id, [{ created_at: n.created_at, note: true }]); });
  const groups = Array.from(byCard.entries())
    .filter(([id]) => cardById.has(id))
    .sort((a, b) => (a[1][a[1].length - 1].created_at < b[1][b[1].length - 1].created_at ? 1 : -1));
  if (!groups.length) log.appendChild(h('p', 'hist-empty', 'No decisions yet.'));
  groups.forEach(([cardId, evs]) => {
    const c = cardById.get(cardId);
    const box = h('div', 'hist-card fmt-' + c.format);
    const title = h('p', 'hist-title', c.title);
    if (c.series) title.prepend(h('span', 'gwm-series-label', c.series));
    box.appendChild(title);
    evs.slice().reverse().forEach((e) => {
      if (e.note) return;
      const m = eventMember(e.member_id);
      const row = h('div', 'hist-row');
      row.appendChild(avatarEl(m));
      const who = h('span');
      who.appendChild(h('span', 'who', nameOrYou(m)));
      who.appendChild(h('span', 'pill gwm-center gwm-mono-tag ' + e.action, ACTION_LABEL[e.action]));
      if (e.source === 'sales') who.appendChild(h('span', 'src', ' · sales page'));
      row.appendChild(who);
      row.appendChild(h('span', 'when', fmtWhen(e.created_at)));
      box.appendChild(row);
    });
    const notes = h('div', 'card-notes');
    renderNotes(notes, cardId);
    box.appendChild(notes);
    log.appendChild(box);
  });

  const un = $('#history-upnext');
  un.textContent = '';
  const ranked = upNext().slice(0, 8);
  if (!ranked.length) un.appendChild(h('p', 'hist-empty', 'Like or fast-track cards and they queue up here.'));
  ranked.forEach((x, i) => {
    const box = h('div', 'hist-card fmt-' + x.card.format);
    const row = h('div', 'upnext-item');
    row.appendChild(h('span', 'upnext-rank gwm-center', i + 1));
    row.appendChild(h('span', 'hist-title', x.card.title));
    const tags = h('span', 'upnext-tags');
    if (x.pinned) tags.appendChild(h('span', 'gwm-marker', 'Moved up'));
    if (x.ov && x.ov.state === 'agree') {
      const lab = h('span', 'ov-label gwm-center agree');
      const avs = h('span', 'avs');
      avs.append(avatarEl(x.ov.a), avatarEl(x.ov.b));
      lab.append(avs, document.createTextNode('Agree'));
      tags.appendChild(lab);
    }
    row.appendChild(tags);
    box.appendChild(row);
    un.appendChild(box);
  });
}

// -- Library: catalog mode (read-only fan) --------------------------------------
// One entry per card that is up next, requested, writing or delivered.
// Articles carry the last three; UP NEXT entries are derived from swipes.
function entryOf(a) {
  return { id: a.id, status: a.status, format: a.format, title: a.title, card_id: a.card_id, article: a, card: S.cards.find((c) => c.id === a.card_id) || null };
}
function upNextEntry(card) {
  return { id: 'card:' + card.id, status: 'up_next', format: card.format, title: card.title, card_id: card.id, article: null, card };
}
const TIME_OF = (e) => (e.article ? String(e.article.delivered_at || e.article.requested_at || e.article.created_at) : '');
function libEntries() {
  const rank = { delivered: 0, writing: 1, requested: 2 };
  const arts = S.articles.map(entryOf).sort((a, b) =>
    ((rank[a.status] ?? 3) - (rank[b.status] ?? 3)) || TIME_OF(b).localeCompare(TIME_OF(a)));
  return arts.concat(upNext().map((x) => upNextEntry(x.card)));
}
function entryById(id) { return libEntries().find((e) => e.id === id) || null; }
function syncLibOrder() {
  const ids = libEntries().map((e) => e.id);
  S.libOrder = S.libOrder.filter((id) => ids.includes(id));
  ids.forEach((id) => { if (!S.libOrder.includes(id)) S.libOrder.push(id); });
}
// Hand of cards: the top card flat and centered; two per side peek out,
// rotated 5 and 8 degrees, showing only their edges and spines.
const FAN = [
  { x: 0, r: 0 },
  { x: 30, r: 5 }, { x: -30, r: -5 },
  { x: 50, r: 8 }, { x: -50, r: -8 },
];
/** The live piece (credits spent) for an article, if any. */
function pieceFor(a) {
  return S.pieces.find((p) => p.article_id === a.id && p.status !== 'killed') || null;
}
/** Credits (frozen): a requested article nothing has been spent on yet. */
function writable(a) {
  return CREDITS_ENABLED && !!a && a.status === 'requested' && !pieceFor(a) && portalActive();
}
/** "14H 20M" style: always hours and minutes. */
function hoursMinutes(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return null;
  const mins = Math.ceil(ms / 60000);
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}
/** Who asked for it: the member, or the owner for a sales-page pick. */
function requesterName(a) { return displayName(eventMember(a.requested_by)); }
/** Status line for an entry: tag (UP NEXT, REQUESTED, WRITING, DELIVERED)
 *  and the line under it. */
function deliveryState(e) {
  const a = e.article;
  if (e.status === 'up_next') return { kind: 'up_next', text: portalActive() ? 'Tap to request' : '' };
  if (e.status === 'writing') {
    const left = a.deliver_by ? hoursMinutes(a.deliver_by) : null;
    return { kind: 'writing', text: left ? 'Arriving in ' + left : 'Arriving any minute' };
  }
  if (e.status === 'requested') {
    const piece = CREDITS_ENABLED ? pieceFor(a) : null;
    if (piece && piece.status === 'queued') return { kind: 'requested', text: 'Queued' };
    return { kind: 'requested', text: 'Requested by ' + requesterName(a) + (a.requested_at ? ' · ' + fmtDay(a.requested_at) : '') };
  }
  const when = fmtWhen(a.delivered_at || a.created_at);
  const text = a.requested_at && a.delivered_at
    ? 'Delivered in ' + hoursBetween(a.requested_at, a.delivered_at) + 'h · ' + when
    : 'Delivered · ' + when;
  return { kind: 'delivered', text };
}
function statusTag(status, extra) {
  const t = h('span', 'status-tag gwm-center gwm-mono-tag st-' + status + (extra ? ' ' + extra : ''), STATUS_TAG[status]);
  return t;
}
let countdownTimer = null;
function stopCountdowns() { clearInterval(countdownTimer); countdownTimer = null; }
function tickCountdowns() {
  $all('[data-countdown]').forEach((el) => {
    const a = S.articles.find((x) => x.id === el.dataset.countdown);
    if (a) el.textContent = deliveryState(entryOf(a)).text;
  });
}
function libCountText(list) {
  const n = (st) => list.filter((e) => e.status === st).length;
  let t = n('delivered') + ' delivered · ' + n('up_next') + ' up next';
  if (n('requested')) t += ' · ' + n('requested') + ' requested';
  if (CREDITS_ENABLED && balance() > 0) t += ' · ' + credits(balance());
  return t;
}
function renderLibrary(opts) {
  syncLibOrder();
  stopCountdowns();
  const stage = $('#deck-stage');
  stage.textContent = '';
  const all = libEntries();
  const byId = new Map(all.map((e) => [e.id, e]));
  const order = S.libOrder.map((id) => byId.get(id)).filter(Boolean);
  $('#lib-count').textContent = libCountText(all);
  $('#lib-nav').hidden = order.length < 2;
  if (!order.length) {
    stage.appendChild(h('p', 'lib-empty', 'Like a card in your feed and it lands here, up next.'));
    return;
  }
  const visible = order.slice(0, FAN.length);
  const els = [];
  // Paint back to front so the top card is last and fully covers the rest.
  for (let i = visible.length - 1; i >= 0; i--) {
    const e = visible[i];
    const ghost = isGhostStatus(e.status);
    const slot = FAN[i];
    const tf = `translateX(${slot.x}px) rotate(${slot.r}deg)`;
    const z = 20 - i * 2;
    if (ghost) {
      // The ghost trail: two faint dashed copies, 6px and 12px down-right.
      [2, 1].forEach((k) => {
        const t = h('div', `book-trail t${k} fmt-${e.format}`);
        t.style.transform = `${tf} translate(${6 * k}px, ${6 * k}px)`;
        t.style.zIndex = String(z - 1);
        t.setAttribute('aria-hidden', 'true');
        stage.appendChild(t);
      });
    }
    const b = h('div', 'book fmt-' + e.format + (ghost ? ' ghost' : '') + (i === 0 ? ' top' : ' back'));
    b.dataset.id = e.id;
    b.style.transform = tf;
    b.style.zIndex = String(z);
    const head = h('div', 'book-head');
    head.appendChild(h('span', 'card-format gwm-center gwm-mono-tag fmt-' + e.format, FMT_LABEL[e.format] || e.format));
    if (e.card && e.card.series) head.appendChild(h('span', 'gwm-series-label', e.card.series));
    if (isLive(e.article)) head.appendChild(h('span', 'live-tag gwm-center gwm-mono-tag', 'Live'));
    head.appendChild(statusTag(e.status));
    b.appendChild(head);
    b.appendChild(h('h3', 'book-title', e.title));
    const st = deliveryState(e);
    if (st.kind === 'delivered') {
      b.appendChild(h('span', 'book-stamp delivered', st.text));
    } else if (st.text) {
      const line = h('span', 'book-state ' + st.kind, st.text);
      if (st.kind === 'writing') line.dataset.countdown = e.id;
      b.appendChild(line);
    }
    if (i === 0) {
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', (ghost ? STATUS_TAG[e.status] + ': ' : 'Open article: ') + e.title + (st.text ? '. ' + st.text : ''));
      attachBookGestures(b, e);
    } else b.setAttribute('aria-hidden', 'true');
    stage.appendChild(b);
    els[i] = b;
  }
  if (visible.some((e) => e.status === 'writing')) countdownTimer = setInterval(tickCountdowns, 30000);
  if (els[0]) fitOneLine($all('.book-stamp.delivered, .book-state', els[0]));
  if (opts && opts.fromRects) animateBooksFrom(opts.fromRects, els);
}
/** Status stamps never wrap: tighten the letter-spacing first, then shrink
 *  the type, until the whole stamp fits the card's inner width. */
function fitOneLine(list) {
  list.forEach((el) => {
    el.style.fontSize = ''; el.style.letterSpacing = '';
    const card = el.parentElement, cs = getComputedStyle(card);
    const room = card.clientWidth - parseFloat(cs.paddingRight) - 6 - Math.max(0, el.offsetLeft);
    const width = () => el.getBoundingClientRect().width / Math.cos(4 * Math.PI / 180);
    if (el.scrollWidth <= room && width() <= room + 8) return;
    for (const ls of ['0.03em', '0.01em', '0em']) {
      el.style.letterSpacing = ls;
      if (el.offsetWidth <= room) return;
    }
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.offsetWidth > room && size > 7.5) { size -= 0.25; el.style.fontSize = size + 'px'; }
  });
}
function animateBooksFrom(rects, els) {
  if (prefersReduced) return;
  els.forEach((el, n) => {
    const from = el && rects[el.dataset.id];
    if (!from) return;
    const to = el.getBoundingClientRect();
    const base = el.style.transform;
    el.animate(
      [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / Math.max(1, to.width)})` }, { transform: base }],
      { duration: 640, easing: SPRING, delay: n * 40, composite: 'replace' },
    );
  });
}
/** Book rects, for the Hub to unstack from. */
function libraryRects() {
  const out = {};
  $all('#deck-stage .book').forEach((b) => { out[b.dataset.id] = b.getBoundingClientRect(); });
  return out;
}
function rotateLib(dir) {
  if (S.libOrder.length < 2) return;
  if (dir > 0) S.libOrder.push(S.libOrder.shift());
  else S.libOrder.unshift(S.libOrder.pop());
  renderLibrary();
}
// Swiping the top card shuffles it to the back; a tap opens it. Nothing here
// is grabbable or movable; that lives only in the Hub.
function attachBookGestures(el, entry) {
  let d = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    d = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x0;
    if (!d.moved && Math.hypot(d.dx, e.clientY - d.y0) < 8) return;
    d.moved = true;
  });
  const up = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const moved = d.moved, dx = d.dx;
    d = null;
    if (e.type === 'pointercancel') return;
    if (!moved) { openEntry(entry); return; }
    if (Math.abs(dx) > 60) rotateLib(dx > 0 ? -1 : 1);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEntry(entry); }
  });
}
function openEntry(e) {
  if (e.status === 'delivered') return openReader(e.article);
  openCardSheet(e);
}

// Notes on a card, readable at every access level (History, Library, reader).
function renderNotes(wrap, cardId) {
  wrap.textContent = '';
  const list = S.notes.filter((n) => n.card_id && n.card_id === cardId && n.body !== WANTS_WRITTEN);
  wrap.hidden = !list.length;
  if (!list.length) return;
  wrap.appendChild(h('p', 'notes-h gwm-mono-tag', list.length === 1 ? '1 note' : list.length + ' notes'));
  list.forEach((n) => {
    const row = h('div', 'card-note');
    const m = memberById(n.member_id);
    row.appendChild(avatarEl(m));
    const body = h('div', 'cn-body');
    body.appendChild(h('span', 'cn-who', nameOrYou(m) + ' · ' + fmtDay(n.created_at)));
    body.appendChild(h('span', 'cn-text', n.body));
    row.appendChild(body);
    wrap.appendChild(row);
  });
}

// Card detail for anything not delivered yet. UP NEXT: "Request this" with a
// format choice (the card's own format preselected, one tap). REQUESTED and
// WRITING: who asked, when, and the countdown. Credits (frozen) reuse the
// same box as "Write this".
let sheetEntry = null, writeFmt = null, sheetMode = null;
function openCardSheet(e) {
  sheetEntry = e;
  track('card_detail_opened', { status: e.status, format: e.format });
  $('#ghost-sheet-fmt').textContent = FMT_LABEL[e.format] || e.format;
  $('#ghost-sheet-title').textContent = e.title;
  const tagWrap = $('#ghost-tag');
  tagWrap.textContent = '';
  tagWrap.appendChild(statusTag(e.status));
  const st = deliveryState(e);
  const copy = $('#ghost-copy');
  delete copy.dataset.countdown;
  sheetMode = null;
  if (e.status === 'up_next') {
    copy.textContent = 'Liked, not requested yet.';
    sheetMode = 'request';
  } else if (e.status === 'writing') {
    copy.textContent = 'Being written now. ' + st.text + '.';
  } else {
    copy.textContent = st.text === 'Queued' ? 'Queued. Writing starts when the piece ahead of it is delivered.' : st.text + '. ' + confirmLine();
    if (writable(e.article) && costOf(e.format)) sheetMode = 'credits';
  }
  $('#write-box').hidden = !sheetMode;
  if (sheetMode) { writeFmt = e.format; renderWriteBox(); }
  renderNotes($('#ghost-notes'), e.card_id);
  openScrim('ghost-sheet');
}
function renderWriteBox() {
  const credit = sheetMode === 'credits';
  $all('#fmt-choice .fmt-opt').forEach((b) => {
    const on = b.dataset.fmt === writeFmt;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.textContent = FMT_LABEL[b.dataset.fmt] + (credit ? ' · ' + costOf(b.dataset.fmt) : '');
    b.setAttribute('aria-label', FMT_LABEL[b.dataset.fmt] + (credit ? ', ' + credits(costOf(b.dataset.fmt)) : ''));
  });
  const btn = $('#write-btn');
  const msg = $('#write-msg');
  msg.className = 'field-msg';
  msg.textContent = ' ';
  $('#write-cost').hidden = !credit;
  btn.removeAttribute('title');
  btn.removeAttribute('aria-describedby');
  if (credit) {
    const cost = costOf(writeFmt), bal = balance();
    $('#write-cost').textContent = credits(cost) + '. You have ' + credits(bal) + '.';
    btn.textContent = bal >= cost ? 'Write this · ' + credits(cost) : 'Get credits';
    btn.disabled = false;
    return;
  }
  btn.textContent = 'Request this';
  btn.disabled = !portalActive();
  if (btn.disabled) {
    // Disabled, with the reason as a tooltip and as a visible line.
    btn.title = CLOSED_TIP;
    btn.setAttribute('aria-describedby', 'write-msg');
    msg.textContent = CLOSED_TIP;
  }
}
async function writeThis() {
  if (sheetMode === 'request') return requestFromSheet();
  const a = sheetEntry && sheetEntry.article;
  if (!a) return;
  const cost = costOf(writeFmt);
  if (balance() < cost) { closeScrim('ghost-sheet'); openCredits({ need: cost - balance() }); return; }
  const btn = $('#write-btn');
  btn.disabled = true;
  const { data, error } = await sb.rpc('spend_credits', { p_article_id: a.id, p_format: writeFmt });
  if (error) {
    btn.disabled = false;
    if (/insufficient_credits/.test(error.message)) { await refreshAccount(); renderWriteBox(); return; }
    $('#write-msg').textContent = 'That didn’t go through. Try again.';
    $('#write-msg').className = 'field-msg err';
    return;
  }
  track('credits_spent', { article_id: a.id, format: writeFmt, cost });
  await Promise.all([refreshAccount(), refreshArticles()]);
  closeScrim('ghost-sheet');
  toast(data.piece.status === 'writing' ? 'Writing starts now. It lands within 24 hours.' : 'Queued. It starts when the one ahead of it is delivered.');
  if (S.view === 'library') renderLibrary();
  if (S.view === 'hub') goHub();
}
async function requestFromSheet() {
  const e = sheetEntry;
  if (!e || !e.card) return;
  const btn = $('#write-btn');
  btn.disabled = true;
  const a = await requestCard(e.card, writeFmt, S.view === 'hub' ? 'hub' : 'library');
  if (!a) { renderWriteBox(); return; }
  // The sheet turns into the requested card: a stamp lands, the line updates.
  $('#write-box').hidden = true;
  const tagWrap = $('#ghost-tag');
  tagWrap.textContent = '';
  tagWrap.appendChild(statusTag('requested', prefersReduced ? '' : 'stamp-in'));
  $('#ghost-copy').textContent = 'Requested by ' + requesterName(a) + ' · ' + fmtDay(a.requested_at) + '. ' + confirmLine();
  sheetEntry = entryOf(a);
  if (S.view === 'library') renderLibrary();
  if (S.view === 'hub') refreshHub();
}

/** request_card: UP NEXT becomes REQUESTED. Also tells the team inbox (the
 *  portal-request Netlify form); a failed post is only logged. */
async function requestCard(card, format, via) {
  if (!portalActive()) { toast(CLOSED_TIP); return null; }
  const before = articleFor(card.id);
  const { data, error } = await sb.rpc('request_card', { p_card_id: card.id, p_format: format || card.format });
  if (error) {
    console.warn('[portal] request failed', error.message);
    toast(/portal closed/.test(error.message) ? CLOSED_TIP : 'That didn’t go through. Try again.');
    return null;
  }
  let a = S.articles.find((x) => x.id === data.id);
  if (!a) {
    a = { id: data.id, card_id: card.id, title: card.title, body_html: null, google_doc_url: null, deliver_by: null, delivered_at: null, live_at: null, created_at: data.requested_at };
    S.articles.push(a);
  }
  Object.assign(a, { status: data.status, format: data.format, requested_at: data.requested_at, requested_by: data.requested_by });
  // The Library puts it where the UP NEXT card was.
  const k = S.libOrder.indexOf('card:' + card.id);
  if (k >= 0) S.libOrder[k] = a.id;
  track('card_requested', { card_id: card.id, format: a.format, via });
  if (!before) postRequestForm(card, a);
  await hubCardToArticle(card, a);
  return a;
}
function postRequestForm(card, a) {
  const fields = {
    'form-name': 'portal-request',
    company: S.company.name || '', slug: S.company.slug || '', card_title: card.title || '', format: a.format || '',
    requester_name: displayName(S.me), requester_email: (S.session && S.session.user && S.session.user.email) || '',
  };
  try {
    // /portal is a 200 rewrite; '/' is a redirect and would drop the post.
    fetch('/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }).then((r) => { if (!r.ok) console.warn('[portal] portal-request form post failed', r.status); })
      .catch((err) => console.warn('[portal] portal-request form post failed', err && err.message));
  } catch (err) { console.warn('[portal] portal-request form post failed', err && err.message); }
}
/** A Hub "card" item keeps its spot and becomes the article. */
async function hubCardToArticle(card, a) {
  const it = S.hubItems.find((i) => i.kind === 'card' && i.ref_id === card.id);
  if (!it) return;
  const { error } = await sb.from('hub_items').update({ kind: 'article', ref_id: a.id, updated_at: new Date().toISOString() }).eq('id', it.id);
  if (error) { console.warn('[portal] hub item move failed', error.message); return; }
  it.kind = 'article';
  it.ref_id = a.id;
}

// Credits sheet: resume the $19 first if needed, then Starter (never bought)
// or plan and top-up.
function openCredits(opts) {
  const A = S.account || {};
  const body = $('#credits-body');
  body.textContent = '';
  $('#credits-msg').textContent = ' ';
  $('#credits-msg').className = 'field-msg';
  const title = $('#credits-title');
  const offer = (label, big, note, btnText, onClick) => {
    const box = h('div', 'offer');
    box.appendChild(h('p', 'offer-h gwm-mono-tag', label));
    box.appendChild(h('p', 'offer-big', big));
    if (note) box.appendChild(h('p', 'offer-note', note));
    const b = h('button', 'btn btn-primary gwm-btn', btnText);
    b.type = 'button';
    b.addEventListener('click', () => onClick(b));
    box.appendChild(b);
    body.appendChild(box);
    return box;
  };
  if (S.company.is_internal) {
    title.textContent = 'Internal portal';
    body.appendChild(h('p', 'offer-note', 'Credits on this portal are added by hand in Supabase.'));
  } else if (!A.portal_active) {
    if (A.can_resume) {
      title.textContent = 'Resume your $19 to buy credits';
      offer('Your $19 portal', 'Ends ' + fmtDay(S.company.subscription_ends_at),
        'Resume it and it keeps renewing as before. No new charge today.', 'Resume my $19', resumeThenBuy);
    } else {
      title.textContent = 'Your $19 portal has ended';
      const p0 = h('p', 'offer-note', 'Credits need an active $19 portal. ');
      const a0 = h('a', null, 'Resubscribe');
      a0.href = '/' + encodeURIComponent(S.company.slug);
      p0.appendChild(a0);
      body.appendChild(p0);
    }
  } else if (!A.ever_bought) {
    title.textContent = 'Start with 5 credits';
    offer('Starter', '5 credits · ' + PRICE_TEXT.starter, 'Your $19 counts toward this.', 'Continue to checkout', (b) => checkout('starter', 1, b));
  } else {
    title.textContent = 'You have ' + credits(balance()) + '.';
    if (!A.plan_active) {
      offer('Plan', '20 credits a month · ' + PRICE_TEXT.plan, 'Unused credits carry over one month.', 'Start the plan', (b) => checkout('plan', 1, b));
    }
    let qty = Math.max(1, (opts && opts.need) || 1);
    const box = offer('Top-up', '$' + PRICE_TEXT.topupEach + ' per credit', null, '', (b) => checkout('topup', qty, b));
    const btn = box.querySelector('button');
    const picker = h('div', 'qty');
    const minus = h('button', 'qty-btn gwm-center', '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'One fewer');
    const out = h('output', 'qty-n');
    const plus = h('button', 'qty-btn gwm-center', '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'One more');
    const sync = () => {
      out.textContent = String(qty);
      btn.textContent = 'Buy ' + credits(qty) + ' · $' + (qty * PRICE_TEXT.topupEach).toLocaleString('en-US');
      minus.disabled = qty <= 1;
    };
    minus.addEventListener('click', () => { qty = Math.max(1, qty - 1); sync(); });
    plus.addEventListener('click', () => { qty = Math.min(100, qty + 1); sync(); });
    picker.append(minus, out, plus);
    box.insertBefore(picker, btn);
    sync();
  }
  track('credits_opened', { need: (opts && opts.need) || 0, active: !!A.portal_active, ever_bought: !!A.ever_bought });
  openScrim('credits-sheet');
}
const CHECKOUT_ERR = {
  portal_inactive: 'Your $19 needs to be active first.',
  starter_used: 'You already used the Starter pack. Pick a plan or a top-up.',
  plan_active: 'Your plan is already running.',
  not_configured: 'Checkout isn’t set up yet. Try again soon.',
};
async function invokeCheckout(body) {
  const { data, error } = await sb.functions.invoke('create-checkout', { body });
  if (!error) return { data };
  let code = '';
  try { code = (await error.context.json()).error; } catch (_) {}
  return { code: code || 'failed' };
}
async function checkout(action, quantity, btn) {
  if (btn) btn.disabled = true;
  const msg = $('#credits-msg');
  msg.className = 'field-msg';
  msg.textContent = 'Opening checkout…';
  const r = await invokeCheckout({ action, quantity });
  if (r.data && r.data.url) {
    track('checkout_started', { kind: action, quantity });
    // The webhook can land before the person is back; compare with this.
    try { sessionStorage.setItem('gwm_balance_before', String(balance())); } catch (_) {}
    location.assign(r.data.url);
    return;
  }
  if (btn) btn.disabled = false;
  msg.textContent = CHECKOUT_ERR[r.code] || 'We couldn’t reach checkout. Try again in a minute.';
  msg.className = 'field-msg err';
  if (r.code === 'portal_inactive' || r.code === 'starter_used' || r.code === 'plan_active') { await refreshAccount(); }
}
// One click: resume the same $19 subscription, then straight on to credits.
async function resumeThenBuy(btn) {
  btn.disabled = true;
  const msg = $('#credits-msg');
  msg.className = 'field-msg';
  msg.textContent = 'Resuming your $19…';
  const r = await invokeCheckout({ action: 'resume' });
  if (!r.data || !r.data.resumed) {
    btn.disabled = false;
    msg.textContent = 'We couldn’t resume it. Resubscribe from your sales page.';
    msg.className = 'field-msg err';
    return;
  }
  track('portal_resumed');
  S.company.subscription_status = 'active';
  S.company.subscription_ends_at = null;
  await refreshAccount();
  if (!S.account.ever_bought) return checkout('starter', 1, btn);
  openCredits();
}
// Back from Stripe Checkout.
async function afterCheckout() {
  const flag = PARAMS.get('credits');
  if (!flag) return;
  const p = new URLSearchParams(location.search);
  p.delete('credits'); p.delete('kind');
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
  if (flag !== 'success') { toast('Checkout canceled. Nothing was charged.'); return; }
  toast('Payment received. Your credits land in a moment.');
  let before = balance();
  try {
    const stored = sessionStorage.getItem('gwm_balance_before');
    if (stored !== null) before = Number(stored);
    sessionStorage.removeItem('gwm_balance_before');
  } catch (_) {}
  for (let i = 0; i < 10 && balance() === before; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    await refreshAccount();
    if (balance() !== before) break;
  }
  if (balance() !== before) toast(credits(balance()) + ' ready.');
  if (S.view === 'library') renderLibrary();
}

// -- Reader --------------------------------------------------------------------
const ALLOWED = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUB', 'SUP',
  'BLOCKQUOTE', 'CODE', 'PRE', 'BR', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'FIGURE', 'FIGCAPTION', 'IMG']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'TITLE', 'HEAD']);
const BLOCKS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'FIGURE', 'DIV', 'SECTION', 'ARTICLE', 'HR']);
/** Clean body_html: allow-listed tags only, no classes, no styles, safe links. */
function cleanHtml(html) {
  const doc = new DOMParser().parseFromString('<div id="r">' + (html || '') + '</div>', 'text/html');
  const root = doc.getElementById('r');
  (function walk(node) {
    Array.from(node.childNodes).forEach((c) => {
      if (c.nodeType === 3) return;
      if (c.nodeType !== 1) { c.remove(); return; }
      const tag = c.tagName.toUpperCase();
      if (DROP.has(tag)) { c.remove(); return; }
      walk(c);
      if (!ALLOWED.has(tag)) {
        const hasBlock = Array.from(c.children).some((k) => BLOCKS.has(k.tagName.toUpperCase()));
        if (BLOCKS.has(tag) && !hasBlock && c.textContent.trim()) {
          const p = doc.createElement('p');
          while (c.firstChild) p.appendChild(c.firstChild);
          c.replaceWith(p);
        } else c.replaceWith(...Array.from(c.childNodes));
        return;
      }
      Array.from(c.attributes).forEach((at) => {
        const n = at.name.toLowerCase();
        const keep = (tag === 'A' && n === 'href') || (tag === 'IMG' && (n === 'src' || n === 'alt')) ||
          ((tag === 'TD' || tag === 'TH') && (n === 'colspan' || n === 'rowspan'));
        if (!keep) c.removeAttribute(at.name);
      });
      if (tag === 'A' && !/^(https?:|mailto:|#)/i.test((c.getAttribute('href') || '').trim())) c.removeAttribute('href');
      if (tag === 'IMG' && !/^https:\/\//i.test(c.getAttribute('src') || '')) c.remove();
    });
  })(root);
  return root.innerHTML.trim();
}
function htmlToText(html) {
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  let out = '';
  (function walk(node, listTag) {
    let idx = 1;
    Array.from(node.childNodes).forEach((c) => {
      if (c.nodeType === 3) { out += c.nodeValue.replace(/\s+/g, ' '); return; }
      if (c.nodeType !== 1) return;
      const tag = c.tagName.toUpperCase();
      if (tag === 'BR') { out += '\n'; return; }
      if (tag === 'HR') { out += '\n\n---\n\n'; return; }
      if (tag === 'LI') { out += '\n' + (listTag === 'OL' ? (idx++) + '. ' : '- '); walk(c, null); return; }
      const block = BLOCKS.has(tag);
      if (block) out += '\n\n';
      walk(c, tag === 'UL' || tag === 'OL' ? tag : listTag);
      if (block) out += '\n\n';
    });
  })(doc.getElementById('r'), null);
  return out.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
let readerArticle = null;
function openReader(a) {
  readerArticle = a;
  track('library_open', { article_id: a.id, status: a.status, format: a.format });
  const fmt = $('#reader-fmt');
  fmt.className = 'card-format gwm-center gwm-mono-tag fmt-' + a.format;
  fmt.textContent = FMT_LABEL[a.format] || a.format;
  $('#reader-date').textContent = deliveryState(entryOf(a)).text;
  $('#reader-title').textContent = a.title;
  const body = $('#reader-html');
  body.innerHTML = cleanHtml(a.body_html) || '<p>The full text is in the Google Doc.</p>';
  $all('a[href]', body).forEach((l) => { l.target = '_blank'; l.rel = 'noopener noreferrer'; });
  const gdoc = $('#gdoc-link');
  const url = String(a.google_doc_url || '');
  gdoc.hidden = !/^https:\/\//i.test(url);
  if (!gdoc.hidden) gdoc.href = url;
  $('#copy-web').disabled = !a.body_html;
  renderNotes($('#reader-notes'), a.card_id);
  const lt = $('#live-toggle');
  // portal_set_live needs an open window.
  lt.hidden = !portalActive();
  lt.setAttribute('aria-checked', isLive(a) ? 'true' : 'false');
  const r = $('#reader');
  r.hidden = false;
  r.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  $('[data-close="reader"]').focus();
}
async function copyForWeb() {
  const a = readerArticle;
  if (!a || !a.body_html) return;
  const html = cleanHtml(a.body_html);
  const text = htmlToText(html);
  let ok = false;
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      ok = true;
    }
  } catch (_) { ok = false; }
  if (!ok) {
    // Fallback: a copy event lets us set both flavours synchronously.
    const onCopy = (e) => { e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', text); e.preventDefault(); ok = true; };
    document.addEventListener('copy', onCopy);
    try { document.execCommand('copy'); } catch (_) {}
    document.removeEventListener('copy', onCopy);
  }
  if (ok) {
    track('article_copied', { article_id: a.id, format: a.format });
    toast('Copied. Paste into your CMS.');
  } else toast('Copy didn’t work in this browser. Select the text and copy it.');
}
async function toggleLive() {
  const a = readerArticle;
  if (!a || !portalActive()) return;
  const lt = $('#live-toggle');
  const goLive = !isLive(a);
  lt.setAttribute('aria-checked', goLive ? 'true' : 'false');
  lt.disabled = true;
  const { data, error } = await sb.rpc('portal_set_live', { p_article_id: a.id, p_live: goLive });
  lt.disabled = false;
  if (error) {
    lt.setAttribute('aria-checked', goLive ? 'false' : 'true');
    toast('That didn’t save. Try again.');
    return;
  }
  // portal_set_live only stamps live_at now (status stays 'delivered').
  a.status = data.status;
  a.live_at = data.live_at;
  track('marked_live', { article_id: a.id, live: goLive });
  if (goLive) firstLine('live', 'It’s live. We’ll start watching how it ranks.');
  renderLibrary();
}

// -- Hub entry: pencil -> (invite) -> design mode --------------------------------
// First tap: the invite pop-up (if a seat is open), then the Hub. A locked
// Hub shows its lock modal over a blurred canvas; the header with seats and
// Invite stays usable above it.
function openHubFlow() {
  track('hub_tapped', { members: S.members.length, forced: S.forceHub || undefined, hub_access: hubOpen() });
  if (S.onb.library_glow && !S.onb.pencil_glow) { setFlag('pencil_glow'); $('#pencil-sticker').classList.remove('onb-glow'); }
  hideBubble();
  const forceInvite = S.forceHub === 'invite';
  if (forceInvite || (seatsLeft() > 0 && !S.onb.hub_invite_seen)) openInvite(goHub, { flag: true });
  else goHub();
}
function goHub() {
  renderHubHead();
  enterHub({ forceLocked: S.forceHub === 'locked', fromRects: libraryRects() });
}
/** The Hub's "Talk it through" goes to the booking page. */
function renderHubLock() {
  const a = $('#hub-talk');
  const url = bookingUrl();
  a.hidden = !url;
  if (url) a.href = url;
}
function exitHub() {
  const rects = articleRects();
  go('library', { fromRects: rects });
}

// One invite pop-up in four places: the Hub's first tap, the Hub header's
// Invite button, a "+ seat" ghost, and an open-seat bubble in the empty feed.
// `after` runs once it closes (sent or skipped).
let inviteAfter = null, inviteFlag = false;
function renderInviteSeats() {
  const left = seatsLeft();
  $('#invite-sub').textContent = 'They’ll get a sign-in link.' + (left ? ' ' + seatLine(left) : '');
  renderSeats($('#invite-seat-row'));
  // No seats left: the form goes, the last line stays.
  $('#invite-form').hidden = !left;
  $('[data-action="invite-skip"]').textContent = left ? 'Skip for now' : 'Done';
}
function openInvite(after, opts) {
  inviteAfter = after || null;
  inviteFlag = !!(opts && opts.flag);
  const left = seatsLeft();
  if (left <= 0) { finishInvite(); return; }
  $('#invite-email').value = '';
  $('#invite-msg').textContent = ' ';
  $('#invite-msg').className = 'field-msg';
  $('#invite-btn').disabled = false;
  renderInviteSeats();
  track('invite_opened', { seats_left: left, from: S.view });
  openScrim('invite-modal');
  setTimeout(() => $('#invite-email').focus(), 60);
}
function finishInvite() {
  const f = inviteAfter;
  inviteAfter = null;
  if (inviteFlag) setFlag('hub_invite_seen');
  inviteFlag = false;
  if (S.view === 'hub') renderHubHead();
  if (S.view === 'feed') renderFeed();
  if (f) f();
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INVITE_ERR = {
  get seat_limit() { return allTaken(); },
  invalid_email: 'That email doesn’t look right.',
  self_invite: 'That’s you. Invite someone else.',
  already_member: 'They’re already on your portal.',
  not_signed_in: 'Your session expired. Sign in again.',
};
const INVITE_FAILED = 'We couldn’t send that invite. Try again in a minute.';
async function submitInvite(e) {
  e.preventDefault();
  const msg = $('#invite-msg');
  const input = $('#invite-email');
  const email = input.value.trim().toLowerCase();
  const fail = (text) => { msg.textContent = text; msg.className = 'field-msg err'; };
  if (!email) return fail('Add an email, or skip for now.');
  if (!EMAIL_RE.test(email)) return fail(INVITE_ERR.invalid_email);
  if (S.session && email === String(S.session.user.email || '').toLowerCase()) return fail(INVITE_ERR.self_invite);
  const btn = $('#invite-btn');
  btn.disabled = true;
  msg.textContent = 'Sending…';
  msg.className = 'field-msg';
  let data = null, code = '';
  try {
    const r = await sb.functions.invoke('invite-member', { body: { emails: [email] } });
    data = r.data;
    if (r.error) {
      try { code = (await r.error.context.json()).error; } catch (_) {}
      code = code || 'failed';
    }
  } catch (_) { code = 'failed'; }
  btn.disabled = false;
  const results = (data && data.results) || [];
  // A lone per-address "already_member" reads the same as the top-level one.
  if (!code && results.length === 1 && results[0].status === 'already_member') code = 'already_member';
  if (!code && !results.some((r) => r.status === 'invited')) code = 'failed';
  if (code) {
    track('invite_failed', { code });
    fail(INVITE_ERR[code] || INVITE_FAILED);
    if (code === 'seat_limit' || code === 'already_member' || results.length) { await refreshMembers(); renderInviteSeats(); }
    return;
  }
  track('invite_sent', { count: 1 });
  await refreshMembers();
  // Stay open: the field clears, the new seat shows up, the line updates.
  input.value = '';
  renderInviteSeats();
  msg.textContent = 'Invite sent to ' + email + '.';
  msg.className = 'field-msg ok';
  if (S.view === 'hub') renderHubHead();
}
function skipInvite() {
  closeScrim('invite-modal');
  finishInvite();
}
async function refreshMembers() {
  const { data } = await sb.from('members').select('id,user_id,role,display_name,avatar_shape,onboarding,created_at')
    .eq('company_id', S.company.id).order('created_at');
  if (data) S.members = data;
}

// -- Navigation ----------------------------------------------------------------
function go(view, opts) {
  if (view === 'library') {
    if (!S.onb.library_glow && S.onb.feed_intro) { setFlag('library_glow'); $('#switch-library').classList.remove('onb-glow'); }
    show('library'); renderLibrary(opts);
  } else if (view === 'feed') {
    show('feed'); renderFeed();
  }
  runOnboarding();
}

// -- Auth ----------------------------------------------------------------------
function readAuthError() {
  const p = new URLSearchParams(location.hash.replace(/^#/, '') + '&' + location.search.replace(/^\?/, ''));
  const desc = p.get('error_description');
  if (!desc) return null;
  history.replaceState(null, '', location.pathname);
  return /expired|invalid/i.test(desc) ? 'That link has expired. Send yourself a fresh one.' : desc.replace(/\+/g, ' ');
}
// The email the last link and code went to. The code form verifies against
// this, never against whatever is in the email input now.
let sentTo = null;
const RATE_LIMITED = 'Too many tries. Wait a minute and try again.';
const isRateLimit = (err) => !!err && (err.status === 429 || /rate limit|too many/i.test(err.message || ''));
async function requestLink(email) {
  return sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + '/portal' },
  });
}
async function sendLink(e) {
  e.preventDefault();
  const input = $('#signin-email');
  const msg = $('#signin-msg');
  const email = input.value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { msg.textContent = 'Enter the email your portal was set up with.'; msg.className = 'field-msg err'; return; }
  const btn = $('#signin-btn');
  btn.disabled = true;
  msg.className = 'field-msg';
  msg.textContent = 'Sending…';
  const { error } = await requestLink(email);
  btn.disabled = false;
  if (isRateLimit(error)) {
    msg.textContent = RATE_LIMITED;
    msg.className = 'field-msg err';
    return;
  }
  // Same answer whether or not the email has a portal.
  msg.textContent = ' ';
  sentTo = email;
  $('#signin-form').hidden = true;
  $('#signin-sent').hidden = false;
  $('#code-resend').hidden = true;
  $('#signin-code').focus();
  track('signin_link_sent');
}
// The code from the same email, for people whose link opens in an email
// app's built-in browser. Any length; spaces are dropped.
async function verifyCode(e) {
  e.preventDefault();
  const input = $('#signin-code');
  const msg = $('#code-msg');
  const token = input.value.replace(/\s+/g, '');
  input.value = token;
  const bad = () => {
    msg.textContent = 'That code didn’t work. Check the latest email or send a new link.';
    msg.className = 'field-msg err';
    $('#code-resend').hidden = false;
  };
  if (!sentTo || !token) return bad();
  const btn = $('#code-btn');
  btn.disabled = true;
  msg.className = 'field-msg';
  msg.textContent = 'Checking…';
  let res;
  try { res = await sb.auth.verifyOtp({ email: sentTo, token, type: 'email' }); }
  catch (err) { res = { error: err }; }
  btn.disabled = false;
  if (isRateLimit(res.error)) { msg.textContent = RATE_LIMITED; msg.className = 'field-msg err'; return; }
  if (res.error || !res.data || !res.data.session) return bad();
  msg.textContent = ' ';
  S.session = res.data.session;
  track('signin_code_used');
  start(true);
}
async function resendLink() {
  if (!sentTo) return resetSignin();
  const msg = $('#code-msg');
  const btn = $('#code-resend');
  btn.disabled = true;
  const { error } = await requestLink(sentTo);
  btn.disabled = false;
  $('#signin-code').value = '';
  if (isRateLimit(error)) { msg.textContent = RATE_LIMITED; msg.className = 'field-msg err'; return; }
  msg.textContent = 'New link sent. Use the code in the latest email.';
  msg.className = 'field-msg';
  btn.hidden = true;
  $('#signin-code').focus();
}
function resetSignin() {
  $('#signin-code').value = '';
  $('#code-msg').textContent = ' ';
  $('#code-msg').className = 'field-msg';
  $('#signin-sent').hidden = true;
  $('#signin-form').hidden = false;
  $('#signin-email').focus();
}
async function signOut() {
  try { await sb.auth.signOut({ scope: 'local' }); } catch (_) {}
  try { ph.reset(); } catch (_) {}
  location.href = '/portal';
}

// -- Internal testing switches (internal companies only) -------------------------
async function applySwitches() {
  if (!S.company.is_internal) return;
  const hub = PARAMS.get('hub');
  if (hub === 'locked' || hub === 'invite') S.forceHub = hub;
  if (PARAMS.get('onboarding') === 'reset') {
    S.onb = {};
    await saveOnb(true);
    const p = new URLSearchParams(location.search);
    p.delete('onboarding');
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
    toast('Onboarding reset.');
  }
  if (S.forceHub) $('#test-switch').hidden = false;
  $('#test-switch').textContent = S.forceHub ? 'Testing: hub=' + S.forceHub : '';
}

// -- Load ----------------------------------------------------------------------
async function loadPortal(fromLink) {
  const uid = S.session.user.id;
  const { data: mine, error: meErr } = await sb.from('members').select('*').eq('user_id', uid)
    .order('created_at', { ascending: true }).limit(1);
  if (meErr) throw meErr;
  if (!mine || !mine.length) { show('nolink'); return; }
  S.me = mine[0];
  S.onb = Object.assign({}, S.me.onboarding || {});
  const cid = S.me.company_id;
  const [company, members, cards, decisions, events, signal, articles, notes, hubItems] = await Promise.all([
    sb.from('companies').select('id,slug,name,contact_first_name,subscription_status,subscription_ends_at,portal_access_until,unlock_mode,hub_unlocked,is_internal,first_opened_at,created_at,seat_limit').eq('id', cid).single(),
    sb.from('members').select('id,user_id,role,display_name,avatar_shape,onboarding,created_at').eq('company_id', cid).order('created_at'),
    sb.from('cards').select('id,card_key,format,series,title,angle,evidence,tags,sources,drop_date,sort_order').eq('company_id', cid).order('sort_order'),
    sb.from('decisions').select('card_id,member_id,action,updated_at').eq('company_id', cid),
    sb.from('swipe_events').select('id,card_id,member_id,action,source,created_at').eq('company_id', cid).order('created_at'),
    sb.from('signals').select('text,source,signal_date').eq('company_id', cid).order('signal_date', { ascending: false }).order('created_at', { ascending: false }).limit(1),
    sb.from('articles').select(ARTICLE_COLS).eq('company_id', cid),
    sb.from('notes').select('id,member_id,card_id,body,created_at').eq('company_id', cid).order('created_at'),
    sb.from('hub_items').select('*').eq('company_id', cid),
  ]);
  const failed = [company, members, cards, decisions, events, signal, articles, notes, hubItems].find((r) => r.error);
  if (failed) throw failed.error;
  S.company = company.data;
  S.members = members.data;
  S.cards = cards.data;
  S.decisions = decisions.data;
  S.events = events.data;
  S.signal = signal.data[0] || null;
  S.articles = articles.data;
  S.notes = notes.data;
  S.hubItems = hubItems.data;
  const c = S.company;
  await refreshAccount();
  // Access comes from portal_active() only.
  S.expired = !portalActive();
  S.loaded = true;
  await applySwitches();

  // Analytics: member id only, never email. Group by company slug.
  try {
    ph.identify(S.me.id, { role: S.me.role });
    ph.group('company', c.slug, { name: c.name, internal: !!c.is_internal });
    ph.register({ slug: c.slug, surface: 'portal' });
  } catch (_) {}
  let loggedThisTab = false;
  try { loggedThisTab = sessionStorage.getItem('gwm_portal_login') === '1'; sessionStorage.setItem('gwm_portal_login', '1'); } catch (_) {}
  if (fromLink || !loggedThisTab) track('portal_login', { via: fromLink ? 'link' : 'session', expired: S.expired });

  $('#company-name').textContent = c.name;
  $('#pencil-sticker').innerHTML = pencilSVG(84);
  buildItems();
  renderClosedBanner();
  renderHubLock();
  go('feed');
  if (CREDITS_ENABLED) afterCheckout();
}

async function boot() {
  const authError = readAuthError();
  const fromLink = /access_token=|type=(magiclink|invite|signup|recovery)/.test(location.hash) || /[?&]code=/.test(location.search);
  try {
    const r = await fetch('/config/runtime.json', { cache: 'no-cache' });
    if (r.ok) runtime = Object.assign(runtime, await r.json());
  } catch (_) {}
  initPosthog();
  try {
    const mod = await import(SUPABASE_JS);
    sb = mod.createClient(runtime.supabaseUrl, runtime.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
  } catch (err) {
    console.error('[portal] supabase-js failed to load', err);
    $('#screen-loading .loading').textContent = 'The portal couldn’t load. Refresh to try again.';
    return;
  }
  initHub({
    get sb() { return sb; }, S, show, track, toast, firstLine, avatarEl, displayName, memberById,
    libEntries, entryOf, upNextEntry, exitHub, FMT_LABEL, STATUS_TAG, WANTS_WRITTEN, hubOpen, openEntry, deliveryState, articleFor, upNext,
  });
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (location.hash && /access_token|error/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  if (!S.session) {
    show('signin');
    if (authError) { $('#signin-msg').textContent = authError; $('#signin-msg').className = 'field-msg err'; }
    sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'SIGNED_IN' && session && !S.loaded) { S.session = session; start(true); }
    });
    return;
  }
  start(fromLink);
}
// verifyOtp also fires SIGNED_IN, so the listener and the code form can both
// ask to start. Only the first one runs.
let started = false;
async function start(fromLink) {
  if (started || S.loaded) return;
  started = true;
  show('loading');
  try { await loadPortal(fromLink); }
  catch (err) {
    console.error('[portal] load failed', err);
    $('#screen-loading .loading').textContent = 'The portal couldn’t load. Refresh to try again.';
    show('loading');
  }
}

// -- Wiring --------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action],[data-decide],[data-go],[data-close],[data-tab],.dot');
  if (!t) return;
  if (t.classList.contains('dot')) return goTo(Number(t.dataset.index), 'tap');
  if (t.dataset.decide) return decide(t.dataset.decide, 'button');
  if (t.dataset.go) return go(t.dataset.go);
  if (t.dataset.close) return closeScrim(t.dataset.close);
  if (t.dataset.tab) return renderHistory(t.dataset.tab);
  switch (t.dataset.action) {
    case 'feed-prev': return goTo(S.feedIndex - 1, 'arrow');
    case 'feed-next': return goTo(S.feedIndex + 1, 'arrow');
    case 'show-history': show('history'); return renderHistory('log');
    case 'close-history': return go('feed');
    case 'lib-prev': return rotateLib(-1);
    case 'lib-next': return rotateLib(1);
    case 'hub': return openHubFlow();
    case 'back-to-library': return exitHub();
    case 'invite-skip': return skipInvite();
    case 'invite': return openInvite(null);
    case 'hub-start': return CREDITS_ENABLED ? openCredits() : undefined;
    case 'bubble-dismiss': return dismissBubble();
    case 'sign-out': return signOut();
    case 'signin-again': return resetSignin();
  }
});
// Tap outside a sheet closes it.
['src-sheet', 'note-sheet', 'ghost-sheet', 'hub-text-sheet', 'credits-sheet'].forEach((id) => {
  $('#' + id).addEventListener('click', (e) => { if (e.target.id === id) closeScrim(id); });
});
$('#signin-form').addEventListener('submit', sendLink);
$('#code-form').addEventListener('submit', verifyCode);
$('#code-resend').addEventListener('click', resendLink);
// Pasted codes: keep the digits and letters, drop the spaces.
$('#signin-code').addEventListener('paste', (e) => {
  const t = (e.clipboardData || window.clipboardData).getData('text');
  if (!t) return;
  e.preventDefault();
  e.target.value = t.replace(/\s+/g, '');
});
$('#invite-form').addEventListener('submit', submitInvite);
$('#note-input').addEventListener('input', (e) => {
  $('#note-count').textContent = e.target.value.length + ' / ' + NOTE_MAX;
  // A bare prefill ("Liked because ") is not a note yet.
  $('#note-save').disabled = !e.target.value.trim() || CASE_PREFIXES.includes(e.target.value.trim() + ' ');
});
$('#note-save').addEventListener('click', saveNote);
$('#write-btn').addEventListener('click', writeThis);
$('#fmt-choice').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fmt]');
  if (!b) return;
  writeFmt = b.dataset.fmt;
  renderWriteBox();
});
$('#copy-web').addEventListener('click', copyForWeb);
$('#live-toggle').addEventListener('click', toggleLive);
$('#gdoc-link').addEventListener('click', () => readerArticle && track('gdoc_opened', { article_id: readerArticle.id }));

// Dot slider: drag along it to scrub back and forth.
(function dotScrub() {
  const dots = $('#dots');
  let s = null;
  dots.addEventListener('pointerdown', (e) => { s = { id: e.pointerId, x0: e.clientX, moved: false, start: S.feedIndex }; });
  dots.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    if (!s.moved && Math.abs(e.clientX - s.x0) < 8) return;
    if (!s.moved) { s.moved = true; try { dots.setPointerCapture(e.pointerId); } catch (_) {} }
    const hit = Array.from(dots.children).findIndex((d) => {
      const r = d.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right;
    });
    if (hit >= 0 && hit !== S.feedIndex) { S.feedIndex = hit; renderFeed(); }
  });
  const end = (e) => {
    if (!s || e.pointerId !== s.id) return;
    if (s.moved && S.feedIndex !== s.start) track('dot_jump', { to_index: S.feedIndex, via: 'scrub' });
    s = null;
  };
  dots.addEventListener('pointerup', end);
  dots.addEventListener('pointercancel', end);
})();

// Buttons brighten while a card is touched.
$('#card-stage').addEventListener('touchstart', () => document.body.classList.add('touching'), { passive: true });
$('#card-stage').addEventListener('touchend', () => setTimeout(() => document.body.classList.remove('touching'), 1400), { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (isRevealOpen()) return closeReveal();
    if (!$('#reader').hidden) return closeScrim('reader');
    ['src-sheet', 'note-sheet', 'ghost-sheet', 'hub-text-sheet', 'credits-sheet'].forEach((id) => closeScrim(id));
    $('#hub-emoji-picker').hidden = true;
    if ($('#invite-modal').classList.contains('open')) skipInvite();
    return;
  }
  if (isRevealOpen() || e.target.closest('input, textarea') || !$('#reader').hidden || document.querySelector('.sheet-scrim.open, .modal-scrim.open')) return;
  if (S.view === 'feed' && e.key === 'ArrowLeft') { e.preventDefault(); goTo(S.feedIndex - 1, 'key'); }
  if (S.view === 'feed' && e.key === 'ArrowRight') { e.preventDefault(); goTo(S.feedIndex + 1, 'key'); }
  if (S.view === 'library' && e.key === 'ArrowRight') { e.preventDefault(); rotateLib(1); }
  if (S.view === 'library' && e.key === 'ArrowLeft') { e.preventDefault(); rotateLib(-1); }
});
window.addEventListener('resize', () => { if (bubbleKey) runOnboarding(); });

boot();
