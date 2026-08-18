# Handoff — Agentic OS (Kingdom) — 2026-08-18

## Goal & status

Agentic OS at `E:\AI\Agentic OS` is a multi-agent orchestrator shaped as a
kingdom: an orchestrator decomposes and delegates, a cheap briefer watches the
firehose and briefs it, and peasants work in isolated git worktrees. Members
message each other **directly over MCP** rather than routing through the
orchestrator. They run the Claude Code CLI, the Codex CLI, Antigravity
(`agy`), or opencode.

**This session finished "repo becomes optional" — the working tree is no
longer a mandatory launch argument.** Chat, Research and Build now run with
no repo attached at all; only Code mode needs one, and it can be picked from
inside the running app (a native folder dialog in Electron, or a plain
text-input panel over the browser) instead of on the command line. **Fully
implemented, tested (`node test/run-all.js` → 50 suites, all green), and
manually verified end-to-end in a live browser session** — which caught and
fixed two real bugs the automated suite could not see (both were client-side
crashes that only happen when a page actually loads with `repo: null`).

This builds directly on two other finished, still-uncommitted efforts sitting
in the same working tree: the **Four Modes** work (Code/Research/Chat/Build
mode table, advisor auto-classification, idle-gated mode flips) and a
**role rename** (king/jester → orchestrator/briefer, plus twelve flavor-role
renames, propagated into the Obsidian vault). All of that predates this
session and is also done and tested.

**Nothing from any of this is committed.** The working tree has been
accumulating uncommitted work across several sessions now — as of this
writing, `git status --porcelain` reports 73 lines (62 modified, 11
untracked) on top of HEAD `db202f7`, and there is still no git remote
configured. Deciding how to stage and commit this is the single largest open
item — see *Next steps* #1.

## Current state (what exists now)

### Verified as of this writing

- **`node test/run-all.js` → 50 suites, 4-wide, ~45–53s, all passed.** Run
  twice this session (once before, once after the two live-testing fixes
  below), both green.
- **The full repo-optional flow was driven live in the Browser pane**, not
  just unit-tested: booted the daemon with no CLI argument and no saved repo
  → confirmed `repo: null` in `/api/ping` and in the SSE snapshot → switched
  through Chat/Research/Build with no worktree created → clicked Code →
  got the "Code mode needs a repository — attach one first." toast with a
  "Choose repo…" action → opened the browser-path picker panel (a plain text
  input, since Electron's native dialog can't be driven remotely) → attached
  this repo (`E:\AI\Agentic OS`) → Code mode became active immediately, no
  restart, header updated live. Then killed that daemon and rebooted with
  **no CLI argument again** → it found the previously-attached repo in the
  saved workspace config and came up already in Code mode against it
  (`throne room: http://127.0.0.1:7777  (repo: E:\AI\Agentic OS)`).
- **Explicit-repo launch still works unchanged** (regression check): a fresh
  temp repo passed as `node src/daemon.js <repo> --port 7778` booted and
  reported that exact repo over `/api/ping`. This is the pre-existing launch
  path and it was not touched by this feature beyond making the argument
  optional.
- `git log --oneline -1` → still `db202f7`, branch `main`, **no remote
  configured**.
- No daemon process is currently running on 7777 or 7778 — both were stopped
  after verification (confirmed via `Get-NetTCPConnection -State Listen`).

### Two bugs found only by loading the real page, both fixed this session

Neither was caught by `test/run-all.js` — both are client-side, only trigger
when a page actually connects with `repo: null`, and the first one silently
swallowed itself (caught by `es.onmessage`'s own try/catch, logged, nothing
visibly wrong beyond a roster that never populated).

1. **[ui/app.js](ui/app.js) — snapshot handler crashed on a null repo.**
   `$('#repo').textContent = d.repo.split(...)` threw
   `TypeError: Cannot read properties of null (reading 'split')` on *every*
   SSE `snapshot` event when `d.repo` was `null`, which aborted all the code
   after it in that switch case — roster, goal, models, efforts, advisor
   settings, skills, the whole snapshot replay never applied. Fixed by
   extracting a `paintRepo(repo, base)` helper that renders `"no repository"`
   when `repo` is falsy.
