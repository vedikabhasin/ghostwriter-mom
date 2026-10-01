// -----------------------------------------------------------------------------
// Portal kit for the sales page (swipe2): portal/avatars.js copied verbatim on
// 2026-10-01 and wrapped as a classic script (window.gwmPortalKit). The
// portal file is untouched; nothing here imports from /portal.
// -----------------------------------------------------------------------------
(function(){
// -----------------------------------------------------------------------------
// Six little monsters, one per member. Names match the avatar_shape values the
// Stripe webhook and invite-member assign. Colors come from the format tokens.
// -----------------------------------------------------------------------------
const AVATAR_SHAPES = ['blob', 'worm', 'ghost', 'spike', 'pebble', 'curl'];

// Token names from /styles/tokens.css, so a palette change there recolors the
// monsters too. Resolved through inline style, which inline SVG supports.
const COLORS = {
  blob:   { body: 'var(--f-pillar)',  ink: 'var(--f-pillar-ink)' },
  worm:   { body: 'var(--f-insight)', ink: 'var(--f-insight-ink)' },
  ghost:  { body: 'var(--save)',      ink: 'var(--save-ink)' },
  spike:  { body: 'var(--fasttrack)', ink: 'var(--fasttrack-ink)' },
  pebble: { body: 'var(--like)',      ink: 'var(--like-ink)' },
  curl:   { body: 'var(--pass)',      ink: 'var(--pass-ink)' },
};

const BODIES = {
  // Round blob with a wobbly base.
  blob:   'M20 4c8.5 0 14 6.4 14 14.5V30c0 2-1.6 3.2-3.2 2.2-1.6-1-3-1-4.6 0s-3 1-4.6 0-3-1-4.6 0-3 1-4.6 0S9.8 31.2 8.2 32.2C6.6 33.2 6 32 6 30V18.5C6 10.4 11.5 4 20 4z',
  // Tall worm with an antenna bump.
  worm:   'M20 3c2 0 3 1.4 3 3 5 1.2 8 5.2 8 10.5V31a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4V16.5C9 11.2 12 7.2 17 6c0-1.6 1-3 3-3z',
  // Sheet ghost with a zig-zag hem.
  ghost:  'M20 4c7.7 0 13 5.8 13 13v17l-3.2-2.6L26.5 34 23.2 31.4 20 34l-3.2-2.6L13.5 34l-3.3-2.6L7 34V17C7 9.8 12.3 4 20 4z',
  // Spiky urchin.
  spike:  'M20 3l3 5 5-3 .5 5.6 5.6.4-3 5 4.4 3.6-5.2 2 1.8 5.4-5.6-.6-1 5.6L20 29.8 15.5 33l-1-5.6-5.6.6 1.8-5.4-5.2-2L9.9 17l-3-5 5.6-.4L13 6l5 3z',
  // Flat pebble, wide and low.
  pebble: 'M6 24c0-8 6.3-13 14-13s14 5 14 13c0 5-3.6 9-8.4 9H14.4C9.6 33 6 29 6 24z',
  // Curly-tailed bean.
  curl:   'M19 5c8 0 13 6 13 13.5S27 32 19 32c-3 0-5.4-.9-7-2.4-.8 2-2.9 3.4-5 3.4-1.6 0-2.4-1.3-1.4-2.4 1.6-1.8 1.4-4.2 1-6.2C6.2 23 6 21 6 18.5 6 11 11 5 19 5z',
};

const FACES = {
  blob:   { eyes: [[15, 17], [25, 17]], mouth: 'M16 24q4 3 8 0' },
  worm:   { eyes: [[16, 17], [24, 17]], mouth: 'M17 25h6' },
  ghost:  { eyes: [[16, 17], [24, 17]], mouth: 'M18 24a2 2 0 0 0 4 0' },
  spike:  { eyes: [[16.5, 18], [23.5, 18]], mouth: 'M17 23.5l1.5 1.5 1.5-1.5 1.5 1.5 1.5-1.5' },
  pebble: { eyes: [[15, 22], [25, 22]], mouth: 'M17.5 27q2.5 1.6 5 0' },
  curl:   { eyes: [[15, 16], [23, 16]], mouth: 'M16 22q3 2.5 6 0' },
};

function avatarShape(member) {
  const s = member && member.avatar_shape;
  if (s && AVATAR_SHAPES.includes(s)) return s;
  // Stable fallback for rows without a shape.
  const id = String((member && member.id) || '');
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_SHAPES[h % AVATAR_SHAPES.length];
}

function avatarColor(member) { return COLORS[avatarShape(member)]; }

function avatarSVG(member, size = 28) {
  const shape = avatarShape(member);
  const c = COLORS[shape];
  const f = FACES[shape];
  const eyes = f.eyes.map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="2.6" style="fill:var(--white)"/><circle cx="${x + 0.5}" cy="${y + 0.4}" r="1.3" style="fill:${c.ink}"/>`
  ).join('');
  return `<svg class="av-svg" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">` +
    `<path d="${BODIES[shape]}" style="fill:${c.body};stroke:${c.ink}" stroke-width="1.6" stroke-linejoin="round"/>` +
    eyes +
    `<path d="${f.mouth}" fill="none" style="stroke:${c.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
}

// The Ghostwriter Mom pencil mascot: plain, no face. Mirrors the SVG that
// serves as the waitlist page cursor. Used as the Hub sticker on the portal;
// shared so the two surfaces read as one product.
function pencilSVG(size = 88) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 88 88" aria-hidden="true" focusable="false">` +
    `<g transform="rotate(-38 44 44)" stroke="#0E0E0E" stroke-width="1.8" stroke-linejoin="round">` +
      `<polygon points="44,4 36.5,18 51.5,18" fill="#2B2B2B"/>` +
      `<polygon points="36.5,18 51.5,18 53,27 35,27" fill="#E8C9A0"/>` +
      `<rect x="35" y="27" width="18" height="40" fill="#F2C200"/>` +
      `<rect x="41" y="27" width="6" height="40" fill="#FFD84A" stroke="none"/>` +
      `<rect x="35" y="67" width="18" height="6" fill="#BBBBBB"/>` +
      `<rect x="35" y="73" width="18" height="10" rx="3.5" fill="#B8FF71"/>` +
    `</g></svg>`;
}

// Small glyphs (currentColor) used by the note button and the overlap reveal.
const ICONS = {
  pencil: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5 4 20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 7l3 3" stroke="currentColor" stroke-width="2"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 21s-7-4.35-10-9.5C.5 8 2.7 4 6.5 4c2 0 3.5 1 5.5 3 2-2 3.5-3 5.5-3 3.8 0 6 4 4.5 7.5C19 16.65 12 21 12 21z" fill="currentColor"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"/></svg>',
  text: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 6V4h14v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
};

// murmur3 finalizer from portal/reveal.js: spreads neighbouring seeds.
function mix(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
// portal/lib.js hash.
function hash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
window.gwmPortalKit = { AVATAR_SHAPES, avatarSVG, avatarShape, pencilSVG, ICONS, mix, hash };
})();
