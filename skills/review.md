---
name: review
description: reviewing a diff, a PR, or your own work before calling it done
---
# review

Review in passes. One pass looking for everything finds nothing.

1. **Correctness.** Trace the real path with real values. Empty, null, one
   element, the boundary, the second call. Does the diff do what its message says?
2. **Blast radius.** Every caller of every changed signature. Every other place
   the same bug shape lives — one fixed instance of four is a false green.
3. **Failure modes.** What happens when the disk is full, the network hangs, the
   input is hostile, two of these run at once?
4. **Deletion.** What could go? Unreached branches, config with one value,
   abstraction with one implementation, comments restating the code.
5. **Tests.** Does one exist for the new branch, and does it fail without it?

Rank findings by severity and say which you actually verified against the code
versus which you suspect. A plausible-sounding unverified finding wastes more
time than silence.

Do not report style opinions as defects.
