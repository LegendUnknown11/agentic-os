# Specs — the three canvas features not built on `T3-code`

Written 2026-10-21 on the `functionality` branch (based on `T3-code` at
`e730bb6`). These are **specs, not implementations**. The sovereign chose
"spec them now" over building them, because each one has product decisions
that only they can make. Those decisions are listed under **Open questions**,
and nothing should be built until they are answered.

Claims are typed as CLAUDE.md asks. *Read* means seen in the source on this
branch, and *proposed* means a design choice that still needs approval.

The "Agentic OS - T3 Code style" canvas is not in the repository. What it
draws is known only from `PLAN.md`'s T3 section and the comment at the top of
`ui/inspector.js`. Each spec states what it assumes the canvas meant, so a
wrong guess is easy to spot and correct.

---

## 1. Remote control

### What exists (read)

- `src/daemon.js` already has a phone-approval mode. `--bind <addr>` (or
  `KINGDOM_BIND`) binds off-loopback. Every launch generates a random 32-byte
  bearer token, and it is never written to disk. A connection that did not
  arrive over loopback must present the token (`bearerAuthorized`, compared in
  constant time). With a valid token it can reach only `GET /api/ping`,
  `GET /api/approvals`, and `POST approve | reject | answerQuestion`
  (`REMOTE_READS`, `REMOTE_ACTIONS`, `remoteGate`). Loopback behaviour is
  unchanged.
- The daemon refuses a non-loopback bind if no token was generated.
- Missing pieces: the bind is fixed at launch, so it can't be switched while
  running, and nothing in the UI shows the token, the URL or a QR code.
- Tests: `test/t-csrf.js`, which uses the `KINGDOM_TEST_FORCE_REMOTE` and
  `KINGDOM_TEST_DISABLE_TOKEN` test seams.

### What the canvas's toggle is assumed to mean

A Remote control switch in the run's session inspector. When it's on, the
sovereign can follow the run and act on its gates from another device.

### Proposed design

1. **A runtime listener, not a rebind.** The loopback server stays exactly as
   it is. Turning the switch on starts a *second* `http.Server` on the chosen
   interface and port, and turning it off closes that server. Every request to
   it is treated as remote, whatever its source IP, so it always goes through
   `remoteGate`. This keeps the existing rule that loopback is classified by
   connection.
2. **The token is issued when the switch goes on.** Each "on" mints a fresh
   token and invalidates the previous one. It's held only in memory, the same
   as today. The UI shows it once, as a URL with the token in the fragment
   (`#t=…`, so it never reaches a server log) plus a QR code drawn locally with
   no network call.
