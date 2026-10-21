---
name: handoff-audit
description: Check HANDOFF.md and PLAN.md against what the repository actually reports now. Use before trusting a figure, path, branch state, suite count or status from either file, before editing them, and at the end of a work session.
---

# handoff-audit

`HANDOFF.md` is the operating source of truth and it has shipped stale figures
more than once. Commit `018fae7` corrected four claims in one pass. This skill
is the pass.

A claim in those files is a **remembered** claim. Reading it does not make it
true. Re-derive it.

## The sweep

Work down [checks.md](checks.md). It pairs each claim class with the command
that settles it, and records which ones have gone stale before.

For every claim the command contradicts, correct the file to what the command
printed. Do not soften a contradicted claim into a hedge; replace it.

## What not to do

Keep `HANDOFF.md` and `PLAN.md` as the only active instruction documents.
`AGENTS.md` is a pointer, and `CLAUDE.md` holds standing
discipline and points here. A correction goes into the file that owns the fact.
Creating a third instruction document to hold it is the failure this repository
has already recovered from once.

Never put a credential, token or absolute vault path into either file.

## Reporting

State the count of claims checked, the count corrected, and each correction as
*was / is / proved by*. A sweep that reports "looks current" without naming the
commands it ran has proved nothing.

Done when: every class in [checks.md](checks.md) has been run, each
contradicted claim is replaced with the printed value, and the corrections are
listed with the command that settled each.
