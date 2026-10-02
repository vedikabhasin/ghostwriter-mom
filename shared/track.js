// -----------------------------------------------------------------------------
// Sales-page analytics module. Loaded once by swipe.html as an ES module and
// re-exposed on window.gwmTrack.* for the classic-script IIFE that owns the
// swipe flow. Handles:
//
//   * Gating          swipetemplate, is_internal companies and any feed
//                     JSON with "tracking":"basic" fall back to BASIC.
//                     Everything else is ENHANCED.
//   * Local capture   Suppressed on localhost / 127.0.0.1 unless ?ph_debug=1.
//   * Personal device ?gw_internal=1 flips a localStorage flag that opts the
//                     device out entirely; ?gw_internal=0 clears it and opts
//                     back in (the only time opt_in_capturing runs, so no
//                     $opt_in event on ordinary loads).
//   * Excluded        swipetemplate and swipe2template capture nothing.
//   * Super props     Attached to every event. Every template registers
//                     template, slug, lead_type, cards_count and flow (from
//                     the slug config in clients/<slug>.json).
//   * Event names     Shared by every template: page_open, deal_me_in,
//                     first_swipe, swipe_complete, email_submitted,
//                     unlock_clicked. The older per-step events still fire.
//   * Session replay  ENHANCED only. Inputs masked. [data-ph-mask] elements
//                     have their text redacted so the greeting name never
//                     appears in replays.
//   * Booked hook     Loading with ?booked=1 fires call_booked once and
//                     strips the query param.
//   * Session summary Sent once on the first visibilitychange->hidden (or
//                     the pagehide fallback), through sendBeacon.
//   * Root cause fix  Every capture reads window.posthog fresh at call time.
//                     Historically the sales page cached the stub before the
//                     real library replaced window.posthog, and every capture
//                     after init went to a dead queue. Never cache the stub.
// -----------------------------------------------------------------------------

const APP           = 'sales_page';
const PAGE_VERSION  = '2026-10-01-a';
// The template routes are internal previews: BASIC, like swipetemplate.
const BASIC_SLUGS   = new Set(['swipetemplate', 'swipe1template', 'rprtemplate', 'swipe2template']);
// Preview slugs that never send anything (the pages also skip posthog.init).
const EXCLUDED_SLUGS = new Set(['swipetemplate', 'swipe2template']);
const LEAD_TYPES    = ['warm', 'cold', 'partner'];
const OPT_OUT_KEY   = 'gw_internal';

let cfg          = null;
let enhanced     = false;
let optedOut     = false;
let summarySent  = false;
let summaryFn    = () => ({});

