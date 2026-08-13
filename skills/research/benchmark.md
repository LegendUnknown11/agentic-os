---
name: benchmark
description: comparing two implementations, or proving a change helped
---
# benchmark

A benchmark that measures the wrong thing is worse than no benchmark, because
it is believed.

1. **Benchmark through the real interface** with realistic input. Synthetic
   best-case input is how a 10× win becomes a 0% win in production.
2. **Warm and cold are different questions.** Say which you are answering.
3. **Repeat, and report the spread.** One run is an anecdote. Watch for a first
   run that is slower — that is the cost of a cold cache, and it is real.
4. **Control one variable.** Change one thing between runs.
5. **Verify the change is actually in the binary you ran.** A patch that did
   not apply is the most common source of "no difference".
6. **A/B the result**: break the optimisation and confirm the number regresses.
7. **Report cost as well as gain.** Memory, disk, complexity, per-process
   multiplied by every process. A 1.8× win that costs 150MB is a loss.

Record rejected optimisations with their numbers, so nobody re-derives them.
