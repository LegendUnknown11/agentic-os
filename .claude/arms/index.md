# ARMS index

The dispatch table for this workspace. It routes; it does not rule. Authority
stays where it already lives:

- [HANDOFF.md](../../HANDOFF.md) — operating rules, architecture map, test gate,
  Windows and CLI traps, continuation state.
- [PLAN.md](../../PLAN.md) — the approved product contract and its acceptance
  criteria.
- [CLAUDE.md](../../CLAUDE.md) — standing discipline.

A fact stated here and also stated there is a bug. Point, do not restate.

## Domains

| You are working on | Router | First read |
|---|---|---|
| The Kingdom source: daemon, UI, tests, build | [[dev]] ([dev.md](dev.md)) | HANDOFF.md key-files table |
| The court the app runs: roles, its shipped skill set, the vault | [[court]] ([court.md](court.md)) | `src/skills.js`, `src/memory.js` header comments |
| The Habitable pilot target | [[pilot]] ([pilot.md](pilot.md)) | HANDOFF.md "Habitable pilot" |
| Connectors, MCP servers, CLIs | [[apps]] ([apps.md](apps.md)) | that file's table |

No content, marketing, or admin domain exists in this workspace. Add a router
when there is work to route, not before.

## Skills

Claude Code skills for working *on* this repo live in `.claude/skills/`. They
are a different system from `skills/` at the repo root, which is the court's own
shipped skill set loaded by `src/skills.js` and shipped in the Electron build.

| Skill | Fires when |
|---|---|
| [verify](../skills/verify/SKILL.md) | a change is about to be called done |
| [ui-change](../skills/ui-change/SKILL.md) | `ui/app.css` or any `ui/` view is touched |
| [handoff-audit](../skills/handoff-audit/SKILL.md) | HANDOFF.md or PLAN.md is read as truth, or a session ends |

Headless: `claude -p "/verify"`, `claude -p "/handoff-audit"`.

## Routines

[routines/README.md](../routines/README.md) holds the scheduled loops and their
registration script.
