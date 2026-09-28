// -----------------------------------------------------------------------------
// Drop day: the weekly weekday when a client's next batch of directions lands.
//
// Both the sales page and the portal need to write the same day into
// confirmation copy ("Your free article lands {Weekday} either way", "Five new
// directions every {Weekday}"). We anchor to the company's first_opened_at,
// then read that timestamp's weekday in the *visitor's* local time zone and
// collapse Sat/Sun to Monday so the answer is always a business day.
//
// Callers who don't yet have a first_opened_at (a brand-new company that has
// never been opened, or an internal preview) fall back to the visitor's own
// "now": still their local weekday, still Sat/Sun -> Monday.
//
// Exports:
//   dropWeekday(firstOpenedAt?)        -> "Monday"..."Friday"
//   nextDropDate(firstOpenedAt?, now?) -> Date whose weekday matches
//                                         dropWeekday() and is >= now
//   formatDeliveryTime(date)           -> "Mon Sep 22, 5:40 PM"
// -----------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Anchor -> local weekday, but collapse the weekend to Monday.
export function dropWeekday(firstOpenedAt) {
  const d = coerce(firstOpenedAt) || new Date();
  const wd = d.getDay(); // 0..6 in local tz
  if (wd === 0 || wd === 6) return 'Monday';
  return WEEKDAY_NAMES[wd];
}

// Next occurrence of the drop weekday on or after `now` (default: local now).
export function nextDropDate(firstOpenedAt, now) {
  const base = coerce(now) || new Date();
  const target = WEEKDAY_NAMES.indexOf(dropWeekday(firstOpenedAt));
  const out = new Date(base);
  out.setHours(0, 0, 0, 0);
  const delta = ((target - out.getDay()) + 7) % 7;
  out.setDate(out.getDate() + delta);
  return out;
}

// "Mon Sep 22, 5:40 PM" — visitor's local time, no timezone label.
export function formatDeliveryTime(date) {
  const d = coerce(date) || new Date();
  const day  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  const mon  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const dt   = d.getDate();
  let hrs    = d.getHours();
  const ampm = hrs >= 12 ? 'PM' : 'AM';
  hrs = hrs % 12 || 12;
  const min  = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon} ${dt}, ${hrs}:${min} ${ampm}`;
}

function coerce(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