3. **A remote surface that grows one step at a time.** Proposed tiers, which
   the sovereign picks:
   - **Approve** (today's surface): approvals list, approve, reject, answer.
   - **Watch**: adds read-only `GET /api/state`-equivalent run status, the
     run's blocker, spend, and a filtered `/stream` limited to run and approval
     events. No conversation content.
   - **Steer**: adds `run/pause`, `run/resume`, and sending a message to the
     orchestrator.
   No tier ever reaches `/api/command`, repo switching, uploads, config,
   tokens, or the full UI bundle (agents run unconfined, so an arbitrary
   command is code execution).
4. **A small remote page.** Serve a dedicated `/remote` page (approvals plus
   run status) instead of the full app shell. It reuses the T3 tokens and
   `tone()`.
5. **Expiry.** Remote control turns itself off after N minutes with no remote
   request (proposed: 60), and always when the daemon exits. Each remote
   action is recorded as a bus event with `origin: 'remote'`.

### API (proposed, additive)

- `POST /api/remote {on: bool, tier, bind?, port?}` (loopback only) returns
  `{on, url, tier, expiresAt}`. The token appears in `url` on the "on"
  response only.
- `GET /api/remote` (loopback only) returns `{on, tier, bind, port, lastSeenAt,
  expiresAt}` and never the token.

### Security notes

- Nothing is reachable off-machine until the sovereign turns the switch on,
  and it is always time-bounded.
- A plain-HTTP token on a LAN can be sniffed. Options: (a) accept that and say
  it in the UI, (b) a self-signed TLS listener with the fingerprint in the QR
  code, (c) leave transport to the user (Tailscale or similar) and bind only to
  that interface. **Proposed: (c) as the default, with (a)'s warning shown.**

### Open questions for the sovereign

1. Which tier is the ceiling: Approve, Watch or Steer?
2. Transport: LAN HTTP with a warning, self-signed TLS, or "bring your own
   tunnel"?
3. Where the switch lives: the inspector, as the canvas draws it, or Settings?
   It's global state, like mode.
4. Is the idle timeout acceptable, and if so for how long?

### Acceptance (proposed)

- A source test for each tier's allowed and refused routes, extending
  `t-csrf.js`'s pattern. A test that an old token is refused after it's
  re-minted. A test that the listener is closed when the switch is off.
- Device evidence: a real phone on the same network approves a real approval.
  This can't be held in the container. It's a developer-machine step.

---

## 2. Browser preview

### What exists (read)

- Each member works in its own git worktree (`src/worktree.js`). Kingdom state
  lives outside the target repo in a sibling `.kingdom` directory.
- The Electron court window uses `contextIsolation: true` and
  `nodeIntegration: false` with a preload (`electron/main.js`). No `webview`,
  `BrowserView` or `WebContentsView` is used.
- Nothing starts, tracks or proxies a target app's dev server.

### What the canvas's board is assumed to mean

A pane beside the run thread that shows the *target repository's* running app,
such as its dev server, as it is now inside the run's worktree. The sovereign
can look at what the agents built without leaving Agentic OS.

### Proposed design

1. **A preview is a declared command, not guesswork.** The target repo
   declares how to preview it, in `kingdom.config.json`
   (`preview: {command, cwd?, port?, readyPattern?}`) or a detected
   `package.json` `dev`/`start` script that the sovereign confirms once. The
   daemon never runs an undeclared script.
2. **One process per run worktree.** The daemon spawns the command in the
   run's worktree with `PORT` set to a free port (reusing
   `courts.firstFreePort`'s approach). It waits for `readyPattern` or for the
   port to open, keeps a 200-line log ring buffer, and kills the process tree
   when the run closes or the preview is stopped. Windows needs tree-kill and
   `.cmd` shims, which are traps in HANDOFF.md.
3. **Display.**
   - *Browser (daemon UI over HTTP):* a "Open preview" link to
     `http://127.0.0.1:<port>` in a new tab. Embedding it in an iframe would
     have to work around the target's own frame headers, so this doesn't try.
   - *Electron:* a `WebContentsView` docked beside the thread, with
     `contextIsolation`, no preload, no Node, `sandbox: true`, and navigation
     locked to the preview origin. The preview's content is untrusted code and
     must never reach the court preload.
4. **Agents can see it too (optional).** An MCP tool `preview_status` returns
   `{url, ready, lastLogLines}`, so a verifier can check the app boots. A
   screenshot tool would need Playwright and would be a separate decision.

### API (proposed, additive)

- `POST /api/preview {runId, action: 'start'|'stop'|'restart'}` and
  `GET /api/preview?runId=` return `{state: 'stopped'|'starting'|'ready'|'failed', url, pid, log}`.
- Stream events `preview` with `{runId, state}`.

### Open questions for the sovereign

1. Is "preview" the target app's dev server (assumed), or something else, such
   as rendering changed HTML or Markdown files?
2. How should it be declared: config only, or detecting `package.json` scripts
   with a one-time confirmation?
3. Embedding in Electron: is a docked `WebContentsView` wanted, or is opening
   an external browser enough?
4. What's in scope for the Habitable pilot? It's a Flutter app, so a "preview"
   there is an emulator, which is a different feature. Proposed: web targets
   only.

### Acceptance (proposed)

- Source: a fake dev server (a node script that prints "ready" and serves a
  page) is started, reaches `ready`, is served at the reported URL, and is
  killed when the run ends, with no orphan process. That's tested on Linux, and
  on Windows CI for tree-kill.
- Browser: the link opens a working page. Electron: the docked view loads, and
  it can't navigate away or reach `window.kingdom`.

---

## 3. Design canvas

### What exists (read)

- Uploads go to `<kingdomDir>/assets`, named so they can't escape it, through
  `/api/assets` (GET and POST) and are served at `/assets/*`.
- No board, layout or design-review surface exists. Agents can't attach images
  to a run.

### What the canvas's board is assumed to mean

This is the least certain of the three. The best guess is a per-run visual
board: images, mockups and screenshots, placed freely and annotated, that the
sovereign and agents share as a design brief and review surface. The canvas
itself appears to be a board of this kind.

### Proposed design (minimal and useful)

1. **The board is data.** A `run_boards` table, or one JSON file per run under
   `<kingdomDir>/boards/<runId>.json`, holds items
   `{id, kind: 'image'|'note'|'link', assetId?, text?, x, y, w, h, author, createdAt}`.
   Images use the existing asset store, so there's no new upload path.
2. **Agents can read and write it.** MCP tools `board_read` (items plus
   readable image paths) and `board_add` (note, or image from a worktree file
   copied into assets). A designer role, if f2's court has one, gets them by
   default.
3. **The UI is a run chip, "Board".** A pannable grid of cards with 44px
   handles, drag-to-place, and keyboard move (arrow keys), following
   `ui-change` rules. No freehand drawing in v1.
4. **Review.** "Pin as reference" adds a board item to the run's objective
   context (path plus caption), so the orchestrator's next turn can see it.

### Decided 2026-10-21

1. **Review surface.** The board is where agent output comes to the user for
   review. Design (1) above stands, but the board's default framing is
   "review", and items carry a review state (`open | approved | changes`)
   that the user sets.
2. **Free placement.** Cards are placed and resized freely (x/y/w/h), not in
   a gallery. Keyboard move and resize stay mandatory under `ui-change`.
3. **Both can add.** Agents (`board_add`) and the user can both add items,
   and every item records its `author`.
4. **Both, plus a canvas.** Imports (a Figma or Claude-design link and its
   thumbnail) *and* a native canvas. The canvas means freehand drawing and
   annotation over items, which reverses design (3)'s "no freehand in v1".
   Proposed: an SVG ink layer per board (`kind: 'ink'` items holding path
   data), so it stays data and can be reviewed and diffed.

### Open questions (original, now answered above)

1. Is the board a **brief** (inputs for agents), a **review** surface (agent
   output for the sovereign), or both?
2. Is free placement needed, or is an ordered gallery with captions enough?
   A gallery is far cheaper and fully keyboard-accessible.
3. Should agents be able to add to it, or only the sovereign?
4. Is this the same thing as a Figma or Claude-design import? If so, the
   board would hold links and thumbnails, not a canvas engine.

### Acceptance (proposed)

- Source: board CRUD, asset-path confinement (reuse the assets name tests),
  and MCP role gating.
- Browser: place, move by keyboard, and pin at three viewports, with no
  overflow and 44px targets (the T3 audit method).

---

## Suggested order once answered

1. **Remote control.** Its foundations and security model already exist, and
   it's the smallest change.
2. **Browser preview.** It's well defined once question 1 is answered, and it's
   the most useful to watch during a run.
3. **Design canvas.** It has the most open product questions. Start with the
   gallery version.
