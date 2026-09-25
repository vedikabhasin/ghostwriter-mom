// -----------------------------------------------------------------------------
// ghostwriter.mom portal. Three places: Feed, Library, Hub.
// Reads through RLS as the signed-in member; writes through RLS (notes,
// members.onboarding) or the portal_* RPCs (decisions, mark live), and the
// invite-member edge function.
// -----------------------------------------------------------------------------
import { avatarSVG, pencilSVG } from '/portal/avatars.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2.45.0';
const SWIPE_T = 90;
const VERT_T = 100;
const CHIP_LIMIT = 3;
const NOTE_MAX = 280;
const WANTS_WRITTEN = 'wants_written';
const POSITIVE = ['like', 'fasttrack'];
const ACTION_LABEL = { like: 'Liked', pass: 'Passed', save: 'Saved', fasttrack: 'Fast-track' };
const FMT_LABEL = { pillar: 'Pillar', insight: 'Insight', post: 'Post' };
const FMT_TINT = { pillar: 'rgba(183,156,255,0.28)', insight: 'rgba(140,200,255,0.28)', post: 'rgba(245,232,74,0.26)' };
const ACTION_TINT = { like: 'rgba(184,255,113,0.5)', pass: 'rgba(255,157,192,0.5)', fasttrack: 'rgba(183,156,255,0.5)', save: 'rgba(245,232,74,0.5)' };
const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// -- Tiny DOM helpers ---------------------------------------------------------
const $ = (sel, root) => (root || document).querySelector(sel);
const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function avatarEl(member, lg) {
  const s = h('span', 'av' + (lg ? ' lg' : ''));
  s.innerHTML = avatarSVG(member || {}, lg ? 27 : 20);
  s.title = displayName(member);
  return s;
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(v) {
  if (!v) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function fmtWhen(iso) {
  const d = new Date(iso);
  return fmtDate(iso) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function hash(s) { let x = 0; s = String(s); for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; }

// -- State --------------------------------------------------------------------
let runtime = { supabaseUrl: '', supabaseAnonKey: '', posthogKey: '', posthogHost: 'https://us.i.posthog.com' };
let sb = null;
let ph = { capture() {}, identify() {}, group() {}, register() {}, reset() {} };
const S = {
  session: null, me: null, company: null, members: [], cards: [], decisions: [], events: [],
  signal: null, articles: [], notes: [], readOnly: false,
  view: 'loading', feedIndex: 0, items: [], libOrder: [], onb: {}, loaded: false,
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
  const sw = $('#switch');
  sw.hidden = !(S.loaded && (view === 'feed' || view === 'library') && !S.readOnly);
  $('#switch-feed').classList.toggle('active', view === 'feed');
  $('#switch-library').classList.toggle('active', view === 'library');
  $('#sign-out-btn').hidden = !S.session;
  if (view !== 'feed') setFormatTint(null);
  hideBubble();
  window.scrollTo(0, 0);
}
function setFormatTint(format) {
  const t = $('#tint-format');
  if (!format || !FMT_TINT[format]) { t.setAttribute('data-on', '0'); return; }
  document.documentElement.style.setProperty('--tint-format', FMT_TINT[format]);
  t.setAttribute('data-on', '1');
}
function setActionTint(action, strength) {
  document.documentElement.style.setProperty('--tint-action', ACTION_TINT[action] || 'transparent');
  document.documentElement.style.setProperty('--tint-action-strength', String(strength || 0));
}

// -- Toasts (queued so first-time lines never trample each other) -------------
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
    const b = h('button', null, t.action.label);
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
function saveOnb() {
  clearTimeout(onbTimer);
  onbTimer = setTimeout(() => {
    sb.from('members').update({ onboarding: S.onb }).eq('id', S.me.id).then(({ error }) => {
      if (error) console.warn('[portal] onboarding save failed', error.message);
    });
  }, 250);
}
function setFlag(key) { if (S.onb[key]) return; S.onb[key] = true; saveOnb(); }
// First-time event lines. Each shows once per member.
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
  let left = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 12);
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
function runOnboarding() {
  if (S.readOnly) return;
  const o = S.onb;
  $('#switch-library').classList.toggle('onb-glow', !!o.feed_intro && !o.library_glow);
  $('#pencil-sticker').classList.toggle('onb-glow', !!o.library_glow && !o.pencil_glow);
  // Wait a frame so layout (and the switch) are in place before measuring.
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
// "Up next": what we'd write next. Agree cards move to the top.
function upNext() {
  const written = new Set(S.articles.map((a) => a.card_id).filter(Boolean));
  return feedCards()
    .filter((c) => !written.has(c.id))
    .map((c) => {
      const acts = Array.from(teamDecisions(c.id).values());
      const pos = acts.filter((a) => POSITIVE.includes(a)).length;
      const ft = acts.filter((a) => a === 'fasttrack').length;
      const pass = acts.filter((a) => a === 'pass').length;
      const ov = overlap(c.id);
      const score = (ov && ov.state === 'agree' ? 100 : 0) + pos * 10 + ft * 5 - pass * 4;
      return { card: c, score, pos, ov };
    })
    .filter((x) => x.pos > 0)
    .sort((a, b) => b.score - a.score);
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
  for (let d = 2; d >= 0; d--) {
    const item = S.items[S.feedIndex + d];
    if (item) stage.appendChild(buildFeedCard(item, d));
  }
  const top = stage.querySelector('.card[data-depth="0"]');
  if (top) {
    stage.style.minHeight = Math.max(window.innerWidth <= 420 ? 380 : 470, top.offsetHeight + 28) + 'px';
    const cur = S.items[S.feedIndex];
    setFormatTint(cur.kind === 'card' ? cur.card.format : null);
    if (cur.kind === 'card') noticeOverlap(cur.card);
  }
  if (S.feedIndex === S.items.length - 1 && cards.length && !unread) {
    stage.appendChild(Object.assign(h('span', 'caught-up', 'All caught up'), { style: 'position:absolute; bottom:-8px;' }));
  }
  renderDots();
  renderControls();
}
function buildFeedCard(item, depth) {
  const el = h('div', 'card');
  el.setAttribute('data-depth', String(depth));
  if (item.kind === 'signal') {
    el.classList.add('fmt-signal');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Signal');
    const head = h('div', 'card-head');
    head.appendChild(h('span', 'card-format', 'Signal'));
    head.appendChild(h('span', 'signal-dot'));
    el.appendChild(head);
    el.appendChild(h('p', 'signal-body', item.signal.text));
    const meta = h('p', 'signal-meta', (item.signal.source || '') + (item.signal.signal_date ? ' · ' + fmtDate(item.signal.signal_date) : ''));
    el.appendChild(meta);
    el.appendChild(h('span', 'signal-hint', 'Swipe for this week’s cards →'));
    if (depth === 0) attachCardGestures(el, item);
    return el;
  }
  const c = item.card;
  const fmt = String(c.format || 'post').toLowerCase();
  el.classList.add('fmt-' + fmt);
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', (FMT_LABEL[fmt] || 'Card') + ': ' + c.title);
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (tags.some((t) => String(t).toLowerCase() === 'refresh')) el.classList.add('has-refresh');

  const head = h('div', 'card-head');
  head.appendChild(h('span', 'card-format', FMT_LABEL[fmt] || fmt));
  if (item.isNew) head.appendChild(h('span', 'new-label', 'New this week'));
  el.appendChild(head);

  // Overlap label sits in the header row to keep the card short on phones.
  const ov = depth === 0 ? overlap(c.id) : null;
  if (ov) {
    el.classList.add('ov-' + ov.state);
    const lab = h('span', 'ov-label ' + ov.state);
    const avs = h('span', 'avs');
    avs.appendChild(avatarEl(ov.a)); avs.appendChild(avatarEl(ov.b));
    lab.appendChild(avs);
    lab.appendChild(document.createTextNode({ agree: 'Agree', split: 'Split', timing: 'Timing' }[ov.state]));
    lab.setAttribute('aria-label', ov.state + ': ' + displayName(ov.a) + ' ' + ACTION_LABEL[ov.aAction].toLowerCase() + ', ' + displayName(ov.b) + ' ' + ACTION_LABEL[ov.bAction].toLowerCase());
    head.appendChild(lab);
  }

  el.appendChild(h('h2', 'card-title', c.title));
  el.appendChild(h('p', 'card-angle', c.angle));
  if (c.evidence) el.appendChild(h('p', 'card-evidence', c.evidence));
  const tagWrap = h('div', 'card-tags');
  tags.filter((t) => String(t).toLowerCase() !== 'refresh').forEach((t) => tagWrap.appendChild(h('span', 'card-tag', t)));
  el.appendChild(tagWrap);

  if (depth === 0) {
    const notes = S.notes.filter((n) => n.card_id === c.id && n.body !== WANTS_WRITTEN).slice(-2);
    if (notes.length) {
      const wrap = h('div', 'card-notes');
      notes.forEach((n) => {
        const row = h('div', 'n');
        row.appendChild(avatarEl(memberById(n.member_id)));
        row.appendChild(h('span', null, n.body));
        wrap.appendChild(row);
      });
      el.appendChild(wrap);
    }
    if (ov && (ov.state === 'split' || ov.state === 'timing') && !S.readOnly) {
      const nb = h('button', 'note-btn', 'Add a note');
      nb.type = 'button';
      stopDrag(nb);
      nb.addEventListener('click', (e) => { e.stopPropagation(); openNoteSheet(c); });
      tagWrap.appendChild(nb);
    }
  }

  const sources = Array.isArray(c.sources) ? c.sources : [];
  if (sources.length) {
    const sw = h('div', 'card-sources');
    sw.appendChild(h('span', 'card-sources-label', 'Sources'));
    sources.slice(0, CHIP_LIMIT).forEach((src, i) => sw.appendChild(sourceChip(src, i + 1, c)));
    if (sources.length > CHIP_LIMIT) {
      const more = h('button', 'src-chip more', '+' + (sources.length - CHIP_LIMIT));
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
    const st = h('span', 'card-stamp ' + mine, ACTION_LABEL[mine]);
    st.setAttribute('aria-label', 'Your call: ' + ACTION_LABEL[mine]);
    el.appendChild(st);
  }
  ['like', 'pass', 'save', 'fasttrack'].forEach((a) => {
    const s = h('span', 'drag-stamp ' + a, ACTION_LABEL[a]);
    s.setAttribute('aria-hidden', 'true');
    el.appendChild(s);
  });
  if (depth === 0) attachCardGestures(el, item);
  return el;
}
function sourceChip(src, num, card) {
  const b = h('button', 'src-chip');
  b.type = 'button';
  b.setAttribute('aria-label', 'Source ' + num + ': ' + (src.publisher || '') + '. Open list of sources.');
  const n = h('span', 'num', num);
  const i0 = h('span', 'mono-init', String(src.publisher || '?').trim().charAt(0).toUpperCase() || '?');
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
      d.setAttribute('aria-label', 'Card ' + (i + (S.signal ? 0 : 1)) + ': ' + item.card.title + (read ? '' : ' (unread)'));
    }
    if (i === S.feedIndex) { d.classList.add('current'); d.setAttribute('aria-selected', 'true'); }
    else d.setAttribute('aria-selected', 'false');
    wrap.appendChild(d);
  });
  const cur = wrap.children[S.feedIndex];
  if (cur) {
    const left = cur.offsetLeft - wrap.clientWidth / 2 + cur.offsetWidth / 2;
    wrap.scrollLeft = left;
  }
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
  if (!seenOverlap.has(card.id + ov.state)) {
    seenOverlap.add(card.id + ov.state);
    track('overlap_seen', { state: ov.state, card_id: card.id });
  }
  overlapLine(card, ov);
}
function overlapLine(card, ov) {
  const meIn = ov.a.id === S.me.id || ov.b.id === S.me.id;
  if (ov.state === 'agree' && meIn) {
    firstLine('agree', 'You both want this one. It’s moving up.');
  } else if (ov.state === 'split' && meIn) {
    const other = ov.a.id === S.me.id ? ov.b : ov.a;
    const otherAction = ov.a.id === S.me.id ? ov.bAction : ov.aAction;
    const text = otherAction === 'pass'
      ? displayName(other) + ' passed. You want this one. Leave a note?'
      : displayName(other) + (otherAction === 'fasttrack' ? ' wants to fast-track this.' : ' likes this.') + ' You passed. Leave a note?';
    firstLine('split', text, { action: { label: 'Add a note', fn: () => openNoteSheet(card) }, ms: 6000 });
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
      // Signal card: any swipe moves to the next card.
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
  if (prev === action) {
    // Same call again: nothing to record, just move on.
    const next = () => { if (S.feedIndex < S.items.length - 1) S.feedIndex += 1; renderFeed(); };
    return top0 ? exitThen(top0, action, next) : next();
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

  const top = $('#card-stage .card[data-depth="0"]');
  const advance = () => {
    if (S.feedIndex < S.items.length - 1) S.feedIndex += 1;
    renderFeed();
  };
  if (top) exitThen(top, action, advance); else advance();

  track('feed_swipe', { action, via: via || 'button', card_id: card.id, format: card.format, changed: !!prev && prev !== action });
  if (prev && prev !== action) {
    track('decision_changed', { from: prev, to: action, card_id: card.id });
    firstLine('changed', 'Changed your mind? Swipe back anytime. We track the final call.');
  }
  const after = overlap(card.id);
  if (after && (!before || before.state !== after.state)) {
    seenOverlap.add(card.id + after.state);
    track('overlap_seen', { state: after.state, card_id: card.id });
    overlapLine(card, after);
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
    li.append(h('span', 'sheet-num', i + 1), body);
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
  if (S.view === 'feed') renderFeed();
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
    box.appendChild(h('p', 'hist-title', c.title));
    evs.slice().reverse().forEach((e) => {
      const m = eventMember(e.member_id);
      const row = h('div', 'hist-row');
      row.appendChild(avatarEl(m));
      const who = h('span');
      who.appendChild(h('span', 'who', m.id === S.me.id ? 'You' : displayName(m)));
      who.appendChild(h('span', 'pill ' + e.action, ACTION_LABEL[e.action]));
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
    row.appendChild(h('span', 'upnext-rank', i + 1));
    row.appendChild(h('span', 'hist-title', x.card.title));
    if (x.ov && x.ov.state === 'agree') {
      const lab = h('span', 'ov-label agree');
      const avs = h('span', 'avs');
      avs.append(avatarEl(x.ov.a), avatarEl(x.ov.b));
      lab.append(avs, document.createTextNode('Agree'));
      row.appendChild(lab);
    } else row.appendChild(h('span'));
    box.appendChild(row);
    un.appendChild(box);
  });
}

// -- Library -------------------------------------------------------------------
function libArticles() {
  const rank = { live: 0, delivered: 0, approved_unwritten: 1 };
  return S.articles.slice().sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    String(b.delivered_at || b.created_at).localeCompare(String(a.delivered_at || a.created_at)));
}
function syncLibOrder() {
  const ids = libArticles().map((a) => a.id);
  S.libOrder = S.libOrder.filter((id) => ids.includes(id));
  ids.forEach((id) => { if (!S.libOrder.includes(id)) S.libOrder.push(id); });
}
const FAN = [0, 4, -5, 7, -8];
function thickness(fmt) {
  const n = fmt === 'pillar' ? 7 : fmt === 'insight' ? 3 : 1;
  const s = [];
  for (let k = 1; k <= n; k++) s.push(k + 'px ' + k + 'px 0 ' + (k % 2 ? '#FFFFFF' : '#DCD8CE'));
  s.push('0 22px 40px -22px rgba(14,14,14,0.5)');
  return s.join(',');
}
function renderLibrary() {
  syncLibOrder();
  const stage = $('#deck-stage');
  stage.textContent = '';
  const byId = new Map(S.articles.map((a) => [a.id, a]));
  const order = S.libOrder.map((id) => byId.get(id)).filter(Boolean);
  const delivered = order.filter((a) => a.status !== 'approved_unwritten').length;
  $('#lib-count').textContent = order.length ? delivered + ' written · ' + (order.length - delivered) + ' approved' : '';
  $('#lib-nav').hidden = order.length < 2;
  if (!order.length) {
    stage.appendChild(h('p', 'lib-empty', 'Your articles land here as they’re written.'));
    return;
  }
  const visible = order.slice(0, 5);
  for (let i = visible.length - 1; i >= 0; i--) {
    const a = visible[i];
    const b = h('div', 'book fmt-' + a.format + (a.status === 'approved_unwritten' ? ' ghost' : ''));
    b.style.zIndex = String(10 - i);
    b.style.transform = 'translate(' + (i * 7) + 'px,' + (i * -9) + 'px) rotate(' + FAN[i] + 'deg) scale(' + (1 - i * 0.035) + ')';
    if (a.status !== 'approved_unwritten') b.style.boxShadow = thickness(a.format);
    b.appendChild(h('span', 'card-format fmt-' + a.format, FMT_LABEL[a.format] || a.format));
    b.appendChild(h('h3', 'book-title', a.title));
    const meta = h('div', 'book-meta');
    if (a.status === 'approved_unwritten') meta.appendChild(h('span', null, 'Approved · not written yet'));
    else {
      meta.appendChild(h('span', null, 'Delivered ' + fmtDate(a.delivered_at || a.created_at)));
      if (a.status === 'live') meta.appendChild(h('span', 'live-tag', 'Live'));
    }
    b.appendChild(meta);
    if (i === 0) {
      b.classList.add('top');
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', (a.status === 'approved_unwritten' ? 'Approved, not written: ' : 'Open article: ') + a.title);
      attachBookGestures(b, a);
    } else b.setAttribute('aria-hidden', 'true');
    stage.appendChild(b);
  }
}
function rotateLib(dir) {
  if (S.libOrder.length < 2) return;
  if (dir > 0) S.libOrder.push(S.libOrder.shift());
  else S.libOrder.unshift(S.libOrder.pop());
  renderLibrary();
}
function attachBookGestures(el, article) {
  let d = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    d = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(d.dx, dy) < 6) return;
    d.moved = true;
    el.style.transform = 'translate(' + d.dx + 'px,0) rotate(' + (d.dx / 18) + 'deg)';
  });
  const up = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const moved = d.moved, dx = d.dx;
    d = null;
    el.classList.remove('dragging');
    if (e.type === 'pointercancel') { renderLibrary(); return; }
    if (!moved) { openArticle(article); return; }
    if (Math.abs(dx) > 70) {
      // Slide the top card out, then tuck it at the back of the hand.
      el.style.transform = 'translate(' + (dx > 0 ? 120 : -120) + '%, 20px) rotate(' + (dx > 0 ? 16 : -16) + 'deg)';
      el.style.opacity = '0';
      setTimeout(() => rotateLib(1), prefersReduced ? 0 : 260);
    } else renderLibrary();
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
  // The sheet itself carries the first-time line, so just mark it seen.
  S.onb.lines = S.onb.lines || {};
  if (!S.onb.lines.ghost) { S.onb.lines.ghost = true; saveOnb(); }
  $('#ghost-sheet-fmt').textContent = FMT_LABEL[a.format] || a.format;
  $('#ghost-sheet-title').textContent = a.title;
  const btn = $('#notify-btn');
  $('#notify-host').hidden = S.readOnly;
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
// Clean body_html: allow-listed tags only, no classes, no styles, safe links.
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
  fmt.className = 'card-format fmt-' + a.format;
  fmt.textContent = FMT_LABEL[a.format] || a.format;
  $('#reader-date').textContent = 'Delivered ' + fmtDate(a.delivered_at || a.created_at);
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

// -- Hub -----------------------------------------------------------------------
function openHubFlow() {
  track('hub_tapped', { members: S.members.length });
  if (S.onb.library_glow && !S.onb.pencil_glow) { setFlag('pencil_glow'); $('#pencil-sticker').classList.remove('onb-glow'); }
  hideBubble();
  if (S.members.length < 3 && !S.onb.hub_invite_seen) openInvite();
  else openHub();
}
function openInvite() {
  const seats = Math.min(2, 3 - S.members.length);
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
  openHub();
}
function skipInvite() {
  setFlag('hub_invite_seen');
  closeScrim('invite-modal');
  openHub();
}
async function refreshMembers() {
  const { data } = await sb.from('members').select('id,user_id,role,display_name,avatar_shape,created_at')
    .eq('company_id', S.company.id).order('created_at');
  if (data) S.members = data;
}
function openHub() {
  const unlocked = !!S.company.hub_unlocked;
  show('hub');
  const canvas = $('#hub-canvas');
  const items = $('#hub-items');
  items.textContent = '';
  const cardById = new Map(S.cards.map((c) => [c.id, c]));

  const notes = S.notes.filter((n) => n.body !== WANTS_WRITTEN).map((n) => {
    const s = h('div', 'sticker sticky-note');
    s.appendChild(h('span', null, n.body));
    const about = n.card_id && cardById.get(n.card_id);
    if (about) s.appendChild(h('span', 'about', 'On: ' + about.title));
    const who = h('span', 'who');
    who.append(avatarEl(memberById(n.member_id)), document.createTextNode(displayName(memberById(n.member_id))));
    s.appendChild(who);
    return { id: n.id, el: s };
  });
  const books = libArticles().map((a) => {
    const b = h('div', 'sticker mini-book fmt-' + a.format + (a.status === 'approved_unwritten' ? ' ghost' : ''));
    b.appendChild(h('span', null, a.title));
    b.appendChild(h('span', 'k', a.status === 'approved_unwritten' ? 'Approved' : a.status === 'live' ? 'Live' : 'Delivered'));
    return { id: a.id, el: b };
  });
  const agrees = upNext().filter((x) => x.ov && x.ov.state === 'agree').slice(0, 3).map((x) => {
    const c = h('div', 'sticker agree-card');
    const lab = h('span', 'ov-label agree');
    const avs = h('span', 'avs');
    avs.append(avatarEl(x.ov.a), avatarEl(x.ov.b));
    lab.append(avs, document.createTextNode('Agree'));
    c.append(lab, h('span', null, x.card.title));
    return { id: x.card.id, el: c };
  });
  // Interleave so the canvas reads as a mixed board, not three lists.
  const all = [];
  const lists = [notes, books, agrees];
  for (let i = 0; lists.some((l) => i < l.length); i++) lists.forEach((l) => { if (l[i]) all.push(l[i]); });
  all.forEach(({ id, el }) => {
    const r = hash(id);
    el.style.setProperty('--rot', ((r % 1100) / 100 - 5.5).toFixed(1) + 'deg');
    el.style.setProperty('--dy', ((r >> 8) % 22 - 11) + 'px');
    items.appendChild(el);
  });
  canvas.classList.toggle('locked', !unlocked);
  canvas.classList.toggle('unlocked', unlocked);
  canvas.classList.toggle('empty', !all.length);
  $('#hub-line').textContent = unlocked
    ? 'Coming soon: add stickers, links, and notes.'
    : 'Your notes, articles, and ideas, in one place. Unlocks with your first credit pack.';
  if (!unlocked) track('hub_locked_viewed', { items: all.length });
}

// -- Navigation ----------------------------------------------------------------
function go(view) {
  if (view === 'library') {
    if (!S.onb.library_glow && S.onb.feed_intro) { setFlag('library_glow'); $('#switch-library').classList.remove('onb-glow'); }
    show('library'); renderLibrary();
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
  msg.textContent = 'Check your inbox. The link opens your portal.';
}
async function signOut() {
  try { await sb.auth.signOut(); } catch (_) {}
  try { ph.reset(); } catch (_) {}
  location.href = '/portal';
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
  const [company, members, cards, decisions, events, signal, articles, notes] = await Promise.all([
    sb.from('companies').select('id,slug,name,contact_first_name,subscription_status,subscription_ends_at,hub_unlocked').eq('id', cid).single(),
    sb.from('members').select('id,user_id,role,display_name,avatar_shape,created_at').eq('company_id', cid).order('created_at'),
    sb.from('cards').select('id,card_key,format,title,angle,evidence,tags,sources,drop_date,sort_order').eq('company_id', cid).order('sort_order'),
    sb.from('decisions').select('card_id,member_id,action,updated_at').eq('company_id', cid),
    sb.from('swipe_events').select('id,card_id,member_id,action,source,created_at').eq('company_id', cid).order('created_at'),
    sb.from('signals').select('text,source,signal_date').eq('company_id', cid).order('signal_date', { ascending: false }).order('created_at', { ascending: false }).limit(1),
    sb.from('articles').select('id,card_id,format,title,status,body_html,google_doc_url,delivered_at,live_at,created_at').eq('company_id', cid),
    sb.from('notes').select('id,member_id,card_id,body,created_at').eq('company_id', cid).order('created_at'),
  ]);
  const failed = [company, members, cards, decisions, events, signal, articles, notes].find((r) => r.error);
  if (failed) throw failed.error;
  S.company = company.data;
  S.members = members.data;
  S.cards = cards.data;
  S.decisions = decisions.data;
  S.events = events.data;
  S.signal = signal.data[0] || null;
  S.articles = articles.data;
  S.notes = notes.data;
  const c = S.company;
  S.readOnly = c.subscription_status === 'canceled' && !!c.subscription_ends_at && new Date(c.subscription_ends_at) <= new Date();
  S.loaded = true;

  // Analytics: member id only, never email. Group by company slug.
  try {
    ph.identify(S.me.id, { role: S.me.role });
    ph.group('company', c.slug, { name: c.name });
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
    line.textContent = 'Your subscription ended ' + fmtDate(c.subscription_ends_at) + '. Your library stays here. ';
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
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (location.hash && /access_token|error/.test(location.hash)) history.replaceState(null, '', location.pathname);
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
async function start(fromLink) {
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
    case 'back-to-library': return go('library');
    case 'invite-skip': return skipInvite();
    case 'bubble-dismiss': return dismissBubble();
    case 'sign-out': return signOut();
  }
});
// Tap outside a sheet closes it.
['src-sheet', 'note-sheet', 'ghost-sheet'].forEach((id) => {
  $('#' + id).addEventListener('click', (e) => { if (e.target.id === id) closeScrim(id); });
});
$('#signin-form').addEventListener('submit', sendLink);
$('#invite-form').addEventListener('submit', submitInvite);
$('#note-input').addEventListener('input', (e) => {
  const n = e.target.value.length;
  $('#note-count').textContent = n + ' / ' + NOTE_MAX;
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
  dots.addEventListener('pointerdown', (e) => {
    s = { id: e.pointerId, x0: e.clientX, moved: false, start: S.feedIndex };
  });
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
    if (!$('#reader').hidden) return closeScrim('reader');
    ['src-sheet', 'note-sheet', 'ghost-sheet'].forEach((id) => closeScrim(id));
    if ($('#invite-modal').classList.contains('open')) skipInvite();
    return;
  }
  if (e.target.closest('input, textarea') || !$('#reader').hidden || document.querySelector('.sheet-scrim.open, .modal-scrim.open')) return;
  if (S.view === 'feed' && e.key === 'ArrowLeft') { e.preventDefault(); goTo(S.feedIndex - 1, 'key'); }
  if (S.view === 'feed' && e.key === 'ArrowRight') { e.preventDefault(); goTo(S.feedIndex + 1, 'key'); }
  if (S.view === 'library' && e.key === 'ArrowRight') { e.preventDefault(); rotateLib(1); }
  if (S.view === 'library' && e.key === 'ArrowLeft') { e.preventDefault(); rotateLib(-1); }
});
window.addEventListener('resize', () => { if (bubbleKey) runOnboarding(); });

boot();