2. **[src/daemon.js](src/daemon.js) — the `'repo'` event was never forwarded
   over SSE.** `Kingdom#attachRepo` emits `this.emit('repo', {repo, base})`,
   but daemon.js's list of events it re-broadcasts to the browser didn't
   include `'repo'`, so after a live attach the header's repo label stayed
   stuck on "no repository" until a manual page reload. Fixed by adding
   `'repo'` to that forwarded-events list and adding a `case 'repo':` in
   `ui/app.js`'s `onStreamEvent` switch that calls the same `paintRepo`
   helper.

### New / touched files this session

| Path | What changed |
|---|---|
| `src/worktree.js` | `kingdomDir(repo)` falls back to `~/.kingdom/workspace/` when `repo` is falsy, instead of requiring one. `dbPath`/`worktreePath` inherit this for free. |
| `src/kingdom.js` | Constructor/`start()` accept `repo: null`; new `attachRepo(path)`; `setMode`/`queueMode` refuse/degrade Code mode without a repo; `#doSpawn`'s worktree condition now requires `Boolean(this.repo)` too; new `#cwd()` helper so a null repo never reaches a spawned CLI's argv as a literal `null`; `#onDone`/`#rescueWork` gained repo-less early-return branches. |
| `src/daemon.js` | CLI repo argument is now optional — falls back to a previously-saved repo in the workspace config, then to `null`; new `POST /api/attachRepo`; `/api/ping` and the SSE snapshot report the *live* `kingdom.repo`, not the boot-time value; `'repo'` added to the forwarded SSE event list (bug fix #2 above). |
| `electron/main.js` | No longer blocks app launch behind a native folder-picker dialog; repo is optional at spawn; new `ipcMain.handle('repo:choose', ...)` for on-demand picking. |
| `electron/court-preload.cjs` | **New.** Bridges `window.kingdomShell.chooseRepo()` to the `repo:choose` IPC handler, mirroring the existing `pet-preload.cjs` pattern. |
| `ui/app.js` | Mode-switch buttons now check the result and show a toast + "Choose repo…" action on refusal; new `openRepoPicker()`/`attachRepo()`/`openRepoPanel()`; new `paintRepo()` helper (bug fix #1 above); new `case 'repo':` in the SSE handler (bug fix #2 above). |
| `test/t-repo-optional.js` | **New.** Covers null-repo construction, `setMode`/`queueMode` gating, worktree-skipping for a repo-less worktrees:true mode, and a live `attachRepo` call — registered in `test/run-all.js`. |
| `.claude/launch.json` | **New "daemon" entry** — `node src/daemon.js --port 7777` with no repo argument, for driving the daemon from the Browser pane tool without Electron's native dialog in the way. The pre-existing `"start"` entry (`npm run start`, i.e. Electron, port 3000) is unchanged. |

### Side effects of manual testing (real state, not a mistake, but worth knowing)

- **`~/.kingdom/workspace/kingdom.config.json` now exists on this machine for
  the first time** (created because the repo-less daemon was actually
  booted). Because the live-attach test used this project's own repo as its
  target, that file now holds `mode: "code"` and
  `repo: "E:\\AI\\Agentic OS"`. Practical effect: **the next time anyone runs
  `node src/daemon.js` with no argument on this machine, it will boot straight
  into Code mode against this repo**, not into a clean no-repo state. To
  re-test the true first-ever-launch experience, delete that file (or its
  `repo` key) first.
- **A second, separate config home for this same repo already existed before
  this session**: `E:\AI\.kingdom\Agentic OS\kingdom.config.json` (created by
  an earlier session's explicit `node src/daemon.js "E:\AI\Agentic OS"`
  launch, per the previous handoff). This feature does not touch or migrate
  that file — it is unrelated, still live, and used whenever the repo is
  passed explicitly on the command line. The two configs now coexist and can
  drift independently; that is expected, not a bug, per this session's
  explicit design decision (see *Decisions*).
- A leftover daemon process (PID 18768) was found already running on :7777
  from an earlier session's wallpaper testing (repo `E:\AI\Agentic OS`
  attached) and was stopped to free the port for this session's testing.
- `Background.jpg` sits **untracked at the repo root**
  (`E:\AI\Agentic OS\Background.jpg`) — the user's own wallpaper test image
  from an earlier part of this session, never cleaned up or gitignored. The
  app's own asset store (inside `kingdomDir/assets`) has its own copy; this
  root-level file is just the original drop.

## Decisions made, and why

**Worktree isolation is now gated on `mode.worktrees && Boolean(this.repo)`,
not `mode.worktrees` alone.** `src/modes.js` gives Research and Build
`worktrees: true` deliberately — a git worktree is the *mechanism* that makes
"can't touch the real repo" true, since only one of the four CLIs has its own
sandbox flag. That's still correct when a repo is open. But a worktree
protects a repo; with none attached there is nothing to protect, so there is
nothing to isolate. Resolved by asking the user directly rather than
guessing — their answer: *"Chat + Research + Build as Chat mode doesnt edit
anything, research mode saves it to the vault, build mode edits the
fundamentals of this application (like skills, vault, etc.) so only code
needs a repo."*

**Attaching a repo does NOT migrate workspace state.** The db, config, vault
pointer, goal and roster stay at `kingdomDir(null)` (the workspace home)
permanently, even after `attachRepo()` runs — only `kingdom.repo`/`base`
change, pointing Code mode's worktrees somewhere new. The alternative
(copying state into a repo-relative `.kingdom/<repoName>/` on attach) would
require hot-swapping a live sqlite connection mid-session for no real
benefit, since goal/roster/vault/research notes are workspace-level concepts
per the user's own framing above, not repo-level ones. Switching to a
genuinely *different* repo later still needs a fresh court, exactly as
before.

**Code mode's refusal is a thrown error, not a special response shape.** The
daemon's existing generic `/api/*` dispatch already turns any thrown error
into `{ok:false, error: message}` over HTTP — `setMode` just throws
`'Code mode needs a repository — attach one first.'` and the toolbar surfaces
it directly, no new API contract needed. `queueMode` (the advisor's
background auto-classifier) degrades silently instead — it must never throw
out of a call nothing is watching for an exception.

**The browser-path picker is a plain text input, not a fake file browser.**
Electron's native `dialog.showOpenDialog` can't be driven by the remote
Browser-pane test tool, and a plain-browser launch (`node src/daemon.js` +
any browser, the documented headless path) has no native dialog available at
all — so the fallback had to work without one regardless. A text input over
the existing `W.toggle` panel primitive (same one `openMetrics` already uses)
was the smallest thing that covers both cases.

## Dead ends — don't retry these

**Clicking a mode-switch button via the `computer` tool's `ref` targeting
intermittently no-oped after the roster re-rendered** (no network request
sent, no visible error) during this session's manual verification, even
though the button element, its `onclick` handler, and its on-screen
coordinates all checked out fine under direct inspection. Switching to
`javascript_tool` with a direct `element.click()` call fired reliably every
time. This looks like a `ref`-to-DOM-node mapping going stale across a
re-render inside the Browser pane tool itself, not an app bug — if a click
via `computer`+`ref` seems to do nothing, verify with a direct JS click
before concluding the app is broken.

## Next steps

1. **Decide how to stage and commit the working tree.** `git status
   --porcelain` shows 73 lines (62 modified, 11 untracked) covering at least
   three separate, independently-finished efforts layered on top of each
   other in the same files: the 2026-08-17 code-review pass, the Four
   Modes + role-rename work, and this session's repo-optional feature.
   Answering "one commit, everything" unblocks immediately; answering
   "separate them" means a hunk-by-hunk pass, as commit `db202f7` already did
   once for a similar tangle. **There is no remote configured**, and pushing
   needs a fresh, explicit instruction for the specific commit regardless of
   any past authorization (see *Watch out for*).
2. **Phase 5 (fix the Add-agents category bug) and Phases 3/4/6/7 (approvals
   consolidation, turn cards, settings consolidation, accessibility)** are
   still open on the original UI/UX redesign plan and were **not** touched
   this session or the one before it. Don't start them without the user
   re-raising — they are unrelated to repo-optionality.
3. **Decide what to do with `Background.jpg` at the repo root** — remove it,
   gitignore it, or leave it; it's not referenced by any code path (the app
   reads its own copy from `kingdomDir/assets`).
