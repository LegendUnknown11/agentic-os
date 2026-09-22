# pilot — Habitable

Parent: [[index]] ([index.md](index.md)). Authority for the preparation
sequence: HANDOFF.md under "Habitable pilot". Do not restate it here.

Target: `E:\AI\Mobile Apps\Habitable`. An offline-first Flutter app with local
Drift/SQLite, local-time scoring, history, notifications, and export/import.

Its own documents own its behaviour, and they outrank anything in this
repository about it:

| Owns | File |
|---|---|
| Behaviour | `E:\AI\Mobile Apps\Habitable\DESIGN.md` |
| Operating and build instructions | its `AGENTS.md`, `README.md` |
| Architecture | its `ARCHITECTURE.md` |
| Continuation state | its `HANDOFF.md`, `RESUME-PLAN.md` |

## Toolchain

Verified present on this machine 2026-09-22: `flutter` and `dart` at
`C:\src\flutter\bin`, `adb` at `%LOCALAPPDATA%\Android\Sdk\platform-tools`.
HANDOFF.md's note about unresolved Flutter and Android tool discovery predates
that and is stale as a blocker.

Emulator readiness, a physical device, and signing are separate from tool
presence and remain unproven.

## Before a worker touches it

The four-step sequence in HANDOFF.md is the gate: snapshot, capture fresh
evidence, demonstrate and audit into a finite backlog, then get that backlog
approved before implementation. The backlog approval is the step most likely to
be skipped; it is the one that makes the rest recoverable.
