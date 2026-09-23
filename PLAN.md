# Rebuild the Agentic OS interface around the run

## Status — closed 2026-09-21

Every section below is implemented on `main`. The contract stays here in full
because it is the record of what was agreed and why, not a checklist to work
from. What closed each one:

| Section | Closed by |
|---|---|
| 1. One design system | Reversed to the Cold-Call Workflow kit 2026-09-21 at the sovereign's direction — see section 1. The Hiveory work it replaced was `c4c6573`, `9524d3f`, `b67ed9e`. |
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

**Re-walked 2026-09-21 on the redesign**, because a palette swap is not a
behaviour change but the layout under it moved. The same live pass found five
more defects, none of them visible to the 73 suites: twenty-eight text-on-
ground pairings under 4.5:1 (the kit publishes its ratios against the wrong
one of its own two papers); `.conversation-open` at 210x24 and `.sidebar-repo`
at 227x27 against an enforced 44px; the collapsed rail's nav buttons at 34x44
inside a 16px inset; the 720px drawer's mode section reporting 287x0 while its
pills painted straight through the Overview row; and that same drawer running
122px past the viewport, squashing the conversation list to nothing so there
was no way to reach a conversation at all. All fixed at their declarations and
pinned in `test/t-theme.js`. Re-verified live afterwards: a 14-view audit
returns clean at 1440x900, the collapsed rail is 47x44 throughout, the drawer's
keyboard path still traps Tab across 26 presses and returns focus to Menu on
Escape, and reduced motion holds at both `reduce` (every animation `none`,
transitions `0.001s`) and `no-preference` (`0.15s`).

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

**Reversed 2026-09-21.** The sovereign supplied `Prototype.zip` — the
Cold-Call Workflow kit, the same prototype-derived "paper and ink" source this
section retired four days earlier — and asked for the app redesigned on it
outright. That instruction supersedes the Hiveory adoption spelled out below,
which stays in place as the record of what was agreed on 2026-09-17 and is no
longer what the app implements. The reversal is written down rather than made
quietly, and `ui/app.css`'s `:root` comment says the same thing at the code.

What the app runs now, read from the kit's own `tokens/*.css` and its three
shipped client builds rather than paraphrased:

- **Light, not dark.** `color-scheme: light`. Three grounds and no ladder:
  `--bg: #f7f1e7` (page), `--surface: #ebe1d2` (rail, sections, meter tracks,
  code), `--raised: #fffdf9` (the panel a card is drawn on).
- **Text two values, not three.** `--text: #17332f`; `--muted` and `--faint`
  are both `#55635e`. Metadata separates from body copy by type treatment, not
  by a third grey.
- **One hairline**, `--line: #cec7ba`. **One accent**, teal `#0d6663`, carrying
  brand and primary interactive together; the kit calls swapping that single
  value the whole reskin.
- **Two status hue families against four tones.** Live and settled share teal
  and separate by depth plus the pulse; attention is `#9e4239`; idle is
  ink-soft, because in this system waiting is not a colour. A run in flight and
  a finished one are harder to tell apart here than under the retired palette —
  that is the cost, stated rather than papered over, and the dot and the label
  carry the difference.
- **The product scale, not the marketing one.** This is a dense tool: 16px
  card, 12px control, **no pill buttons** except where the kit itself pills —
  the status badge and the segmented control. Spacing is the kit's own
  4/8/16/24/32/48/64/88.
- **Metadata is mono, uppercase and tracked.** This inverts the Hiveory rule
  below. It is the one convention all three of the kit's client sources share
  exactly, and it is how `.card-meta`, `.message-meta`, `.metric-label`,
  `.field-label`, `.data-table th` and the rail headings read now.
- **Paper grain**, the kit's CSS dot technique, over its tiled photograph:
  it ships no binary into an offline Electron bundle and tokenises without
  putting a literal colour outside `:root`.

Unchanged, because they are this app's rules and not any design system's:
local-stack type (an offline Electron webfont fetch fails silently), the `-rgb`
channel twin on every colour, no literal colour outside `:root`, gold for the
orchestrator alone and never for status, and 44px enforced rather than
suggested.

Two departures from the kit's published numbers, both found by measuring and
both pinned in `test/t-theme.js` so nobody "restores" them: the kit quotes
every contrast ratio against `--paper` and never against `--paper-deep`, which
is the ground under the rail and every section here, so `--muted`/`--faint`
went `#5c6c66` → `#55635e` and `--tone-attention` went `#af4a3f` → `#9e4239`
to clear 4.5:1 on that ground. And the kit's contrast card claims 12.1:1 for
ink on paper; its other five figures reproduce exactly and that one gives
9.6:1, so the code records the number computed.

### The 2026-09-17 Hiveory adoption, kept as record

Everything from here to the end of this section is what was agreed on
2026-09-17 and is no longer what the app implements. It read, in full:

The sovereign asked for Hiveory's (github.com/raktim-yoddha/hiveory)
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

## Functional revamp — multiple courts and pilot readiness (2026-09-23)

Two independent pieces of work, landed on `functional-revamp`. Neither touches
the interface contract in sections 1-5 above.

### A. Multiple courts at once (closes GitHub issue #42)

