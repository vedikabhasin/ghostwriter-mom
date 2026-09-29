// -----------------------------------------------------------------------------
// Portal-local helpers: DOM shorthands and date formats.
// The date formats are copied from swipe.html (fmtWhen, formatDeliverBy) so
// the portal and the sales page print dates the same way. Colors are never
// defined here; they come from /styles/tokens.css.
// -----------------------------------------------------------------------------
export const $ = (sel, root) => (root || document).querySelector(sel);
export const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

export function hash(s) {
  let x = 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

export const prefersReduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---- dates (same options as swipe.html) --------------------------------------
function toDate(v) {
  // Date-only strings are pinned to local noon so they never slip a day.
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
}
/** "Sep 22, 5:40 PM": swipe.html fmtWhen. */
export function fmtWhen(v) {
  try { return toDate(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return String(v); }
}
/** "Sep 22": the date half of fmtWhen. */
export function fmtDay(v) {
  if (!v) return '';
  try { return toDate(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch (_) { return String(v); }
}
/** "Monday, Sep 28, 5:40 PM": swipe.html formatDeliverBy. */
export function fmtDeliverBy(v) {
  try { return toDate(v).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return String(v); }
}
/** Whole hours between two timestamps, rounded. */
export function hoursBetween(from, to) {
  return Math.max(0, Math.round((new Date(to) - new Date(from)) / 3600000));
}
/** "14h 20m" until `iso`, or null once it has passed. */
export function countdown(iso, now = Date.now()) {
  const ms = new Date(iso) - now;
  if (!(ms > 0)) return null;
  const mins = Math.ceil(ms / 60000);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return hh ? `${hh}h ${mm}m` : `${mm}m`;
}
export function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---- weekly drop day --------------------------------------------------------
// The drop day itself comes from /shared/drop-day.js (shared with the sales
// page). These only format it.
/** "Tuesday, Oct 6" */
export function fmtWeekday(d) {
  try { return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); }
  catch (_) { return String(d); }
}
/** Date-only "YYYY-MM-DD" for a local date. */
export function dateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/** "3d 4h", "14h 20m" or "20m" until `when`, or null once it has passed. */
export function countdownLong(when, now = Date.now()) {
  const ms = new Date(when) - now;
  if (!(ms > 0)) return null;
  const mins = Math.ceil(ms / 60000);
  const dd = Math.floor(mins / 1440), hh = Math.floor((mins % 1440) / 60), mm = mins % 60;
  if (dd) return `${dd}d ${hh}h`;
  return hh ? `${hh}h ${mm}m` : `${mm}m`;
}
