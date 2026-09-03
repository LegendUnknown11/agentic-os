# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` above is the operating contract for this codebase — the four
non-negotiable rules, the spawn traps that have already cost sessions, and the
module map. Read it as instructions, not background. What follows is the rest.

## Commands

```bash
npm test                       # everything that costs no API quota (68 suites, 4-wide)
KINGDOM_TEST_WIDTH=1 npm test  # serialize; use when a failure looks like a race
node test/t-pages.js           # one suite — every test/t-*.js runs standalone
npm start                      # Electron shell (spawns the daemon)
node src/daemon.js <repo> --port 7777   # daemon only, for browser-driven work
node src/cli.js <repo> "first order"    # headless terminal court
npm run doctor                 # preflight the CLIs — from a plain terminal, not from inside Claude Code
npm run dist                   # NSIS installer into dist/
```

`node test/t-agent.js` and `node test/t-comms.js` spend real API quota and are
excluded from `npm test`. Run them deliberately.

**Many `src/` and `ui/` modules are their own test suite.** `node src/bus.js`,
`src/ripeness.js`, `src/modes.js`, `src/price.js`, `ui/court.js`,
`ui/names.js`, `ui/graph.js`, `ui/views/home.js` and others self-check when
invoked directly, and `test/run-all.js` lists them as suites. If you change
pure logic in one of those files, run the file.

`npm test` re-runs a failed suite alone before reporting it — several suites
use real ports, git, or the tick loop and lose races under load. A suite
printed as `flaky` passed on that retry.

## Architecture

Three processes, on purpose. **Electron** (`electron/main.js`) is a thin shell
that spawns the daemon and shows the UI — it never runs orchestration, because
Electron's bundled Node has no `node:sqlite`. The **daemon** (`src/daemon.js`,
HTTP + SSE) runs the court under Node 24+ and survives the window closing. The
**court** (`src/kingdom.js`) spawns each member as its own CLI process
(`src/agent.js`), normalising claude / codex / agy / opencode to one event
shape.

Everything crosses `src/bus.js` — a SQLite message bus, event log and kv store
living in `<repoParent>/.kingdom/<repoName>/`, outside the target repo. Members
call each other through `src/mcp.js`, whose toolset is filtered per role *and*
per mode (`src/modes.js`) so no member's cached prompt prefix carries tools it
cannot call.

Cost is the design constraint, and the constants that govern it are derived,
not chosen: `src/ripeness.js` (batching), `src/recycle.js` (briefer recycle
threshold), `src/replay.js` (delivery windows), `src/price.js` (rate card for
CLIs that report no cost). Each has a measured derivation in a comment beside
the value. `node src/ctx.js <repo>` reports where a real session's money went.
Re-derive with these tools before touching a threshold — see rule 2 in
`AGENTS.md`.

### The UI

Vanilla ES modules, no build step, no framework. `ui/store.js` is the single
state owner (DOM modules never keep their own copy of the stream or start their
own timers); `ui/main.js` owns routing, the one stream/poll lifecycle, and
route cleanup; `ui/sidebar.js`, `ui/thread.js` and `ui/views/` render. Prefs
live under one `kd.prefs` key.

View mounts must return their cleanup **synchronously** and guard late
responses with a request token — navigation has to be able to cancel a view
before its first request settles.

`PLAN.md` is the authoritative contract for the current UI rebuild; the root
`HANDOFF.md` carries the live continuation state, including what has and has not
been verified at runtime. Read both before changing UI files.
