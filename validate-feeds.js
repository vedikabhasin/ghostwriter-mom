// -----------------------------------------------------------------------------
// Build-time schema check for /clients/*.json.
// Runs from netlify.toml as:  node validate-feeds.js
//
// Formats come from /shared/formats.js (one list shared with the sales page):
// pillar / insight / post (RPR) plus long_form / short_insight / linkedin_post.
//
// Optional per-company lead fields: greetingName (string or null; null renders
// "Hi there."), introBasis (string or null; null keeps RPR's intro sentence).
// signal may be null for a cold lead (no signals row is imported). Cards may
// carry formatNote (stored, never rendered).
//
// Two feed shapes are accepted:
//   * Regular client feed (default) — needs stripeLink19, offerText,
//     directionShape, emailKnown, signal, cards[]. Backs a public sales page.
//   * Internal company (data.isInternal === true) — needs signal + cards[]
//     only. Never served by the public sales page; its slug is generated at
//     provision time, so the filename == slug rule and the [REPLACE-scan don't
//     apply. Vedika Bhasin's feed is the first example.
//
// Every feed names its page template ("template": rpr | swipe1 | swipe2, see
// templates/README.md). Optional analytics fields: leadType (warm | cold |
// partner) and flow (a string; default swipe_pick_<unlock mode>).
// RPR terminology stays RPR-only: an "rpr" feed, or Rock Paper Reality's own
// swipe2 feed (RPR_SWIPE2_SLUGS), uses pillar / insight / post; every other
// feed uses the lead formats.
//
// After validating, this script writes /_redirects: one rewrite per routed
// slug to its template file, plus the old template aliases. Netlify reads
// _redirects before netlify.toml, so slugs without a feed file still fall
// through to the /:slug rule there.
//
// Templates (TEMPLATE_SLUGS) may hold [REPLACE… tokens and non-https URLs so
// authoring against them stays smooth. Every other regular feed fails the
// build if a source URL is not https or the file still contains [REPLACE.
// -----------------------------------------------------------------------------
'use strict';
const fs   = require('fs');
const path = require('path');
const gwmFormats = require('./shared/formats.js');

const CLIENTS_DIR = path.join(__dirname, 'clients');
const REGULAR_REQUIRED  = [
  'slug', 'companyName', 'contactFirstName', 'emailKnown',
  'stripeLink19', 'signal', 'directionShape', 'offerText',
  'cards'
];
const INTERNAL_REQUIRED = ['slug', 'companyName', 'signal', 'cards'];
const CARD_REQUIRED = ['id', 'format', 'title', 'angle', 'evidence', 'sources'];
// Formats are the visible card categories. "refresh" is a TAG, not a format.
const FORMATS   = gwmFormats.list;
const SLUG_RE   = /^[a-z0-9_-]{1,64}$/;
const STRIPE_RE = /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//;
const HTTPS_RE  = /^https:\/\//;
const TEMPLATE_SLUGS = new Set(['swipetemplate', 'rprtemplate', 'swipe1template', 'swipe2template']);
// Page templates and the file each one is served from.
const TEMPLATES = { rpr: '/templates/rpr.html', swipe1: '/templates/swipe1.html', swipe2: '/templates/swipe2.html' };
const RPR_FORMATS  = ['pillar', 'insight', 'post'];
const LEAD_FORMATS = FORMATS.filter(f => RPR_FORMATS.indexOf(f) === -1);
const RPR_SWIPE2_SLUGS = new Set(['rpr-k7m2qx']);
const LEAD_TYPES   = ['warm', 'cold', 'partner'];
// Old routes kept as permanent redirects. Their feed files stay (the database
// company and the portal tests still use them) but they are never routed.
const ALIASES = { swipetemplate: 'swipe1template' };
const EM_DASH_RE = /\u2014/;
const routes = [];
// Internal-company files that carry a placeholder slug the provision script
// rewrites at runtime. Their filename never has to match the runtime slug.
const INTERNAL_FILES = new Set(['vedika-bhasin.json']);

function fail(msg){
  console.error('[validate-feeds] ' + msg);
  process.exit(1);
}

function stringifyDeep(v){
  try { return JSON.stringify(v); } catch(_){ return String(v); }
}

