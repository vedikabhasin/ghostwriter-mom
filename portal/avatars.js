// -----------------------------------------------------------------------------
// Six little monsters, one per member. Names match the avatar_shape values the
// Stripe webhook and invite-member assign. Colors come from the format tokens.
// -----------------------------------------------------------------------------
export const AVATAR_SHAPES = ['blob', 'worm', 'ghost', 'spike', 'pebble', 'curl'];

const COLORS = {
  blob:   { body: '#B79CFF', ink: '#2A1A63' },  // pillar violet
  worm:   { body: '#8CC8FF', ink: '#123458' },  // insight blue
  ghost:  { body: '#F5E84A', ink: '#3A3200' },  // post yellow
  spike:  { body: '#FFB45A', ink: '#5A2E00' },  // refresh orange
  pebble: { body: '#B8FF71', ink: '#194111' },  // like green
  curl:   { body: '#FF9DC0', ink: '#5A1E3B' },  // pass pink
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

export function avatarShape(member) {
  const s = member && member.avatar_shape;
  if (s && AVATAR_SHAPES.includes(s)) return s;
  // Stable fallback for rows without a shape.
  const id = String((member && member.id) || '');
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_SHAPES[h % AVATAR_SHAPES.length];
}

export function avatarColor(member) { return COLORS[avatarShape(member)]; }

export function avatarSVG(member, size = 28) {
  const shape = avatarShape(member);
  const c = COLORS[shape];
  const f = FACES[shape];
  const eyes = f.eyes.map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="2.6" fill="#fff"/><circle cx="${x + 0.5}" cy="${y + 0.4}" r="1.3" fill="${c.ink}"/>`
  ).join('');
  return `<svg class="av-svg" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">` +
    `<path d="${BODIES[shape]}" fill="${c.body}" stroke="${c.ink}" stroke-width="1.6" stroke-linejoin="round"/>` +
    eyes +
    `<path d="${f.mouth}" fill="none" stroke="${c.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
}

// The Ghostwriter Mom pencil mascot, used as the Hub sticker.
export function pencilSVG(size = 88) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 88 88" aria-hidden="true" focusable="false">` +
    `<g transform="rotate(-38 44 44)" stroke="#0E0E0E" stroke-width="1.8" stroke-linejoin="round">` +
      `<polygon points="44,4 36.5,18 51.5,18" fill="#2B2B2B"/>` +
      `<polygon points="36.5,18 51.5,18 53,27 35,27" fill="#E8C9A0"/>` +
      `<rect x="35" y="27" width="18" height="40" fill="#F2C200"/>` +
      `<rect x="41" y="27" width="6" height="40" fill="#FFD84A" stroke="none"/>` +
      `<rect x="35" y="67" width="18" height="6" fill="#BBBBBB"/>` +
      `<rect x="35" y="73" width="18" height="10" rx="3.5" fill="#B8FF71"/>` +
      `<circle cx="40" cy="41" r="3.4" fill="#fff"/><circle cx="40.6" cy="41.6" r="1.7" fill="#0E0E0E" stroke="none"/>` +
      `<circle cx="48" cy="41" r="3.4" fill="#fff"/><circle cx="48.6" cy="41.6" r="1.7" fill="#0E0E0E" stroke="none"/>` +
      `<path d="M40.5 49q3.5 3 7 0" fill="none" stroke-linecap="round"/>` +
      `<circle cx="37.6" cy="47" r="1.6" fill="#FF9DC0" stroke="none"/><circle cx="50.4" cy="47" r="1.6" fill="#FF9DC0" stroke="none"/>` +
    `</g></svg>`;
}
