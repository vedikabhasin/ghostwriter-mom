// -----------------------------------------------------------------------------
// Desk layer — a shared background of stationery emojis + a DELIVERED stamp,
// shown behind the waitlist, the sales-page intro, and the portal login.
// Consumers call mountDesk(host, { density }) once; the module inserts a
// .gwm-desk container full of .gwm-desk-frag elements. No images, no CLS,
// aria-hidden, pointer-events: none.
//
// Densities:
//   'full'  — waitlist background. Every fragment.
//   'light' — 4 phone-safe fragments (pushpin top-center, paperclip top-left,
//             coffee right, DELIVERED stamp bottom-left). Portal login /
//             sales intro use this.
//   'none'  — no fragments (module still mounted so the CSS rules apply).
// -----------------------------------------------------------------------------

// Every entry: { fid, glyph|stamp:true, def, cls }. `def` positions the
// fragment via top / bottom / left / right + rotation. `cls` adds hide-sm /
// hide-md flags so the responsive breakpoints hide the desktop-heavy items
// on phones. `light: true` marks the fragments that survive at density=light.
const FRAGMENTS = [
  // Phone-safe (visible at every width).
  { fid:'paperclip-tl', glyph:'\u{1F4CE}',              def:{ top:'22vh', left:'1vw',  rot:-22 }, light:true },
  { fid:'linkclip-bl',  glyph:'\u{1F587}\u{FE0F}',      def:{ bottom:'24vh', left:'1vw', rot:28 } },
  { fid:'pushpin-top',  glyph:'\u{1F4CC}',              def:{ top:'1vh',   left:'46%', rot:8   }, light:true },
  { fid:'pen-br',       glyph:'\u{1F58A}\u{FE0F}',      def:{ bottom:'22vh', right:'3vw', rot:34 } },
  { fid:'coffee-right', glyph:'\u{2615}',               def:{ top:'58vh',  right:'1vw', rot:-6 }, light:true },

  // Desktop-only (hidden under 640px via hide-sm).
  { fid:'memo-bottom',   glyph:'\u{1F4DD}', def:{ bottom:'4vh',  left:'24%', rot:-9  }, cls:'hide-sm' },
  { fid:'notepad-tr',    glyph:'\u{1F4D2}', def:{ top:'40vh',    right:'7vw', rot:12 }, cls:'hide-sm' },
  { fid:'notebook-mid',  glyph:'\u{1F4D3}', def:{ top:'56vh',    right:'8vw', rot:-18 }, cls:'hide-sm' },
  { fid:'scroll-left',   glyph:'\u{1F4DC}', def:{ top:'68vh',    left:'1vw',  rot:16 }, cls:'hide-sm' },

  // DELIVERED stamp — no longer says "Draft Approved", since "Approved" is
  // not a status anymore. Phone-safe.
  { fid:'stamp-tl', stamp:true, def:{ bottom:'30vh', left:'1vw', rot:-6 }, cls:'hide-xs', light:true },
];

function makeFrag(item){
  var el = document.createElement('div');
  el.className = 'gwm-desk-frag';
  el.dataset.fid = item.fid;
  if(item.stamp){
    el.classList.add('stamp');
    el.textContent = 'Delivered';
  } else {
    el.classList.add('emoji');
    // The desktop-heavy fragments read as small accents; the phone-safe ones
    // are drawn slightly smaller.
    if(item.cls === 'hide-sm') el.classList.add('lg');
    else el.classList.add('sm');
    el.textContent = item.glyph;
  }
  if(item.cls) el.classList.add(item.cls);
  // Density=light survives via hide-light marker on the OTHER fragments.
  if(!item.light) el.classList.add('hide-light');
  var d = item.def || {};
  if(d.top != null)    el.style.top    = d.top;
  if(d.bottom != null) el.style.bottom = d.bottom;
  if(d.left != null)   el.style.left   = d.left;
  if(d.right != null)  el.style.right  = d.right;
  var rot = d.rot || 0;
  el.style.transform = 'rotate(' + rot + 'deg)';
  return el;
}

// Mount the desk into `host` (defaults to document.body). Returns the wrapper
// element so callers can unmount by removing it.
export function mountDesk(host, opts){
  opts = opts || {};
  var density = opts.density || 'full';
  host = host || document.body;
  var wrap = document.createElement('div');
  wrap.className = 'gwm-desk';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.dataset.density = density;
  FRAGMENTS.forEach(function(item){ wrap.appendChild(makeFrag(item)); });
  host.appendChild(wrap);
  return wrap;
}

// Explicit alias for callers that want to strip the layer (e.g. a Turbo-style
// page transition).
export function unmountDesk(wrap){
  if(wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
}
