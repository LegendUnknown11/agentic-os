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

`skills/` is loaded by [src/skills.js](../../src/skills.js) and shipped in the
Electron build. Its rules are enforced by test, not convention:

- One directory level only. A subdirectory is a *pack*: `skills/design/a11y.md`
  becomes `design:a11y`. Deeper nesting is unreachable, and a
  `skills/<name>/SKILL.md` layout would resolve as the skill `<name>:skill`.
- The index rides in every prompt of every member on every turn, capped under
  2200 characters. A new top-level skill spends that budget on all members
  forever; a skill inside a pack costs one shared line. Put it in a pack unless
  the court must know it exists without being told.
- Every skill needs `name` and `description` frontmatter and a body over 100
  characters. Every `combo:` step must resolve to a skill that exists.
- The sovereign's vault copy shadows a shipped skill of the same name, so a
  procedure can be overridden without editing the repo.

Prove a change with `node src/skills.js` (self-check) then `node test/t-skills.js`.