function q(name){
  try { return new URLSearchParams(location.search).get(name); }
  catch (_) { return null; }
}
function stripParams(names){
  try {
    const u = new URL(location.href);
    let changed = false;
    names.forEach(n => { if (u.searchParams.has(n)) { u.searchParams.delete(n); changed = true; } });
    if (changed) history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  } catch (_) {}
}
function isLocalHost(){
  const h = (typeof location !== 'undefined') ? location.hostname : '';
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

// Look up window.posthog at call time. Never cache; the stub gets swapped
// for the real library after the async script loads.
function ph(){
  return (typeof window !== 'undefined') ? window.posthog : null;
}

function superProps(){
  const feed = (cfg && cfg.feed) || {};
  const N    = (feed.cards && feed.cards.length) || 0;
  const unlock = feed.unlockMode || 'call';
  return {
    app:          APP,
    template:     (cfg && cfg.template) || feed.template || 'legacy',
    slug:         (cfg && cfg.slug) || '',
    lead_type:    LEAD_TYPES.indexOf(feed.leadType) >= 0 ? feed.leadType : 'unset',
    cards_count:  N,
    flow:         feed.flow || ('swipe_pick_' + unlock),
    company_name: feed.companyName || '',
    page_version: PAGE_VERSION,
    deck_size:    N,
    unlock_mode:  unlock,
    src:          q('src') || 'direct'
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function isEnhanced() { return enhanced; }
export function isOptedOut() { return optedOut; }
export function pageVersion() { return PAGE_VERSION; }

export function capture(name, props){
  if (optedOut) return;
  const p = ph();
  if (!p || typeof p.capture !== 'function') return;
  try { p.capture(name, Object.assign({}, superProps(), props || {})); }
  catch (_) {}
}

// Card-scoped events also get card_position_pct.
export function captureCard(name, ctx, extra){
  const feed = (cfg && cfg.feed) || {};
  const N    = (feed.cards && feed.cards.length) || 0;
  const idx  = ctx && typeof ctx.card_index === 'number' ? ctx.card_index : null;
  const props = Object.assign({}, ctx || {}, extra || {});
  if (idx !== null && N) props.card_position_pct = Math.round((idx / N) * 100) / 100;
  capture(name, props);
}

// The classic-script IIFE hands us a function that returns whatever the
// session_summary should carry (cards_viewed, cards_swiped, ...). Wired this
// way so this module doesn't have to know about swipe.html's state shape.
export function setSummaryCollector(fn){
  if (typeof fn === 'function') summaryFn = fn;
}

// Fire session_summary once. Guarded so tab-switch churn doesn't multi-send.
// ENHANCED slugs only; BASIC slugs never send session_summary.
export function sendSessionSummary(){
  if (summarySent || optedOut || !enhanced) return;
  summarySent = true;
  const p = ph();
  if (!p || typeof p.capture !== 'function') return;
  let extra = {};
  try { extra = summaryFn() || {}; } catch (_) {}
  try {
    p.capture('session_summary',
      Object.assign({}, superProps(), extra),
      { transport: 'sendBeacon' }
    );
  } catch (_) {}
}

// -----------------------------------------------------------------------------
// initTracking — called once by swipe.html AFTER the feed has loaded, so we
// know slug + is_internal + unlockMode + deck size before the first event.
// -----------------------------------------------------------------------------
export function initTracking(opts){
  cfg = opts || {};
  const feed = cfg.feed || {};
  const slug = cfg.slug || '';

  // ?gw_internal — set or clear the local opt-out flag.
  const gw = q('gw_internal');
  if (gw === '1' || gw === '0'){
    try {
      if (gw === '1') localStorage.setItem(OPT_OUT_KEY, '1');
      else            localStorage.removeItem(OPT_OUT_KEY);
    } catch (_) {}
    stripParams(['gw_internal']);
  }
  let internalDevice = false;
  try { internalDevice = localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (_) {}

  // Gate.
  const isInternal    = !!(cfg.isInternal || feed.isInternal);
  const trackingBasic = feed.tracking === 'basic';
  const isBasicSlug   = BASIC_SLUGS.has(slug);
  enhanced = !(isInternal || trackingBasic || isBasicSlug);

  // Localhost gate.
  if (isLocalHost() && q('ph_debug') !== '1') optedOut = true;
  // Preview slugs: no capture at all.
  if (EXCLUDED_SLUGS.has(slug)) optedOut = true;

  const p = ph();
  if (!p) return { enhanced, optedOut };

  // Device-level opt-out is absolute. opt_in_capturing() sends a $opt_in
  // event, so it runs only when ?gw_internal=0 lifts an earlier opt-out,
  // never on an ordinary page load.
  if (internalDevice){
    optedOut = true;
    try { p.opt_out_capturing && p.opt_out_capturing(); } catch (_) {}
  } else if (gw === '0'){
    try { p.opt_in_capturing && p.opt_in_capturing(); } catch (_) {}
  }

  // Super properties.
  try { p.register && p.register(superProps()); } catch (_) {}

  // ENHANCED extras: session replay + dead clicks + exceptions + narrow
  // autocapture. BASIC keeps the minimal init that swipe.html already
  // performs.
  if (enhanced && !optedOut){
    try {
      p.set_config && p.set_config({
        disable_session_recording: false,
        session_recording: {
          maskAllInputs: true,
          // Anything wrapped in data-ph-mask has its text redacted in replay.
          maskTextSelector: '[data-ph-mask], [data-ph-mask] *'
        },
        capture_dead_clicks: true,
        capture_exceptions: true,
        autocapture: {
          dom_event_allowlist: ['click'],
          element_allowlist:   ['button', 'a']
        }
      });
      p.startSessionRecording && p.startSessionRecording();
    } catch (_) {}
  }

  // ?booked=1 -> fire call_booked once, strip the param so a refresh doesn't
  // re-fire.
  if (q('booked') === '1'){
    capture('call_booked', {});
    stripParams(['booked']);
  }

  // Session summary hooks.
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') sendSessionSummary();
  });
  window.addEventListener('pagehide', sendSessionSummary);

  return { enhanced, optedOut };
}
