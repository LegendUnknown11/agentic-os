# The stylesheet contract

Companion to [SKILL.md](SKILL.md). Values live in `ui/app.css` and are pinned in
`test/t-theme.js`; read them there. This file holds the rules and reasons those
files do not state.

## Where a rule goes

Edit each selector **at its declaration**. Appending an override block at the
bottom of the file is how a stylesheet becomes two stylesheets that disagree,
and it is explicitly banned by HANDOFF.md operating rule 6.

## Colour

- Only the `:root` token block holds a colour. Nothing else, ever.
- Every colour token carries an `-rgb` channel twin (`--text` and
  `--text-rgb: 245 247 250`). Alpha is expressed as
  `rgb(var(--text-rgb) / 0.6)`, which is why the twin exists.
- `test/t-theme.js` scans for stray hex literals and for coloured `rgb()` calls
  that did not come from a channel token. Both fail the suite.
- Gold identifies the orchestrator and nothing else.

## Where the palette came from

Hiveory (github.com/raktim-yoddha/hiveory), adopted in full per PLAN.md
section 1, from literal values in its shipped `app.css`. It is dark-only, so
there is no light theme and no dark-prefixed token convention. Contrast ratios
for the whole palette were measured 2026-09-18 and are recorded in the comment
at the top of `ui/app.css`. A new colour pair needs its own measurement written
beside it — HANDOFF.md operating rule 2, measure before changing a threshold.

## Status vocabulary

Four tones, and only four: `live`, `settled`, `attention`, `idle`. They are
resolved by `tone()` in `ui/views/util.js`, not by each view inventing a
mapping. PLAN.md section 2 existed because five private vocabularies had grown
in parallel; Approvals was the last one folded in.

A new status string joins a tone set in `util.js`. It does not get a new colour.

## Type and motion

Local font stacks only. This is an offline Electron app, where a webfont fetch
can fail silently, so Hiveory's IBM Plex Sans and JetBrains Mono are
approximated locally rather than shipped.

`--ease` is plain `ease` and `--fast` is `150ms`. Respect reduced motion.

## Things that stay removed

The drawn hall and the avatars were removed deliberately. So was the
light/dark toggle. Keep the `#bg` wash.
