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

**Reversed again 2026-10-21** to the dark T3 Code system; see the section at the end of this file. What follows is the record of the two earlier systems, neither of which the app implements now.

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

## UI revamp — paper with glass (2026-09-23)

Scope: issue #39 ("Ugly UI," no screenshot — worked from a live audit, not a
description) and the surviving part of #48 (Hiveory). #48 itself is
superseded by the paper kit adopted 2026-09-21; the glass/translucent feel it
asked for is adopted within that paper system rather than swapping the
palette for Hiveory's dark one.

**Method**: started a demo court (`node src/daemon.js <throwaway-repo>
--port 7811`), drove it with Playwright/Chromium, screenshotted all 14 views
at 1440x900 and 720x900 before and after. Findings are in
`/home/user/wt-ui-shots/AUDIT.md` (outside the repo, per the session's
instructions) — summarised here because that file lives outside version
control.

**Finding**: the interface was already close to this section's own prior
"Status — closed 2026-09-21" claim. No layout defect from the prior
`align-content: start` free-height-leak class recurred; every `auto-fit`
card grid sits inside an already-`start`-pinned parent. The one concrete gap,
read directly rather than assumed: `--shell-alpha`/`--surface-alpha` existed
but were 1 (opaque) by default and only left their default for the optional
user-wallpaper feature, so the interface most people see had no
translucency or blur anywhere the sovereign's direction named.

