// -----------------------------------------------------------------------------
// ghostwriter.mom portal. Three places: Feed, Library, and the Library's design
// mode, the Hub. Reads through RLS as the signed-in member; writes through RLS
// (notes, hub_items, members.onboarding) or the portal_* RPCs (decisions, mark
// live), plus the invite-member edge function.
//
// Colors, type and motion come from /styles/tokens.css; date formats from
// /portal/lib.js (copied from swipe.html); the mascot from /portal/avatars.js.
// -----------------------------------------------------------------------------
import { $, $all, h, prefersReduced, fmtWhen, fmtDay, hoursBetween, countdown, todayStr } from '/portal/lib.js';
import { avatarSVG, pencilSVG, ICONS } from '/portal/avatars.js';
import { showReveal, closeReveal, isRevealOpen } from '/portal/reveal.js';
import { initHub, enterHub, articleRects, slotForNewItem } from '/portal/hub.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.45.0';
const SWIPE_T = 90;
const VERT_T = 100;
const CHIP_LIMIT = 3;
const NOTE_MAX = 280;
const WANTS_WRITTEN = 'wants_written';
const POSITIVE = ['like', 'fasttrack'];
const ACTION_LABEL = { like: 'Liked', pass: 'Passed', save: 'Saved', fasttrack: 'Fast-track' };
const FMT_LABEL = { pillar: 'Pillar', insight: 'Insight', post: 'Post' };
const SPRING = 'cubic-bezier(0.34,1.56,0.64,1)';
const PARAMS = new URLSearchParams(location.search);

// -- State --------------------------------------------------------------------
let runtime = { supabaseUrl: '', supabaseAnonKey: '', posthogKey: '', posthogHost: 'https://us.i.posthog.com' };
let sb = null;
let ph = { capture() {}, identify() {}, group() {}, register() {}, reset() {} };
const S = {
  session: null, me: null, company: null, members: [], cards: [], decisions: [], events: [],
  signal: null, articles: [], notes: [], hubItems: [], readOnly: false,
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
  document.body.setAttribute('data-view', view);
  $all('.screen').forEach((s) => s.classList.toggle('on', s.id === 'screen-' + view));
  $('#switch').hidden = !(S.loaded && (view === 'feed' || view === 'library') && !S.readOnly);
  $('#switch-feed').classList.toggle('active', view === 'feed');
  $('#switch-library').classList.toggle('active', view === 'library');
  $('#switch-feed').setAttribute('aria-current', view === 'feed' ? 'page' : 'false');
  $('#switch-library').setAttribute('aria-current', view === 'library' ? 'page' : 'false');
  $('#sign-out-btn').hidden = !S.session;
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
  if (S.onb.lines[key] || S.readOnly) return false;
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
  if (S.readOnly || isRevealOpen()) return;
  const o = S.onb;
  $('#switch-library').classList.toggle('onb-glow', !!o.feed_intro && !o.library_glow);
  $('#pencil-sticker').classList.toggle('onb-glow', !!o.library_glow && !o.pencil_glow);
  requestAnimationFrame(() => {
    if (S.view === 'feed' && !o.feed_intro) {
      showBubble('feed_intro', $('#dots'), 'Your feed is live. Swipe to decide, tap a dot to jump.', 'above');
    } else if (S.view === 'feed' && !o.library_glow) {
      showBubble('library_glow', $('#switch-library'), 'Your articles live in the Library.', 'above');
    } else if (S.view === 'library' && o.library_glow && !o.pencil_glow) {
      showBubble('pencil_glow', $('#pencil-sticker'), 'Tap the pencil to open your Hub.', 'below');
    }
  });
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
function overlap(cardId) {
  const entries = Array.from(teamDecisions(cardId).entries());
  if (entries.length < 2) return null;
  // Prefer pairs that include the viewer.
  entries.sort((a, b) => (b[0] === S.me.id) - (a[0] === S.me.id));
  const pos = entries.filter((e) => POSITIVE.includes(e[1]));
  const pass = entries.filter((e) => e[1] === 'pass');
  const save = entries.filter((e) => e[1] === 'save');
  const m = (e) => (e[0] === 'owner' ? ownerStandIn() : memberById(e[0]) || { id: e[0] });
  if (pos.length && pass.length) return { state: 'split', a: m(pos[0]), aAction: pos[0][1], b: m(pass[0]), bAction: 'pass' };
  if (pos.length && save.length) return { state: 'timing', a: m(pos[0]), aAction: pos[0][1], b: m(save[0]), bAction: 'save' };
  if (pos.length >= 2) return { state: 'agree', a: m(pos[0]), aAction: pos[0][1], b: m(pos[1]), bAction: pos[1][1] };
  return null;
}
/** Cards any member moved up from an Agree reveal (stored in their onboarding). */
function pinnedCards() {
  const set = new Set();
  S.members.forEach((m) => {
    const onb = m.id === S.me.id ? S.onb : m.onboarding || {};
    (onb.pins || []).forEach((id) => set.add(id));
  });
  return set;
}
/** "Up next": what we'd write next. Moved-up cards first, then Agree cards. */
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
      const score = (pinned ? 1000 : 0) + (ov && ov.state === 'agree' ? 100 : 0) + pos * 10 + ft * 5 - pass * 4;
      return { card: c, score, pos, ov, pinned };
    })
    .filter((x) => x.pos > 0 || x.pinned)
    .sort((a, b) => b.score - a.score);
}

