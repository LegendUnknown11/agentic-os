# Contributing to Agentic OS

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Getting set up

1. Install **Node 24+** (the daemon needs the built-in `node:sqlite`).
2. Install and log in to at least one coding CLI: `claude`, `codex`, `agy`, `opencode` or `cursor-agent`.
3. Clone and install:

   ```sh
   git clone https://github.com/LegendUnknown11/agentic-os.git
   cd agentic-os
   npm install
   npm run doctor   # checks your setup, never spends quota
   ```

Run everything from a plain terminal, not from inside a Claude Code or Claude Desktop session.

## Before you change code

- Read [HANDOFF.md](HANDOFF.md). It is the architecture map and the operating contract for this repo.
- [PLAN.md](PLAN.md) holds the product contract and acceptance checks.
- Working with an AI agent? Point it at [CLAUDE.md](CLAUDE.md) or [AGENTS.md](AGENTS.md).

## Tests

```sh
npm test   # everything that costs no API quota
```

`test/t-agent.js` and `test/t-comms.js` spend real quota, so `npm test` skips them. Run them yourself only if your change touches agent processes or messaging.

A pre-commit hook (husky) runs checks before each commit. Please don't skip it with `--no-verify`.

## Pull requests

- Keep each PR to one change. Small PRs get reviewed faster.
- Say what you changed and why, and how you tested it.
- Add or update a test when you fix a bug or add behaviour.
- Never commit tokens or keys. Tokens belong in `~/.agenticos/tokens.json` or env vars, never in `agenticos.config.json`.

## Reporting bugs

Open an issue using the bug report template. Include your OS, Node version, which CLI(s) you use, and the output of `npm run doctor`.

For security problems, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
