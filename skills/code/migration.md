---
name: migration
description: a schema change, a data backfill, or a rename across many call sites
---
# migration

The dangerous part is not the new state, it is the window where both exist.

1. **Expand, migrate, contract.** Add the new thing alongside the old. Move
   readers, then writers. Backfill. Only then remove the old — in a later
   change, after the new path has actually run.
2. **Every step must be independently deployable and reversible.** If step 2
   cannot ship without step 3, it is one step and you have not decomposed it.
3. **Find every site before you change any.** `grep` the name; count them; say
   the number. Missing three of forty is worse than not starting.
4. **Backfill in batches**, resumable, with progress. A one-shot script that
   dies at 80% leaves you worse off than at 0%.
5. **Write the rollback** before you run the migration. If there is no rollback,
   say so out loud before starting, not after.
6. **Test on a copy of real data**, including the ugly rows.

Never destroy the old column in the same change that stops reading it.
