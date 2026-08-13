---
name: error-handling
description: anything touching IO, a network, a subprocess, or user input
---
# error-handling

Decide, per failure: recover, report, or crash. Silently swallowing is none of
those and is how data is lost.

1. **Validate at the trust boundary**, once, where untrusted input arrives.
   Inside the boundary, trust your own types.
2. **Never catch what you cannot handle.** An empty `catch` turns a loud bug
   into a silent wrong answer.
3. **Keep the cause.** Wrap with context, do not replace: "could not read
   config at /x: EACCES" beats "config error".
4. **Fail fast on programmer error, degrade on environment error.** A missing
   required env var should stop the process; a slow API should retry.
5. **Retry only idempotent work**, with a ceiling and a backoff.
6. **Clean up on every path** — `finally`, or the language's equivalent.
7. **Never let an error path lose data.** Write to a dead-letter file, refund
   the credit, keep the temp file. Losing work is the one unrecoverable outcome.

Messages are read by a person at 3am: say what failed, with what input, and
what to do about it.
