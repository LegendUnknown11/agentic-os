// Floating panels on the shared canvas. Drag the title bar to move, grab the
// corner to resize (CSS does that), and where you put them is remembered per id.
//
// Panel coordinates are CANVAS coordinates, not screen ones: the panel layer
// rides the same pan/zoom transform as the canvas, so the workspace scrolls as
// one surface. Every pointer position therefore has to be converted before it
// can be compared with a panel's position.
import { setIcon } from './icons.js';
import { toCanvas, visibleRect, onView } from './canvas.js';

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
// kd.win2: panel geometry from before the canvas existed was in screen
// coordinates, which are not canvas coordinates. Reusing it scattered panels.
const geom = load('kd.win2', {});
const wins = new Map();
let z = 100;
let host;
// Board mode: the grid owns the geometry. Dragging and remembering are both
// off, or every tiled card would overwrite the free-canvas layout with the
// cell size the grid happened to give it.
let tiled = false;
export const setTiled = (on) => { tiled = on; };

export const setHost = (el) => {
  host = el;
  // Panels ride the canvas: one transform for the whole workspace.
  host.style.transformOrigin = '0 0';
  onView((v) => { host.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`; });
};
export const isOpen = (id) => wins.has(id);
/** Which panels exist right now — the rail mirrors this. */
export const openIds = () => new Set(wins.keys());
let changed = () => {};
export const onChange = (fn) => { changed = fn; };
export const getWindow = (id) => wins.get(id);

// Teardown per panel, run by close() itself.
//
// It used to be the caller's job — `close(id); onClose?.()` at the X button and
// at toggle(). Every other way a panel dies skipped it: Escape calls W.close()
// directly, and so do closeAll() and the rail. Metrics kept a 5s draw timer and
// Approvals a 6s poll running forever against detached DOM. The music panel's
// cleanup could not run even from the X button, because it was reached through
// `getWindow('music')?._offMusic?.()` and close() had already dropped the
// element — an optional chain quietly no-opping over a ~4Hz callback that
// pinned the whole detached subtree.
const teardown = new Map();

export function close(id) {
  const fns = teardown.get(id);
  teardown.delete(id);
  wins.get(id)?.remove();
  wins.delete(id);
  for (const fn of fns ?? []) { try { fn(); } catch (e) { console.error(e); } }
  changed();
}

export function closeAll() {
  for (const id of [...wins.keys()]) close(id);
}

/**
 * build(el) fills the body; it is called once. Re-opening a closed window
 * rebuilds it, so callers keep their own scrollback.
 */
export function open(id, { title, cls = '', build, onClose } = {}) {
  const existing = wins.get(id);
  if (existing) { front(existing); return existing; }

  const g = geom[id] ?? spawnSpot();
  const el = document.createElement('div');
  el.className = `win ${cls}`;
  el.dataset.id = id;
  el.style.cssText = `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;z-index:${++z}`;
  el.innerHTML = `<div class="bar"><span class="title"></span><span class="stat"></span>
    <span class="slot"></span></div>`;
  el.querySelector('.title').textContent = title ?? id;
  const x = document.createElement('button');
  x.className = 'x';
  el.querySelector('.slot').append(x);
  setIcon(x, 'close', 'Close');
  x.onclick = () => close(id);
  el.addEventListener('pointerdown', () => front(el), true);

  host.append(el);
  wins.set(id, el);
  drag(el.querySelector('.bar'), el, id);
  remember(id, el);   // so even a window you never touch keeps its spot
  const ro = new ResizeObserver(() => remember(id, el));
  ro.observe(el);
  // Registered BEFORE build(), so a build that throws still leaves the observer
  // disconnectable — and so build() itself can add its own via onTeardown.
  teardown.set(id, [() => ro.disconnect(), ...(onClose ? [onClose] : [])]);
  build?.(el);
  changed();
  return el;
}

export function toggle(id, opts) {
  if (wins.has(id)) { close(id); return false; }
  open(id, opts);
  return true;
}

/** Cleanup a panel's own build() wants to run when it closes. */
export const onTeardown = (id, fn) => teardown.get(id)?.push(fn);

const front = (el) => { el.style.zIndex = ++z; };

// Cascade so a second window never lands exactly on the first — and land it
// where the sovereign is actually looking, not at the canvas origin, which may
// be far off screen after a pan.
function spawnSpot() {
  const n = wins.size;
  const v = visibleRect();
  // 34px of stagger on a 620px card is a 95% overlap — the second panel landed
  // almost exactly on the first and looked like a rendering fault.
  return {
    x: v.x + 32 + (n % 5) * 76,
    y: v.y + 32 + (n % 5) * 58,
    w: 620, h: 440,
  };
}

function remember(id, el) {
  if (tiled) return;                                 // the grid's size is not the sovereign's
  if (!el.offsetWidth || !el.offsetHeight) return;   // not laid out yet; 0x0 would stick
  geom[id] = {
    x: parseFloat(el.style.left), y: parseFloat(el.style.top),
    w: el.offsetWidth, h: el.offsetHeight,
  };
  // The in-memory geometry updates now — open() reads it synchronously. The
  // WRITE waits: a ResizeObserver fires this once per frame for the whole drag
  // of a corner, and stringifying every panel's geometry to localStorage on
  // each frame is work no one asked for. Only the last frame matters.
  clearTimeout(flushGeom);
  flushGeom = setTimeout(() => localStorage.setItem('kd.win2', JSON.stringify(geom)), 250);
}
let flushGeom;

function drag(bar, el, id) {
  bar.addEventListener('pointerdown', (e) => {
    if (tiled) return;
    if (e.target.closest('button,select,input')) return;
    // Grab offset in CANVAS units. Mixing screen deltas with canvas positions
    // made panels fly away from the cursor at any zoom other than 1.
    const g = toCanvas(e.clientX, e.clientY);
    const dx = g.x - el.offsetLeft, dy = g.y - el.offsetTop;
    try { bar.setPointerCapture(e.pointerId); } catch {}   // nice to have, not required
    const move = (m) => {
      const p = toCanvas(m.clientX, m.clientY);
      // No clamping: the canvas is unbounded, and "Gather the panels" brings
      // back anything pushed out of sight.
      el.style.left = `${Math.round(p.x - dx)}px`;
      el.style.top = `${Math.round(p.y - dy)}px`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      // A pointer the browser takes back — a touch cancelled by a system
      // gesture, a pen leaving range — fires pointercancel and never
      // pointerup, so without this the move handler stayed attached and the
      // panel kept following the cursor. pet-window.js:120 already had it.
      bar.removeEventListener('pointercancel', up);
      remember(id, el);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}

/**
 * Bring every open panel back into the visible canvas, tiled. The escape hatch
 * for "I zoomed out, dragged something into the void and cannot find it".
 */
export function gather() {
  const v = visibleRect();
  const pad = 16;
  let x = v.x + pad, y = v.y + pad, rowH = 0;
  for (const [id, el] of wins) {
    const w = el.offsetWidth || 430, h = el.offsetHeight || 320;
    if (x > v.x + pad && x + w > v.x + v.w - pad) { x = v.x + pad; y += rowH + pad; rowH = 0; }
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    x += w + pad;
    rowH = Math.max(rowH, h);
    remember(id, el);
  }
}

// ponytail: the native CSS resize handle drags in screen pixels but sets a size
// in canvas pixels, so resizing feels fast when zoomed out and slow when zoomed
// in. Writing a custom resizer to fix that is more code than the annoyance is
// worth — revisit if anyone actually complains.
