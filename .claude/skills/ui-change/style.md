# The stylesheet contract

Companion to [SKILL.md](SKILL.md). Values live in `ui/app.css` and are pinned in
`test/t-theme.js`; read them there. This file holds the rules and reasons those
files do not state.

## The rules, and who owns them

HANDOFF.md operating rule 6 owns where a rule goes and where colour may live.
Read it there. What follows is only what makes those rules actionable and is
written nowhere else.

- The ban on override blocks exists because an appended block turns one
  stylesheet into two that disagree. Edit at the declaration.
- Every colour token carries an `-rgb` channel twin, because alpha is expressed
  as `rgb(var(--text-rgb) / 0.6)` and a hex token cannot supply it. A new token
  needs both halves or the twin is missing exactly when someone needs alpha.
- `test/t-theme.js` is what catches a violation: it scans for stray hex literals
  and for coloured `rgb()` calls that did not come from a channel token.

## Which system this is

The T3 Code canvas ("Agentic OS - T3 Code style"), adopted at the user's
direction on 2026-10-21. It **reverses** the Cold-Call Workflow paper theme of
2026-09-21, which had itself reversed Hiveory on 2026-09-17. PLAN.md section 1
keeps the two earlier specs and its last section is the contract for this one.
Dark, neutral and flat; no glass, grain or wash.

Read the values from `ui/app.css`'s `:root` comment and the pins in
`test/t-theme.js`. This file deliberately names none of them, because a cached
palette is exactly what went stale each time the system reversed.

One trap, from HANDOFF.md: **the canvas fails this app's own rules in places,
and the rule wins.** Its metadata grey is under 4.5:1 on the ground the rail and
every section sit on, so `--faint` is lighter than the canvas ships. Sizes, by
the user's call on 2026-10-21, are the canvas's own: 32px rows and controls
(`--tap-target-min`), 28px chips (`--chip-h`). The suite fails if `--faint` is
"restored" to the canvas value. Compute contrast, do not quote it (HANDOFF.md
operating rule 2), and measure it on the ground the text actually sits on.

## Status vocabulary

Four tones, and only four: `live`, `settled`, `attention`, `idle`. They are
resolved by `tone()` in `ui/views/util.js`, not by each view inventing a
mapping. PLAN.md section 2 existed because five private vocabularies had grown
in parallel; Approvals was the last one folded in.

A new status string joins a tone set in `util.js`. It does not get a new colour.

## Type and motion

Inter and JetBrains Mono are bundled in `ui/fonts` and loaded same-origin, so
there is no network fetch to fail in an offline Electron window; the stylesheet
may not `@import` or name a remote URL. The daemon must serve a font with a font
MIME type or Chromium drops it silently (`test/t-assets.js`). Motion honours
reduced motion.

## Scale

12px card, 6px control, pill only for the status badge and the segmented
control. Metadata (eyebrows, board names, table heads, form labels) is 11px,
tracked, uppercase in the UI face; mono is for code, diff and log content.
Status is a dot plus a label. The one primary action is the white fill, not the
accent, which is reserved for live work, links and focus.
