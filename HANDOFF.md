# Handoff — Agentic OS (Kingdom) — 2026-08-07

## Goal & status

Agentic OS is a multi-agent orchestrator at `E:\AI\Agentic OS`, shaped as a
kingdom: a king orchestrates, a jester observes cheaply, and 14 peasants work
in isolated git worktrees. Its differentiator is that peasants message each
other **directly over MCP**, not through the king. Members run the Codex CLI,
the Claude Code CLI, or the Antigravity CLI (`agy`).

This session did three things, all **complete and verified**: a UI overhaul
(board layout, member card, and a substantial visual pass), a desktop pet
(HappyDog, in his own always-on-top window), and an unplanned but important
fix — the `agy` CLI silently self-updated and broke the king.

Nothing is half-finished. There is no work in flight.

## Current state (what exists now)

**This is not a git repository.** `git rev-parse` fails in the project root;
there is no `.git`. Nothing this session can be diffed, reverted, or inspected
through git — the filesystem is the only record. If you want history, the
first useful act is `git init`.

Verified as of this writing:

- `node test/run-all.js` — **24 suites, all pass**, on three consecutive clean
  runs with no other court process running.
- The Electron app launches, the pet window appears, drag and resize behave
  (measurements in *Decisions* below).
- The king answers on `agy`: prompted "Reply with exactly: the court hears
  you.", it replied `the court hears you.` with real token usage recorded.

### Files created this session

| Path | What it is |
|---|---|
| `ui/pet.js` | Sprite engine for HappyDog — clips, moods, fidgets. Shared by both windows. |
| `ui/pet.html` | The floating pet window's page. |
| `ui/pet-window.js` | Desktop-pet behaviour: court subscription, drag, size slider. |
| `ui/pet/happydog.webp` | The sprite sheet, copied from `~/.codex/pets/happydog/`. |
| `ui/pet/happydog.json` | Codex's own manifest for it, copied verbatim. |
| `ui/avatar.js` | Per-member coloured monogram, derived from the name. |
| `ui/identity.js` | The right-hand member card. |
| `electron/pet-preload.cjs` | IPC bridge for the pet window. CommonJS on purpose (see *Watch out for*). |
| `HANDOFF.md` | This file. |

### Files changed this session

- `electron/main.js` — the floating pet window: creation, placement, drag,
  resize, persistence.
- `ui/app.js` — board/flow mode, member-card wiring, pet mood, toolbar
  overflow menu, avatars on member panels.
- `ui/app.css` — board grid, member card, avatars, and a "fourth refit" block
  addressing defects found in a screenshot.
- `ui/index.html` — mode tabs, the member-card `<aside>`, the rail's pet slot,
  the overflow menu container.
- `ui/win.js` — `setTiled()` so board mode does not overwrite free-canvas
  geometry; `data-id` on each panel.
- `ui/rail.js` — avatars; stopped printing "not summoned" on every row.
- `ui/icons.js` — three new icons: `who`, `more`, `pet`.
- `src/agent.js` — **the agy prompt fix** (see *Dead ends*).
- `src/doctor.js` — same fix in the agy probe.
- `test/t-agy.js` — assertions repointed to the new agy contract.

### Live configuration (read from `kingdom.config.json` just now)

- king: `agy` / `gemini-3.6-flash-high` / effort `high`
- jester: `codex` / `gpt-5.6-luna`
- 14 peasants: `codex` / `gpt-5.6-luna`
- advisor: `codex` / `gpt-5.6-luna` / effort `xhigh`, with **`promptEngineer:
  false` and `autoModel: false`** — both were on earlier and have since been
  turned off. Allowlist is `codex/gpt-5.6-luna`, `codex/gpt-5.6-terra`.
- summarizer: enabled, `codex` / `gpt-5.4-mini`, effort `none`, 16 words
- `maxKingdomUsd: 75`

## Decisions made, and why

**Board is the default layout; Flow is the free canvas.** Board tiles every
open panel into a grid filling the stage; Flow keeps the pannable canvas where
you place panels yourself. Board is default because an even grid needs no
setup. Board is implemented purely in CSS overriding the inline geometry the
canvas writes (hence the `!important` — inline styles are what is being
overridden), so switching back restores your arrangement untouched. The one JS
addition is `setTiled()` in `ui/win.js`: while tiled, drag and
geometry-remember are off, or every grid cell size would overwrite the saved
flow layout.

**Members get a coloured monogram derived from their name.** Sixteen rows of
grey text beside identical grey dots was the single biggest reason the roster
read as a list of strings rather than a court. Deriving the hue from the name
means it is stable across restarts and needs no configuration.

**The toolbar is six icons plus an overflow menu.** Fourteen unlabelled 16px
hairlines in a row is a memory test — you cannot tell vault from metrics from
chronicle. The six opened during a working session stay on the bar; the rest
moved behind `⋯`, which shows their real names. Every tool kept its Alt key.

