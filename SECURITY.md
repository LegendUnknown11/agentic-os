# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems.

Report it privately with GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/LegendUnknown11/agentic-os/security). I'll reply as soon as I can.

Helpful things to include:

- What the problem is and what an attacker could do with it
- Steps to reproduce
- Your OS, Node version and which coding CLI you use

## Things worth knowing

- Agent permission defaults allow automatic tool use (Claude runs with `bypassPermissions`, Codex with `danger-full-access`). Read "Safety and limits" in the README before pointing Agentic OS at anything sensitive.
- Spend caps (`maxBudgetUsd`, `maxTotalUsd`) are off by default.
- If you accidentally commit a token, revoke it right away. Removing it from the repo is not enough because it stays in git history.
