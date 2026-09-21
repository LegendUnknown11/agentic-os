# Agentic OS

Read [HANDOFF.md](HANDOFF.md) before acting. It owns the architecture map, the
test gate, the operating rules every change must satisfy, the Windows and CLI
traps that fail silently, and the current continuation state.

[PLAN.md](PLAN.md) owns the approved product contract and its acceptance
criteria. Read it before scoping or starting work.

[.claude/arms/index.md](.claude/arms/index.md) routes by domain: which paths,
skill and trap apply to the work in front of you. It points; the two files
above still rule.

## Standing discipline

**Type every claim before asserting it.** A claim is *read* (seen directly this
session), *derived* (computed from something read), *remembered* (from memory or
an earlier session), or *convenient* (assumed because it makes the answer
simpler). Verify a remembered or convenient claim before acting on it. "The
handoff says X" is not "X is true now" — this file has shipped stale figures
before.

**Type the evidence too.** A passing suite is source evidence. It is never
visual, Electron, device, signing, provider, or human-acceptance evidence. State
which kind you hold and which you lack.

**Close the loop.** After a change, run the thing that proves it — the test, the
diff, the output. An edit that is written is not an edit that works.

**One change at a time.** Small independently verifiable steps, so a wrong turn
is cheap to find and cheap to undo.
