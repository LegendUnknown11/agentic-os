// Drawn icons, one consistent stroke, one 16px grid.
//
// The throne room used emoji as its icon set — 👑 ♔ ⛏ ☰ 🎙 ⏻ ✕. Emoji render
// differently on every machine, carry their own colour, and sit on their own
// baseline, so a row of them can never line up or share a weight. These are
// authored paths on a 16-box at stroke 1.5, currentColor, so they inherit text
// colour and align with the text they sit beside.
const P = {
  crown: 'M2 12h12M2.5 12 2 5l3.2 2.6L8 3l2.8 4.6L14 5l-.5 7',
  bus: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h7',
  command: 'M5.5 5.5h5v5h-5zM5.5 5.5a2 2 0 1 0-2-2v2m2 0v5m0 0a2 2 0 1 0 2 2v-2'
    + 'm3-5a2 2 0 1 1 2-2v2m-2 0v5m0 0a2 2 0 1 1 2 2v-2',
  mic: 'M8 2.5a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 1 1-3.6 0V4.3A1.8 1.8 0 0 1 8 2.5Z'
    + 'M4 7.4v.6a4 4 0 0 0 8 0v-.6M8 12v1.6',
  close: 'M4 4l8 8M12 4l-8 8',
  power: 'M8 2.6v5M5 4.6a4.6 4.6 0 1 0 6 0',
  target: 'M8 1.8v2.6M8 11.6v2.6M1.8 8h2.6M11.6 8h2.6M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z',
  shuffle: 'M2.5 4.5h2.2l6.6 7h2.2M2.5 11.5h2.2l2.4-2.6M9.1 6.1l2.2-1.6h2.2M11.8 2.6l1.9 1.9-1.9 1.9M11.8 9.6l1.9 1.9-1.9 1.9',
  send: 'M2.5 8h9M8.4 4.6 11.8 8l-3.4 3.4',
  // Same grid, same stroke: a frame with a horizon and a sun.
  image: 'M2.5 3.5h11v9h-11zM2.5 10.2l3-2.8 3.2 2.9 2.3-1.9 2.5 2.1M10.4 6.1a.9.9 0 1 0 0-.1Z',
  music: 'M6 12V3.6l7-1.4v8.2M6 12a1.7 1.7 0 1 1-3.4 0A1.7 1.7 0 0 1 6 12Zm7-1.6a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0Z',
  play: 'M5.5 3.4 12 8l-6.5 4.6z',
  pause: 'M6 3.6v8.8M10 3.6v8.8',
  prev: 'M11.5 3.6 5.8 8l5.7 4.4zM4.2 3.6v8.8',
  next: 'M4.5 3.6 10.2 8l-5.7 4.4zM11.8 3.6v8.8',
  loop: 'M3 7a3 3 0 0 1 3-3h6.2M12.8 9a3 3 0 0 1-3 3H3.6M10.6 2.2 12.9 4l-2.3 1.8M5.4 10.2 3.1 12l2.3 1.8',
  upload: 'M8 10.6V2.8M5.4 5.2 8 2.6l2.6 2.6M2.6 10v2.6a.8.8 0 0 0 .8.8h9.2a.8.8 0 0 0 .8-.8V10',
  // The toolbar set. Same 16 grid, same 1.5 stroke — a row of icons only reads
  // as a set if every one was drawn to the same rules.
  metrics: 'M2.6 13.4h10.8M4.4 13.4V8.2M7.4 13.4V4.4M10.4 13.4V6.6',
  vault: 'M3.4 3.2h6.2a2.4 2.4 0 0 1 2.4 2.4v7.2H5.8a2.4 2.4 0 0 1-2.4-2.4zM3.4 10.4a2.4 2.4 0 0 1 2.4-2.4H12',
  bell: 'M6.2 12.6a1.8 1.8 0 0 0 3.6 0M4 12.6h8l-1-1.6V7.6a3 3 0 0 0-6 0v3.4z',
  advisor: 'M3 13 10.6 5.4M9.4 4.2l2.4 2.4M12.2 2.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5zM4 6l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z',
  summary: 'M2.8 4.2h10.4M2.8 7.4h7.4M2.8 10.6h4.6M11 10.2l.45 1.15 1.15.45-1.15.45L11 13.4l-.45-1.15-1.15-.45 1.15-.45z',
  gather: 'M2.6 2.6h4.2v4.2H2.6zM9.2 2.6h4.2v4.2H9.2zM2.6 9.2h4.2v4.2H2.6zM9.2 9.2h4.2v4.2H9.2z',
  zoom: 'M7.2 2.8a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zM10.5 10.5l2.9 2.9M5.2 7.2h4',
  pause: 'M6 3.6v8.8M10 3.6v8.8',
  chronicle: 'M2.8 3.4h10.4M2.8 6.6h10.4M2.8 9.8h6.6M2.8 13h4.2',
  goal: 'M8 2.4v11.2M4.2 3.4h6.6l-1.4 2.2 1.4 2.2H4.2z',
  approve: 'M3.4 8.4l3 3 6.2-6.6M2.6 12.6h10.8',
  more: 'M4 8h.01M8 8h.01M12 8h.01',
  // A dog: muzzle, two floppy ears, and a collar.
  pet: 'M5.4 5.2C4.2 4 2.8 3.4 2.8 3.4v3.9a5.2 5.2 0 0 0 10.4 0V3.4s-1.4.6-2.6 1.8'
    + 'M6.4 8.2h.01M9.6 8.2h.01M8 10.4a1.2 1.2 0 0 1-1-.5M8 10.4a1.2 1.2 0 0 0 1-.5',
  who: 'M8 8.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM3.3 13.4a4.7 4.7 0 0 1 9.4 0',
  // A raised standard: the court is called to it.
  summon: 'M4.4 14V2.4M4.4 3.3h8.2l-1.9 2.7 1.9 2.7H4.4',
  // A horn: the cone, the bell, and two calls leaving it.
  sound: 'M2.6 6.2h2.4L8.4 3.4v9.2L5 9.8H2.6zM10.8 6a2.8 2.8 0 0 1 0 4M12.8 4a5.4 5.4 0 0 1 0 8',
  diff: 'M4.2 2.8v7.4M4.2 13.2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.2 5.8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.8 5.8v4.4M11.8 13.2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.8 5.8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5.7 4.3h4.6',
  // A page with a folded corner, and two lines of text.
  document: 'M4.5 2.6h4.8l2.2 2.2v8.2a.6.6 0 0 1-.6.6h-6.4a.6.6 0 0 1-.6-.6V3.2a.6.6 0 0 1 .6-.6ZM9.3 2.6v2.2h2.2M5.6 8.4h4.8M5.6 10.6h4.8',
};

/** @returns {SVGSVGElement} 16x16, inherits colour, no fill. */
export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] ?? P.close);
  svg.append(p);
  return svg;
}

/** Replace an element's contents with an icon, keeping its accessible name. */
export function setIcon(el, name, label) {
  el.textContent = '';
  el.append(icon(name));
  if (label) {
    el.setAttribute('aria-label', label);
    if (!el.title) el.title = label;
  }
}