**HappyDog reports the court; he is not decoration.** Asleep when nobody is
working, running while any member has a turn in flight, cheering on a merge or
milestone. The mood is derived from the roster each time rather than from a
counter, for the same reason as the approvals badge: a tally and the screen can
disagree, and you believe the screen.

**In Electron the dog lives in his own window; in a browser he lives at the
foot of the rail.** The environment decides, no setting. The first attempt put
him on the stage, which forced a choice between being buried under a panel
(`ui/win.js` hands each focused card an ever-increasing z-index) and floating
over one — and on top he sat squarely across the bottom-left card's prompt
input. The rail's foot is the only place on screen that never holds content.

**Pet drag is driven entirely from the main process via
`screen.getCursorScreenPoint()`.** Renderer coordinates cannot be used; see
*Dead ends*.

**The pet window is moved with `setBounds` and an explicitly computed size,
never `setPosition`.** Also *Dead ends*. The size comes from `petBox(petScale)`
— computed from the scale, never read back off the window.

**The `×` dismisses the dog for the session only, not permanently.** His
tooltip promises he comes back next launch, and there is no IPC bridge in the
throne room to summon him back, so persisting the dismissal would make the
tooltip a lie.

## Dead ends — don't retry these

**Do not move the pet window with `setPosition`.** It is implemented as "keep
the current size, change the origin", and on a display at 125% scaling that
round trip re-applies the scale factor. Measured across a single 100-step
drag: the window grew **144×172 → 180×208 → 267×295 → 344×378 → 432×467**,
compounding by roughly ×1.25 every few frames. The *position* was always
correct; the transparent box around the dog ballooned, throwing the `×` and
the slider off into space. Fixed by `setBounds` with an explicit size every
frame. Re-verified: 144×171 at every checkpoint of the same drag.

**Do not compute the pet drag from renderer `screenX`/`screenY`.** Chromium
derives `screenX` as `clientX` plus the window's *cached* screen origin, and
that cache updates a beat after the window moves. Every frame measured against
a stale origin and fed the error into the next move — hold the dog still and
he sails off across the desktop. There is no renderer-side fix; the cursor
must be read from outside the window being moved.

**Do not freeze the pet's drag size from `getBounds()`.** It returns whole
DIPs while the physical box rounds up, so each drag re-freezes the slightly
larger reading. Measured creeping 114 → 118 → 119 → 120 over four drags.
Compute it from the scale instead.

**Do not call `setBounds` on the pet window without lifting `resizable`
first.** The window is created `resizable: false`, and on Windows that pins
min/max size so `setBounds` is silently clamped — the sprite scaled via CSS
while the window did not, and the `×` and slider drifted further from the dog
at every step. `pet:scale` toggles `setResizable(true)` around the one call and
restores it immediately, so the frameless window keeps no invisible drag
borders.

**Do not put a looping clip in the pet's `FIDGET` list.** A fidget only ends
when its clip wraps and clears `once`; `sit` loops, so it pinned the dog in
that animation permanently. `play()` now refuses any looping clip outright.

**Do not pass the agy prompt as a trailing positional.** See *Watch out for* —
this is the live trap, not merely a historical one.

**Do not trust `EnumWindows`-based window measurement from PowerShell here.**
It matches Electron's hidden helper windows (there is a 159×27 one titled
"Kingdom" at −25600,−25600), and a callback delegate that gets
garbage-collected mid-enumeration returns partial results. Several apparently
alarming measurements this session were this tooling, not the app. Keep the
delegate alive in a variable and filter by size, or take a desktop screenshot
instead.

## Next steps

There is no queued work. These are the things actually worth doing next, in
order:

1. **`git init` and make a first commit.** This is the highest-value single
   action available. The project has no version control at all, and a session
   just rewrote large parts of the UI and the agy backend with no way to diff
   or revert. Done when `git log` shows one commit and `git status` is clean.

2. **Delete the stale probe files in the project root:**
   `.tmp-mcp-probe.db-shm` and `.tmp-mcp-probe.db-wal` (dated 2026-08-04).
   They are leftovers from an MCP test, not used by anything. Do this before
   the first commit so they never enter history — or add them to
   `.gitignore`.

3. **Rebuild the installer if you want the pet shipped.** `npm run dist`
   produces `dist/Kingdom Setup 0.1.0.exe`; the current one is dated
   2026-08-04 and predates every change in this session. `package.json`
   `build.files` already covers the new files via `electron/**` and `ui/**` —
   no manifest change needed.

4. **Consider adding a regression test for the agy argument order.**
   `test/t-agy.js` now pins it, which is the important half. What is not
   covered is the *class* of failure: an auto-updating CLI changing an
   argument's arity. A periodic `agy --help` diff, or a doctor check that
   fails loudly on an unexpected flag surface, would catch the next one.

## Watch out for

