---
name: incident
description: something is broken in front of users right now
---
# incident

Stop the bleeding first. Understanding is the second priority, not the first.

1. **Mitigate**: roll back, disable the flag, scale up, fail over. A revert now
   beats a fix in an hour.
2. **Confirm it stopped.** Look at the actual signal, not at your expectation.
3. **Timeline**, from the logs. What changed just before it started? It is
   nearly always a change.
4. **Then find the cause** properly — see `root-cause`. Under pressure the
   temptation is to patch the symptom; that is how the same incident recurs.
5. **Write it up blamelessly**: what happened, the impact, the cause, the fix,
   and what would have caught it earlier.
6. **One concrete prevention**, assigned. "Be more careful" is not one.

Keep a running note as you go. Reconstructing an incident afterwards from
memory produces a confident, wrong timeline.