// -- Overlap reveal -----------------------------------------------------------
// Once per card per member (members.onboarding.reveals), the first time the
// member views a card with an overlap, or right after their swipe creates one.
function revealSeen(cardId) { return !!(S.onb.reveals && S.onb.reveals[cardId]); }
function maybeReveal(card) {
  const ov = overlap(card.id);
  if (!ov || S.readOnly || isRevealOpen() || revealSeen(card.id)) return false;
  if (document.querySelector('.sheet-scrim.open, .modal-scrim.open') || !$('#reader').hidden) return false;
  const meIn = ov.a.id === S.me.id || ov.b.id === S.me.id;
  if (!meIn) return false;
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
  showReveal({
    state: ov.state, left, right,
    card: { format: card.format, series: card.series, title: card.title },
    onPrimary: () => (ov.state === 'agree' ? moveUp(card) : openNoteSheet(card)),
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
  const pins = new Set(S.onb.pins || []);
  pins.add(card.id);
  S.onb.pins = Array.from(pins);
  saveOnb();
  track('moved_up', { card_id: card.id });
  toast('Moved to the top of Up next.');
}

// -- Feed ---------------------------------------------------------------------
function feedCards() {
  const t = todayStr();
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
  S.feedIndex = Math.min(S.feedIndex, Math.max(0, S.items.length - 1));
}
function renderFeed() {
  const stage = $('#card-stage');
  stage.textContent = '';
  const cards = S.items.filter((i) => i.kind === 'card');
  const unread = cards.filter((i) => !myAction(i.card.id)).length;
  $('#feed-count').textContent = cards.length + (cards.length === 1 ? ' card' : ' cards') + ' · ' + unread + ' unread';

  if (!S.items.length) {
    stage.appendChild(h('p', 'lib-empty', 'Your first drop lands soon.'));
    renderDots(); renderControls(); return;
  }
  const els = [];
  for (let d = 2; d >= 0; d--) {
    const item = S.items[S.feedIndex + d];
    if (!item) continue;
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
  $('#caught-up').hidden = !(S.feedIndex === S.items.length - 1 && cards.length && !unread);
  renderDots();
  renderControls();
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
    lab.appendChild(document.createTextNode({ agree: 'Agree', split: 'Split', timing: 'Timing' }[ov.state]));
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

  if (depth === 0 && ov && (ov.state === 'split' || ov.state === 'timing') && !S.readOnly) {
    const nb = h('button', 'btn-note gwm-btn');
    nb.type = 'button';
    nb.innerHTML = ICONS.pencil;
    nb.appendChild(h('span', null, 'Add a note'));
    stopDrag(nb);
    nb.addEventListener('click', (e) => { e.stopPropagation(); openNoteSheet(c); });
    el.appendChild(nb);
  }

  const sources = Array.isArray(c.sources) ? c.sources : [];
  if (sources.length) {
    const sw = h('div', 'card-sources');
    sw.appendChild(h('span', 'card-sources-label', 'Sources'));
    sources.slice(0, CHIP_LIMIT).forEach((src, i) => sw.appendChild(sourceChip(src, i + 1, c)));
    if (sources.length > CHIP_LIMIT) {
      const more = h('button', 'src-chip more gwm-center', '+' + (sources.length - CHIP_LIMIT));
      more.type = 'button';
      more.setAttribute('aria-label', 'Open all sources');
      stopDrag(more);
      more.addEventListener('click', (e) => { e.stopPropagation(); openSourceSheet(c); });
      sw.appendChild(more);
    }
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
function sourceChip(src, num, card) {
  const b = h('button', 'src-chip');
  b.type = 'button';
  b.setAttribute('aria-label', 'Source ' + num + ': ' + (src.publisher || '') + '. Open list of sources.');
  const n = h('span', 'num gwm-center', num);
  const i0 = h('span', 'mono-init gwm-center', String(src.publisher || '?').trim().charAt(0).toUpperCase() || '?');
  const p = h('span', 'pub', src.publisher || '');
  b.append(n, i0, p);
  stopDrag(b);
  b.addEventListener('click', (e) => { e.stopPropagation(); openSourceSheet(card); });
  return b;
}
function stopDrag(el) {
  ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'mousedown'].forEach((t) =>
    el.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));
}
function renderDots() {
  const wrap = $('#dots');
  wrap.textContent = '';
  S.items.forEach((item, i) => {
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
    b.disabled = !isCard || S.readOnly;
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
    if (e.target.closest('button, a')) return;
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
    if (drag.item.kind !== 'card' || S.readOnly) return;
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
    if (d.item.kind === 'signal' || S.readOnly) {
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
  if (S.readOnly) return;
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
function openNoteSheet(card) {
  noteCard = card;
  $('#note-sheet-title').textContent = card.title;
  const input = $('#note-input');
  input.value = '';
  $('#note-count').textContent = '0 / ' + NOTE_MAX;
  $('#note-save').disabled = true;
  openScrim('note-sheet');
  setTimeout(() => input.focus(), 50);
}
async function saveNote() {
  const body = $('#note-input').value.trim().slice(0, NOTE_MAX);
  if (!body || !noteCard) return;
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
  S.events.forEach((e) => {
    if (!byCard.has(e.card_id)) byCard.set(e.card_id, []);
    byCard.get(e.card_id).push(e);
  });
  const cardById = new Map(S.cards.map((c) => [c.id, c]));
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
function libArticles() {
  const rank = { live: 0, delivered: 0, approved_unwritten: 1 };
  return S.articles.slice().sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    String(b.delivered_at || b.requested_at || b.created_at).localeCompare(String(a.delivered_at || a.requested_at || a.created_at)));
}
function syncLibOrder() {
  const ids = libArticles().map((a) => a.id);
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
/** Delivery state line for a card. */
function deliveryState(a) {
  if (a.status === 'approved_unwritten') {
    if (a.requested_at && a.deliver_by) {
      const left = countdown(a.deliver_by);
      return { kind: 'arriving', text: left ? 'Arriving in ' + left : 'Arriving any minute' };
    }
    return { kind: 'approved', text: 'Approved · not written yet' };
  }
  const when = fmtWhen(a.delivered_at || a.created_at);
  const text = a.requested_at && a.delivered_at
    ? 'Delivered in ' + hoursBetween(a.requested_at, a.delivered_at) + 'h · ' + when
    : 'Delivered · ' + when;
  return { kind: 'delivered', text };
}
let countdownTimer = null;
function stopCountdowns() { clearInterval(countdownTimer); countdownTimer = null; }
function tickCountdowns() {
  $all('#deck-stage [data-countdown]').forEach((el) => {
    const a = S.articles.find((x) => x.id === el.dataset.countdown);
    if (a) el.textContent = deliveryState(a).text;
  });
}
function renderLibrary(opts) {
  syncLibOrder();
  stopCountdowns();
  const stage = $('#deck-stage');
  stage.textContent = '';
  const byId = new Map(S.articles.map((a) => [a.id, a]));
  const order = S.libOrder.map((id) => byId.get(id)).filter(Boolean);
  const written = order.filter((a) => a.status !== 'approved_unwritten').length;
  $('#lib-count').textContent = order.length ? written + ' written · ' + (order.length - written) + ' approved' : '';
  $('#lib-nav').hidden = order.length < 2;
  if (!order.length) {
    stage.appendChild(h('p', 'lib-empty', 'Your articles land here as they’re written.'));
    return;
  }
  const visible = order.slice(0, FAN.length);
  const els = [];
  // Paint back to front so the top card is last and fully covers the rest.
  for (let i = visible.length - 1; i >= 0; i--) {
    const a = visible[i];
    const ghost = a.status === 'approved_unwritten';
    const slot = FAN[i];
    const tf = `translateX(${slot.x}px) rotate(${slot.r}deg)`;
    const z = 20 - i * 2;
    if (ghost) {
      // The ghost trail: two faint dashed copies, 6px and 12px down-right.
      [2, 1].forEach((k) => {
        const t = h('div', `book-trail t${k} fmt-${a.format}`);
        t.style.transform = `${tf} translate(${6 * k}px, ${6 * k}px)`;
        t.style.zIndex = String(z - 1);
        t.setAttribute('aria-hidden', 'true');
        stage.appendChild(t);
      });
    }
    const b = h('div', 'book fmt-' + a.format + (ghost ? ' ghost' : '') + (i === 0 ? ' top' : ' back'));
    b.dataset.id = a.id;
    b.style.transform = tf;
    b.style.zIndex = String(z);
    const head = h('div', 'book-head');
    head.appendChild(h('span', 'card-format gwm-center gwm-mono-tag fmt-' + a.format, FMT_LABEL[a.format] || a.format));
    const card = S.cards.find((c) => c.id === a.card_id);
    if (card && card.series) head.appendChild(h('span', 'gwm-series-label', card.series));
    if (a.status === 'live') head.appendChild(h('span', 'live-tag gwm-center gwm-mono-tag', 'Live'));
    b.appendChild(head);
    b.appendChild(h('h3', 'book-title', a.title));
    const st = deliveryState(a);
    if (st.kind === 'delivered') {
      b.appendChild(h('span', 'book-stamp delivered gwm-center', st.text));
    } else {
      b.appendChild(h('span', 'book-stamp approved gwm-center', 'Approved'));
      const line = h('span', 'book-state ' + st.kind, st.text);
      if (st.kind === 'arriving') line.dataset.countdown = a.id;
      b.appendChild(line);
    }
    if (i === 0) {
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', (ghost ? 'Approved, not written: ' : 'Open article: ') + a.title + '. ' + st.text);
      attachBookGestures(b, a);
    } else b.setAttribute('aria-hidden', 'true');
    stage.appendChild(b);
    els[i] = b;
  }
  if (visible.some((a) => deliveryState(a).kind === 'arriving')) countdownTimer = setInterval(tickCountdowns, 30000);
  if (opts && opts.fromRects) animateBooksFrom(opts.fromRects, els);
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
function attachBookGestures(el, article) {
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
    if (!moved) { openArticle(article); return; }
    if (Math.abs(dx) > 60) rotateLib(dx > 0 ? -1 : 1);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openArticle(article); }
  });
}
function openArticle(a) {
  if (a.status === 'approved_unwritten') return openGhost(a);
  openReader(a);
}

// Ghost card
let ghostArticle = null;
function wantsWritten(a) {
  return S.notes.some((n) => n.member_id === S.me.id && n.body === WANTS_WRITTEN && n.card_id && n.card_id === a.card_id);
}
function openGhost(a) {
  ghostArticle = a;
  track('ghost_tapped', { article_id: a.id, format: a.format });
  S.onb.lines = S.onb.lines || {};
  if (!S.onb.lines.ghost) { S.onb.lines.ghost = true; saveOnb(); }
  $('#ghost-sheet-fmt').textContent = FMT_LABEL[a.format] || a.format;
  $('#ghost-sheet-title').textContent = a.title;
  const st = deliveryState(a);
  const arriving = st.kind === 'arriving';
  // A free pick in progress is already being written: say when, no Notify me.
  $('#ghost-copy').textContent = arriving ? 'Being written now. ' + st.text + '.' : 'Approved, not written yet. Credits open soon.';
  $('#notify-host').hidden = S.readOnly || arriving;
  const btn = $('#notify-btn');
  const done = wantsWritten(a);
  btn.disabled = done;
  btn.textContent = done ? 'You’re on the list' : 'Notify me';
  openScrim('ghost-sheet');
}
async function notifyMe() {
  const a = ghostArticle;
  if (!a || wantsWritten(a)) return;
  const btn = $('#notify-btn');
  btn.disabled = true;
  track('article_interest', { article_id: a.id, card_id: a.card_id, format: a.format });
  const { data, error } = await sb.from('notes')
    .insert({ company_id: S.company.id, member_id: S.me.id, card_id: a.card_id, body: WANTS_WRITTEN })
    .select('id,member_id,card_id,body,created_at').single();
  if (error) { btn.disabled = false; toast('That didn’t save. Try again.'); return; }
  S.notes.push(data);
  btn.textContent = 'You’re on the list';
  toast('We’ll let you know.');
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
  $('#reader-date').textContent = deliveryState(a).text;
  $('#reader-title').textContent = a.title;
  const body = $('#reader-html');
  body.innerHTML = cleanHtml(a.body_html) || '<p>The full text is in the Google Doc.</p>';
  $all('a[href]', body).forEach((l) => { l.target = '_blank'; l.rel = 'noopener noreferrer'; });
  const gdoc = $('#gdoc-link');
  const url = String(a.google_doc_url || '');
  gdoc.hidden = !/^https:\/\//i.test(url);
  if (!gdoc.hidden) gdoc.href = url;
  $('#copy-web').disabled = !a.body_html;
  const lt = $('#live-toggle');
  lt.hidden = S.readOnly;
  lt.setAttribute('aria-checked', a.status === 'live' ? 'true' : 'false');
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
  if (!a || S.readOnly) return;
  const lt = $('#live-toggle');
  const goLive = a.status !== 'live';
  lt.setAttribute('aria-checked', goLive ? 'true' : 'false');
  lt.disabled = true;
  const { data, error } = await sb.rpc('portal_set_live', { p_article_id: a.id, p_live: goLive });
  lt.disabled = false;
  if (error) {
    lt.setAttribute('aria-checked', goLive ? 'false' : 'true');
    toast('That didn’t save. Try again.');
    return;
  }
  a.status = data.status;
  a.live_at = data.live_at;
  track('marked_live', { article_id: a.id, live: goLive });
  if (goLive) firstLine('live', 'It’s live. We’ll start watching how it ranks.');
  renderLibrary();
}

// -- Hub entry: pencil -> (invite) -> design mode --------------------------------
function openHubFlow() {
  track('hub_tapped', { members: S.members.length, forced: S.forceHub || undefined });
  if (S.onb.library_glow && !S.onb.pencil_glow) { setFlag('pencil_glow'); $('#pencil-sticker').classList.remove('onb-glow'); }
  hideBubble();
  const forceInvite = S.forceHub === 'invite';
  if (forceInvite || (S.members.length < 3 && !S.onb.hub_invite_seen)) openInvite();
  else goHub();
}
function goHub() {
  enterHub({ forceLocked: S.forceHub === 'locked', fromRects: libraryRects() });
}
function exitHub() {
  const rects = articleRects();
  go('library', { fromRects: rects });
}
function openInvite() {
  const seats = Math.min(2, 3 - S.members.length);
  if (seats <= 0) { toast('Your portal already has 3 people.'); goHub(); return; }
  const wrap = $('#invite-fields');
  wrap.textContent = '';
  for (let i = 0; i < seats; i++) {
    const lab = h('label', 'field');
    const input = h('input');
    input.type = 'email';
    input.placeholder = i === 0 ? 'teammate@work.com' : 'another@work.com (optional)';
    input.autocomplete = 'off';
    input.inputMode = 'email';
    input.setAttribute('aria-label', 'Teammate email ' + (i + 1));
    lab.appendChild(input);
    wrap.appendChild(lab);
  }
  $('#invite-sub').textContent = seats === 1
    ? 'They’ll get a sign-in link. One seat left on your portal.'
    : 'They’ll get a sign-in link. Up to 3 people per portal.';
  $('#invite-msg').textContent = ' ';
  $('#invite-msg').className = 'field-msg';
  $('#invite-btn').disabled = false;
  openScrim('invite-modal');
  setTimeout(() => { const f = $('#invite-fields input'); if (f) f.focus(); }, 60);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
async function submitInvite(e) {
  e.preventDefault();
  const msg = $('#invite-msg');
  const emails = $all('#invite-fields input').map((i) => i.value.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) { msg.textContent = 'Add an email, or skip for now.'; msg.className = 'field-msg err'; return; }
  const bad = emails.find((x) => !EMAIL_RE.test(x));
  if (bad) { msg.textContent = 'That email doesn’t look right: ' + bad; msg.className = 'field-msg err'; return; }
  const btn = $('#invite-btn');
  btn.disabled = true;
  msg.textContent = 'Sending…';
  msg.className = 'field-msg';
  const { data, error } = await sb.functions.invoke('invite-member', { body: { emails } });
  if (error) {
    let code = '';
    try { code = (await error.context.json()).error; } catch (_) {}
    msg.textContent = {
      seat_limit: 'Your portal already has 3 people.',
      invalid_email: 'One of those emails doesn’t look right.',
      self_invite: 'That’s your own email.',
    }[code] || 'That didn’t go through. Try again.';
    msg.className = 'field-msg err';
    btn.disabled = false;
    return;
  }
  const sent = (data && data.results || []).filter((r) => r.status === 'invited').length;
  track('invite_sent', { count: sent, requested: emails.length });
  setFlag('hub_invite_seen');
  await refreshMembers();
  closeScrim('invite-modal');
  toast(sent ? (sent === 1 ? 'Invite sent.' : 'Invites sent.') : 'They’re already on your portal.');
  goHub();
}
function skipInvite() {
  setFlag('hub_invite_seen');
  closeScrim('invite-modal');
  goHub();
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
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + '/portal' },
  });
  btn.disabled = false;
  if (error && error.status === 429) {
    msg.textContent = 'Too many tries. Wait a minute and try again.';
    msg.className = 'field-msg err';
    return;
  }
  // Same answer whether or not the email has a portal.
  msg.textContent = ' ';
  sentTo = email;
  $('#sent-email').textContent = email;
  $('#signin-form').hidden = true;
  $('#signin-sent').hidden = false;
  $('#signin-code').focus();
}
// Six to eight digit code from the same email, for people whose link opens in
// an email app's built-in browser instead of the one they want to stay in.
async function verifyCode(e) {
  e.preventDefault();
  const input = $('#signin-code');
  const msg = $('#code-msg');
  const token = input.value.replace(/\s+/g, '');
  input.value = token;
  const bad = () => {
    msg.textContent = 'That code didn’t work. Check the latest email or send a new one.';
    msg.className = 'field-msg err';
  };
  if (!sentTo || !/^[0-9]{6,8}$/.test(token)) return bad();
  const btn = $('#code-btn');
  btn.disabled = true;
  msg.className = 'field-msg';
  msg.textContent = 'Checking…';
  let res;
  try { res = await sb.auth.verifyOtp({ email: sentTo, token, type: 'email' }); }
  catch (err) { res = { error: err }; }
  btn.disabled = false;
  if (res.error || !res.data || !res.data.session) return bad();
  msg.textContent = ' ';
  S.session = res.data.session;
  start(true);
}
function resetSignin() {
  $('#signin-code').value = '';
  $('#code-msg').textContent = ' ';
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
    sb.from('companies').select('id,slug,name,contact_first_name,subscription_status,subscription_ends_at,hub_unlocked,is_internal').eq('id', cid).single(),
    sb.from('members').select('id,user_id,role,display_name,avatar_shape,onboarding,created_at').eq('company_id', cid).order('created_at'),
    sb.from('cards').select('id,card_key,format,series,title,angle,evidence,tags,sources,drop_date,sort_order').eq('company_id', cid).order('sort_order'),
    sb.from('decisions').select('card_id,member_id,action,updated_at').eq('company_id', cid),
    sb.from('swipe_events').select('id,card_id,member_id,action,source,created_at').eq('company_id', cid).order('created_at'),
    sb.from('signals').select('text,source,signal_date').eq('company_id', cid).order('signal_date', { ascending: false }).order('created_at', { ascending: false }).limit(1),
    sb.from('articles').select('id,card_id,format,title,status,body_html,google_doc_url,requested_at,deliver_by,delivered_at,live_at,created_at').eq('company_id', cid),
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
  S.readOnly = c.subscription_status === 'canceled' && !!c.subscription_ends_at && new Date(c.subscription_ends_at) <= new Date();
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
  if (fromLink || !loggedThisTab) track('portal_login', { via: fromLink ? 'link' : 'session', read_only: S.readOnly });

  $('#company-name').textContent = c.name;
  $('#pencil-sticker').innerHTML = pencilSVG(84);
  buildItems();

  if (S.readOnly) {
    const line = $('#resub-line');
    line.hidden = false;
    line.textContent = 'Your subscription ended ' + fmtDay(c.subscription_ends_at) + '. Your library stays here. ';
    const a = h('a', null, 'Resubscribe to reopen your feed.');
    a.href = '/' + encodeURIComponent(c.slug);
    line.appendChild(a);
    $('#pencil-sticker').hidden = true;
    go('library');
    return;
  }
  go('feed');
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
    libArticles, exitHub, FMT_LABEL, WANTS_WRITTEN,
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
    case 'bubble-dismiss': return dismissBubble();
    case 'sign-out': return signOut();
    case 'signin-again': return resetSignin();
  }
});
// Tap outside a sheet closes it.
['src-sheet', 'note-sheet', 'ghost-sheet', 'hub-text-sheet'].forEach((id) => {
  $('#' + id).addEventListener('click', (e) => { if (e.target.id === id) closeScrim(id); });
});
$('#signin-form').addEventListener('submit', sendLink);
$('#code-form').addEventListener('submit', verifyCode);
$('#invite-form').addEventListener('submit', submitInvite);
$('#note-input').addEventListener('input', (e) => {
  $('#note-count').textContent = e.target.value.length + ' / ' + NOTE_MAX;
  $('#note-save').disabled = !e.target.value.trim();
});
$('#note-save').addEventListener('click', saveNote);
$('#notify-btn').addEventListener('click', notifyMe);
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
    ['src-sheet', 'note-sheet', 'ghost-sheet', 'hub-text-sheet'].forEach((id) => closeScrim(id));
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