**What shipped**: a translucent, blurred glass on `#header`, `#sidebar`
(rail and the 720px drawer), `#composer`, `.hover-tip`, and the drawer scrim.
Two new tokens, `--glass-chrome-alpha: .90` (for the `--raised`-based header
and hover-tip) and `--glass-panel-alpha: .97` (for the `--surface`-based
sidebar and composer, whose opaque `--muted` budget was already the
system's tightest at 4.87:1), drive `rgb(var(--x-rgb) / alpha)` backgrounds
plus `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`.
Both alphas are chosen against the worst ground this app can ever put behind
glass — a fully black wallpaper image, not the paper default — so every text
pairing still clears 4.5:1 there (`--muted` 4.72:1 at .90, 4.57:1 at .97;
the arithmetic is recorded beside the tokens in `ui/app.css`). An
`@supports not (backdrop-filter: blur(1px))` fallback and a
`prefers-reduced-transparency: reduce` query both force the pre-glass opaque
paint. `.view-section` (the card primitive) never receives `backdrop-filter`
and stays flat and shadowless at rest, per this system's own shadow rule.

**Tests**: `test/t-theme.js` had carried a positive guard since 2026-09-21,
`a.equal(/backdrop-filter/i.test(css), false, ...)`, dated to when Hiveory's
dark palette was rejected wholesale. It is replaced, not weakened, with
positive assertions naming each of the five glass selectors, a negative
assertion that `.view-section` never gets glass, pins on both alpha values,
and pins on both fallbacks — recorded as an intentional presentation change
in its commit, per this repository's own rule against silently changing an
assertion.

**Acceptance evidence**: `npm test` — 77 suites, 4-wide, 36.3s, all suites
passed, no flaky retries, run after the change. `test/t-theme-geometry.js`
ran against real Chromium (not skipped) and confirmed the collapsed rail and
drawer geometry defects from 2026-09-21 have not recurred. Visual evidence:
a live Chromium session with a synthetic wallpaper set (`--wall` +
`body.has-bg`) showed the header and sidebar edge visibly blurring and
tinting from the wallpaper behind them while every text pairing on top
stayed legible, and `getComputedStyle(#header).backdropFilter` read back as
`"blur(20px) saturate(1.6)"` in that same tab — confirming the rule actually
applied, not just that its source text existed. The no-wallpaper default was
also captured and reads unchanged (flat paper), since glass has nothing to
blur without a wallpaper behind it. This is browser evidence, not Electron
or Windows evidence — neither was exercised this session.

**Superseded below**: the "Not done" conclusion above — that an empty demo
court's audit found nothing further to fix — was wrong, and is corrected in
the next section rather than edited in place, so the mistake and the
correction both stay on the record.

## UI revamp round 2 — populated-court audit and defect sweep (2026-09-23)

The round above audited an **empty** demo court: no objective, no run, no
tasks, no approvals, one conversation, no diff. That hid real defects the
same way the 2026-09-21 session's 73 green suites hid the `align-content`
grid-leak class — an empty state cannot show a rail that overflows once it
has content, a heading block whose weight only matters against a real page
below it, or a code block with nothing in it to render badly. Corrected by
seeding the same demo court with real state — an objective, a run that
travelled planning → running → blocked with recovery history plus a second,
completed run in history, five tasks across pending/claimed/done/blocked-on-
deps, three approvals (push, summon, question), twelve conversations, a
multi-turn thread with a fenced code block and a deliberately long unbroken
URL, and a real git diff (three files) from a summoned peasant's worktree —
via `/home/user/wt-ui-shots/seed.mjs`, which writes directly through
`src/bus.js` (and, for the worktree, the daemon's own `summon`/`approve` HTTP
actions) rather than approximating the app's own state shapes by hand.
Re-audited at 1440x900, 1280x720, and 720x900;
`/home/user/wt-ui-shots/populated-before/` and `populated-after/` hold the
screenshots, `/home/user/wt-ui-shots/AUDIT.md` the updated findings.

Five real defects found this way, each fixed with its own commit and a
failing-before assertion:

1. **The rail clipped under real height pressure.** At 1280x720 (and the
   enforced 900px minimum) with a populated rail (twelve conversations, More
   tools open), `#sidebar`'s sections could ask for more height than the rail
   had, and its `overflow: hidden` clipped whatever did not fit — the
   Settings/Collapse footer ran off the bottom of the viewport, Conversations
   squeezed toward one row. Fixed with a `.sidebar-scroll` region (the parts
   that can grow) wrapped by a non-scrolling header and footer, so the footer
   is a document-flow guarantee rather than a height budget it can lose.
   `test/t-theme-geometry.js` gained a real-Chromium case at 1280x720 with a
   populated fixture, confirmed failing before the fix.
2. **The page heading carried no information and the marketing scale.**
   "AGENTIC OS / WORKSPACE" repeated identically on all 14 views (a prior
   session already removed it once for the same reason and it came back), a
   48px display-face H1 (`clamp(32px, 5vw, 48px)`) although this file's own
   section 1 requires the product scale throughout. Both cost real space
   above the fold of a dense tool. Eyebrow dropped and banned a second time;
   H1 shrunk to `clamp(20px, 2.4vw, 26px)`.
3. **Glass was invisible in the state most people see.** Round 1's glass
   rules were correct but blurring a flat colour is indistinguishable from
   not blurring it, and with no wallpaper set `#bg` sits at opacity 0 and the
   paper grain beneath it is a .05-alpha dot pattern too faint to register.
   Added `--wash`, two soft radial gradients (teal- and paper-tinted, from
   existing channel colours) painted under the grain on `body` itself, so the
   chrome has real tonal variation to blur regardless of wallpaper state.
4. **A card nested inside a panel.** Models & efficiency and Notifications
   build their `section()` out of one or more bordered `.settings-group`
   fieldsets, with the outer `.view-section`'s own border sitting flush
   against the inner one and nothing of its own between them. Un-cards the
   outer wrapper only when it actually contains a `.settings-group`
   (`.settings-shell .view-section:has(> .settings-group)`), so a tab with no
   groups (Repository) is unaffected.
5. **The header's mode switcher visibly dominated the header.** Three
   two-line pills (label plus a permission blurb) pushed "Connected" out to
   the far edge looking detached — and this is the *same* defect
   `test/t-theme.js` already banned under a `.mode-option small` selector; it
   came back under `<span>` instead, which the existing test could not see.
   Each button's own `dataset.tip`/`aria-label` and the app's established
   `.hover-tip` convention already carry the description, so hiding the
   always-visible copy loses no information. The ban is widened to cover
   both tag names.

Also fixed, found on the *first*, empty-court pass but not reported then
because it was misdiagnosed mid-session as a UI bug before being traced to a
seeding mistake and correctly attributed: **fenced/inline code in thread
messages had no styling** (`<pre><code>`/`<code>` on bare browser defaults, no
wrap handling, so a long line pushed the message bubble past the thread
column). `ui/markdown.js` already emitted real `<pre><code>`; the gap was
purely that `ui/app.css` never styled it. Fixed with `.markdown pre`/`.markdown
pre code`/`.markdown code`, all token-sourced.

**Evaluated and left alone, with reasons**: Settings' tab row already scrolls
horizontally (`overflow-x: auto; flex-wrap: nowrap`) rather than wrapping at
720px — read directly, this was not a defect. Changes' diff view, checked
against a real three-file diff, already reads well (monospace, coloured
`+`/`-` lines, no overflow). Overview's "Verified deliverables" card, which
looked disproportionately tall beside "Current work" in a screenshot, measured
173px against "Current work"'s 350px in real Chromium — `align-items: start`
is doing its job; the appearance of equal height was a misreading of the
screenshot, corrected before acting on it. Further list-density work
(Work/Team/Activity/Decisions rows) and a deeper Overview/thread-composer
redesign were not undertaken in the time available; nothing in the populated
audit surfaced a concrete defect there beyond what is already fixed above.

**Acceptance evidence**: `npm test` — 77 suites, 4-wide, ~37-40s across these
commits' individual runs, all suites passed, no flaky retries, run before
every commit in this round. `test/t-theme-geometry.js` ran against real
Chromium throughout (never skipped). Visual evidence: the populated-court
screenshots above, plus a live Chromium read-back of
`getComputedStyle(#header).backdropFilter` confirming the boosted `--wash`
still renders. This is browser evidence, not Electron or Windows evidence —
neither was exercised in this round either.

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
in a shared registry at `~/.kingdom/courts.json` (`src/teams.js`) alongside the
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
own refusal to move a live court onto a different repo, `src/agenticos.js`, is
unchanged and still correct).

