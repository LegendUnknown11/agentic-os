# Kingdom → shippable app

## Status (2026-08-24)

Shipped: Phase 0 (graph.js landed); 2.1 CSRF gate (`c7fb4e6`); 2.2 neutral
config template + packaged skills/roles.json (`4f19c37`); 2.3 first-run doctor
screen (`4237599`); 2.4 Node-version check before daemon spawn (`479587b`);
2.5's CI workflow (`84fbaab`); 2.6 docs moved under `docs/` (`3306812`). The
schema-migration concern in 2.5 is already covered by `src/bus.js`'s existing
guarded, additive kv-flag migrations (`#migrateConversations()`) — no new
mechanism needed. `npm test`: 65 suites, all green.

Deliberately not done here — the user's call, not mine: a git remote and push,
a LICENSE choice (asked; user chose CI-only for now), and the clean-machine
install test in 1.1/1.3 (needs a second physical/VM machine). Phase 2.7 stays
deferred as written below.

## Context

Kingdom (`E:\AI\Agentic OS`) is a multi-agent orchestrator: an orchestrator
delegates, a cheap briefer digests the firehose, and members work in isolated
git worktrees while messaging **each other** directly over MCP. ~30k LOC across
`src/` (29 files), `ui/` (27 files, no framework, no build step), `electron/`
(thin shell), 62 offline test suites, one runtime dependency, no native modules.

It is much further along than "make this an app" implies. There is already an
Electron shell, an electron-builder NSIS config, and a built
`dist/Kingdom Setup 0.1.0.exe`. Four CLI backends (claude, codex, agy,
opencode), 46 MCP tools, 9 UI panels, cost accounting, quotas, workflows,
vault, STT, the pet window.

So the gap is not "build an app." The gap is that **nobody has verified this
runs anywhere but your machine**, and the exploration turned up four concrete
things that are broken *right now* in ways only a second machine would reveal —
including one that turns the shipped app into a remote-code-execution path.

Per your call this plan is two halves — check what exists, then build what's
missing — and every personal surface (pet, wallpaper/music, STT, Obsidian
vault, the 107-role bench) stays as identity, not as debt.

Out of scope, decided elsewhere, not relitigated here: `RENAME.md` (de-theming,
2115 occurrences — do it in one sitting or not at all) and `docs/PLAN-saas.md`
(hosting — a different product).

---

## Phase 0 — Land the in-flight work *(do this first, it is not tidy-up)*

`ui/graph.js` is **untracked** (533 lines, a visual automation-graph editor) and
`ui/panels.js:9` hard-imports it: `import * as GR from './graph.js';`. A fresh
clone therefore ships a renderer that fails to load a module and a test suite
(`test/run-all.js:44`) that cannot start. Everything else in this plan is
measured against a clone, so this blocks the rest.

The feature itself is finished and tested — `NODE_TYPES` exported from
`src/workflows.js` with a two-way self-check asserting the UI palette against
`runNode`'s switch, plus the `nodeForm` inspector in `ui/panels.js` (+237) and
`t-panels.js` / `t-opencode.js` / `run-all.js` updates. Review the diff, run
`npm test`, commit.

Also decide the four stray files while you're here: `Background.jpg`
(flagged across three sessions, unreferenced), `.tmp-observe.mjs`, and the two
`.kingdom-daemon-*.log` pairs — the logs are **not** covered by `.gitignore`
and contain paths to your other private repos, and `.gitignore:9-11` warns in
its own comment that members run `git add -A`. Add `.kingdom-daemon-*.log` and
`*.jpg`-or-explicit to `.gitignore`.

**Done when:** `git status` is clean and `npm test` is green from a fresh
`git clone` into a temp dir.

---

## Phase 1 — Check existing features

The deliverable of this phase is a written verdict per feature. It is cheap and
it decides how much of Phase 2 is worth building.

### 1.1 The clean-machine test

Install `dist/Kingdom Setup 0.1.0.exe` on a machine (or fresh VM / second
Windows user) that has never run this project. Don't fix anything yet — write
down every point where it stops or lies. Four failures are known in advance:

