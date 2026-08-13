---
name: small-slice
description: a task that will not fit in one sitting, or a brief with more than one deliverable
---
# small-slice

Ship the thinnest end-to-end slice that a person could actually use, then
widen it. Breadth-first work leaves you with four half-things and nothing that
runs.

1. **Name the smallest useful whole.** Not "the auth layer" — "a user can log
   in with an email and password, nothing else".
2. **Make it work end to end**, ugly parts included. Stub what is genuinely
   external; never stub the middle.
3. **Verify it**: run it, test it, look at it.
4. **Then widen**, one slice at a time, each one shippable.

Split by *user-visible capability*, not by layer. A slice that is "the database
schema" cannot be verified by anyone.

If a slice is blocked, finish every other slice in full and say plainly what
was left and why. Narrowing scope silently is not your call.
