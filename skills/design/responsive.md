---
name: responsive
description: anything that has to work on a phone as well as a desktop
---
# responsive

1. **Design the narrow case first.** Widening a small layout works; cramming a
   wide one does not.
2. **Breakpoints follow the content**, not device names. Add one where the
   layout actually breaks.
3. **Let the layout do it.** Flex and grid with `minmax`, `clamp()` and
   `auto-fit` remove most breakpoints outright. Reach for a media query when
   intrinsic sizing genuinely cannot express it.
4. **Relative units.** `clamp()` for type. `max-width: 100%` on every image.
5. **Wide content scrolls inside its own container** — tables, code, diagrams.
   The page body must never scroll horizontally.
6. **Touch targets 44px minimum** on coarse pointers. Hover states must not be
   the only way to reach anything.
7. **Respect the safe area** on notched devices, and test with the keyboard open.

Check at 320px wide, at 200% browser zoom, and with the longest string a real
user will paste in.