- **`skills/` is not in the package.** `package.json:21-27` ships
  `electron/**, src/**, ui/**, kingdom.config.json, package.json`. Verified
  against the real build: `dist/win-unpacked/resources/app/` contains no
  `skills/`. `src/skills.js:26` resolves `BUILTIN` to a directory that does not
  exist, so **the installed app's skill menu is empty** — 27 skill files that
  work in dev and silently vanish when shipped. (`roles.json` is also omitted
  but is harmless: the read at `src/kingdom.js:237` is try/caught and the
  shipped config already has `rolesSeeded: true` with 107 roles inlined.)
- **The shipped config is your personal one.** `defaultConfigPath()`
  (`src/kingdom.js:3266-3277`) copies the repo-root file per-workspace on first
  use, and it is in `build.files`. It currently carries
  `vault: "E:\\AGIOS Kingdom\\Obsidian Vault"`, `speechbird: "E:\\AI\\SpeechBird"`,
  your live `goal.text` with `setAt: 1786458819795`, and an `advisor.allow`
  pinned to two codex models. Model lists also name frontier models a normal
  account cannot reach (`gpt-5.6-sol`, `gemini-3.6-flash-high`,
  `openrouter/stealth/ox-alpha`).
- **Node 24+ must already be on PATH.** `electron/main.js:69` spawns
  `process.env.KINGDOM_NODE ?? 'node'` because the daemon needs `node:sqlite`
  and Electron's bundled Node lacks it. The failure message at `:86-87` is at
  least real, but an installer that requires a separate runtime install is not
  a consumer distributable.
- **`npm run doctor` is the actual onboarding and the app never runs it.**
  `src/doctor.js` probes node, `node:sqlite`, git, each CLI binary, each CLI's
  auth *and quota*, and the token pool. Someone who installs the .exe never
  sees any of it — they get an empty throne room and an "OAuth session expired"
  error the README needs 40 lines to explain.

**Done when:** an ordered written list of clean-machine failures exists.

### 1.2 Test suite, honestly

`npm test` → 62 suites (`test/run-all.js:21-101`), 4-wide, one serial retry per
failure, `flaky` printed rather than `pass`. Record pass count, flaky count,
wall clock. Trust the flaky signal.

Note two suites are machine-dependent by construction: `t-stt.js` needs the
SpeechBird virtualenv at `E:\AI\SpeechBird` (another project entirely), and
several bind fixed TCP ports. Decide now whether `t-stt` is a required suite
or an opt-in one — it cannot pass on any machine but yours.

Then run the two quota-spending suites deliberately, once: `test/t-agent.js`
and `test/t-comms.js`. `t-comms` proves the product's actual differentiator
(member messages member unaided). If it has rotted, nothing else matters.

### 1.3 Per-feature smoke pass

Drive a real daemon (`node src/daemon.js <repo> --port 7777`, browser at
`http://127.0.0.1:7777`) and exercise each surface once, recording
*works / undiscoverable / broken / never actually run*:

| Surface | Where | Confirm |
|---|---|---|
| Modes | `src/modes.js` | each mode's crew/worktree/merge rules hold |
| Summon + approvals | `openSummon`, `openApprovals` | approve/reject; `propose_role` writes config |
| Merge path | `src/worktree.js`, `openDiff` | declare_done → tests → digest → request_merge → Merge |
| Push gate | `requestPush` (`daemon.js:161`) | each push behind its own approval |
| Cost + quotas | `openMetrics`, `metrics()` (`:187`) | live `$ · turns`; quota meters render |
| Chronicle | `openChronicle` | FTS5 transcript search |
| Goal + milestones | `openGoal` | set/complete a milestone |
| Recall / memory | `openRecall`, `src/memory.js` | citations render as `vault:` links |
| Vault | `openVault`, `src/vault.js` | whole-vault read; writes confined to `vaultWriteDir` |
| Workflows | `openWorkflows`, `src/workflows.js` | save, run, hook trigger, run history |
| Chat | `ui/chat.js` | multi-conversation, branching, search, attachments |
| Uploads | `/api/assets` | image/audio/doc → `list_uploads` round-trip |
| **Skills** | `src/skills.js`, `/` menu | **check in the installed app, not dev** — see 1.1 |
| STT | `src/stt.js` + `stt_worker.py` | record exactly what it needs |
| Pet window | `ui/pet.js`, `electron/main.js:216` | opens, positions, survives restart |
| Token pool | `src/set-token.js` | stable per-member assignment; rate-limit failover |
| CLI | `src/cli.js` | `@member`, `/approve`, `/roster`, `/quit` |
| Doctor | `src/doctor.js` | every probe against your real setup |

