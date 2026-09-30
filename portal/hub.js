// -----------------------------------------------------------------------------
// Hub: the Library's design mode. The same books, unstacked onto a canvas.
//
// hub_items rows (migration 6) hold everything on the canvas:
//   article  ref_id -> articles.id          note  ref_id -> notes.id
//   text     body                           emoji emoji glyph
//   card     ref_id -> cards.id, an UP NEXT card (migration 13); it becomes
//            the article in place once someone requests it
// An emoji pinned onto another item stores that item's id in ref_id and its
// x/y relative to the item, so it travels with it. A free emoji has ref_id
// null and canvas x/y. Only this view has grabbable, movable items.
//
// Access comes from the account (hub_access: internal, hub_unlocked, or any
// credit grant). Locked, the canvas shows only the company's own items (or an
// empty grid), blurred and read-only under the lock modal; the header with
// seats and Invite sits above both.
// -----------------------------------------------------------------------------
import { $, $all, h, hash, prefersReduced } from '/portal/lib.js';
import { ICONS } from '/portal/avatars.js';
import { fmtClass, fmtLabel } from '/portal/formats.js';

export const EMOJIS = ['📌', '⭐', '🔥', '💡', '❓', '✅', '👀', '🎯'];
const CELL_W = 260, CELL_H = 236, PAD = 24;
const TEXT_MAX = 280;
const SPRING = 'cubic-bezier(0.34,1.56,0.64,1)';

let app = null;          // host API, see initHub()
let items = [];          // hub_items rows (real or virtual when locked)
let locked = false;
let showHidden = false;
let placingEmoji = null; // glyph waiting to be dropped
let drag = null;

export function initHub(api) {
  app = api;
  $('#hub-toolbar').addEventListener('click', onToolbar);
  $('#hub-emoji-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    placingEmoji = b.dataset.emoji;
    $('#hub-emoji-picker').hidden = true;
    const hint = $('#hub-hint');
    hint.textContent = `Tap the canvas or an item to drop ${placingEmoji}`;
    hint.hidden = false;
  });
  $('#hub-canvas').addEventListener('pointerdown', onCanvasDown);
  $('#hub-text-save').addEventListener('click', saveText);
  $('#hub-text-input').addEventListener('input', (e) => {
    $('#hub-text-count').textContent = e.target.value.length + ' / ' + TEXT_MAX;
    $('#hub-text-save').disabled = !e.target.value.trim();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.hub-menu, .hub-menu-btn')) $all('.hub-menu').forEach((m) => m.remove());
  });
}

// ---- layout -------------------------------------------------------------------
// Footprint per kind (matches portal.css), so a wide text note blocks every
// grid cell it covers, not just the one its corner sits in.
const SIZE = { article: [150, 196], card: [150, 196], note: [200, 190], text: [340, 200], emoji: [40, 40] };
function occupied(list) {
  const cells = new Set();
  list.filter((i) => i.kind !== 'emoji' || !i.ref_id).forEach((i) => {
    const [w, hh] = SIZE[i.kind] || [200, 200];
    const c0 = Math.floor((+i.x - PAD) / CELL_W), c1 = Math.floor((+i.x + w - PAD - 1) / CELL_W);
    const r0 = Math.floor((+i.y - PAD) / CELL_H), r1 = Math.floor((+i.y + hh - PAD - 1) / CELL_H);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) cells.add(c + ':' + r);
  });
  return cells;
}
function cols() { return Math.max(3, Math.floor((Math.max(window.innerWidth, 900) - PAD) / CELL_W)); }
/** Next free cell in a loose grid, with a stable jitter and tilt per id. */
function place(list, id) {
  const cells = occupied(list);
  const c = cols();
  for (let n = 0; n < 400; n++) {
    const col = n % c, row = Math.floor(n / c);
    if (!cells.has(col + ':' + row)) {
      const r = hash(id);
      return {
        x: PAD + col * CELL_W + ((r % 17) - 8),
        y: PAD + row * CELL_H + (((r >>> 5) % 17) - 8),
        rotation: (((r >>> 9) % 70) / 10) - 3.5,
      };
    }
  }
  return { x: PAD, y: PAD, rotation: 0 };
}
function maxZ() { return items.reduce((m, i) => Math.max(m, i.z || 0), 0); }

