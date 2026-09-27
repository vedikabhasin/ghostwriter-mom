// -----------------------------------------------------------------------------
// Build-time schema check for /clients/*.json.
// Runs from netlify.toml as:  node validate-feeds.js
//
// Two feed shapes are accepted:
//   * Regular client feed (default) — needs stripeLink19, offerText,
//     directionShape, emailKnown, signal, cards[]. Backs a public sales page.
//   * Internal company (data.isInternal === true) — needs signal + cards[]
//     only. Never served by the public sales page; its slug is generated at
//     provision time, so the filename == slug rule and the [REPLACE-scan don't
//     apply. Vedika Bhasin's feed is the first example.
//
// Templates (TEMPLATE_SLUGS) may hold [REPLACE… tokens and non-https URLs so
// authoring against them stays smooth. Every other regular feed fails the
// build if a source URL is not https or the file still contains [REPLACE.
// -----------------------------------------------------------------------------
'use strict';
const fs   = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, 'clients');
const REGULAR_REQUIRED  = [
  'slug', 'companyName', 'contactFirstName', 'emailKnown',
  'stripeLink19', 'signal', 'directionShape', 'offerText',
  'cards'
];
const INTERNAL_REQUIRED = ['slug', 'companyName', 'signal', 'cards'];
const CARD_REQUIRED = ['id', 'format', 'title', 'angle', 'evidence', 'sources'];
// Formats are the visible card categories. "refresh" is a TAG, not a format.
const FORMATS   = ['pillar', 'insight', 'post'];
const SLUG_RE   = /^[a-z0-9_-]{1,64}$/;
const STRIPE_RE = /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//;
const HTTPS_RE  = /^https:\/\//;
const TEMPLATE_SLUGS = new Set(['swipetemplate']);
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

function validateOne(file){
  const full = path.join(CLIENTS_DIR, file);
  let data;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch(e){ fail(file + ': invalid JSON — ' + e.message); }
  if(!data || typeof data !== 'object') fail(file + ': must be a JSON object');

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
  // Signal object (required for every feed).
  const sig = data.signal;
  if(!sig || typeof sig !== 'object'){
    fail(file + ': signal must be an object');
  }
  ['text','source','date'].forEach(k => {
    if(typeof sig[k] !== 'string' || !sig[k].trim()){
      fail(file + ': signal.' + k + ' must be a non-empty string');
    }
  });
  // Client-email hygiene: these JSON files are publicly fetchable when regular.
  // Even for internal ones, no reason to store an email in the JSON.
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