---

## Phase 2 — New features

### 2.1 Close the CSRF hole *(the one that must ship first)*

**The finding.** `src/daemon.js:735-741` reads the POST body and
`JSON.parse`s it regardless of `Content-Type`, and there is no `Origin`,
`Referer`, or `Sec-Fetch-Site` check anywhere in the file (grep confirms).
A cross-origin `fetch` with `content-type: text/plain` and a JSON body is a
CORS *simple request* — no preflight — so **any website the user visits while
the daemon is running can drive the entire `ACTIONS` table** (`:138-176`):
`command` (arbitrary prompt into the court), `attachRepo` (arbitrary
filesystem path), `merge`, `approve`, `requestPush`, `setBudget`, `shutdown`.

That is worse than the usual localhost-CSRF story because the agents run
unconfined by design: `src/agent.js:368` `--permission-mode bypassPermissions`,
`:521` `sandbox ?? 'danger-full-access'`, `:670` `--dangerously-skip-permissions`.
The comments at `agent.js:508-521` explain why (a confining codex sandbox mutes
every MCP call) and that reasoning is sound *for one user on one box*. It stops
being sound the moment a stranger installs it. A drive-by POST to
`/api/command` is arbitrary code execution on their machine.

**The fix is small.** One gate at the top of the request handler, before any
routing:

- Reject if `Origin` is present and is not `http://127.0.0.1:<port>` /
  `http://localhost:<port>`. Browsers always send `Origin` on cross-origin
  POSTs; non-browser callers (the CLI, tests) send none and pass.
- Require `content-type: application/json` on every `POST /api/*`. That alone
  forces a preflight for cross-origin, and the preflight fails.

Two checks, one place, the whole class dead. Keep loopback binding
(`src/daemon.js:792`) as the outer layer — it is the correct security model for
a desktop app and this plan does not add auth on top of it.

*Test:* `test/t-csrf.js` — a POST with `Origin: https://evil.example` is
rejected; a POST with `content-type: text/plain` is rejected; the UI's own
`post()` and `src/cli.js` still work.

While here, add a body cap to the three unbounded readers (`:608-609`,
`:669-670`, `:738-739` — `body += c` with no limit) and to `/api/transcribe`
(`:726`). `/api/assets` already caps at 80 MB with `req.destroy()` (`:684-687`)
— reuse that shape.

### 2.2 Ship a neutral config template

`kingdom.config.json` is two things wearing one hat: a **template** shipped to
new users, and **live session state** for your court — and runtime edits land
on the shipped default. Split them.

- Strip the template to defaults: `vault: null`, `speechbird: null`,
  `goal: {text: '', milestones: []}`, `advisor.allow` unpinned. Prune the model
  lists to models a normal account can actually reach; keep yours in your own
  per-workspace copy, which `defaultConfigPath()` already gives you.
- `goal` is per-court runtime state and belongs in the bus kv store
  (`src/bus.js` already has one), not in a file that ships. `setGoal` /
  `setMilestone` (`daemon.js:152,155`) move to it.
- Add `skills/` to `package.json`'s `build.files`.

*Test:* `test/t-config-template.js` — the shipped template contains no absolute
path and no `setAt`; a packaged tree resolves `src/skills.js`'s `BUILTIN` to a
directory that exists and is non-empty. This is what stops it regressing.

### 2.3 First-run setup screen (doctor, in the app)

`src/doctor.js` already computes everything a new user needs. It only prints
ANSI to a terminal. Refactor its probes into a function returning a structured
result, keep the CLI printer as a thin caller over it, expose `GET /api/doctor`,
and render it as the first screen whenever no CLI authenticates — with the exact
fix per failed probe (`claude setup-token`, `codex login`, "install Node 24+",
"point me at a git repo").

*Reuse:* every probe at `src/doctor.js:38-254`; `ui/overview.js` already owns
the "nothing is happening yet" slot and once held a first-run tour.

### 2.4 Fail loudly, not silently

Two failure modes currently produce a blank window:

