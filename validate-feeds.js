// -----------------------------------------------------------------------------
// Build-time schema check for /clients/*.json.
// Runs from netlify.toml as:  node validate-feeds.js
// A missing / malformed field FAILS the build.
// A non-template client feed that still contains "[REPLACE" also fails.
// A non-template client card missing sources, or with a non-https source URL,
// also fails.
// -----------------------------------------------------------------------------
'use strict';
const fs   = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, 'clients');
const REQUIRED = [
  'slug', 'companyName', 'contactFirstName', 'emailKnown',
  'stripeLink19', 'signal', 'directionShape', 'offerText',
  'cards'
];
const CARD_REQUIRED = ['id', 'format', 'title', 'angle', 'evidence', 'sources'];
// Formats are the visible card categories (Pillar / Insight / Post).
// "refresh" is a TAG, not a format — allowed inside c.tags but never in c.format.
const FORMATS   = ['pillar', 'insight', 'post'];
const SLUG_RE   = /^[a-z0-9_-]{1,64}$/;
const STRIPE_RE = /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//;
const HTTPS_RE  = /^https:\/\//;
// Template feed(s) are allowed to contain the placeholder tokens the
// authoring UX uses. Every other feed must not ship "[REPLACE" strings.
const TEMPLATE_SLUGS = new Set(['swipetemplate']);

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

  REQUIRED.forEach(k => {
    if(!(k in data)) fail(file + ': missing required field "' + k + '"');
  });
  if(typeof data.slug !== 'string' || !SLUG_RE.test(data.slug)){
    fail(file + ': slug must match ' + SLUG_RE + ' (kebab/underscore, up to 64 chars)');
  }
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
  // Signal object
  const sig = data.signal;
  if(!sig || typeof sig !== 'object'){
    fail(file + ': signal must be an object');
  }
  ['text','source','date'].forEach(k => {
    if(typeof sig[k] !== 'string' || !sig[k].trim()){
      fail(file + ': signal.' + k + ' must be a non-empty string');
    }
  });
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
  // Client-email hygiene: these JSON files are publicly fetchable. Never store
  // a client's email address inside one.
  if('email' in data){
    fail(file + ': client feeds must not contain an "email" field (files are publicly served)');
  }
  // Cards
  if(!Array.isArray(data.cards) || data.cards.length === 0){
    fail(file + ': cards must be a non-empty array');
  }
  const isTemplate = TEMPLATE_SLUGS.has(data.slug);
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
      // Template feed(s) are allowed to hold placeholder URLs.
      if(!isTemplate && !HTTPS_RE.test(src.url)){
        fail(file + ': ' + sl + ' url must be https://');
      }
    });
  });

  // Non-template feeds must not contain "[REPLACE" placeholders anywhere.
  if(!isTemplate){
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
