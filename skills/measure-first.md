---
name: measure-first
description: anything described as slow, heavy, expensive, or "we should optimise"
---
# measure-first

Never optimise from a hunch. Every optimisation in this codebase that stuck was
measured before and after; the two that were reverted were not.

1. **Benchmark the real path**, through the interface the caller actually uses.
   Optimising a function nobody calls is the most common wasted day — check the
   caller is even reaching your code before you touch it.
2. **Write the number down** before you change anything.
3. **Change one thing.**
4. **Measure again on the same input.** Under 20% on a noisy machine is noise.
5. **Verify the change applied.** Read the file back. A patch that silently did
   not apply produces a very convincing "no improvement" result.
6. **A/B the fix**: break it deliberately and confirm the number gets worse. If
   it does not, you measured something else.

Report both numbers and the ratio. A rejected optimisation is a real result —
record why, with its measurement, so nobody re-derives it in three weeks.
