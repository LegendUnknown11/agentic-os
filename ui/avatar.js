// A face for every member.
//
// Sixteen rows of grey text with a grey dot beside each one is the single
// biggest reason this reads as a list of strings rather than a court. People
// recognise a colour and a shape far faster than they read a word, and a
// multi-agent app lives or dies on "which one is this".
//
// The colour is derived from the name, so it is stable across restarts,
// consistent everywhere the member appears, and needs no configuration.
const HUE = new Map();

export function hueOf(name) {
  if (HUE.has(name)) return HUE.get(name);
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  // Skip the muddy yellow-browns: they collide with the crown and read as
  // "disabled" against this palette.
  if (h > 38 && h < 62) h = (h + 60) % 360;
  HUE.set(name, h);
  return h;
}

/** One or two letters. "quartermaster" -> Q, "green-screen" -> GS. */
const monogram = (name) => {
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 1)).toUpperCase();
};

/**
 * @param {string} name
 * @param {'king'|'jester'|'peasant'} role  the king wears the crown's gold
 * @param {number} size
 */
export function avatar(name, role, size = 22) {
  const el = document.createElement('span');
  el.className = `av${role === 'king' ? ' crown' : ''}`;
  el.style.setProperty('--h', hueOf(name));
  el.style.setProperty('--av', `${size}px`);
  el.textContent = monogram(name);
  el.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('i');
  el.append(dot);
  return el;
}
