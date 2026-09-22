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
| Ending a court and switching repository | [electron/switch-repo.js](../../electron/switch-repo.js) | `test/t-repo-switch.js` |
| Rendered layout, as opposed to CSS source text | [test/t-theme-geometry.js](../../test/t-theme-geometry.js) | needs Chromium; skips itself without one |

## Gate

The gate and its operating rules belong to HANDOFF.md; the commands belong to
the `scripts` block in [package.json](../../package.json). Reach
[verify](../skills/verify/SKILL.md) before reporting a result — it covers the
suite count, the known flaky suite, and what the evidence does not reach.

## Traps this domain owns

HANDOFF.md's "Windows and CLI traps" section owns the list. The two that bite
most often in this domain, so you know which entries to look for: suite
discovery in [test/run-all.js](../../test/run-all.js) is a hand-maintained
array, and branch liveness cannot be read from ancestry.

## Build

Commands are in [package.json](../../package.json)'s `scripts`. The one thing
that block does not announce: its `build.files` list decides what ships inside
the installer, so a new runtime asset directory is invisible to the packaged app
until it is added there.