**This reverses the 2026-09-22 decision** recorded in the previous revision of
`HANDOFF.md`, where the sovereign declined multiple courts for that round
("Not even using it"). The sovereign asked for it explicitly on 2026-09-23.

**What closed it.**

| Piece | File |
|---|---|
| Registry core: register/list/prune/pick-port, lockfile + atomic write | `src/teams.js` |
| Daemon wiring: auto/pinned port, conflict refusal, register/unregister | `src/daemon.js` |
| Live-attach registry claim (POST /api/attachRepo, saved-repo re-attach) | `src/daemon.js` |
| Launch routing (single-instance, focus-vs-start), pure and fakeable | `electron/teams-launch.js` |
| Electron: single-instance lock, per-port windows, courts IPC | `electron/main.js`, `electron/team-preload.cjs` |
| Switcher UI, degrades visibly outside Electron | `ui/views/teams.js`, `ui/views/settings.js` |

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
- Source: `test/t-teams.js` (registry unit behaviour), `test/t-multi-team.js`
  (two real daemon processes, real conflict/port-busy refusals),
  `test/t-teams-launch.js` (launch-routing decisions, fakes),
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

## Run visibility — blocker, spend, notifications (2026-09-25)

Asked for by the sovereign on 2026-09-25 after an interview. It is three
features on `feature-implementation`, each its own commit. None of them
touches the interface contract in sections 1-5 beyond adding one section to
Usage.

**Contract.**

1. A blocked run's reason (operation and next action) is durable. A reload or
   a restarted workspace shows it, and leaving `blocked` clears it.
2. A run's spend is its own ledger, one row per priced turn while the run is
   current. `maxRunUsd` reads that ledger, so `clearSpend()` cannot disarm it.
3. Usage gains a **Run spend** section with these parts:
   - the current run (else the most recent), shown as objective and state;
   - a meter against `maxRunUsd`, or a plain note when none is set;
   - a cumulative spend line with the ceiling dashed;
   - spend and turns per member;
   - recent runs' totals.

   There is one series, so no legend box. Hover uses a drawn readout, never a
   native `title`.
4. Desktop notifications fire when a run moves into `blocked` (on by default,
   carrying the reason) or `ready_for_review` (on). A notification for
   `completed` is available but off by default. Each fires once per move, and
   a reconnect snapshot never notifies.

**What closed it.**

| Piece | Commit | Test that fails without it |
|---|---|---|
| Durable blocker | `78cd302` | `t-control.js` section 9 (survives a real restart); bus self-check |
| Spend ledger + ceiling fix + `/api/runSpend` | `6c98780` | `t-efficiency.js` (prior spend, `clearSpend`, then crossing the cap still blocks); `t-panels.js` section 6 |
| Run spend section | `e15e588` | `t-pages.js` (loader tokens, `spendGeometry`); `t-theme.js` (token strokes) |
| Run notifications | `7848e7c` | new `t-notify.js` |

**Acceptance evidence.**

- Source: 90 suites, with 89 passing in the Linux container. `t-electron.js`
  fails there for want of a display, the same as on the unchanged base.
  `t-theme-geometry.js` ran in real Chromium.
- Browser: the Run spend section was rendered by a real daemon against a seeded
  court and inspected in Chromium at 1440x900 and 720x900. The hover readout
  was exercised, no page errors occurred, and there was no horizontal overflow.
  This found three defects, all fixed before commit:
  - the round marks stretched into ellipses under the stretched viewBox;
  - the end mark was clipped at the right edge;
  - the history table was cut off in a half-width column.
- **Not held**: Electron, Windows, and a desktop notification actually shown by
  an operating system.

## Assistant features — tasks, inbox, templates, run templates (2026-09-25)

