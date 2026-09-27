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
 *   card: { format, series, title }
 *   onPrimary(), onClose()
 */
export function showReveal(o) {
  closeReveal(true);
  const root = $('#reveal');
  root.textContent = '';
  root.className = 'reveal rv-' + o.state + (prefersReduced ? ' rv-static' : '');
  root.setAttribute('aria-label', COPY[o.state].line);

  // Background: burst / diagonal split / yellow wash.
  const bg = h('div', 'rv-bg');
  if (o.state === 'split') {
    bg.style.setProperty('--rv-a', `var(--${o.left.action})`);
    bg.style.setProperty('--rv-b', `var(--${o.right.action})`);
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
      f.style.top = (8 + ((r >>> 7) % 80)) + '%';
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
  stage.appendChild(card);
  stage.appendChild(side('right', o.right));
  root.appendChild(stage);

  const copy = h('h2', 'rv-line', COPY[o.state].line);
  copy.id = 'rv-line';
  root.appendChild(copy);

  const actions = h('div', 'rv-actions');
  const host = h('span', 'btn-glow-host');
  const glow = h('span', 'btn-glow');
  glow.setAttribute('aria-hidden', 'true');
  host.appendChild(glow);
  const primary = h('button', 'btn btn-primary gwm-btn', COPY[o.state].primary);
  primary.type = 'button';
  host.appendChild(primary);
  const secondary = h('button', 'btn btn-secondary gwm-btn', 'Keep swiping');
  secondary.type = 'button';
  actions.append(host, secondary);
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
