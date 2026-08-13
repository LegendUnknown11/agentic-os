---
name: ship-safe
description: the whole path from "it works on my machine" to in front of a user
combo: test-first, review, ops:release-check, ship-it
---
# ship-safe
Everything between working code and a user, in order. Each part below gates
the next: do not review untested code, do not release unreviewed code.