// swipe2 configs have their own shape (see templates/README.md):
//   slug, template "swipe2", company, contactFirstName, sourceLine, cards
//   (exactly 3, lead formats; RPR formats for RPR_SWIPE2_SLUGS), vediReactions
//   (like | pass per card), writeOn (every card id once), deliveryChannel
//   (LinkedIn | email), lead_type (warm | cold); flow optional. lockedCount
//   only on preview templates: a real company's "N more directions" is
//   counted from its cards in the database at page load.
function validateSwipe2(file, data){
  const isTemplate = TEMPLATE_SLUGS.has(data.slug);
  const str = (k) => { if(typeof data[k] !== 'string' || !data[k].trim()) fail(file + ': "' + k + '" must be a non-empty string'); };
  ['slug', 'company', 'contactFirstName', 'sourceLine'].forEach(str);
  if(!SLUG_RE.test(data.slug)) fail(file + ': slug must match ' + SLUG_RE);
  if(file !== data.slug + '.json') fail(file + ': filename must match slug (expected ' + data.slug + '.json)');
  if(['LinkedIn', 'email'].indexOf(data.deliveryChannel) === -1) fail(file + ': deliveryChannel must be "LinkedIn" or "email"');
  if(['warm', 'cold'].indexOf(data.lead_type) === -1) fail(file + ': lead_type must be "warm" or "cold"');
  if('flow' in data && (typeof data.flow !== 'string' || !data.flow.trim())) fail(file + ': flow must be a non-empty string when present');
  if(isTemplate && (!Number.isInteger(data.lockedCount) || data.lockedCount < 0)) fail(file + ': lockedCount must be a non-negative integer');
  if(!isTemplate && 'lockedCount' in data) fail(file + ': lockedCount is counted from the database for a real company; remove it');
  const formats = RPR_SWIPE2_SLUGS.has(data.slug) ? RPR_FORMATS : LEAD_FORMATS;
  if('email' in data) fail(file + ': client feeds must not contain an "email" field (files are publicly served)');
  if(!Array.isArray(data.cards) || data.cards.length !== 3) fail(file + ': swipe2 shows exactly 3 cards');
  const keys = [];
  data.cards.forEach((c, i) => {
    const label = file + ': card #' + (i + 1);
    CARD_REQUIRED.forEach(k => { if(!(k in c)) fail(label + ' missing "' + k + '"'); });
    if(keys.indexOf(String(c.id)) !== -1) fail(label + ' duplicate id ' + c.id);
    keys.push(String(c.id));
    if(formats.indexOf(String(c.format).toLowerCase()) === -1) fail(label + ' format must be one of ' + formats.join(', '));
    ['title', 'angle', 'evidence'].forEach(k => { if(typeof c[k] !== 'string' || !c[k].trim()) fail(label + ' "' + k + '" must be a non-empty string'); });
    if(!Array.isArray(c.sources) || !c.sources.length) fail(label + ' sources must be a non-empty array');
    c.sources.forEach((src, si) => {
      ['title', 'publisher', 'url'].forEach(k => { if(!src || typeof src[k] !== 'string' || !src[k].trim()) fail(label + ' source #' + (si + 1) + ' "' + k + '" must be a non-empty string'); });
      if(!isTemplate && !HTTPS_RE.test(src.url)) fail(label + ' source #' + (si + 1) + ' url must be https://');
    });
  });
  const vr = data.vediReactions;
  if(!vr || typeof vr !== 'object' || Array.isArray(vr)) fail(file + ': vediReactions must be { cardId: "like" | "pass" }');
  keys.forEach(k => { if(vr[k] !== 'like' && vr[k] !== 'pass') fail(file + ': vediReactions.' + k + ' must be "like" or "pass"'); });
  Object.keys(vr).forEach(k => { if(keys.indexOf(k) === -1) fail(file + ': vediReactions has unknown card ' + k); });
  const wo = data.writeOn;
  if(!Array.isArray(wo) || wo.length !== keys.length || keys.some(k => wo.map(String).indexOf(k) === -1)) fail(file + ': writeOn must list every card id once, in writing order');
  if(EM_DASH_RE.test(stringifyDeep(data))) fail(file + ': no em dashes in page copy');
  if(!isTemplate && /\[REPLACE/i.test(stringifyDeep(data))) fail(file + ': contains "[REPLACE" placeholder text');
  routes.push({ slug: data.slug, to: TEMPLATES.swipe2 });
}

function validateOne(file){
  const full = path.join(CLIENTS_DIR, file);
  let data;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch(e){ fail(file + ': invalid JSON — ' + e.message); }
  if(!data || typeof data !== 'object') fail(file + ': must be a JSON object');

  if(data.template === 'swipe2') return validateSwipe2(file, data);
  const isInternal = data.isInternal === true || INTERNAL_FILES.has(file);
  const isTemplate = TEMPLATE_SLUGS.has(data.slug);
  const required = isInternal ? INTERNAL_REQUIRED : REGULAR_REQUIRED;

  required.forEach(k => {
    if(!(k in data)) fail(file + ': missing required field "' + k + '"');
  });
  if(typeof data.slug !== 'string' || !SLUG_RE.test(data.slug)){
    fail(file + ': slug must match ' + SLUG_RE + ' (kebab/underscore, up to 64 chars)');
  }
  if(!isInternal){
    const expected = data.slug + '.json';
    if(file !== expected){
      fail(file + ': filename must match slug (expected ' + expected + ')');
    }
    if(typeof data.stripeLink19 !== 'string' || !STRIPE_RE.test(data.stripeLink19)){
      fail(file + ': stripeLink19 must be an https Stripe URL');
    }
    if(typeof data.emailKnown !== 'boolean'){
      fail(file + ': emailKnown must be a boolean');
    }
    if(typeof data.offerText !== 'string' || !data.offerText.trim()){
      fail(file + ': offerText must be a non-empty string');
    }
    // directionShape: map of known format → non-negative int, sum 1..3
    const shape = data.directionShape;
    if(!shape || typeof shape !== 'object' || Array.isArray(shape)){
      fail(file + ': directionShape must be an object of format→count');
    }
    let sum = 0;
    Object.keys(shape).forEach(k => {
      if(FORMATS.indexOf(k) === -1) fail(file + ': directionShape has unknown format "' + k + '"');
      const n = shape[k];
      if(!Number.isInteger(n) || n < 0) fail(file + ': directionShape.' + k + ' must be a non-negative integer');
      sum += n;
    });
    if(sum < 1 || sum > 3){
      fail(file + ': directionShape must sum to 1-3 slots (got ' + sum + ')');
    }
  }
  // Signal: the key is required; null is allowed (cold lead, no signals
  // row). When present it must be complete.
  const sig = data.signal;
  if(sig !== null){
    if(!sig || typeof sig !== 'object'){
      fail(file + ': signal must be an object or null');
    }
    ['text','source','date'].forEach(k => {
      if(typeof sig[k] !== 'string' || !sig[k].trim()){
        fail(file + ': signal.' + k + ' must be a non-empty string');
      }
    });
  }
  // Lead fields: optional, string or null.
  ['greetingName','introBasis'].forEach(k => {
    if(k in data && data[k] !== null && (typeof data[k] !== 'string' || !data[k].trim())){
      fail(file + ': ' + k + ' must be a non-empty string or null');
    }
  });
  // Client-email hygiene: these JSON files are publicly fetchable when regular.
  // Even for internal ones, no reason to store an email in the JSON.
  // Template, lead type, flow.
  if(!Object.prototype.hasOwnProperty.call(TEMPLATES, data.template)){
    fail(file + ': template must be one of ' + Object.keys(TEMPLATES).join(', '));
  }
  if('leadType' in data && LEAD_TYPES.indexOf(data.leadType) === -1){
    fail(file + ': leadType must be one of ' + LEAD_TYPES.join(', '));
  }
  if('flow' in data && (typeof data.flow !== 'string' || !data.flow.trim())){
    fail(file + ': flow must be a non-empty string when present');
  }
  const routed = !isInternal && !Object.prototype.hasOwnProperty.call(ALIASES, data.slug);
  if(routed){
    const allowed = data.template === 'rpr' ? RPR_FORMATS : LEAD_FORMATS;
    const used = (Array.isArray(data.cards) ? data.cards.map(c => String(c.format).toLowerCase()) : [])
      .concat(Object.keys(data.directionShape || {}));
    used.forEach(f => {
      if(allowed.indexOf(f) === -1) fail(file + ': format "' + f + '" is not allowed in the ' + data.template + ' template (allowed: ' + allowed.join(', ') + ')');
    });
    if(EM_DASH_RE.test(stringifyDeep(data))) fail(file + ': no em dashes in page copy');
    routes.push({ slug: data.slug, to: TEMPLATES[data.template] });
  }
  if('email' in data){
    fail(file + ': client feeds must not contain an "email" field (files are publicly served)');
  }
  // Cards
  if(!Array.isArray(data.cards) || data.cards.length === 0){
    fail(file + ': cards must be a non-empty array');
  }
  const seen = new Set();
  data.cards.forEach((c, i) => {
    const label = 'card #' + (i + 1);
    CARD_REQUIRED.forEach(k => {
      if(!(k in c)) fail(file + ': ' + label + ' missing "' + k + '"');
    });
    if(typeof c.id !== 'string' && typeof c.id !== 'number'){
      fail(file + ': ' + label + ' id must be a string or number');
    }
    if(seen.has(String(c.id))) fail(file + ': ' + label + ' duplicate id ' + c.id);
    seen.add(String(c.id));
    if(FORMATS.indexOf(String(c.format).toLowerCase()) === -1){
      fail(file + ': ' + label + ' format must be one of ' + FORMATS.join(', '));
    }
    ['title','angle','evidence'].forEach(k => {
      if(typeof c[k] !== 'string' || !c[k].trim()){
        fail(file + ': ' + label + ' "' + k + '" must be a non-empty string');
      }
    });
    if('tags' in c && !Array.isArray(c.tags)){
      fail(file + ': ' + label + ' tags must be an array if present');
    }
    if('series' in c && (typeof c.series !== 'string' || !c.series.trim())){
      fail(file + ': ' + label + ' series must be a non-empty string when present');
    }
    if('formatNote' in c && c.formatNote !== null && (typeof c.formatNote !== 'string' || !c.formatNote.trim())){
      fail(file + ': ' + label + ' formatNote must be a non-empty string or null when present');
    }
    // Sources: required, non-empty; each { title, publisher, url } with https URL.
    if(!Array.isArray(c.sources) || c.sources.length === 0){
      fail(file + ': ' + label + ' sources must be a non-empty array');
    }
    c.sources.forEach((src, si) => {
      const sl = label + ' source #' + (si + 1);
      if(!src || typeof src !== 'object') fail(file + ': ' + sl + ' must be an object');
      ['title','publisher','url'].forEach(k => {
        if(typeof src[k] !== 'string' || !src[k].trim()){
          fail(file + ': ' + sl + ' "' + k + '" must be a non-empty string');
        }
      });
      // Templates get placeholder URLs. Every other feed's sources are https.
      if(!isTemplate && !HTTPS_RE.test(src.url)){
        fail(file + ': ' + sl + ' url must be https://');
      }
    });
  });

  // Non-template regular feeds must not ship "[REPLACE" placeholders anywhere.
  // Internal files are exempt — their slug is a placeholder until provisioned.
  if(!isTemplate && !isInternal){
    const dump = stringifyDeep(data);
    if(/\[REPLACE/i.test(dump)){
      fail(file + ': contains "[REPLACE" placeholder text; fill it in before deploying');
    }
  }
}

if(!fs.existsSync(CLIENTS_DIR)){
  console.log('[validate-feeds] no /clients dir, skipping');
  process.exit(0);
}
const files = fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.json'));
if(!files.length){
  console.log('[validate-feeds] no client feeds present, skipping');
  process.exit(0);
}
files.forEach(validateOne);
console.log('[validate-feeds] OK, ' + files.length + ' feed(s) validated');

// Every template file must exist before a slug is routed to it.
routes.forEach(r => {
  if(!fs.existsSync(path.join(__dirname, r.to))) fail(r.slug + ': template file ' + r.to + ' is missing');
});
const lines = [
  '# Generated by validate-feeds.js from clients/*.json on every build. Do not edit.',
  '# Each slug is served by its template; the browser URL never changes.',
];
Object.keys(ALIASES).sort().forEach(a => lines.push('/' + a + '  /' + ALIASES[a] + '  302!'));
routes.sort((a, b) => a.slug < b.slug ? -1 : 1).forEach(r => lines.push('/' + r.slug + '  ' + r.to + '?slug=' + r.slug + '  200'));
fs.writeFileSync(path.join(__dirname, '_redirects'), lines.join('\n') + '\n');
console.log('[validate-feeds] _redirects: ' + routes.length + ' slug route(s), ' + Object.keys(ALIASES).length + ' alias(es)');
