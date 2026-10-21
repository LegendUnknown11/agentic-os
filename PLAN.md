# Agentic OS product contract

The live contract is the T3 Code design below, as amended by the cleanup pass.
Every earlier contract (the run system, the paper and glass themes, the
multiple-teams and pilot-readiness revamps, run visibility, assistant features)
is closed; its text and evidence are in Git history.

## Cleanup and canvas pass (2026-10-21, branch `cleanup`)

Asked for by the user: remove unnecessary code (dead code, duplicated logic,
stale docs, and the rename's legacy migration layer), then make every screen
look like the design canvas "Agentic OS — T3 Code style", checked visually in
Chromium.

1. **Navigation stays.** The rail's items, order and routes are unchanged; only
   their styling follows the canvas.
2. **Canvas sizes win.** Nav rows are 32px and chips 28px, as drawn. This
   replaces the T3 contract's 44px tap-target rule below.
3. **Contrast still wins.** `--faint` stays #8a8a8a; the canvas's #737373 fails
   4.5:1 on the surface.
4. **Legacy is gone.** Pre-rename state, env vars and branches are no longer
   read or moved.
5. **Not built, still.** The canvas's Browser preview, Design canvas and Remote
   control boards are specced, not built: [docs/specs.md](docs/specs.md).

**Decisions made without asking.**

- Model and effort stay in the run header, drawn as caption-less chips, not
  moved into the composer as the canvas draws them: the composer mounts
  outside the thread root that wires their events.
- Overview keeps the open run's detail panel (Pause/Stop live there), placed
  after Needs you and Runs instead of first.
- Each automation template's "Switch on" is a chip, not a white primary: the
  canvas allows one primary action per screen.

**Evidence.** Source: `npm test` printed 101 suites, all passing but
`t-electron.js` (no display in the Linux container); `t-theme-geometry` ran in
real Chromium. Browser: a seeded team (a running and a completed run, five
tasks, three approvals including a question, two of your tasks, messages,
spend) was screenshotted route by route in real Chromium at 1440x900, 1024x768
and 390x844 against the canvas boards, with no horizontal overflow and no
console errors beyond one 404. **Not held:** Electron and Windows
(`t-electron.js` was re-pinned to 32px but has not run), and your own look.

## Carried forward from the previous contract

The run system described in the previous `PLAN.md` is implemented and merged; its
text remains in Git history. Two of its obligations are still open and are
restated in `HANDOFF.md`: the Habitable pilot has not begun, and live
subscription-pool behaviour without paid API fallback is unproven.

## T3 Code redesign (2026-10-21)

Asked for by the user on 2026-10-21: implement the Claude design canvas
"Agentic OS - T3 Code style" exactly, on a `T3-code` branch, with the navigation
simplified further, and ask questions where unsure. It was scoped in an
interview before any code. It is a third reversal of section 1: the dark,
neutral T3 system replaces the Cold-Call Workflow paper theme (itself a reversal
of Hiveory), and the 2026-09-23 glass layer goes with it.

**Contract, as the user chose it.**

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
- **Browser.** A seeded team (a blocked run with recovery history and a
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
  CI only); a desktop notification on a real OS; the user's own acceptance
  of how it looks.
