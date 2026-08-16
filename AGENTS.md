# AGENTS.md — Agentic OS

Instructions for any AI agent working in this repository. Codex and Antigravity read this file automatically from the working directory; Claude Code reads it via `CLAUDE.md`.

Court members working *inside* a kingdom get the sovereign's live instructions and memory index injected into their system prompt from the Obsidian vault (`Kingdom/Court Instructions.md`). **That vault note is the source of truth for how the court behaves.** This file is for agents working on *this codebase itself*.

## What this is

A multi-agent orchestrator shaped as a kingdom: a king decomposes and delegates, a jester watches cheaply and briefs, and peasants work in isolated git worktrees. Members message each other **directly over MCP** rather than routing everything through the king — that is the differentiator. Members run the Codex CLI, Claude Code CLI, or Antigravity (`agy`).

## Run it

```bash
npm test          # 38 suites, no API quota, must be green before you commit
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
- **The room is drawn, in `ui/index.html`.** `#hall` is an inline SVG — windows, columns, banners, dais, throne, runner — sitting between `#bg` and `#surface`. It is scenery: `aria-hidden`, no network request, colours from the same tokens as everything else. An earlier pass tried to carry the theme on gradients and a vignette alone and the verdict was that nothing had changed. Do not "simplify" it back to atmosphere.
- **`ui/app.css` declares every selector exactly once — keep it that way.** It used to end in five appended REFIT blocks that each overrode the last, so the rule you found was rarely the rule that won. Edit the rule where it lives; do not append an override section. Keep the evidence comments beside the values they explain.
- **The Browser pane reports `prefers-reduced-motion: reduce`**, so no animation plays there. Verify one by driving `Animation.currentTime` and reading computed styles, or open the app outside the pane.
- **Screenshots work, but only while the Browser pane is displayed.** `computer{action:"screenshot"}` returns "the Browser pane is not displayed, so the page is not compositing frames" otherwise — `preview_start{url}` re-displays it. Two live limits: the image is scaled down to 800px wide (so design at a viewport near 800 and read layout, not detail, above it), and region `zoom` is not implemented. If the pane wedges — `navigate` timing out at 300s, screenshots at 30s — close the stuck tabs and `preview_start` a fresh one; the daemon is almost never the fault, check it with `curl -o /dev/null -w "%{http_code}" http://127.0.0.1:7788/` first.

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
