---
name: ui-change
description: The contract for changing this repository's interface. Use before editing ui/app.css, any file under ui/ or ui/views/, a colour, a token, a status label, a tap target, or a view's render or cleanup path.
---

# ui-change

The interface has two contracts, both enforced by test rather than review. Read
the one your change touches before editing.

| Your change | Read |
|---|---|
| Colour, token, selector, spacing, radius, motion | [style.md](style.md) |
| A view's render, state, cleanup, or accessible name | [views.md](views.md) |
| A status label, badge, or dot | both — the vocabulary is shared |

Both, if you are unsure which. They are short.

## The one rule that spans both

`ui/app.css` is the whole design system, and its `:root` block is the only place
a colour may exist. Everything downstream reads tokens. A literal hex or a
coloured `rgb()` anywhere else cannot follow a palette change, and
`test/t-theme.js` fails the build for it.

## Proving it

```powershell
node test/t-theme.js
node test/t-pages.js
node test/t-thread.js
npm.cmd test
```

`t-theme.js` matches CSS source text. `t-theme-geometry.js` reads real computed
geometry from a real Chromium tab, and **skips itself with a note when Chromium
cannot be launched** — which is the case in this repository's CI. A green run
that skipped it proves nothing about layout, so read whether it ran.

Then read [verify](../verify/SKILL.md) before reporting the result. This is the
domain where source evidence has failed hardest here: on 2026-09-21 the
interface had 73 green suites and eight visible layout defects, six of them one
root cause. Visual evidence means a browser or Electron session, and the
repository now has a path for it rather than an excuse — see [apps](../../arms/apps.md).

Done when: the suites above pass, `t-theme-geometry` either asserted or is
reported as skipped, no literal colour was added outside `:root`, the selector
was edited at its declaration, and the report says which evidence is held.
