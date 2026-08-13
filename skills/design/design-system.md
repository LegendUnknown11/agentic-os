---
name: design-system
description: building or extending a set of UI tokens and components
---
# design-system

The system exists so decisions are made once. Every value chosen at a call site
is a decision made again, differently.

1. **Find the existing system first.** In this workspace it is `globals.css` —
   tokens are the source of truth, not a document about them. Never start a
   second one.
2. **Tokens, then primitives, then components.** Colour, space, radius, type
   scale, shadow, duration, easing. Semantic aliases over raw values:
   `--surface-card`, not `--grey-3`.
3. **A scale, not a value.** Space and type come from a ratio. Ad-hoc values are
   how a system dies.
4. **A component earns its existence at the third use**, not the first.
5. **Every component ships its states** — including empty, loading and error.
6. **Never hardcode what a token covers.** If you need a value the system does
   not have, add it to the system.

Document by example, in code. A design system with a separate spec drifts from
the spec inside a month.
