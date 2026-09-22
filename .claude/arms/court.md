# court — the agents the app runs

Parent: [[index]] ([index.md](index.md)).

Distinct from [[dev]]: that domain is the source, this one is the behaviour the
source configures. Changing a file here changes how every court member acts
without changing a line of logic.

| Concern | File | Contract |
|---|---|---|
| Roles and their levels | [roles.json](../../roles.json) | `test/t-roles.js`; a skill naming a role that does not exist fails at spawn |
| The shipped skill set | [skills/](../../skills) | `src/skills.js` self-check and `test/t-skills.js` |
| Vault reads, memory, instructions | [src/memory.js](../../src/memory.js) | its header comment is the doctrine |
| Mode table: crew, merge, vault dir | [src/modes.js](../../src/modes.js) | pure and self-checking |

## Editing the shipped skill set

The rules are owned by [src/skills.js](../../src/skills.js) — its header comment
states them and its self-check enforces them. Read it before editing `skills/`
rather than trusting a summary here.

The one thing that file does not say out loud, because it follows from `readDir`
rather than being written down: a `skills/<name>/SKILL.md` layout resolves as
the skill `<name>:skill`, so the modular directory shape used by Claude Code
skills silently produces a wrong name here.

Prove a change with `node src/skills.js` then `node test/t-skills.js`. The
self-check prints the current index size against its cap, which is the number to
watch when adding a skill.
