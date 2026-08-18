// The canvas: an unbounded surface you pan and zoom. Panels live on it.
//
// This used to be tangled inside a node-graph view. The graph is gone, but the
// surface it was drawn on is the good part — so it lives here on its own, at
// about a quarter of the size, and knows nothing about what is placed on it.
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
// Debounced, because the callers are gesture handlers: one wheel gesture is
// 60-120 events, each of which was a JSON.stringify plus a synchronous
// localStorage write interleaved with the transform that has to stay smooth.
// Only the last position of a gesture is worth persisting anyway.
const timers = new Map();
const save = (k, v) => {
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => localStorage.setItem(k, JSON.stringify(v)), 250));
};

let surface;                       // the element that receives pan/zoom gestures
// kd.view2, not kd.view: the graph-era view was saved in a different frame of
// reference (its fit() zoomed to frame nodes), so restoring it here dropped the
// workspace in at 2.1x zoom with every panel off screen. A new key discards it.
let view = load('kd.view2', null);
const riders = new Set();

const MIN_K = 0.2, MAX_K = 2.5;
const clampK = (k) => Math.min(MAX_K, Math.max(MIN_K, k));

/** Anything that must move with the canvas subscribes here. */
export function onView(fn) {
  riders.add(fn);
  if (view) fn(view);
  return () => riders.delete(fn);
}

const apply = () => { for (const fn of riders) fn(view); };

export function initCanvas(el) {
  surface = el;
  view ??= { x: 0, y: 0, k: 1 };
  apply();

  surface.addEventListener('pointerdown', startPan);
  surface.addEventListener('wheel', onWheel, { passive: false });
  // Middle-drag pans from anywhere, including over a panel — the usual escape
  // when panels cover the whole surface.
  window.addEventListener('pointerdown', (e) => { if (e.button === 1) startPan(e); });
}

/** Screen point -> canvas point. */
export function toCanvas(cx, cy) {
  const r = surface.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
}

/** The canvas rectangle currently on screen: where a new panel should land. */
export function visibleRect() {
  const r = surface.getBoundingClientRect();
  const a = toCanvas(r.left, r.top);
  const b = toCanvas(r.right, r.bottom);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

export const scale = () => view.k;

export function zoomTo(k, at) {
  const r = surface.getBoundingClientRect();
  const cx = at?.x ?? r.left + r.width / 2;
  const cy = at?.y ?? r.top + r.height / 2;
  const p = toCanvas(cx, cy);
  view.k = clampK(k);
  view.x = cx - r.left - p.x * view.k;
  view.y = cy - r.top - p.y * view.k;
  apply();
  save('kd.view2', view);
}

export const resetZoom = () => zoomTo(1);

/** Put a canvas rectangle in the middle of the screen at the current zoom. */
export function centreOn(box) {
  const r = surface.getBoundingClientRect();
  if (r.width < 80) return;
  view.x = r.width / 2 - (box.x + box.w / 2) * view.k;
  view.y = r.height / 2 - (box.y + box.h / 2) * view.k;
  apply();
  save('kd.view2', view);
}

/** Frame a canvas rectangle, zooming out if it does not fit. */
export function frame(box) {
  const r = surface.getBoundingClientRect();
  if (r.width < 80 || r.height < 80 || !box.w || !box.h) return;
  const pad = 60;
  view.k = clampK(Math.min((r.width - pad * 2) / box.w, (r.height - pad * 2) / box.h, 1));
  centreOn(box);
}

function startPan(e) {
  // Panels handle their own drags; a pan started on one would fight them.
  if (e.button !== 1 && e.target.closest('.win, .rail, header, footer, #palette')) return;
  if (e.button === 2) return;
  e.preventDefault();
  const sx = e.clientX - view.x, sy = e.clientY - view.y;
  surface.classList.add('panning');
  try { surface.setPointerCapture(e.pointerId); } catch {}

  const move = (m) => { view.x = m.clientX - sx; view.y = m.clientY - sy; apply(); };
  const up = () => {
    surface.classList.remove('panning');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    save('kd.view2', view);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onWheel(e) {
  // Ctrl+wheel and pinch zoom; a plain wheel scrolls the canvas, which is what
  // a trackpad two-finger swipe should do on a surface this size.
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    return zoomTo(view.k * Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
  }
  if (e.target.closest('.log, .tracks, .gallery, select, textarea')) return;  // let content scroll
  e.preventDefault();
  view.x -= e.deltaX;
  view.y -= e.deltaY;
  apply();
  save('kd.view2', view);
}