Asked for by the sovereign on 2026-09-25 ("actual functional features, like
managing your tasks, briefing your inboxes … prebuilt in"), then scoped in an
interview. All of it landed on `feature-implementation`, PR #82.

**Contract, as the sovereign chose it.**

1. **Tasks, both kinds.** The sovereign manages the team's queue from the
   interface, and keeps a list of their own. The two stay separate: nothing on
   the personal list is claimable or wakes a member. The orchestrator can read
   the personal list, and add to it only when asked.
2. **Inbox, in-app only.** It holds what is waiting on the sovereign inside the
   app: a blocked run, pending requests and questions, overdue and due-today
   personal tasks, a run ready for final review, and messages addressed to the
   sovereign. There is no email, and no mail credentials anywhere.
3. **Built-in assistants, shipped as automation templates.** "Switch on"
   installs an ordinary, editable workflow. There are five:
   - the morning inbox brief;
   - the daily team digest;
   - scheduled team work, handed to the team on a schedule (weekly
     dependency check);
   - a calendar brief, through the orchestrator's own connector;
   - GitHub triage, through the orchestrator's `gh`.
4. **Run templates.** A named objective, acceptance criteria and allowed
   models, from which a run starts. This needed a "Start a run" form, because
   nothing in the interface could start a run.
5. **Electron sections** for the four clause items that were manual-only.

**What closed it.**

| Piece | Commit | Test that fails without it |
|---|---|---|
| Team queue management + priority | `d1518b7` | new `t-task-admin.js`; `t-panels` §7; t-pages route guard |
| My tasks + orchestrator tools | `a2654ca` | bus self-check; `t-tasks` (real MCP processes); `t-panels` §8; `t-store` |
| Inbox | `afcb1f6` | new `t-inbox.js`; `t-panels` §9; `t-pages`; `t-store` |
| Templates, `digest`/`task` nodes, weekday triggers | `eb4ed5d` | workflows and graph self-checks; `t-panels` §10; `t-notify`; `t-pages` |
| Start a run + run templates | `97b3282` | `t-pages`; `t-panels` §11 |
| Electron sections 3-6, blank-blocker and focus-trap fixes | `6ed25bc` | `t-electron.js` (Windows CI); `ui/run.js` self-check; `t-pages` guard |

**Acceptance evidence.**

- **Source.** 92 suites, 91 passing in the Linux container. `t-electron.js`
  fails there for want of a display. `t-theme-geometry.js` ran in real
  Chromium. On `windows-latest` CI, head `49f81ed` passed all 92 suites.
- **Browser.** Every new view was driven in real Chromium against a real
  daemon with seeded state, at 1440x900 and at 720 wide:
  - team tasks: assigned, reprioritised, added with Enter;
  - My tasks: added, done, snoozed;
  - the Inbox: rank order, the rail count, Open links;
  - templates: installed in Cowork mode and run; the brief reached the
    Inbox; edited days and the template mark held;
  - Start a run: from Overview's next step through a saved template to a
    planning run carrying its criteria.

  This found, and the listed commits fixed:
  - `#tasks` silently rendered Overview, because the shell's route set was
    never told about the view;
  - 20px browser-default selects;
  - a daily trigger's days and a template's mark dropped on save;
  - a start-run confirmation erased by the repaint that followed;
  - blank run blockers;
  - Tab escaping the 720px drawer.
- **Electron.** Sections 3-6 were first run verbatim in Chromium and passed
  there, then passed in a real Electron window on `windows-latest` (PR #82,
  head `49f81ed`, job 107959284113).
- **Not held.**
  - A calendar or GitHub connector actually answering. Those two templates
    depend on the orchestrator's setup on the sovereign's machine.
  - A desktop notification actually shown by an operating system.
  - Any provider or model behaviour.

## T3 Code redesign (2026-10-21)

Asked for by the sovereign on 2026-10-21: implement the Claude design canvas
"Agentic OS - T3 Code style" exactly, on a `T3-code` branch, with the navigation
simplified further, and ask questions where unsure. It was scoped in an
interview before any code. It is a third reversal of section 1: the dark,
neutral T3 system replaces the Cold-Call Workflow paper theme (itself a reversal
of Hiveory), and the 2026-09-23 glass layer goes with it.

**Contract, as the sovereign chose it.**

1. **Theme.** Dark T3 replaces paper outright. Kept: 44px tap targets, an
   `-rgb` twin on every colour, no literal colour outside `:root`.
2. **Scope.** All fourteen existing views, the run thread, and a session
   inspector fed only from state the daemon already streams. Not built: the
   canvas's Browser preview and Design canvas boards, and the inspector's
   context-window meter, Compact session and Remote control toggle (nothing
   measures or does them).
3. **Type.** Inter and JetBrains Mono are bundled in `ui/fonts` and loaded
   same-origin. This ends the local-stack-only rule, whose reason was an offline
   webfont fetch failing silently.
4. **Navigation**, decided destination by destination. Fifteen destinations
   became the brand plus four:

   | Was | Now |
   |---|---|
   | Overview | the logo (the way home) |
   | Objective | Overview: the objective is its headline; the editor and Start a run open inline. `#objective` opens it |
   | Approvals, Inbox, Messages | one Inbox, tabs All, Approvals, Messages, My tasks |
   | Changes, Tasks | the run's Diff and Tasks chips; `#changes` and `#tasks` stay routable, and worktree changes with no run are on Overview |
   | Agents, Activity | Team, tabs Agents, Activity |
   | Memory, Notes | Knowledge, tabs Memory, Notes |
   | Usage, Doctor | Settings tabs |
   | Automations | stays in the rail |

   Rail order: brand, New run (Ctrl N), Inbox with a waiting count, Team,
   Knowledge, Automations, the runs list, footer. Ctrl K reaches every page and
   run. A retired address is an alias that lands on the page and tab that now
   hosts it (`ui/routes.js`), never on Overview by accident.

**Decisions made without asking, and why.** Each is a deviation to revisit.

- The mode switcher stays in the header, compact. The canvas draws none, but
  mode is global state and needs a home.
- "New run" opens a fresh conversation: a run is the orchestrator's thread, and
  the runs list is the conversations list.
- Where the canvas fails this app's rules the rule wins: its #737373 metadata is
  4.10:1 on `--surface`, so `--faint` is #8a8a8a (5.63:1); its 26-32px rows and
  chips keep their look inside 44px hit areas.
- The canvas's Runs table has an Agent column; a run records none, so it shows
  Spend. "Spend today" is Spend: the daemon does not track a day.
- Doctor leaving the rail would hide a failing check, so a failing check is the
  first Inbox row and counts on the rail's Inbox badge.
- `--danger` (red) is separate from `--tone-attention` (amber): a blocked run is
  waiting on you, not broken, and the canvas draws both.

**What closed it** (branch `T3-code`; every commit ran the full gate first).

| Piece | Commit | Test that fails without it |
|---|---|---|
| Bundled fonts, `font/woff2` MIME | `401c4f0` | `t-assets` section 8 |
| Dark tokens, flat chrome, no glass | `9e7985d` | `t-theme` (every token re-pinned) |
| Route table, tab host, Settings tabs | `58157cb` | new `t-routes` |
| Four-item rail, header, Ctrl K | `cc4a91d` | new `t-palette`; `t-theme-geometry` |
| Overview | `ab7dc08` | `t-pages` Overview pins; `t-routes` |
| Run chips and session inspector | `6fa38fb` | new `t-inspector`; `t-pages` thread pins |
| Doctor in Inbox, copy, tap targets | `6339075` | `t-pages` (`doctorItem`) |
| Canvas fidelity pass | `47d2a2b` | `t-theme` pins |

**Acceptance evidence.**

- **Source.** `npm test`: 95 suites in the Linux container, all passing but
  `t-electron.js`, which cannot launch Electron without a display (the baseline
  was 92 with the same single failure). `t-theme-geometry` ran in real Chromium.
- **Browser.** A seeded court (a blocked run with recovery history and a
  completed run in history, five tasks, three approvals, twelve conversations, a
  thread with a code block and a long unbroken URL) was audited route by route at
  1440x900, 1280x720 and 720x900 in real Chromium: horizontal overflow, targets
  under 44px, and WCAG contrast of every rendered text node with alpha-blended
  backgrounds. Clean at all three after fixes, no console errors. Also driven by
  hand: Ctrl K with Enter and Escape, Ctrl N, the four rail targets, the
  collapsed rail (47x44 buttons), the 720px drawer (0 of 30 Tab presses
  escaped), the inline objective editor, the run chips, and typing into the Tasks
  chip's form while four stream events arrived.
- **Fidelity.** The canvas's Overview and Run thread boards were rendered as
  static HTML and compared with the app; the gaps found were closed in the last
  commit. The Inbox, Team, Knowledge, Automations and Settings pages have no
  board of their own in the canvas that was read, so they follow the system, not
  a drawing.
- **Not held.** Electron and Windows (`t-electron.js` runs on `windows-latest`
  CI only); a desktop notification on a real OS; the sovereign's own acceptance
  of how it looks.