4. **Load the app in Electron itself at least once** (`npm start`). This
   session's verification was entirely through the daemon + Browser pane,
   because Electron's native repo-picker dialog can't be driven remotely —
   the `repo:choose` IPC handler and `court-preload.cjs` bridge (the actual
   Electron-only code path) have not been exercised in a real Electron
   window this session.

## Watch out for

**Two live config homes now exist for this one repo, and they can drift
independently — this is intentional, not a bug to "fix" by merging them.**
`E:\AI\.kingdom\Agentic OS\kingdom.config.json` (predates this session, used
when the repo is passed explicitly on the command line) and
`~/.kingdom/workspace/kingdom.config.json` (new this session, used when the
daemon boots with no argument). Editing one and expecting the other's daemon
to see it will not work — check which launch path is in play first.

**`~/.kingdom/workspace/kingdom.config.json` currently has `repo` pre-filled
with this project's own path**, as a side effect of this session's testing
(see *Current state*). A repo-less daemon boot on this machine will attach it
automatically unless that key is cleared first.

**This machine runs out of memory, and that is what most `npm test` failures
here turn out to be** — not re-observed this session, but nothing has changed
to fix it either. 8.36GB total RAM, historically down to 0.4–0.9GB free under
load; at that level `spawn` itself starts failing with `UNKNOWN` and
neighbouring test suites die with `0xC0000409`. Check free memory before
investigating any unexplained failure.