/** Every article, UP NEXT card and note gets a canvas row. Locked: virtual
 *  rows, no writes. A card row whose card has since been requested turns
 *  into that article's row, in place. */
async function ensureItems() {
  const S = app.S;
  for (const it of items.filter((i) => i.kind === 'card')) {
    const a = app.articleFor(it.ref_id);
    if (!a || items.some((x) => x.kind === 'article' && x.ref_id === a.id)) continue;
    it.kind = 'article';
    it.ref_id = a.id;
    if (!locked && !String(it.id).startsWith('virtual-')) {
      const { error } = await app.sb.from('hub_items').update({ kind: 'article', ref_id: a.id, updated_at: new Date().toISOString() }).eq('id', it.id);
      if (error) console.warn('[hub] card to article failed', error.message);
      else syncState(it);
    }
  }
  const have = new Set(items.filter((i) => i.ref_id && i.kind !== 'emoji').map((i) => i.kind + ':' + i.ref_id));
  const missing = [];
  app.libEntries().forEach((e) => {
    if (e.article) { if (!have.has('article:' + e.article.id)) missing.push({ kind: 'article', ref_id: e.article.id }); }
    else if (!have.has('card:' + e.card_id)) missing.push({ kind: 'card', ref_id: e.card_id });
  });
  S.notes.filter((n) => n.body !== app.WANTS_WRITTEN).forEach((n) => { if (!have.has('note:' + n.id)) missing.push({ kind: 'note', ref_id: n.id }); });
  if (!missing.length) return;
  const rows = [];
  let z = maxZ();
  missing.forEach((m) => {
    const p = place(items.concat(rows), m.ref_id);
    rows.push({ company_id: S.company.id, kind: m.kind, ref_id: m.ref_id, x: p.x, y: p.y, rotation: p.rotation, z: ++z, hidden: false, created_by: null });
  });
  if (locked) {
    rows.forEach((r, i) => items.push(Object.assign({ id: 'virtual-' + i }, r)));
    return;
  }
  const { data, error } = await app.sb.from('hub_items').insert(rows).select('*');
  if (error) { console.warn('[hub] auto-create failed', error.message); rows.forEach((r, i) => items.push(Object.assign({ id: 'virtual-' + i }, r))); return; }
  items.push(...data);
  S.hubItems = items.map((i) => Object.assign({}, i));
}

/** Where a new note from the Feed lands: the next free cell. */
export function slotForNewItem(list, id) { return place(list, id); }

// ---- enter / exit ---------------------------------------------------------------
export async function enterHub({ forceLocked, fromRects }) {
  const S = app.S;
  locked = !app.hubOpen() || !!forceLocked;
  $('#hub-canvas').classList.toggle('locked', locked);
  showHidden = false;
  placingEmoji = null;
  items = S.hubItems.map((i) => Object.assign({}, i));
  app.show('hub');
  await ensureItems();
  render();
  animateIn(fromRects || {});
  const scroll = $('#hub-scroll');
  scroll.scrollTo(0, 0);
  $('#hub-toolbar').hidden = locked;
  $('#hub-overlay').hidden = !locked;
  $('#hub-canvas').classList.toggle('locked', locked);
  if (locked) {
    app.track('hub_locked_viewed', { items: items.length, forced: !!forceLocked });
  } else {
    app.track('hub_opened', { items: items.length });
    app.firstLine('hub', 'Drag anything. Pin what matters. Tap Done to go back.', { ms: 5200 });
  }
}

