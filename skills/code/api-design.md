---
name: api-design
description: designing a function, module boundary, or endpoint others will call
---
# api-design

An API is a promise you cannot cheaply take back.

1. **Write the call site first.** If it reads badly there, the signature is
   wrong — no amount of internal cleverness fixes an awkward interface.
2. **Make illegal states unrepresentable.** A type that cannot be wrong beats a
   validator that must remember to run.
3. **Few required parameters. Options object past three.** Booleans in an
   argument list are unreadable at the call site.
4. **One job.** A function that also logs, also caches, and also retries has
   three reasons to change.
5. **Errors are part of the interface.** Decide what a caller can do about each
   one. An error nobody can act on should not be thrown.
6. **Defaults that are right for the common case**, escape hatch for the rest.
7. **Ask what it costs.** A tempting API that hides an N+1 or a full re-read is
   a trap set for your own team.

Then write the smallest implementation that honours it.
