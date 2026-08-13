---
name: dependency
description: considering adding a library, or auditing what is already installed
---
# dependency

Every dependency is a permanent obligation: its bugs, its breaking changes, its
supply chain, its install time.

1. **Does this need to exist?** Speculative need means skip it.
2. **Is it already here?** A helper, a util, a pattern in this repo. Look before
   you add — re-implementing what is two files over is the most common slop.
3. **Does the stdlib do it?** It usually does, and it never breaks.
4. **Does the platform do it?** A CSS feature, a DB constraint, an input type —
   free, and correct on edge cases you have not thought of.
5. **Does something already installed do it?**
6. **Can it be a few lines?** Then it is a few lines, with a test.
7. **Only then** add one — and check its size, its own dependency count, when
   it was last touched, and whether one maintainer could disappear.

Never add a dependency for something a small function covers. Never vendor a
whole framework for one helper.
