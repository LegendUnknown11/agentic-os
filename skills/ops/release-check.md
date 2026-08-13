---
name: release-check
description: immediately before anything reaches a user
---
# release-check

1. **Full suite, clean, on a clean tree.** Not the subset you touched.
2. **Build the thing that actually ships**, in the mode it ships in.
3. **Read the diff** — every file. Secrets, debug output, stray fixtures.
4. **Migrations run forward on a copy of real data**, and the rollback is written.
5. **Config**: every new env var documented and set where it runs. A feature
   that no-ops without a var must no-op quietly, not crash.
6. **Smoke the critical path by hand.** Log in, do the main thing, log out.
7. **Know how to undo it** — and how long that takes — before you do it.

If any of these did not happen, say which. A release checklist reported as done
when it was not is worse than no checklist.
