# AGENTS.md — Agentic OS

Instructions for any AI agent working in this repository. Codex and Antigravity read this file automatically from the working directory; Claude Code reads it via `CLAUDE.md`.

Court members working *inside* a kingdom get the sovereign's live instructions and memory index injected into their system prompt from the Obsidian vault (`Kingdom/Court Instructions.md`). **That vault note is the source of truth for how the court behaves.** This file is for agents working on *this codebase itself*.

## What this is

A multi-agent orchestrator shaped as a kingdom: a king decomposes and delegates, a jester watches cheaply and briefs, and peasants work in isolated git worktrees. Members message each other **directly over MCP** rather than routing everything through the king — that is the differentiator. Members run the Codex CLI, Claude Code CLI, or Antigravity (`agy`).

## Run it

```bash
npm test          # 37 suites, no API quota, must be green before you commit
npm run ctx -- <repo>   # where a court's context actually went
npm start         # the Electron app
node src/cli.js <repo> "first order"   # headless
node src/doctor.js      # preflight the CLIs — run from a normal terminal
```

## Rules that are not negotiable here

1. **Tests ship with the change.** Every suite in `test/` exists because something broke in production. Add to the suite that owns the area rather than making a new one. A test that passes before your fix is not a test of your fix — verify it fails without it.
2. **Never trust a measurement you did not take.** This project has twice tuned the wrong knob from an estimate. If you are about to change a threshold, measure first and put the number in the comment.
3. **Comments carry the evidence, not the intent.** `// this is faster` is noise; `// measured 3,635ms -> 331ms` is why the line survives the next refactor.
4. **Degrade, never wedge.** Anything that can hang, fail to spawn, or return nothing must end the turn and say so. A silent stall is the worst failure this system has.

## Traps that have already cost a session

- **codex takes its prompt on stdin** (`codex exec -`), never as an argument — Windows caps a command line at 32,767 chars and `spawn` throws *synchronously*, so `exit` never fires.
- **`codex exec resume` accepts a strict subset of `exec`'s flags.** No `-C`, `-s`, `-p`, `--oss`. Anything else goes through `-c`.
- **Any confining codex sandbox denies every MCP tool call**, so a member loses `send_message` and `declare_done` and says nothing about it. `danger-full-access` is the default for that reason.
- **codex reports no `total_cost_usd`.** Track tokens; dollars are not available.
- **`agy` self-updates and has changed flag arity mid-session.** If a member goes silent at exit 0, check `agy --help` before anything else.
- **`ui/app.css` has five appended REFIT blocks** that override earlier rules. Check whether a later block already overrides what you are editing, or your change will appear to do nothing.
- **Screenshots do not work** through either in-app browser pane — neither composites frames. Verify UI by reading computed styles, or take a desktop capture.

## Layout

| Path | What it owns |
|---|---|
| `src/kingdom.js` | The orchestrator: spawning, delivery, approvals, merges, prompts |
| `src/agent.js` | One member's process, per CLI. Where the spawn traps live |
| `src/bus.js` | SQLite message bus + event log |
| `src/memory.js` | The brain: vault instructions and the memory index |
| `src/skills.js` | The skill set: packs, combos, and the `/` index |
| `src/ctx.js` | Where a session's context went |
| `src/mcp.js` | The tools members call |
| `src/worktree.js` | Git isolation, test discovery, merges |
| `skills/` | The shipped procedures. `<pack>/<name>.md`; the vault overrides |
| `ui/` | The throne room (vanilla JS, no build step) |

Full workspace map and standing rules: `E:\AI\CLAUDE.md`.