**`agy` updates itself, and 1.1.11 changed `--print` from a boolean to a flag
that takes the prompt as its value** (`--prompt` is now listed as an alias for
it). The code passed the prompt as a trailing positional, so agy's Go flag
parser read the *next flag* as the prompt: the king spent its turn writing a
chat answer about what `--output-format` means, emitted no JSONL, and was
reported as "produced no output (exit 0)". Fixed in `src/agent.js`
`#runAgyTurn()` and `src/doctor.js`. **The installed version right now is
1.1.11**, and there is an `agy.exe.*.old` sitting beside the binary in
`%LOCALAPPDATA%\agy\bin` — that is what a self-update leaves behind. If the
king ever goes silent again with exit 0, check the agy version and `agy
--help` before anything else.

**A bare `agy` call without `--dangerously-skip-permissions` exits 0 with no
output**, because a tool needed the `command` permission that headless mode
cannot prompt for. The agent code passes the flag unless
`spec.skipPermissions === false`, so members are fine — but a manual probe
without it will look like a broken CLI when it is not.

**The test suites bind ports derived from the process PID.** Two intermittent
failures were observed early in this session, both while a test daemon (port
7788) and an Electron instance were still running. With nothing else running,
three consecutive full runs were clean. If a suite fails, check for a stray
daemon before investigating the test.

**`electron/pet-preload.cjs` must keep the `.cjs` extension.** `package.json`
declares `"type": "module"`, so a `.js` preload would be parsed as ESM, which
a sandboxed preload cannot be.

**A hook auto-opens `ui/pet.html` in the Claude Code Browser pane** whenever
that file is written or edited. There is no IPC bridge there, so the dog
renders but nothing works — this looked exactly like a broken feature during
the session. The page now detects the missing bridge and hides the controls
that would be lying, but expect the pane to pop open when you touch that file.

**`ui/win.js` hands each focused panel an ever-increasing z-index.** Anything
placed on the stage will eventually be buried. The pet works around this by
not living on the stage under Electron.

**`ui/app.css` has four appended "REFIT" blocks** that override earlier rules
in the same file. When changing panel or chrome styling, check whether a later
block already overrides what you are editing, or your change will appear to do
nothing.

**Screenshots of the app do not work through the in-app Browser pane** (it
does not composite frames). Use `mcp__claude-in-chrome` against
`http://127.0.0.1:<port>`, or a PowerShell desktop capture for the Electron
window. Four rounds of UI work happened blind before this was discovered, and
the first real screenshot immediately revealed defects that no amount of DOM
measurement had caught.

## Open questions for the user

1. **Should the project be put under git?** Everything else in `E:\AI` and
   `E:\Claude` is versioned; this one is not. Answering yes unblocks next step
   1 and makes every future session safer.

2. **Is the UI now acceptable, or is the disagreement about direction?** The
   user called it "trash" or "slop" four times across the session. The last
   round fixed five concrete, measurable defects (no visual hierarchy, an
   empty 1050×620 card, "not summoned" printed twelve times, fourteen
   unlabelled icons, no per-member identity) and the user has not commented on
   the result. It remains possible the objection is to the whole dark-glass
   direction rather than to defects within it. If so, that is a redesign, not
   a fix, and should be scoped as one.

3. **Should the king stay on `agy`?** It is the only non-codex member, it is
   the member whose CLI just broke silently, and `agy` auto-updates without
   asking. Moving the king to `codex/gpt-5.6-terra` (already on the advisor's
   allowlist for its memory) would remove a whole class of failure. This is a
   real trade-off, not a recommendation — agy may be there deliberately.

## Pointers

- Project root: `E:\AI\Agentic OS`
- Run the app: `npm start` (Electron; picks a repo, then starts a detached
  daemon on port 7777)
- Run the tests: `node test/run-all.js` (also `npm test`)
- Preflight the CLIs: `node src/doctor.js` — **run from a normal terminal**,
  not inside a Claude Code session, or the claude-CLI checks are misleading
- Build the installer: `npm run dist`
- Pet state (position and scale) persists to
  `%APPDATA%\Kingdom\pet.json`
- Source of the sprite sheet: `~/.codex/pets/happydog/` — Codex ships a second
  pet, `cyan`, which is 1536×2288 on the same 192×208 grid and is not wired up
- Sprite sheet geometry, measured not documented: 1536×1872, an 8-column grid
  of 192×208 cells, nine rows, with live frame counts `[6, 8, 8, 4, 5, 8, 6,
  6, 6]` — the trailing cells of a short row are transparent, so playing all
  eight would flash a blank patch
- Workspace map and standing rules: `E:\AI\CLAUDE.md`
- The user's Obsidian vault records project decisions and a Mistake Ledger at
  `E:\AGIOS Kingdom\Obsidian Vault\Kingdom\`. The agy arity change is a good
  candidate entry (an auto-updating CLI silently changing an argument's
  meaning) and has **not** been written there.