- **No Node 24.** Check before `electron/main.js:71-73` spawns the daemon; if
  `node --version` is missing or < 24, show a dialog with the download link.
- **Daemon dies after boot.** It is spawned detached + `unref()`'d on purpose
  (a court runs for hours), stderr lands in `.kingdom-daemon-<port>.err.log`,
  and nothing surfaces it — the 90s deadline at `electron/main.js:82-94` only
  covers initial boot. On non-zero exit, show the last ~20 log lines with a
  copy button. This converts every future "it just doesn't start" into a report
  you can act on.

### 2.5 A remote, CI, and a license

There is **no git remote** and **no `.github/`**. Before anyone else touches
this: push, and add one workflow running `npm test` on `windows-latest` — that
is the supported platform; don't pretend to cross-platform CI yet. 62 suites
with zero automated runs means the next refactor is unprotected.

There is also **no LICENSE file**. Shipping an Electron app without one is its
own blocker; pick one.

On migrations: `PLAN-saas.md` lists "no migrations" as a blocker, and that is
now half-stale — `src/bus.js:144-158` does guarded additive `alter table add
column` for `conversation_id`. There is still no schema *version*, so v0.2
meeting a v0.1 database has no defined story. A `user_version` pragma and a
migration list is an afternoon now; do it before the first release, not after.

### 2.6 Docs for someone who isn't you

`README.md` is excellent *reference* and poor *onboarding* — the run
instructions are 40 lines in before the first failure mode. Put a short
"Install → Doctor → Point at a repo → Your first court" path at the top and
leave everything else as reference below. Move `HANDOFF.md` (session state,
and it references `C:\Users\mayur\.claude\plans\...` that nobody else has) and
`RENAME.md` under `docs/`.

### 2.7 Deferred, deliberately

- **Cross-platform (macOS/Linux).** Nearer than `PLAN-saas.md` implies —
  `src/agent.js` is `IS_WIN`-guarded throughout (`:18,27,47,99,103`) and there
  are no `powershell`/`shell:true` calls anywhere (`:73-75` documents refusing
  them). But STT, the pet window and the installer target all need work. Add
  when someone not on Windows asks.
- **Code signing.** Add when SmartScreen blocks a real user.
- **Auth on the daemon.** Loopback + 2.1's Origin gate is the right model for a
  desktop app. Add when it stops binding loopback.
- **Multiple concurrent courts.** One hardcoded port (`daemon.js:50`,
  `main.js:15`); a conflict shows a dialog and quits (`main.js:333-343`). Add
  port negotiation when someone wants two repos open at once.
- **State location.** `.kingdom/` is written as a *sibling of the user's repo*
  (`worktree.js:76-83`), so uninstalling leaves debris next to every repo it
  ever touched. Moving it under `app.getPath('userData')` orphans every
  existing project — worth doing at the same time as `RENAME.md`'s on-disk
  renames, which already accept that cost, and not before.
- **Auto-update, export/import, backup.** After the first release, if there is
  one.

---

## Verification

Per phase, not at the end:

1. **Phase 0** — `git clone` into a temp dir, `npm install`, `npm test` green.
2. **1.x** — the filled-in verdict grid and the clean-machine failure list
   exist as a document. That document *is* the deliverable.
3. **2.1** — `node test/t-csrf.js`: cross-origin and `text/plain` POSTs
   rejected, UI and `src/cli.js` unaffected. Manually: a POST from a page on
   another origin to `/api/shutdown` does nothing.
4. **2.2** — `t-config-template.js` fails on today's config, passes after the
   split. Rebuild with `npm run dist` and confirm `skills/` is present in
   `dist/win-unpacked/resources/app/` and the `/` menu is populated.
5. **2.3** — `curl 127.0.0.1:7777/api/doctor` returns JSON matching what
   `npm run doctor` prints; the screen renders with a CLI logged out.
6. **2.4** — rename `node.exe` off PATH → dialog, not blank window. Make the
   daemon throw at boot → log excerpt appears.
7. **2.5** — CI green on a pushed branch.
8. **Final gate:** repeat 1.1 on a clean machine. Install → the first screen
   tells you what's missing → fix it → point at a repo → run one real task to
   merge. No terminal, no README, no help from you.

Every change ships with a test that fails without it, per `AGENTS.md`.
