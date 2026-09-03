// Wallpaper and music. Files are uploaded to the daemon and live beside the
// database (outside the target repo, so a wallpaper never turns up in a diff);
// the browser only remembers WHICH one is chosen, not the bytes. That keeps
// localStorage small and survives a reload, a restart and a second window.
import { setPrefs, state as appState } from './store.js';

const pref = (key, fallback) => appState.prefs[key] ?? fallback;

const DEFAULTS = { image: null, dim: 55, blur: 0, fixed: true };
let bg = { ...DEFAULTS, ...pref('background', {}) };
let assets = [];
let onChange = () => {};

export const list = () => assets;
export const background = () => bg;
export const src = (name) => `/assets/${encodeURIComponent(name)}`;

export async function refresh() {
  try {
    const response = await fetch('/api/assets');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok === false) return assets;
    assets = result.assets ?? [];
    syncQueue();
  } catch {
    return assets;
  }
  onChange();
  return assets;
}

export const onAssets = (fn) => {
  onChange = typeof fn === 'function' ? fn : () => {};
  return () => { if (onChange === fn) onChange = () => {}; };
};

/**
 * Upload with the raw file as the body. Not multipart: the daemon is a
 * hand-rolled http server and a boundary parser would be a lot of code to
 * transmit one file.
 */
