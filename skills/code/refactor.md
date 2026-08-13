---
name: refactor
description: code that works but is hard to change
---
# refactor

Refactoring changes structure, never behaviour. If you are also fixing a bug,
you are not refactoring — do them in separate commits.

1. **Get it under test first.** Without a test, this is rewriting and hoping.
2. **One transformation at a time**, each leaving the suite green.
3. **Delete before you abstract.** Most tangled code is unreached branches,
   dead config, and a wrapper nobody calls. Half of it can just go.
4. **Wait for the third repetition** before extracting. Two similar things are
   often not the same thing, and the wrong abstraction costs more than duplication.
5. **Name for the caller**, in the domain's words.
6. **Stop when it is clear.** A refactor with no end condition is a rewrite
   wearing a hat.

If the tests needed changing, you changed behaviour. Say so.
