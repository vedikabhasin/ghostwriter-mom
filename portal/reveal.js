// -----------------------------------------------------------------------------
// Overlap reveal: the full-screen "match" moment for Agree, Split and Timing.
// Motion is transform + opacity only; every animation's resting state is the
// final layout, so prefers-reduced-motion (animations off) shows a static
// overlay with nothing missing.
// -----------------------------------------------------------------------------
import { $, h, hash, prefersReduced } from '/portal/lib.js';
import { avatarSVG, ICONS } from '/portal/avatars.js';

const COPY = {
  agree:  { line: 'You both want this one.',                     primary: 'Move it up' },
  split:  { line: 'You two see this differently.',               primary: 'Leave a note' },
  timing: { line: 'One of you wants it now. One wants it later.', primary: 'Leave a note' },
};
const STAMP = { like: 'Liked', pass: 'Passed', save: 'Saved', fasttrack: 'Fast-track' };
const FMT = { pillar: 'Pillar', insight: 'Insight', post: 'Post' };

let open = null;

// murmur3 finalizer: spreads neighbouring seeds across the whole range.
function mix(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export function isRevealOpen() { return !!open; }

/**
 * @param {object} o
 *   state: 'agree'|'split'|'timing'
 *   left, right: { member, action, name }
 *   card: { format, series, title, angle, sources }
 *   onPrimary(), onClose()
 */
export function showReveal(o) {
  closeReveal(true);
  const root = $('#reveal');
  root.textContent = '';
  root.className = 'reveal rv-' + o.state + (prefersReduced ? ' rv-static' : '');
  root.setAttribute('aria-label', COPY[o.state].line);

  // Background, one per state so the three never look alike: Agree is a
  // like-green burst, Split is like-green and pass-coral halves meeting at
  // the card, Timing is like-green fading into save-yellow.
  const bg = h('div', 'rv-bg');
  if (o.state === 'split') {
    const side = (act) => (act === 'pass' ? 'var(--pass)' : 'var(--like)');
    bg.style.setProperty('--rv-a', side(o.left.action));
    bg.style.setProperty('--rv-b', side(o.right.action));
  }
  if (o.state === 'agree') {
    const shared = o.left.action === 'fasttrack' && o.right.action === 'fasttrack' ? 'fasttrack' : 'like';
    root.style.setProperty('--rv-c', `var(--${shared})`);
    root.style.setProperty('--rv-c-ink', `var(--${shared}-ink)`);
    const icons = h('div', 'rv-floaters');
    icons.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 12; i++) {
      const f = h('span', 'rv-float');
      f.innerHTML = shared === 'fasttrack' ? ICONS.bolt : ICONS.heart;
      const r = mix(hash(o.card.title) + i * 0x9e3779b9);
      f.style.left = (4 + (r % 92)) + '%';
      // Above the stage or below the buttons, never over the headline.
      const band = (r >>> 12) % 2 ? [4, 30] : [80, 94];
      f.style.top = (band[0] + ((r >>> 7) % (band[1] - band[0]))) + '%';
      f.style.setProperty('--d', ((r >>> 3) % 500) + 'ms');
      f.style.setProperty('--s', (0.7 + ((r >>> 5) % 6) / 10).toFixed(2));
      icons.appendChild(f);
    }
    bg.appendChild(icons);
  }
  if (o.state === 'timing') {
    const clock = h('div', 'rv-clock');
    clock.setAttribute('aria-hidden', 'true');
    clock.appendChild(h('span', 'rv-hand'));
    bg.appendChild(clock);
  }
  root.appendChild(bg);

  // Stage: avatar, tilted card, avatar.
  const stage = h('div', 'rv-stage');
  stage.appendChild(side('left', o.left));
  const card = h('div', 'rv-card fmt-' + (o.card.format || 'post'));
  const head = h('div', 'rv-card-head');
  head.appendChild(h('span', 'card-format gwm-center gwm-mono-tag', FMT[o.card.format] || o.card.format));
  if (o.card.series) head.appendChild(h('span', 'gwm-series-label', o.card.series));
  card.appendChild(head);
  card.appendChild(h('p', 'rv-card-title', o.card.title));
  if (o.card.angle) card.appendChild(h('p', 'rv-card-sub', o.card.angle));
  const nSrc = Array.isArray(o.card.sources) ? o.card.sources.length : 0;
  if (nSrc) card.appendChild(h('span', 'rv-card-src gwm-mono-tag', nSrc === 1 ? '1 source' : nSrc + ' sources'));
  stage.appendChild(card);
  stage.appendChild(side('right', o.right));
  root.appendChild(stage);

  const copy = h('h2', 'rv-line', COPY[o.state].line);
  copy.id = 'rv-line';
  root.appendChild(copy);

  // Flat buttons straight from the tokens: no glow, no gradient edge.
  const actions = h('div', 'rv-actions');
  const primary = h('button', 'btn btn-primary rv-btn gwm-btn', COPY[o.state].primary);
  primary.type = 'button';
  const secondary = h('button', 'btn btn-secondary rv-btn gwm-btn', 'Keep swiping');
  secondary.type = 'button';
  actions.append(primary, secondary);
  root.appendChild(actions);

  primary.addEventListener('click', () => { closeReveal(); o.onPrimary && o.onPrimary(); });
  secondary.addEventListener('click', () => { closeReveal(); o.onClose && o.onClose(); });

  open = o;
  root.setAttribute('aria-labelledby', 'rv-line');
  root.hidden = false;
  document.body.classList.add('rv-open');
  setTimeout(() => primary.focus(), prefersReduced ? 0 : 600);
}

function side(which, s) {
  const wrap = h('div', 'rv-side rv-' + which);
  const av = h('div', 'rv-av');
  av.innerHTML = avatarSVG(s.member || {}, 96);
  const stamp = h('span', 'rv-stamp gwm-center rv-a-' + s.action, STAMP[s.action] || s.action);
  const name = h('span', 'rv-name', s.name);
  wrap.append(av, stamp, name);
  return wrap;
}

export function closeReveal(silent) {
  const root = $('#reveal');
  if (!root || root.hidden) { open = null; return; }
  root.hidden = true;
  root.textContent = '';
  document.body.classList.remove('rv-open');
  const o = open;
  open = null;
  if (!silent && o && o.onDismiss) o.onDismiss();
}
