// -----------------------------------------------------------------------------
// Card formats: label and color for every format a card can carry.
//
// The sales branch owns /shared/formats.js (the shared formats map). When that
// file is deployed the portal reads it and it wins for label, family and
// color. Until then (and for any key it leaves out) the portal uses the list
// below, colored by family:
//   long    long_form      Long-form article
//   web     short_insight  Short insight
//   social  linkedin_post  LinkedIn post
// The first three formats (pillar, insight, post) stay for cards made before
// the current set; they share the family colors and are offered only on cards
// already in one of them.
//
// /shared/formats.js is a classic script that sets window.gwmFormats (the
// sales page loads it with <script>); an ES module export works too.
// Accepted shapes, as window.gwmFormats.FORMATS or a named / default export:
//   { long_form: { label, family, color, ink }, ... }  an object keyed by format
//   [ { key|id|format, label|name, family, color|hex, ink }, ... ]   a list
// Colors are CSS colors; a family is one of long / web / social (pillar,
// insight and post, the names the sales page uses, map onto them).
// -----------------------------------------------------------------------------
const FALLBACK = {
  long_form:     { label: 'Long-form article', family: 'long' },
  short_insight: { label: 'Short insight',     family: 'web' },
  linkedin_post: { label: 'LinkedIn post',     family: 'social' },
  pillar:        { label: 'Pillar',            family: 'long',   classic: true },
  insight:       { label: 'Insight',           family: 'web',    classic: true },
  post:          { label: 'Post',              family: 'social', classic: true },
};
const FAMILIES = ['long', 'web', 'social'];
// Older family names some maps may still use.
const FAMILY_ALIAS = { pillar: 'long', insight: 'web', post: 'social' };
const DEFAULT_FAMILY = 'web';

export const FORMATS = Object.fromEntries(Object.entries(FALLBACK).map(([k, v]) => [k, { ...v }]));

const titleCase = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** Label for a format key; unknown keys read as their own name. */
export function fmtLabel(key) { return (FORMATS[key] && FORMATS[key].label) || titleCase(key || 'Card'); }
/** Family (long / web / social) for a format key. */
export function fmtFamily(key) { return (FORMATS[key] && FORMATS[key].family) || DEFAULT_FAMILY; }
/** CSS color for a format (its own, else its family's). */
export function fmtColor(key) {
  const v = FORMATS[key];
  return (v && v.color) || `var(--f-${fmtFamily(key)})`;
}
/** Classes for an element that carries a format: the format, its family. */
export function fmtClass(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return 'fmt fmt-' + k + ' fam-' + fmtFamily(k);
}
/** Formats a card can be requested in: its own first, then the others of its
 *  set (the current formats, or the classic three for a card already in one). */
export function requestFormats(own) {
  const classic = !!(FORMATS[own] && FORMATS[own].classic);
  const set = Object.keys(FORMATS).filter((k) => !!FORMATS[k].classic === classic);
  return [own].concat(set.filter((k) => k !== own));
}

function normalize(mod) {
  const src = mod && (mod.FORMATS || mod.formats || mod.default || mod);
  const list = Array.isArray(src) ? src : src && typeof src === 'object' ? Object.entries(src).map(([k, v]) => ({ key: k, ...(v || {}) })) : [];
  return list.map((v) => ({
    key: String(v.key || v.id || v.format || '').toLowerCase(),
    label: v.label || v.name || null,
    family: FAMILIES.includes(v.family) ? v.family : FAMILY_ALIAS[v.family] || null,
    color: v.color || v.hex || v.bg || null,
    ink: v.ink || v.fg || v.text || null,
  })).filter((v) => /^[a-z][a-z0-9_-]*$/.test(v.key));
}

/** Per-format CSS: --fmt and --fmt-ink on .fmt-<key>. Family colors unless a
 *  format brings its own. Written once into a <style> element. */
function writeCss() {
  const rules = Object.entries(FORMATS).map(([k, v]) => {
    const fam = FAMILIES.includes(v.family) ? v.family : DEFAULT_FAMILY;
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
      const api = mod && (mod.FORMATS || mod.formats || mod.default) ? mod : window.gwmFormats;
      normalize(api).forEach((v) => {
        const cur = FORMATS[v.key] || { label: titleCase(v.key), family: DEFAULT_FAMILY };
        FORMATS[v.key] = { label: v.label || cur.label, family: v.family || cur.family, color: v.color || cur.color, ink: v.ink || cur.ink, classic: !!cur.classic };
      });
      found = true;
      writeCss();
    }
  } catch (err) { console.warn('[portal] shared formats not loaded, using family colors', err && err.message); }
  return found;
}
