---
name: ship-it
description: putting work in front of the sovereign or onto a branch
---
# ship-it

1. **Run the whole suite**, not the one test you touched. Twice if anything is
   timing-dependent.
2. **Read your own diff** top to bottom. Debug prints, commented-out code,
   stray files, a secret pasted into a fixture.
3. **Verify the claim you are about to make.** If you will say "this is 10×
   faster", have both numbers. If you will say "tests pass", they passed just now.
4. **Report failures as failures.** A test that fails, a step you skipped, a
   part you could not finish — say so plainly with the output. Silent omission
   is the one unrecoverable mistake.
5. **Never push to main or master** without a fresh, explicit instruction for
   that specific commit. A previous authorisation does not carry forward.

Say what you did, what you verified, and what you left. In that order.
