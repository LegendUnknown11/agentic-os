# Rebuild the Agentic OS interface around the run

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

Invert the Cold-Call Workflow design system onto a dark ink ground. Its structure
carries over; its palette is rebuilt for a console.

- Adopt its real scales: spacing `4, 8, 16, 24, 32, 48, 64, 88`; the product
  radius pair, 16px card and 12px control, with no pills; layered shadow as
  hairline plus tight plus ambient; `cubic-bezier(.2,0,0,1)` as the single easing;
  a 44px minimum tap target, enforced rather than suggested.
- Adopt its conventions: mono, uppercase, tracked labels carry every piece of
  metadata; status reads through colour, label, dot, and geometry with no icon
  set; a status row takes a full hairline border **and** a 3px coloured left rule.
- Derive the ground ladder from its `--ink`, and take `--paper` as body text.
  Record the measured contrast beside each value, as `ui/app.css` already does.
- Two deviations, both stated in the stylesheet rather than left implicit. No
  webfonts: this application runs offline in Electron and a failed font fetch
  degrades silently, so `--mono` stays a local stack and Playfair Display is
  unused. A third status hue: a console must separate running from settled, so
  the accent and the settled tone stay in one hue family and separate by chroma.
- Gold identifies the orchestrator and never encodes a status.
- Every colour needs an `-rgb` channel twin, because the sheet composes alpha as
  `rgb(var(--x-rgb) / a)` and the suite forbids literal colours outside `:root`.

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