/** Re-read the app state (after a request) without the entry animation. */
export async function refreshHub() {
  items = app.S.hubItems.map((i) => Object.assign({}, i));
  await ensureItems();
  render();
}

/** Rects of the article items, for the Library to animate back from. */
export function articleRects() {
  const out = {};
  $all('#hub-canvas .hub-item.kind-article').forEach((el) => { out[el.dataset.ref] = el.getBoundingClientRect(); });
  return out;
}

// ---- render ----------------------------------------------------------------------
function render() {
  const canvas = $('#hub-canvas');
  canvas.textContent = '';
  const visible = items.filter((i) => showHidden || !i.hidden);
  let w = 0, hgt = 0;
  visible.filter((i) => i.kind !== 'emoji' || !i.ref_id).forEach((i) => { w = Math.max(w, +i.x + 300); hgt = Math.max(hgt, +i.y + 320); });
  canvas.style.width = Math.max(w, window.innerWidth, 1080) + 'px';
  canvas.style.height = Math.max(hgt, window.innerHeight - 60, 860) + 'px';
  // Unhide mode: a hidden item that would overlap a visible one is shown in
  // the next free cell instead (display only), so it never covers anything.
  const shown = new Map();
  if (showHidden) {
    const solid = visible.filter((i) => !i.hidden && !(i.kind === 'emoji' && i.ref_id));
    const taken = solid.slice();
    visible.filter((i) => i.hidden && !(i.kind === 'emoji' && i.ref_id)).forEach((i) => {
      if (solid.some((v) => overlaps(i, v))) {
        const p = place(taken, i.id);
        shown.set(i.id, p);
        taken.push(Object.assign({}, i, p));
      } else taken.push(i);
    });
  }
  const byId = new Map();
  visible.filter((i) => !(i.kind === 'emoji' && i.ref_id)).forEach((i) => {
    const el = itemEl(shown.has(i.id) ? Object.assign({}, i, shown.get(i.id)) : i);
    if (!el) return;
    byId.set(i.id, el);
    canvas.appendChild(el);
  });
  // Pins ride on their item.
  visible.filter((i) => i.kind === 'emoji' && i.ref_id).forEach((i) => {
    const parent = byId.get(i.ref_id);
    const el = itemEl(i);
    if (parent) parent.appendChild(el);
    else { el.style.left = '0px'; el.style.top = '0px'; }
  });
  canvas.classList.toggle('empty', !visible.length);
  // Unlocked and empty: the grid alone, with one line. Locked keeps its modal.
  $('#hub-empty').hidden = locked || visible.length > 0;
  $('[data-hub="hidden"]').classList.toggle('on', showHidden);
  $('[data-hub="hidden"]').setAttribute('aria-pressed', showHidden ? 'true' : 'false');
}

