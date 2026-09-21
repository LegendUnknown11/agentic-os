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

Then read [verify](../verify/SKILL.md) before reporting the result. A green
stylesheet suite is source evidence about the *stylesheet*. It says nothing
about how the pixels look, and this repository has no visual acceptance for any
of it — the Browser pane cannot supply that, because its screenshots compose
only while the pane is visible and it runs with reduced motion. Visual
acceptance needs a visible Electron or browser session.

Done when: the suites above pass, no literal colour was added outside `:root`,
the selector was edited at its declaration, and the report says which evidence
is held and that visual acceptance is not.