export async function upload(file) {
  const r = await fetch(`/api/assets?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { ...body, ok: false, error: body.error ?? 'upload failed' };
  }).catch(() => ({ ok: false, error: 'upload failed' }));
  if (r.ok) await refresh();
  return r;
}

export async function remove(name) {
  const result = await fetch('/api/assets/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { ...body, ok: false, error: body.error ?? 'delete failed' };
  }).catch(() => ({ ok: false, error: 'delete failed' }));
  if (result?.ok === false) return result;
  if (bg.image === name) setBackground({ image: null });
  if (track()?.name === name) stop();
  await refresh();
  return result;
}

/** Opens the OS file picker. Returns the chosen files, or an empty list. */
export function pick(accept, multiple = true) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    let settled = false;
    let focusTimer = null;
    const onFocus = () => { focusTimer = setTimeout(() => finish([...(i.files ?? [])]), 0); };
    const finish = (files = []) => {
      if (settled) return;
      settled = true;
      if (focusTimer) clearTimeout(focusTimer);
      globalThis.removeEventListener?.('focus', onFocus);
      resolve(files);
    };
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    i.onchange = () => finish([...(i.files ?? [])]);
    // The focus-return fallback covers engines which do not dispatch `cancel`.
    i.addEventListener('cancel', () => finish([]));
    globalThis.addEventListener?.('focus', onFocus);
    try { i.click(); } catch { finish([]); }
  });
}

/* ---------- the wallpaper ---------- */
let bgEl;

export function initBackground(el) {
  bgEl = el;
  applyBackground();
}

export function setBackground(patch) {
  bg = { ...bg, ...patch };
  setPrefs({ background: bg });
  applyBackground();
}

/**
 * Average luminance of an image, 0..1, from a 32x32 downscale.
 *
 * Needed because glass PRESERVES the luminance of whatever is behind it. A
 * bright photo at a low dim setting takes the panes' muted text from 6:1 down
 * to under 2:1 — perfectly readable in the preview thumbnail, unreadable in
 * the actual UI. Measure rather than hope.
 */
export function meanLuminance(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 32, 32);
        const { data } = g.getImageData(0, 0, 32, 32);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          // Rec. 709 on the raw bytes: good enough to pick a scrim, and far
          // cheaper than a full sRGB linearisation per pixel.
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        }
        resolve(sum / (data.length / 4));
      } catch {
        resolve(null);   // a tainted canvas is not worth failing an upload over
      }
    };
    img.src = url;
  });
}

/**
 * The least dimming that keeps muted text legible over an image this bright.
 * Derived from the measured worst case, not guessed: a white backdrop needs
 * roughly 80% scrim before --faint clears 4.5:1 through a 55%-alpha pane.
 */
export const safeDim = (lum) =>
  (lum === null ? 50 : Math.round(Math.min(85, Math.max(25, lum * 92))));

/** Choose a wallpaper and dim it enough to stay readable. */
export async function useWallpaper(name) {
  const lum = await meanLuminance(src(name));
  const floor = safeDim(lum);
  setBackground({ image: name, dim: Math.max(bg.dim, floor), floor });
  return { lum, floor };
}

export const resetBackground = () => setBackground({ ...DEFAULTS });

function applyBackground() {
  if (!bgEl) return;
  // The image goes in as a CSS variable rather than as an inline
  // background-image, so the stylesheet keeps ownership of the layering: with
  // no wallpaper the flat body fill stays in the same layer, and there is no
  // inline style left behind to fight it.
  document.body.classList.toggle('has-bg', Boolean(bg.image));
  if (!bg.image) {
    bgEl.style.removeProperty('--wall');
    bgEl.style.removeProperty('--bg-dim');
    bgEl.style.filter = '';
    bgEl.style.transform = '';
    return;
  }
  bgEl.style.setProperty('--wall', `url("${src(bg.image)}")`);
  bgEl.style.filter = bg.blur ? `blur(${bg.blur}px)` : '';
  // Scaling the blurred layer up hides the transparent fringe blur leaves at
  // the edges of an element.
  bgEl.style.transform = bg.blur ? `scale(${1 + bg.blur / 60})` : '';
  bgEl.style.setProperty('--bg-dim', String(bg.dim / 100));
}

/* ---------- music ---------- */
// One <audio>, created once and never replaced: replacing it is what makes a
// player restart the track every time the panel is reopened.
const audio = new Audio();
audio.preload = 'none';
let queue = [];
let at = -1;
let listeners = new Set();

function syncQueue() {
  const names = assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.name);
  const current = track()?.name;
  const nextQueue = [
    ...queue.map((item) => item.name).filter((name) => names.includes(name)),
    ...names.filter((name) => !queue.some((item) => item.name === name)),
  ].map((name) => ({ name }));
  if (nextQueue.length === queue.length && nextQueue.every((item, index) => item.name === queue[index]?.name)) return;
  queue = nextQueue;
  at = current ? queue.findIndex((item) => item.name === current) : (queue.length ? 0 : -1);
  announce();
}

const player = { volume: 0.35, loop: true, shuffle: false, ...pref('music', {}) };
audio.volume = player.volume;
audio.loop = false;   // looping is handled across the queue, not per track

export const onMusic = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const announce = () => { for (const fn of listeners) fn(state()); };

export const track = () => queue[at] ?? null;
export const state = () => ({
  ...player,
  playing: !audio.paused && Boolean(queue.length),
  name: track()?.name ?? null,
  time: audio.currentTime || 0,
  duration: Number.isFinite(audio.duration) ? audio.duration : 0,
  queue: queue.map((t) => t.name),
  index: at,
});

audio.addEventListener('ended', () => next());
audio.addEventListener('timeupdate', announce);
audio.addEventListener('play', announce);
audio.addEventListener('pause', announce);
// A missing or unplayable file must not wedge the queue on a silent track.
audio.addEventListener('error', () => { if (queue.length > 1) next(); else announce(); });

export function setQueue(names) {
  queue = names.map((name) => ({ name }));
  at = queue.length ? 0 : -1;
  announce();
}

export function play(name) {
  if (name) {
    const i = queue.findIndex((t) => t.name === name);
    at = i === -1 ? (queue.push({ name }) - 1) : i;
  }
  if (at === -1 && queue.length) at = 0;
  const t = track();
  if (!t) return;
  const want = src(t.name);
  // Re-assigning src restarts playback, so only do it for a genuinely new track.
  if (!audio.src.endsWith(encodeURIComponent(t.name))) audio.src = want;
  audio.play().catch(() => {});
  announce();
}

export const pause = () => { audio.pause(); announce(); };
export const toggle = () => (audio.paused ? play() : pause());

export function stop() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  at = queue.length ? 0 : -1;
  announce();
}

export function next(step = 1) {
  if (!queue.length) return;
  if (player.shuffle && queue.length > 1) {
    let i = at;
    while (i === at) i = Math.floor(Math.random() * queue.length);
    at = i;
  } else {
    at += step;
    if (at >= queue.length) { if (!player.loop) { at = queue.length - 1; return pause(); } at = 0; }
    if (at < 0) at = queue.length - 1;
  }
  audio.src = src(queue[at].name);
  audio.play().catch(() => {});
  announce();
}

export function setPlayer(patch) {
  Object.assign(player, patch);
  if (patch.volume !== undefined) audio.volume = patch.volume;
  setPrefs({ music: { ...player } });
  announce();
}

export const seek = (s) => { if (Number.isFinite(audio.duration)) audio.currentTime = s; };

export const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