function overlaps(a, b) {
  const [aw, ah] = SIZE[a.kind] || [200, 200], [bw, bh] = SIZE[b.kind] || [200, 200];
  return +a.x < +b.x + bw && +b.x < +a.x + aw && +a.y < +b.y + bh && +b.y < +a.y + ah;
}
function itemEl(i) {
  const S = app.S;
  const el = h('div', 'hub-item kind-' + i.kind + (i.hidden ? ' is-hidden' : ''));
  el.dataset.id = i.id;
  if (i.ref_id) el.dataset.ref = i.ref_id;
  el.style.left = (+i.x) + 'px';
  el.style.top = (+i.y) + 'px';
  el.style.setProperty('--rot', (+i.rotation || 0) + 'deg');
  // Hidden items (shown in unhide mode) always sit under visible ones.
  el.style.zIndex = String(i.kind === 'emoji' && i.ref_id ? 50 : i.hidden ? 1 : 10 + (i.z || 0));

  if (i.kind === 'article' || i.kind === 'card') {
    const e = hubEntry(i);
    if (!e) return null;
    const ghost = e.status !== 'delivered';
    el.classList.add('mini-book', ...fmtClass(e.format).split(' '));
    if (ghost) el.classList.add('ghost', 'tappable');
    const head = h('div', 'mb-head');
    head.appendChild(h('span', 'card-format gwm-center gwm-mono-tag ' + fmtClass(e.format), fmtLabel(e.format)));
    if (e.card && e.card.series) head.appendChild(h('span', 'gwm-series-label', e.card.series));
    el.appendChild(head);
    el.appendChild(h('span', 'mb-title', e.title));
    const live = e.article && e.article.live_at;
    el.appendChild(h('span', 'mb-state status-tag gwm-center gwm-mono-tag st-' + e.status, live ? 'Live' : app.STATUS_TAG[e.status]));
    el.setAttribute('aria-label', app.STATUS_TAG[e.status] + ': ' + e.title);
  } else if (i.kind === 'note') {
    const n = S.notes.find((x) => x.id === i.ref_id);
    if (!n) return null;
    el.classList.add('sticky-note');
    el.appendChild(h('span', 'sn-body', n.body));
    const card = n.card_id && S.cards.find((c) => c.id === n.card_id);
    if (card) el.appendChild(h('span', 'sn-about', 'On: ' + card.title));
    const who = h('span', 'sn-who');
    const m = app.memberById(n.member_id);
    who.append(app.avatarEl(m), document.createTextNode(app.displayName(m)));
    el.appendChild(who);
    el.setAttribute('aria-label', 'Note: ' + n.body);
  } else if (i.kind === 'text') {
    el.classList.add('text-note');
    el.appendChild(h('span', 'tn-body', i.body || ''));
    if (i.created_by) {
      const who = h('span', 'sn-who');
      const m = app.memberById(i.created_by);
      who.append(app.avatarEl(m), document.createTextNode(app.displayName(m)));
      el.appendChild(who);
    }
    el.setAttribute('aria-label', 'Text: ' + (i.body || ''));
  } else if (i.kind === 'emoji') {
    el.classList.add('pin');
    el.textContent = i.emoji || '📌';
    el.setAttribute('aria-label', 'Pin ' + (i.emoji || ''));
  }

  if (!locked) {
    el.tabIndex = 0;
    const menuBtn = h('button', 'hub-menu-btn gwm-center');
    menuBtn.type = 'button';
    menuBtn.innerHTML = ICONS.dots;
    menuBtn.setAttribute('aria-label', 'Item options');
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(i, el); });
    el.appendChild(menuBtn);
    if (i.hidden) {
      const un = h('button', 'hub-unhide gwm-btn', 'Unhide');
      un.type = 'button';
      un.addEventListener('click', (e) => { e.stopPropagation(); setHidden(i, false); });
      el.appendChild(un);
    }
    el.addEventListener('pointerdown', onItemDown);
  }
  return el;
}

/** Library entry for an article or card item; null if it no longer is one
 *  (a card nobody likes any more). */
function hubEntry(i) {
  const S = app.S;
  if (i.kind === 'article') {
    const a = S.articles.find((x) => x.id === i.ref_id);
    return a ? app.entryOf(a) : null;
  }
  if (app.articleFor(i.ref_id)) return null;
  const up = app.upNext().find((x) => x.card.id === i.ref_id);
  return up ? app.upNextEntry(up.card) : null;
}
function openMenu(i, el) {
  $all('.hub-menu').forEach((m) => m.remove());
  const menu = h('div', 'hub-menu');
  const e = (i.kind === 'article' || i.kind === 'card') ? hubEntry(i) : null;
  if (e && e.status === 'up_next') {
    const w = h('button', 'gwm-btn', 'Request this');
    w.type = 'button';
    w.addEventListener('click', (ev) => { ev.stopPropagation(); menu.remove(); app.openEntry(e); });
    menu.appendChild(w);
  }
  const b = h('button', 'gwm-btn', i.hidden ? 'Unhide' : 'Hide');
  b.type = 'button';
  b.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); setHidden(i, !i.hidden); });
  menu.appendChild(b);
  el.appendChild(menu);
  b.focus();
}

