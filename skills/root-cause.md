---
name: root-cause
description: a bug report, a failing test, or anything that "sometimes" happens
---
# root-cause

A bug report names a **symptom**. Your job is the cause. Patching where the
symptom surfaced leaves every sibling caller broken and buys a second bug.

1. **Reproduce it first.** No fix begins before you have made it happen on
   demand. If it is intermittent, find the condition that makes it reliable —
   ordering, empty input, a second call, a slow disk, a cold cache.
2. **Read the whole path.** From the entry point to the failure, every hop.
   Not the file the stack trace names — the path.
3. **Find every caller** of the function you are about to change. `grep` the
   name. If three callers can hit the same broken state, the guard belongs in
   the shared function, not in the one that reported it.
4. **Name the cause in one sentence** before editing. If you cannot, you have
   not found it. "It fails when X is empty because Y assumes at least one" is a
   cause. "There is a race" is a guess.
5. **Write the failing test**, watch it fail for the right reason, then fix.
6. **Break your own fix** to confirm the test catches it. A test that passes
   before and after the fix proves nothing.

Report the cause, not the diff. If you could not find it, say what you ruled
out and what you would need — a false confident answer costs more than none.
