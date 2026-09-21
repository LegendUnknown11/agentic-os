# dev — the Kingdom source

Parent: [[index]] ([index.md](index.md)). Authority: [HANDOFF.md](../../HANDOFF.md).
Its key-files table is the map; this file is the dispatch by task.

## By task

| Task | Enter at | Also touches |
|---|---|---|
| Run lifecycle, SQLite schema, migrations | [src/bus.js](../../src/bus.js) | `test/t-tasks.js`, `test/t-merge.js` |
| Worker spawn, recovery, verification | [src/kingdom.js](../../src/kingdom.js) | `src/worktree.js` |
| Worktrees, revision-bound tests, apply | [src/worktree.js](../../src/worktree.js) | `test/t-merge.js`, `test/t-branching.js` |
| HTTP actions, SSE, snapshots | [src/daemon.js](../../src/daemon.js) | `test/t-daemon-boot.js`, `test/t-csrf.js` |
| MCP tool surface | [src/mcp.js](../../src/mcp.js), [src/mcp/](../../src/mcp) | `test/t-tool-surface.js`, `test/t-mcp-chain.js` |
| Prompt assembly, context budget | [src/prompt.js](../../src/prompt.js) | `test/t-prompt.js`, `test/t-context.js` |
| Any visual or stylesheet change | [ui/app.css](../../ui/app.css) | run [ui-change](../skills/ui-change/SKILL.md) first |
| A view's behaviour | [ui/views/](../../ui/views) | `test/t-pages.js`, `test/t-panels.js` |
| Mode table, crew, vault directory | [src/modes.js](../../src/modes.js) | self-checking; `node src/modes.js` |

## Gate

One command, `npm.cmd test`, and the pre-commit hook runs it again. Read
[verify](../skills/verify/SKILL.md) before reporting a result — the suite count,
the known flaky suite, and what the evidence does not cover are all there.

## Traps this domain owns

Full list in HANDOFF.md under "Windows and CLI traps". The two that bite most
often here:

- A new suite is invisible until it is added by hand to the array in
  [test/run-all.js](../../test/run-all.js). Discovery is not a glob.
- A merged branch does not show under `git branch -r --merged`; this repo
  squash-merges. `gh pr list --state all --json headRefName,state` is the record.

## Build

`npm.cmd start` for Electron, `npm.cmd run dist` for the installer. The
`build.files` list in [package.json](../../package.json) decides what ships;
adding a runtime asset directory means editing it.
