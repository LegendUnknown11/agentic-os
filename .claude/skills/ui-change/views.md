# The view contract

Companion to [SKILL.md](SKILL.md). `test/t-pages.js` and `test/t-thread.js`
enforce this, mostly by matching source patterns — treat those guards as
load-bearing behaviour, not as string checks to satisfy.

## Compose, do not reinvent

`ui/views/util.js` holds the shared primitives every view composes from: `h`,
`page`, `section`, `button`, `field`, `input`, `select`, `meter`, `empty`,
`note`, `tone`, `load`, `bind`. Writing a local version of one of these is the
most common way a view drifts out of the design system. Look there first.

The renderer stays framework-free, and there is one shared stream and poll
lifecycle. Both are in HANDOFF.md operating rule 5.

## Mount and cleanup

A view's mount must return its cleanup **synchronously**, before its first
request settles. `t-pages.js` asserts that no `mountX` is declared `async`,
because the shell receives cleanup synchronously and an async mount hands it a
promise instead.

Anything a view starts, it stops: listeners, graph surfaces, editors. `graph.js`
exposes `destroy()`; automation editors own `disposeEditor(root)`.

## Stale responses

Every async repaint checks that it is still wanted before it writes to the DOM.
Two patterns are pinned in the suite, and both are required:

- a request token compared against current state
  (`state.workflowsRequest !== token`)
- a connectedness check on the root (`root.isConnected === false`)

A stale route failure must not replace the current page, and a successful
background poll must clear a stale error rather than leave it on screen.

## Accessibility

- 32px is the minimum tap target (`--tap-target-min`), the canvas's row height;
  chips are 28px (`--chip-h`). The user chose the canvas's sizes on 2026-10-21.
- Navigation regions carry a spoken name; the active item exposes
  `aria-current="page"`.
- The rerendered view container does not carry `aria-live` — announcing a whole
  page on every stream event is worse than announcing nothing.

## The Windows tooltip trap

Native `title` renders garbled on some Windows/Chromium builds. The rail draws
its own `.hover-tip` through `attachHoverTips(root)` in `util.js`. Reuse it for
any long hover text.

## Naming

The product is Agentic OS. The bare word "AgentOS" leaked into mode blurbs, the
header brand, the sidebar brand, a boot-failure heading and the no-script
fallback, and one guard in `t-pages.js` now watches every source it loads for a
reintroduction.
