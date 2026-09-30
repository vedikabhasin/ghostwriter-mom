// -----------------------------------------------------------------------------
// Card formats: label and color for every format a card can carry.
//
// The sales branch owns /shared/formats.js (the shared formats map). When that
// file exists the portal reads it and it wins for label and color. Until then
// (and for any key it leaves out) the portal falls back to the family colors
// from /styles/tokens.css:
//   pillar family  (long form)          --f-pillar
//   insight family (analysis)           --f-insight
//   post family    (short, social)      --f-post
//
// Accepted shapes for /shared/formats.js, as named or default export:
//   { guide: { label, family, color, ink }, ... }      an object keyed by format
//   [ { key|id|format, label|name, family, color|hex, ink }, ... ]   a list
// Colors are CSS colors; a family is one of pillar / insight / post.
// -----------------------------------------------------------------------------
const FALLBACK = {
  pillar:     { label: 'Pillar',     family: 'pillar' },
  guide:      { label: 'Guide',      family: 'pillar' },
  insight:    { label: 'Insight',    family: 'insight' },
  article:    { label: 'Article',    family: 'insight' },
  comparison: { label: 'Comparison', family: 'insight' },
  explainer:  { label: 'Explainer',  family: 'insight' },
  data:       { label: 'Data',       family: 'insight' },
  post:       { label: 'Post',       family: 'post' },
  byline:     { label: 'Byline',     family: 'post' },
  carousel:   { label: 'Carousel',   family: 'post' },
};
const FAMILIES = ['pillar', 'insight', 'post'];

export const FORMATS = Object.fromEntries(Object.entries(FALLBACK).map(([k, v]) => [k, { ...v }]));

const titleCase = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** Label for a format key; unknown keys read as their own name. */
export function fmtLabel(key) { return (FORMATS[key] && FORMATS[key].label) || titleCase(key || 'Card'); }
/** Family (pillar / insight / post) for a format key. */
export function fmtFamily(key) { return (FORMATS[key] && FORMATS[key].family) || 'insight'; }
/** CSS color for a format (its own, else its family's). */
export function fmtColor(key) {
  const v = FORMATS[key];
  return (v && v.color) || `var(--f-${fmtFamily(key)})`;
}
/** Classes for an element that carries a format: the format, its family. */
export function fmtClass(key) {
  const k = String(key || 'post').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return 'fmt fmt-' + k + ' fam-' + fmtFamily(k);
}
/** Every known format key, the three classic ones first. */
export function formatKeys() { return ['post', 'insight', 'pillar'].concat(Object.keys(FORMATS).filter((k) => !['post', 'insight', 'pillar'].includes(k))); }

function normalize(mod) {
  const src = mod && (mod.FORMATS || mod.formats || mod.default || mod);
  const list = Array.isArray(src) ? src : src && typeof src === 'object' ? Object.entries(src).map(([k, v]) => ({ key: k, ...(v || {}) })) : [];
  return list.map((v) => ({
    key: String(v.key || v.id || v.format || '').toLowerCase(),
    label: v.label || v.name || null,
    family: FAMILIES.includes(v.family) ? v.family : null,
    color: v.color || v.hex || v.bg || null,
    ink: v.ink || v.fg || v.text || null,
  })).filter((v) => /^[a-z][a-z0-9_-]*$/.test(v.key));
}

/** Per-format CSS: --fmt and --fmt-ink on .fmt-<key>. Family colors unless a
 *  format brings its own. Written once into a <style> element. */
function writeCss() {
  const rules = Object.entries(FORMATS).map(([k, v]) => {
    const fam = FAMILIES.includes(v.family) ? v.family : 'insight';
    const bg = v.color || `var(--f-${fam})`, ink = v.ink || `var(--f-${fam}-ink)`;
    return `.fmt-${k}{--fmt:${bg};--fmt-ink:${ink};}`;
  }).join('\n');
  let el = document.getElementById('fmt-css');
  if (!el) { el = document.createElement('style'); el.id = 'fmt-css'; document.head.appendChild(el); }
  el.textContent = rules;
}

/** Read /shared/formats.js if it is deployed; keep the fallback otherwise. */
export async function loadFormats() {
  writeCss();
  let found = false;
  try {
    const head = await fetch('/shared/formats.js', { method: 'HEAD', cache: 'no-cache' });
    if (head.ok && /javascript|ecmascript/.test(head.headers.get('content-type') || '')) {
      const mod = await import('/shared/formats.js');
      normalize(mod).forEach((v) => {
        const cur = FORMATS[v.key] || { label: titleCase(v.key), family: 'insight' };
        FORMATS[v.key] = { label: v.label || cur.label, family: v.family || cur.family, color: v.color || cur.color, ink: v.ink || cur.ink };
      });
      found = true;
      writeCss();
    }
  } catch (err) { console.warn('[portal] shared formats not loaded, using family colors', err && err.message); }
  return found;
}