**Contract.** One daemon process per repository, each on its own port, tracked
in a shared registry at `~/.kingdom/courts.json` (`src/courts.js`) alongside the
existing `tokens.json` convention. A daemon refuses to start for a repository
that already has a live court and names the port it is on; a busy pinned port
(`--port` or `KINGDOM_PORT`) is a clean, visible error, never a silent
rebind. With neither given, the port is picked automatically starting at 7777.
`app.requestSingleInstanceLock()` means a second launch focuses or opens the
right court instead of starting a stray daemon. Settings' Repository panel
gains a switcher — list running courts, open one, start a court for another
repository, end one with confirmation — reachable without ending the current
court, and "End court and switch…" is no longer gated behind attachRepo's
failure (the fail-first dance issue #42 complained about is gone; attachRepo's
own refusal to move a live court onto a different repo, `src/kingdom.js`, is
unchanged and still correct).

**This reverses the 2026-09-22 decision** recorded in the previous revision of
`HANDOFF.md`, where the sovereign declined multiple courts for that round
("Not even using it"). The sovereign asked for it explicitly on 2026-09-23.

**What closed it.**

| Piece | File |
|---|---|
| Registry core: register/list/prune/pick-port, lockfile + atomic write | `src/courts.js` |
| Daemon wiring: auto/pinned port, conflict refusal, register/unregister | `src/daemon.js` |
| Live-attach registry claim (POST /api/attachRepo, saved-repo re-attach) | `src/daemon.js` |
| Launch routing (single-instance, focus-vs-start), pure and fakeable | `electron/courts-launch.js` |
| Electron: single-instance lock, per-port windows, courts IPC | `electron/main.js`, `electron/court-preload.cjs` |
| Switcher UI, degrades visibly outside Electron | `ui/views/courts.js`, `ui/views/settings.js` |

**Review fix (2026-09-23, post-implementation): live attach bypassed the
registry.** `registerCourt` ran once, at listen time, with the boot-time repo —
a repo-less daemon that later got a LIVE attach (`POST /api/attachRepo`, or the
saved-repo re-attach at boot) never updated or conflict-checked the registry.
That let two daemons end up serving the SAME repository with no refusal, and
left the registry showing `repo: null` for a court that had since attached
one. Fixed: the attach handler now claims the repo in the registry (under its
lock, via the same `registerCourt`) BEFORE `kingdom.attachRepo` does any real
work, refuses with the other court's port on conflict, and rolls back the
claim if the attach itself then fails for an unrelated reason. Covered by
`test/t-registry-attach.js` (two real daemons, confirmed to fail without the
fix).

**Acceptance evidence.**
- Source: `test/t-courts.js` (registry unit behaviour), `test/t-multi-court.js`
  (two real daemon processes, real conflict/port-busy refusals),
  `test/t-courts-launch.js` (launch-routing decisions, fakes),
  `test/t-registry-attach.js` (live-attach registry claim, above), plus
  `test/t-pages.js` updates pinning the new Settings source. Suite count: see
  `HANDOFF.md`'s Evidence section for the number printed this round.
- Browser: the Settings > Repository panel was driven in a real Chromium tab
  (Playwright, throwaway repo on port 7823) and confirmed to render the courts
  switcher with no fail-first gating, and to degrade to a plain note (no
  destructive controls) when `window.kingdomShell` is absent — i.e. a plain
  browser tab, not Electron.
- **Not held**: Electron itself (the single-instance lock, multi-window
  behaviour, the native confirmation dialogs, media-permission scoping per
  window) was never run — this environment cannot launch Electron. Windows
  behaviour (the platform every real user runs on) is likewise unverified here.
  Both are real acceptance work still owed before this ships to the sovereign.
- **Test-gate hygiene (2026-09-23, post-implementation)**: several suites that
  spawn a real daemon were found to register into the REAL
  `~/.kingdom/courts.json` on whatever machine runs `npm test`, which on the
  sovereign's machine would mutate their live registry. Fixed at the test
  runner: every suite now gets its own isolated registry file
  (`test/run-all.js`, `test/isolate-registry.js`); `test/t-registry-isolation.js`
  guards it end to end. See `HANDOFF.md` for the mechanism.

### B. Habitable pilot readiness (source-side only)

Machinery for HANDOFF.md's "Habitable pilot" steps 2 and 4, built and tested
without the real Habitable checkout and without Flutter installed anywhere in
this environment — by design; `src/pilot-doctor.js` and `src/pilot-evidence.js`
never read, run against, or reference `E:\AI\Mobile Apps\Habitable` by path.

- `src/pilot-doctor.js`: doctor-style detection of flutter/dart/adb, the
  Android SDK path, and configured emulator AVDs, same `{checks, failures,
  ready}` shape as `src/doctor.js`. flutter/dart/adb are hard blockers; the SDK
  path and an AVD are visible warnings, since a debug build needs neither.
- `src/pilot-evidence.js`: `runPilotEvidenceGate(dir)` runs `flutter analyze`,
  `flutter test --coverage`, and `flutter build apk --debug`, each step's
  result recorded independently so one failing step never hides or stops the
  others. Missing tooling is a single visible blocker raised before any step
  runs. A non-Flutter target is reported as nothing-to-gate, not a failure.
- `src/evidence.js` gained an optional `pilot.json` section, written only when
  a caller passes a `pilotEvidence` result — `src/evidence.js` itself stays
  decoupled from Flutter entirely.

**Acceptance evidence.** Source only: `test/t-pilot-doctor.js` and
`test/t-pilot-evidence.js`, both fakes-only, plus `test/t-evidence.js`'s new
pilot-section cases. **Not held**: any run against real Flutter tooling or the
real Habitable checkout — that is explicitly out of scope for this round and
remains gated on HANDOFF.md's step 3 (demonstrate, audit, get a backlog
approved) before implementation on Habitable itself can start.
