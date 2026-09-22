# apps — connectors and CLIs

Parent: [[index]] ([index.md](index.md)).

Connector inventories go stale the moment they are written, so this file records
what the *workflow depends on* and where the live list is, not a snapshot of it.

Live list: `claude mcp list`, or `/mcp` in an interactive session.

## Depended on

| Tool | Used for | Breaks if missing |
|---|---|---|
| `gh` | the PR record, which is the only reliable branch-liveness test here | branch audits silently report merged branches as dead |
| `claude` | every headless routine in [routines/README.md](../routines/README.md) | scheduled loops fail with no output |
| `node`, `npm` | the test gate, the daemon, every self-check | everything |
| `schtasks` | routine registration on Windows | routines exist as recipes only |
| `flutter`, `dart`, `adb` | the [[pilot]] target | pilot evidence cannot be captured |
| Chromium, via `npx playwright install chromium` | `test/t-theme-geometry.js` reads real computed geometry from a real tab | that suite skips itself with a note and layout goes uncovered, silently green |

## Visual evidence

The Playwright MCP server is how the interface gets exercised in a real
browser, and it is the reason `.playwright-mcp/` is gitignored — its
screenshots and console dumps are evidence for a session, not project state.
The 2026-09-21 live session that found eight layout defects behind 73 green
suites ran this way.

Prefer it over the built-in Browser pane for visual work. The pane composes
screenshots only while it is visible and runs with reduced motion, so it cannot
settle a layout or motion question on its own.

`test/t-theme-geometry.js` is the same capability wired into the suite, and it
needs a locally installed Chromium rather than the MCP server.

## Gaps worth closing

- **GitHub MCP is unauthorized.** The workflow leans on `gh` instead, which
  works and is scriptable. Authorizing it would mainly buy inline PR reads.
  Authorization needs an interactive session; it cannot be done headlessly.
- **No connector for the daemon itself.** The court is driven over HTTP and SSE
  from `src/daemon.js` on port 7777. Nothing exposes it to a Claude Code
  session, so inspecting a live run means curl, Playwright against the UI, or
  the Electron window. A thin MCP wrapper over its existing read endpoints is
  the one wrapper this workspace would actually use — build it when a live run
  needs watching, not before.

## Before building a wrapper

The daemon already speaks HTTP. `src/mcp/` already has seven tool modules and
`test/t-tool-surface.js` pins the surface. A new tool goes there and is tested
there; a standalone wrapper outside the repo would duplicate both.