**`npm test` (`node test/run-all.js`) runs four suites at a time and retries
a failure alone; one that then passes prints `flaky (failed in the pool,
passed alone)`** — that's the runner working as designed, not a false pass.
`KINGDOM_TEST_WIDTH=1` forces the old serial run when isolating something. A
hung suite is killed and reported at 180s rather than hanging the run
forever.

**`agy` updates itself, and 1.1.11 changed `--print` from a boolean to a flag
that takes the prompt as its value.** Passing the prompt as a trailing
positional makes agy's Go flag parser read the *next* flag as the prompt,
and the member emits no JSONL while exiting 0. If a member on `agy` ever goes
silent with exit 0, check `agy --help` before anything else.

**`electron/pet-preload.cjs` and the new `electron/court-preload.cjs` must
keep the `.cjs` extension** — `package.json` declares `"type": "module"`, and
a sandboxed Electron preload script cannot be ESM.

**Never put a token in `kingdom.config.json`.** The real token store lives
outside the repo, at `<repoParent>/.kingdom/<repoName>/tokens.json` (or the
new workspace home when no repo is attached).

**Never push to `main` without a fresh, explicit "push" instruction for that
specific commit.** A prior push authorization does not carry forward to a new
commit, even within the same session. There is currently no remote
configured, so nothing can be pushed by accident today.

**Screenshots and DOM inspection through the Claude Code Browser pane only
work while the pane is displayed** — otherwise `computer{action:"screenshot"}`
returns "the Browser pane is not displayed, so the page is not compositing
frames." `read_console_messages` also appears to return a buffered history
that can include stale entries from before a reload — confirm a fix landed
by checking DOM/network state directly (e.g. `document.getElementById(...)`
via `javascript_tool`), not by trusting the console log alone.

## Open questions for the user

1. **How should the working tree be split into commits?** Three
   independently-finished efforts (the Aug-17 code review, Four Modes +
   role rename, and this session's repo-optional feature) are interleaved
   across the same 62 modified files. "One commit, everything" unblocks
   immediately; "separate them" means a hunk-by-hunk pass.
2. **Should `Background.jpg` be removed from the repo root, gitignored, or
   left as-is?** It's inert either way — not read by any code path — but it
   is currently an untracked stray file.
3. **Pick up Phase 5 / Phases 3-4-6-7 of the older UI/UX redesign plan next,
   or leave them shelved?** They're unrelated to repo-optionality and were
   not touched this session.
4. **Which product shape — A, B or C?** See `docs/PLAN-saas.md`. Carried
   forward unanswered from the 2026-08-17 handoff; nothing in its Phase 1 can
   start without it. The recommendation there was B: host the control plane,
   keep execution on the customer's machine.

## Pointers

- Project root: `E:\AI\Agentic OS`; branch `main`, HEAD `db202f7`, **no
  remote**, working tree dirty (62 modified, 11 untracked)
- Run the tests: `node test/run-all.js` (50 suites) —
  `KINGDOM_TEST_WIDTH=1` to serialize
- Run the app in Electron: `npm start`
- Run just the daemon for browser-driven testing (no repo required):
  `node src/daemon.js --port 7777`, or `.claude/launch.json`'s `"daemon"`
  entry via the Browser pane tool's `preview_start{name:"daemon"}`
- Attach a repo live once the daemon is running:
  `POST /api/attachRepo {"path": "..."}`, or the throne room's "Choose
  repo…" toast action after a refused Code-mode switch
- Codebase rules: `AGENTS.md`. Four rules govern every change: tests ship
  with the change and must fail without it; never trust a measurement you
  did not take; comments carry the evidence, not the intent; degrade, never
  wedge.
- Global Claude rules: `C:\Users\mayur\.claude\CLAUDE.md` (only includes
  `RTK.md`, a token-proxy CLI reference)
