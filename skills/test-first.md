---
name: test-first
description: any behaviour change, bug fix, or new branch of logic
---
# test-first

The test is the specification. Written after, it describes what the code does;
written before, it describes what the code should do.

1. Write the smallest test that fails for the reason you care about.
2. **Watch it fail.** A test you never saw red is a test you never saw work.
3. Make it pass with the least code.
4. **Break the implementation on purpose** and confirm the test goes red again.
   This is the only proof the test is wired to the thing it names.
5. Assert on behaviour, not on internals. A test that breaks on a rename is a
   maintenance bill, not coverage.

One runnable check per piece of non-trivial logic. No fixtures, no frameworks,
no per-function suites unless asked. Trivial one-liners need no test.

Never leave a test inside a swallowed `try/catch` — a failed assertion there
vanishes and the suite reports green.
