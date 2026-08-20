// One place decides what a colour is, and one place decides what a pane is
// made of.
//
// The stylesheet had the accent in two forms that could not be changed
// together: `--accent:#45ecc6` for a solid fill, and the channels typed out
// wherever it appeared with an alpha — rgba(69,236,198,.45), .12, .7, sixteen
// of them, plus fourteen of the crown gold and nine of the danger red. Change
// the accent and the solid uses moved while every wash, glow and focus ring
// kept the old hue. The palette looked like one colour and was two.
//
// Worse, the loudest use of it was not in that set at all. The summon button
// was `linear-gradient(158deg,#63f4d6,#2fc4a4)` — two hexes, neither of them
// the accent — so a sweep looking for the accent could never have found it.
// After the whole palette had been retuned to near-white, that one button was
// still mint, and only looking at the running app showed it.
//
// So this file does not check taste. It checks that a palette change REACHES
// everything: that no colour is written where a change cannot find it, and
// that the material is a set of variables rather than a pile of overrides.
//
//   node test/t-theme.js
import { strict as a } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dirname, '..', 'ui');
const css = readFileSync(join(UI, 'app.css'), 'utf8');

/** The first :root — where writing a colour IS the point. */
const tokenBlock = css.slice(0, css.indexOf('*{box-sizing'));
/**
 * Everything else, with every OTHER `:root{...}` taken out too: the glass
 * material and the reduced-transparency fallback are token blocks that happen
 * to live further down. The line is not where a colour appears but what it is
 * doing — a value on a `--name` inside a :root is a declaration, and the same
 * value on `background:` anywhere else is a hardcode.
 */
const rules = css.slice(css.indexOf('*{box-sizing'))
  .replace(/:root[^{]*\{[^}]*\}/g, '');

/* ---------- 1. the two forms of a brand colour must agree ---------- */
const BRANDS = [
  { hex: '--accent', rgb: '--accent-rgb' },
  { hex: '--crown', rgb: '--crown-rgb' },
  { hex: '--danger', rgb: '--danger-rgb' },
];

const hexOf = (channels) => '#' + channels.trim().split(/\s+/)
  .map((n) => Number(n).toString(16).padStart(2, '0')).join('');

for (const b of BRANDS) {
  const chan = new RegExp(`${b.rgb}\\s*:\\s*([0-9 ]+);`).exec(tokenBlock);
  a.ok(chan, `${b.rgb} must be declared — it is what every alpha use reads`);
  const hex = new RegExp(`${b.hex}\\s*:\\s*(#[0-9a-f]{6})\\s*;`).exec(tokenBlock);
  a.ok(hex, `${b.hex} must be declared for solid fills`);
  a.equal(hex[1], hexOf(chan[1]),
    `${b.hex} and ${b.rgb} are one colour in two forms and must hold the same value — `
    + 'when they drift, a fill and its own glow are two different colours');
}

/* ---------- 2. no colour is written where a palette change cannot find it -- */
// The check that actually holds the line. Everything after :root must reach a
// colour through a variable. A literal looks correct the day it is written and
// silently stops following the palette forever after.
const strayHex = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
  .map((m) => m[0])
  // #fff on --danger is contrast, not palette: it must stay white whatever the
  // red becomes, and naming it would invite somebody to tune it.
  .filter((h) => h.toLowerCase() !== '#fff');
a.deepEqual(strayHex, [],
  `a colour outside :root must come from a token, found: ${strayHex.join(', ')}. `
  + 'This is the check the summon button gradient would have failed.');

const strayRgb = [...rules.matchAll(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g)].map((m) => m[0]);
// Neutral blacks and whites at an alpha are shading, not palette: a shadow is
// black in every theme, and naming forty of them buys nothing.
const coloured = strayRgb.filter((v) => {
  const [r, g, b] = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v).slice(1).map(Number);
  return !(r === g && g === b);
});
a.deepEqual(coloured, [],
  `a coloured rgb() outside :root must come from a token, found: ${coloured.join(', ')}`);

/* ---------- 3. and the renderer obeys the same rule ---------- */
// Two animations held the accent as a string: the rail's arrival flash and
// feel.js's pulse ring. They are the loudest uses of the colour in the app and
// were the last two a palette change could not reach.
for (const f of readdirSync(UI).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(join(UI, f), 'utf8');
  const hits = [...src.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)]
    .filter((m) => !(m[1] === m[2] && m[2] === m[3])).map((m) => m[0]);
  a.deepEqual(hits, [],
    `${f} must not carry a coloured rgb() — read it with brand() from feel.js. Found: ${hits.join(', ')}`);
}

/* ---------- 4. the material is variables, not overrides ---------- */
// Solid is the default and glass is a mode. The rule that makes that possible
// is that a material change redeclares ONLY these variables — the five stacked
// REFIT blocks this file used to end with lost precisely because they
// re-declared .win, #bg and :root instead, and nothing could be changed by
// reading it.
const MATERIAL = ['--glass', '--glass-strong', '--frost', '--edge', '--sheen', '--lift'];
const glassBlock = /:root\[data-material="glass"\]\s*\{([^}]*)\}/.exec(css);
a.ok(glassBlock, 'the glass material must exist — the old room is a mode, not deleted work');

for (const t of MATERIAL) {
  a.ok(new RegExp(`${t}\\s*:`).test(tokenBlock), `${t} must have a default in :root`);
  a.ok(new RegExp(`${t}\\s*:`).test(glassBlock[1]), `${t} must be answered by the glass material too`);
}
a.equal(/--frost\s*:\s*none/.test(tokenBlock), true,
  'the DEFAULT material must be solid: no frost. Separation comes from value and spacing, '
  + 'and a pane over a flat ground wears a blur it cannot show.');
a.equal(/--frost\s*:\s*blur/.test(glassBlock[1]), true, 'and glass must restore the blur');

// Nothing but variables in there: a selector inside would be an override block
// by another name, and this file has been down that road.
a.equal(/[^-\s{][^:]*\{/.test(glassBlock[1]), false,
  'the glass block must declare variables only — a rule inside it is a REFIT block reborn');

/* ---------- 5. brand() hands the animations a colour, not a var() ---------- */
// Deliberately NOT `rgb(var(--accent-rgb) / a)`: a keyframe holding a custom
// property comes back from getKeyframes() unparsed where a literal comes back
// normalised — measured — and whether it still interpolates or degrades to a
// discrete jump was not something worth taking on faith for a 900ms fade.
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => ' 224 228 234 ' });
const { brand } = await import('../ui/feel.js');

a.equal(brand('--accent-rgb', .22), 'rgb(224 228 234 / 0.22)',
  'brand() must hand back a plain colour the browser can interpolate');
a.equal(/var\(/.test(brand('--accent-rgb', .5)), false,
  'if a var() survives into a keyframe, resolving it was pointless');

console.log('t-theme.js OK — a palette change reaches every colour, and the material is one block');