async function setHidden(i, hidden) {
  i.hidden = hidden;
  render();
  await save(i, { hidden });
  app.track(hidden ? 'hub_item_hidden' : 'hub_item_unhidden', { kind: i.kind });
}

async function save(i, patch) {
  syncState(i);
  if (String(i.id).startsWith('virtual-')) return;
  const { error } = await app.sb.from('hub_items').update(Object.assign({ updated_at: new Date().toISOString() }, patch)).eq('id', i.id);
  if (error) { console.warn('[hub] save failed', error.message); app.toast('That didn’t save. Try again.'); }
}
function syncState(i) {
  const S = app.S;
  const k = S.hubItems.findIndex((x) => x.id === i.id);
  if (k >= 0) S.hubItems[k] = Object.assign({}, i); else S.hubItems.push(Object.assign({}, i));
}

// ---- drag -------------------------------------------------------------------------
function onItemDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  if (e.target.closest('.hub-menu-btn, .hub-menu, .hub-unhide')) return;
  if (placingEmoji) return; // the canvas handler drops the pin
  const el = e.currentTarget;
  e.stopPropagation();
  const i = items.find((x) => x.id === el.dataset.id);
  if (!i) return;
  drag = { i, el, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  el.addEventListener('pointermove', onItemMove);
  el.addEventListener('pointerup', onItemUp);
  el.addEventListener('pointercancel', onItemUp);
}
function onItemMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) { drag.moved = true; drag.el.classList.add('dragging'); drag.el.style.zIndex = '999'; }
  drag.el.style.translate = dx + 'px ' + dy + 'px';
  e.preventDefault();
}
async function onItemUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { i, el, moved } = drag;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  drag = null;
  el.removeEventListener('pointermove', onItemMove);
  el.removeEventListener('pointerup', onItemUp);
  el.removeEventListener('pointercancel', onItemUp);
  el.classList.remove('dragging');
  el.style.translate = '';
  if (!moved || e.type === 'pointercancel') {
    // A tap on a card that isn't delivered opens its detail (Request this).
    const en = !moved && e.type !== 'pointercancel' && (i.kind === 'article' || i.kind === 'card') ? hubEntry(i) : null;
    if (en && en.status !== 'delivered') { app.openEntry(en); return; }
    render(); return;
  }

  const patch = { rotation: +i.rotation || 0, z: maxZ() + 1 };
  if (i.kind === 'emoji') {
    const target = itemUnder(e.clientX, e.clientY, i.id);
    Object.assign(patch, dropCoords(target, e.clientX, e.clientY));
  } else {
    patch.x = Math.round(Math.max(0, +i.x + dx));
    patch.y = Math.round(Math.max(0, +i.y + dy));
  }
  Object.assign(i, patch);
  render();
  await save(i, patch);
  app.track('hub_item_moved', { kind: i.kind, pinned: i.kind === 'emoji' ? !!i.ref_id : undefined });
}

/** Topmost non-pin item under the pointer, ignoring `exceptId`. */
function itemUnder(x, y, exceptId) {
  const hit = document.elementsFromPoint(x, y).map((n) => n.closest && n.closest('.hub-item'))
    .find((n) => n && n.dataset.id !== exceptId && !n.classList.contains('kind-emoji'));
  return hit ? items.find((i) => i.id === hit.dataset.id) || null : null;
}
/** Pin coordinates: relative to the item it lands on, else to the canvas. */
function dropCoords(target, cx, cy) {
  if (target) {
    const r = $(`#hub-canvas .hub-item[data-id="${target.id}"]`).getBoundingClientRect();
    return { ref_id: target.id, x: Math.round(cx - r.left - 18), y: Math.round(cy - r.top - 22) };
  }
  const c = $('#hub-canvas').getBoundingClientRect();
  return { ref_id: null, x: Math.round(cx - c.left - 18), y: Math.round(cy - c.top - 22) };
}

