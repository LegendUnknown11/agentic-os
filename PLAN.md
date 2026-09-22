# Rebuild the Agentic OS interface around the run

## Status — closed 2026-09-21

Every section below is implemented on `main`. The contract stays here in full
because it is the record of what was agreed and why, not a checklist to work
from. What closed each one:

| Section | Closed by |
|---|---|
| 1. One design system | `c4c6573` (Hiveory tokens in full), `9524d3f` (dot-and-glow status cue), `b67ed9e` (the header's awake-count label) |
| 2. One status vocabulary | `tone()` in `ui/views/util.js`; the last private vocabulary, Approvals, folded in by `b310960` |
| 3. Rebuild the shell | Header carries repository, branch, objective, mode with its permissions, and connection; the rail is down to two lists; mode has one home |
| 4. Overview as mission control | `ui/views/home.js` ranks by urgency at render time and leads with the run, or the next-step surface when there is none |
| 5. Rebuild the views | `b310960`; `ui/thread.js`, `ui/views/settings.js` and `ui/views/automations.js` were verified against the system and needed no change |

**Acceptance met 2026-09-21, and it cost eight defects.** The clause below was
satisfied in one live session against a demo court on `127.0.0.1:7788`, driven
first in a real browser and then confirmed in the Electron shell
(`navigator.userAgent` contains "Electron"). Every item in the clause was
demonstrated by clicking the interface's own controls, not by writing state
behind it:

| Clause item | What was done |
|---|---|
| A run through its lifecycle | planning → running → paused → running → verifying → ready_for_review, each transition from the run panel |
| A blocked run's recovery | blocked with a visible blocker, then recovered and carried on to verifying |
| The final-review gate | Apply disabled until "Approve final review"; then Apply refused by the baseline guard with a visible danger message, which is the guard working |
| The collapsed rail's controls | 64px rail, expand affordance, drawn `.hover-tip` (not native `title`) |
| The drawer at 720px with its keyboard path | drawer open, main `inert`, scrim, real Tab focus trap wrapping to "+ New" without escaping, Escape returning focus to the Menu button |
| Reduced-motion behaviour | at `reduce`, every animation `none` and transitions `0.001s`; at `no-preference`, `.status-dot.live` pulsing at 1.6s |

Running it also exposed eight layout defects that 73 passing suites could not
see — six of them one root cause, a grid handing its free height to every row it
created. Fixed in `fix/live-layout-defects`; `test/t-theme.js` and
`test/t-pages.js` now pin each one.

This is Electron and browser evidence. It is not device, signing, provider, or
human-acceptance evidence.

## Goal and boundaries

The daemon's spine is the run: a durable record moving through `planning`,
`running`, `verifying`, `ready_for_review`, and `completed`, carrying recovery
history and revision-bound evidence. The interface has not followed. Make the run
the primary surface, give every state one visual vocabulary, and put the visual
system on the design language shared with the sovereign's other builds.

- Rebuild all fourteen views, the shell, and the design system. This supersedes
  the previous contract's deferral of a visual redesign.
- Keep the framework-free renderer, one shared stream and poll lifecycle, direct
  MCP member-to-member messaging, and role and mode filtering.
- Keep every behavioural guard the suite already holds: stale-response tokens,
  loading against error against empty, retry paths, accessible names, and cleanup
  on unmount. This work changes presentation, not behaviour.
- Mode stays global state with the three existing backend ids. Making mode a
  property of a conversation or run is a daemon change and is out of scope.
- Defer hosted services, roster changes, and new product capability.

## The defects this answers

Each was read directly in the source, not inferred.

1. The run renders as one `.run-summary` card inside Overview's auto-fit grid
   plus fragments in thread and Changes. No test covers any `.run-*` class.
2. `ui/views/home.js` appends up to eight conditional cards in fixed source
   order, so a blocked run can land below "Current mode". `.home-next-step`
   exists in `ui/app.css` and nothing renders it.
3. The 260px rail stacks three unrelated lists — navigation, conversations, and
   team — split by `max-height: 34%` and `flex: 1`, each with its own scrollbar.
4. Mode occupies a header control, a drawer section, and Overview's largest card,
   and choosing Chat is secretly a navigation action.
5. Five encodings of "how is this going" coexist: `.status-dot`, `statusLabel()`,
   `.run-badge`, `.task-row b`, `.doctor-row`, `.merge-result`, `.activity-row`.

## 1. Establish one design system

**Superseded 2026-09-17.** The prototype-derived "paper and ink" system above is
retired. The sovereign asked for Hiveory's (github.com/raktim-yoddha/hiveory)
actual visual language adopted in full, not as loose inspiration — its literal
values, read from its shipped `app.css`, not a paraphrase. This app keeps its
own token architecture (`:root`, `-rgb` twins, no literal colour outside
`:root` — that discipline is this app's, not Hiveory's, and survives the swap);
only the values and a few structural rules change.

- **Dark only.** Hiveory ships no light theme (`color-scheme: dark`, hard-set).
  Drop this app's light/dark toggle and its `--dark-*` prefix convention; the
  one ground becomes the token set itself. Existing `--dark-*` values are the
  ones to keep (closest ancestry to the new palette); the light `--paper`
  family is deleted, not backfilled.
- **Ground ladder** (from Hiveory's `app.css`, chosen per surface depth):
  `--bg: #111418` (shell/base), `--bg-alt: #0f141a` (code/runs surfaces),
  `--surface: #14181d`/`#15191e`/`#181c21` (panels, picked per view — these
  are siblings, not a strict ladder, in the source), `--raised: #181d23`.
  Record measured contrast beside each text-on-ground pairing, same discipline
  as before.
- **Text**: `--text: #f5f7fa`, `--muted: #aeb8c5`, `--faint: #758192`.
- **Lines**: `--line: #272d35` (titlebar/rail dividers), `--line-soft: #29323c`
  (panel borders) — both hairline, both real values from the source, not
  invented shades between them.
- **Accent** (brand + primary interactive, one hue doing both jobs in the
  source, so it does here too): `--accent: #2b5f96` fill, `--accent-border:
  #4a6d98`, `--accent-hover: #3675b7`. Accent text-on-fill is `#f7fbff`.
- **Status hues — four, genuinely distinct, not one hue split by chroma**:
  running `#48a7ed` (blue), completed `#45c47b` (green), failed/cancelled
  `#d46d77` (red), blocked/interrupted `#d2a05f` (amber). This replaces the old
  "accent and settled share a hue" rule — Hiveory separates them by hue
  outright, and adopting its system means adopting that choice too.
- **Shape — pills are back.** The old "no pills" rule is dropped; Hiveory pills
  every status chip, count badge, and tag (`border-radius: 99px`). Controls
  (buttons, inputs) take 6px; cards and panels take 10px. Icon-only buttons
  stay tighter at 4px. These are the modal values from the source's own
  distribution, not an average.
- **Status reads through a dot, not a left rule.** Replace the hairline-plus-
  3px-left-rule convention with Hiveory's: a small filled circle (7px, status
  colour) plus, only on the currently-active state, a soft glow —
  `box-shadow: 0 0 0 4px rgb(var(--x-rgb) / .13)` — animated at a slow pulse
  (`1.5-1.7s ease-in-out infinite`) for anything actually in progress, static
  for settled states. The status label itself still carries colour and text;
  the dot adds geometry, it doesn't replace the label.
- **Labels are not mono-uppercase-tracked by default.** That was this app's
  own prior convention, not Hiveory's — Hiveory uses its regular sans for
  every label except small section/rail headings, which alone stay uppercase
  and tracked (`font-size: 11px; font-weight: 700; letter-spacing: .08em;`).
  Reserve mono for what Hiveory reserves it for: code, terminal, diff, and log
  content, never for ordinary UI metadata.
- **Typography stays local-stack, per the existing offline-Electron
  constraint** — that constraint is a fact about this app's runtime, not a
  Hiveory-vs-not-Hiveory choice, and doesn't change. Hiveory's real font is
  "IBM Plex Sans" (with Inter, system-ui as its own fallbacks); since a
  webfont fetch can silently fail here, take a local sans stack
  (`-apple-system, "Segoe UI", Roboto, system-ui, sans-serif`) as the visual
  equivalent rather than shipping the actual webfont. Mono stays whatever
  local mono stack this app already uses; Hiveory's real choice there
  (JetBrains Mono) is webfont-only same as Plex, same reasoning applies.
- **Shadow and motion**: flat and hairline-bordered by default — Hiveory does
  not layer ambient shadow on ordinary cards. Reserve elevation shadow
  (`0 10px 26px rgb(0 0 0 / .16)`) for genuinely floating elements (a
  composer, a popover), not cards at rest. A subtle radial gradient
  (`radial-gradient(circle at 52% -20%, [surface-lifted] 0, [bg] 42%)`) may
  wash large panel backgrounds, same as the source, but never text-bearing
  content directly. Hover/press transitions run at `0.15s ease` — the old
  single custom easing curve is dropped in favour of the source's plain
  `ease`, since matching Hiveory means matching its actual timing function,
  not preserving this app's prior one under a new name.
- **Gold still identifies the orchestrator and never encodes a status** — this
  rule is this app's own and orthogonal to Hiveory's palette (Hiveory has no
  orchestrator-identity convention to borrow), so it survives unchanged;
  reintroduce it against the new dark ground with fresh measured contrast.
- **44px minimum tap target, enforced rather than suggested** — also this
  app's own rule, not sourced from Hiveory either way; keep it.
- Every colour still needs an `-rgb` channel twin; the suite still forbids
  literal colour outside `:root`. This is this app's discipline, unaffected by
  which design system supplies the values.

## 2. Give status one vocabulary

- Add one tone primitive beside the existing `page`, `section`, `field`, and
  `button` helpers in `ui/views/util.js`, mapping every domain state — run
  status, task state, member state, doctor check, merge result, activity kind —
  onto four tones: live, attention, settled, idle.
- Feed it from the existing `statusLabel()` and `displayStatus()`. Do not fork
  them; the suite already requires Agents and the rail to share one classifier.
- Every view then inherits one vocabulary instead of five.

## 3. Rebuild the shell

- The header becomes one line that earns its height: repository and branch, then
  the objective given real width rather than a 12px line truncated at 52ch, then
  mode, then connection.
- Mode gets exactly one home, showing the label and what it permits — crew,
  worktrees, merge, tasks — read from the flags already in `src/modes.js`. The
  drawer shows that same control. Overview stops carrying a mode card.
- The rail drops from three lists to two. Team moves out: member status is entity
  state, not navigation, and belongs where work is being watched.
- Keep the collapsed 64px rail and the measurement recorded in its comment, the
  720/721px breakpoint split, the drawer focus trap, and `inert` on the covered
  workspace.

## 4. Make Overview a mission control

Order the surface by urgency, computed at render time rather than fixed in source
order: the run first, then one ranked list merging pending approvals with blocked
tasks and failed members, then the queue, then team activity, then changes ready,
then ambient objective and spend. With no active run, render the next-step surface
as the lead.

The run panel presents its state on the lifecycle spine with objective, progress,
blockers, recovery history, evidence, and the final-review gate.

## 5. Rebuild the views

The views compose roughly twelve shared primitives rather than carrying their own
styling, so most inherit the system with no edit. Doctor, Memory, Notes, Messages,
Usage, and Objective inherit and are verified. Activity, Approvals, Changes, and
Agents re-compose against the tone primitive. Thread, Settings, and Automations
take a structural pass.

Thread keeps its exact test hooks — the composer, input, skill menu, and the
question, action, and approval data attributes — because the suite mounts it
against a hand-rolled fake DOM that resolves those selectors literally.

## Tests and success criteria

- Rewrite `test/t-theme.js`. Keep its mechanism: the token block regex, the ban on
  literal colours outside `:root`, the reduced-motion rule, the focus-ring
  selector list, and the guard against a second styling vocabulary. Re-point its
  pinned values and selectors, and add the `.run-*` classes it has never covered.
- Re-point only the layout-anchored assertions in `test/t-pages.js`. Its
  behavioural assertions are regression guards and survive untouched.
- Add `ui/run.js` to the runner. It carries a self-check that `npm test` does not
  execute, and its surface becomes the product's lead.
- Every behaviour change extends its owning suite, and a test must fail without
  its fix. Run the complete no-quota suite to its terminal summary before
  committing.
- Source evidence is not acceptance. The redesign is accepted only after a visible
  Electron session demonstrates a run through its lifecycle, a blocked run's
  recovery, the collapsed rail's controls, the drawer at 720px with its keyboard
  path, and reduced-motion behaviour.

## Carried forward from the previous contract

The run system described in the previous `PLAN.md` is implemented and merged; its
text remains in Git history. Two of its obligations are still open and are
restated in `HANDOFF.md`: the Habitable pilot has not begun, and live
subscription-pool behaviour without paid API fallback is unproven.
