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

The Cold-Call Workflow kit, adopted in full at the sovereign's direction on
2026-09-21. It **reverses** PLAN.md section 1, which had retired that same
source on 2026-09-17 in favour of Hiveory. Hiveory's spec stays in PLAN.md as
the record of what was agreed then; it is not what the app implements. Paper,
not a dark shell.

Read the values from `ui/app.css`'s `:root` comment and the pins in
`test/t-theme.js`. This file deliberately names none of them, because a cached
palette is exactly what went stale when the system reversed.

Two traps that neither file shouts, both from HANDOFF.md:

- **The kit's own contrast figures are measured against `--paper`**, and this
  app's rail and every section sit on `--paper-deep`. Two tokens are
  deliberately darker than the kit ships so they clear 4.5:1 on the ground they
  actually sit on. The suite fails if either is "restored" to the kit value, so
  a well-meaning correction toward the source is a regression here.
- **One of the kit's published ratios does not reproduce.** Its contrast card
  claims 12.1:1 for ink on paper; `ui/app.css` records the number computed
  instead. Five of its six figures reproduce exactly and that one does not.
  Compute, do not quote — HANDOFF.md operating rule 2.

## Status vocabulary

Four tones, and only four: `live`, `settled`, `attention`, `idle`. They are
resolved by `tone()` in `ui/views/util.js`, not by each view inventing a
mapping. PLAN.md section 2 existed because five private vocabularies had grown
in parallel; Approvals was the last one folded in.

A new status string joins a tone set in `util.js`. It does not get a new colour.

## Type and motion

Local font stacks only. This is an offline Electron app where a webfont fetch
can fail silently, so the kit's faces are taken at their own declared fallbacks
rather than shipped. Motion honours reduced motion, which the 2026-09-21 live
session verified at both `reduce` and `no-preference`.

## Scale

The kit ships two scales and this app takes the **product** one, not the
marketing one: it is a dense tool, not a landing page. Pills survive only where
the kit itself pills. Marketing supplies display type and the mono, uppercase,
tracked metadata label, which is the one convention all three of the kit's
source builds share exactly — and the exact inverse of the Hiveory rule it
replaced.