// ---- toolbar ------------------------------------------------------------------------
function onToolbar(e) {
  const b = e.target.closest('[data-hub]');
  if (!b) return;
  const what = b.dataset.hub;
  if (what === 'text') openTextSheet();
  if (what === 'pin') {
    const p = $('#hub-emoji-picker');
    p.hidden = !p.hidden;
    if (!p.hidden) p.querySelector('button').focus();
  }
  if (what === 'hidden') { showHidden = !showHidden; render(); }
  if (what === 'done') app.exitHub();
}

async function onCanvasDown(e) {
  if (!placingEmoji || locked) return;
  if (e.target.closest('.hub-menu-btn, .hub-menu')) return;
  e.preventDefault();
  const glyph = placingEmoji;
  placingEmoji = null;
  $('#hub-hint').hidden = true;
  const target = itemUnder(e.clientX, e.clientY, null);
  const pos = dropCoords(target, e.clientX, e.clientY);
  const row = { company_id: app.S.company.id, kind: 'emoji', emoji: glyph, rotation: 0, z: maxZ() + 1, hidden: false, created_by: app.S.me.id, ...pos };
  const { data, error } = await app.sb.from('hub_items').insert(row).select('*').single();
  if (error) { app.toast('That didn’t save. Try again.'); return; }
  items.push(data);
  syncState(data);
  render();
  app.track('hub_pin_added', { emoji: glyph, attached: !!pos.ref_id });
}

function openTextSheet() {
  const input = $('#hub-text-input');
  input.value = '';
  $('#hub-text-count').textContent = '0 / ' + TEXT_MAX;
  $('#hub-text-save').disabled = true;
  $('#hub-text-sheet').classList.add('open');
  setTimeout(() => input.focus(), 50);
}
async function saveText() {
  const body = $('#hub-text-input').value.trim().slice(0, TEXT_MAX);
  if (!body) return;
  const scroll = $('#hub-scroll');
  const row = {
    company_id: app.S.company.id, kind: 'text', body,
    x: Math.round(scroll.scrollLeft + Math.max(16, scroll.clientWidth / 2 - 110)),
    y: Math.round(scroll.scrollTop + Math.max(16, scroll.clientHeight / 2 - 90)),
    rotation: ((hash(body) % 50) / 10) - 2.5, z: maxZ() + 1, hidden: false, created_by: app.S.me.id,
  };
  $('#hub-text-save').disabled = true;
  const { data, error } = await app.sb.from('hub_items').insert(row).select('*').single();
  $('#hub-text-save').disabled = false;
  if (error) { app.toast('That didn’t save. Try again.'); return; }
  $('#hub-text-sheet').classList.remove('open');
  items.push(data);
  syncState(data);
  render();
  app.track('hub_text_added', { length: body.length });
}

// ---- the Library unstacking onto the canvas -------------------------------------------
function animateIn(fromRects) {
  if (prefersReduced) return;
  $all('#hub-canvas .hub-item').forEach((el, n) => {
    const from = el.dataset.ref && fromRects[el.dataset.ref];
    const rot = el.style.getPropertyValue('--rot') || '0deg';
    if (from) {
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left, dy = from.top - to.top;
      const s = Math.max(0.3, Math.min(3, from.width / Math.max(1, to.width)));
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(0deg)` }, { transform: `rotate(${rot})` }],
        { duration: 760, easing: SPRING, delay: n * 40 },
      );
    } else {
      el.animate(
        [{ opacity: 0, transform: `translateY(18px) scale(0.92) rotate(${rot})` }, { opacity: 1, transform: `rotate(${rot})` }],
        { duration: 520, easing: SPRING, delay: 200 + n * 30, fill: 'backwards' },
      );
    }
  });
}
