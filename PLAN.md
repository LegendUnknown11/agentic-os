# Agentic OS UI rewrite — current execution plan

## Outcome

Finish the flat, fixed-layout vanilla-ES-module renderer while preserving its published daemon, API, SSE, Electron IPC, workflow graph editor, and separate pet-window contracts. Verified security and correctness repairs may strengthen those boundaries without broadening the product. The running UI must replace the old floating/canvas renderer and be proven by both automated contracts and live runtime checks.

## Current evidence — 2026-08-29

The working tree is on `ui-rewrite` and deliberately dirty. It contains the rewrite; preserve it and do not restore removed legacy UI modules. The active renderer is `ui/main.js`, `ui/store.js`, `ui/sidebar.js`, `ui/thread.js`, and `ui/views/` with one fixed dark shell in `ui/app.css`.

Completed source work:

- The legacy floating/canvas/layout modules and `test/t-win.js` are removed.
- The store owns state, SSE reduction, one preferences key (`kd.prefs`), dismissal replay protection, roster roles/states, and money formatting.
- `main.js` owns the single stream, route mount/unmount lifecycle and shared ten-second tasks/changes refresh. Async views return cleanup synchronously and ignore stale responses.
- Sidebar, thread, approvals, changes, usage, activity, messages, agents, objective, memory, notes, automations, doctor and settings are mounted as full-page views. Chat, Cowork and Code remain the public modes; only Code permits repository merges.
- The latest renderer/daemon audit repaired the shared dispatcher so object action results (including `attachRepo`'s canonical `repo` and `base`) reach the renderer; void actions retain `{ ok: true }`.
- Thread wake/sleep controls recover from synchronous and asynchronous transport failures, and quick consecutive milestone additions retain the first local success until the next snapshot.
- Stale EventSource callbacks are ignored after replacement, malformed Activity rows render as an empty timeline, and narrow sidebar header labels truncate instead of clipping controls.
- Generic JSON action dispatch rejects primitive and array bodies with a clear 400 rather than leaking a handler TypeError, and Usage stores successful `/api/metrics` responses before rendering.
- Stale conversation-list responses and boot-failure view cleanup are guarded; Settings locks upload controls before the picker; stale send/upload completions cannot repaint a new thread.
- A live court now refuses a different repository before it can mix old worktrees with new repository state; same-repository attachment still leaves the existing court intact.
- Workflow storage rejects path-traversing IDs, and disabled webhook workflows cannot bypass their disabled state through the hook endpoint.
- Uploaded attachments now persist as sanitized asset references in the message bus, reach command and direct-member delivery, replay from history, and render as safe asset links. The migration preserves pre-existing transcripts with an empty attachment list.
- Thread routes now reconnect the shared stream at the active orchestrator conversation. A changed conversation deliberately receives its retained transcript; a same-scope reconnect retains its cursor catch-up.
- Pending approvals now persist independently of the prunable transcript, with one-time migration of retained records. Startup, live surfacing, and the approval API all read the durable records, so a pending decision survives pruning and restart.
- Durable approval retention is bounded: every pending decision is retained, while the newest 2,000 resolved decisions remain available to approval history and older resolved payload/status pairs are pruned together.
- A multi-member summon now resolves atomically from the sovereign's perspective: if any wake fails, newly started siblings are stood down, standing members from before the attempt remain intact, and the approval is durably marked blocked with a visible failure response.
- Workflow deletion remains idempotent for an already-missing file, but genuine filesystem failures now reach daemon and MCP callers instead of returning a false success.
- Workflow listing returns an empty set only before its directory exists; malformed records and genuine read failures now reach callers instead of looking like an empty automation list.
- Asset deletion follows the same rule: a missing asset is harmless, while a real unlink failure returns the existing retryable error response instead of claiming success.
- Asset listing returns an empty list only when the asset directory does not yet exist; real storage failures preserve the renderer's known list and surface a retryable error instead of looking empty.
- Asset writes are now filesystem-exclusive, so simultaneous uploads of one filename cannot overwrite each other; malformed percent escapes in asset URLs are rejected as 404 instead of causing a server error.
- The advisor model-history regression now isolates its advisor prompt capture from concurrent court-member stdin turns, removing a false serial-suite failure while preserving the real end-to-end selection check.
- Chronicle pagination now clamps every query limit to a safe 1–500 range, so negative or malformed values cannot expand a page into most of the retained narrative.
- Stream reconnect cursors now accept only positive safe integers; malformed values recover as a fresh snapshot rather than an empty transcript.
- Bus event readers now drop only malformed persisted payloads, preserving every readable event for stream snapshots, metrics, and chronicle views.
- Transcript recall now applies the same per-row recovery to indexed events, so one corrupt legacy payload cannot suppress readable matching history.
- A corrupt persisted summoned-crew record no longer aborts startup: the court warns and starts without restoring an unverifiable peasant crew.
- A corrupt persisted roster can no longer break a fresh SSE snapshot; the daemon warns and sends an empty roster so the renderer can remain live.
- Member MCP tools now parse roster and summoned-crew state through one guarded reader; corrupted state produces an explicit refusal for state-changing calls rather than a transport error or a false assignment.
- Member goal and milestone tools now turn a corrupt persisted goal into an explicit recovery message instead of failing their MCP call.
- Workflow HTTP nodes now carry a 30-second platform timeout, so an unresponsive endpoint becomes a recorded failed step instead of an indefinitely pending run.
- Workflow `foreach` now rejects more than the engine's existing 200-step budget before invoking any subnodes, preventing a large webhook array from creating unbounded work.
- Workflow HTTP reads now stream with the daemon's existing 2 MiB body budget, rejecting oversized remote responses before they can expand workflow context.
- Nested `foreach` subnodes now share the same 200-step execution budget, and the non-streaming HTTP fallback enforces the same 2 MiB response cap.
- `KINGDOM_TEST_WIDTH=1 npm.cmd test` passed after the latest storage, asset, advisor, chronicle, stream-cursor, event-recovery, crew-state, roster-stream, MCP state-recovery, and bounded workflow HTTP changes: 67 suites, 1-wide, 231.6s. Focused workflow storage, asset, advisor, panels, pages, stream, bus, approval, MCP, and workflow checks are also green.
- Live Electron/DevTools capture proves the Overview at 320, 375, 390, 768, and 1280 px has no horizontal overflow; the mobile drawer opens at 320 px, reduced motion is active, the Electron repository-picker bridge is present, and a live pet window exists. The real navigation controls opened all twelve workspace views plus Settings with their expected headings; the Activity `error` row was a historical API-error entry, not a failed page.
- The native desk-pet control now reopens the window after its own close control; this ran successfully in a freshly restarted Electron session.

Unproven work:

- Stateful user flows that would mutate a workspace, including composer submission, approval resolution, repository attachment, and automation changes.
- Native repository selection (the bridge is present, but the dialog remains deliberately uninvoked).
- The already-open in-app browser cannot currently be driven from this task: its browser-driver module is unavailable. No browser tab, Electron process, or operating-system window was opened while checking this.
- No remaining verified source-level correctness follow-up is currently open after the final serialized suite is green.

The managed host currently prevents the hidden Electron probe from completing:
its default profile/cache is denied, and a retry with a workspace-local profile
and disabled GPU timed out before the renderer loaded. Chrome headless was
also attempted with an isolated temporary profile, but its GPU process was
killed before it could write the first 320px screenshot. This is an environment
blocker, not evidence about the UI.

## Constraints

- Keep the daemon contract and `GET /modes.js` import intact; do not fork mode definitions in the renderer.
- Keep the status dot and `#bg` wash. Do not restore the removed hall, avatars, canvas, draggable windows, Grid/Canvas control, voice UI, rail, overview, panels or legacy `app.js`.
- `ui/app.css` declares every selector once. Edit the owning rule; do not add an override block.
- No framework, build step, dependency, new persistence key, per-view poller, or geometry persistence. Any lifecycle work must be released on navigation.
- Do not commit or push without a fresh explicit instruction.

## Execution

### 1. Static and contract audit

- Check every renderer action and imported asset against the daemon's served routes/actions. Repair a verified mismatch at the shared boundary and add a regression to the existing owning suite.
- Keep the state/lifecycle contracts covered: replayed snapshots do not revive dismissed members; agent updates preserve roles; awake/resting/off stay distinct; thread drafts are conversation-scoped; late async results cannot repaint an unmounted view.
- Run syntax checks and focused renderer suites after each substantive edit.

### 2. Live browser QA

Start the daemon against a disposable git repository and exercise the surface at 320, 375, 390, 768 and 1280 px widths. Record the evidence for:

1. Sidebar collapse/mobile drawer, keyboard focus, hover labels, no horizontal overflow and reduced motion.
2. Chat thread, conversation create/rename/archive/branch, attachments and the skill `/` menu.
3. Chat/Cowork/Code switching, add-agent approval, approval/question actions, changes review/merge and push gate.
4. Usage including quota meters, activity, objective/milestones, memory citations, notes, workflows/graph, doctor and every Settings tab.

Fix only observed or reproducible defects. Re-run the narrow owning test plus the visual path after every repair.

### 3. Electron QA

With a visible Electron session, run `npm.cmd start`; verify the main renderer, native repository picker, desk-pet open/close, and restart behaviour. Treat this as separate evidence from browser checks.

### 4. Completion gates

- The captured serialized `npm.cmd test` result remains green after each substantive change (latest: 67 suites, 1-wide, 231.6s). If a suite reports a pool-only failure, rerun it alone and investigate a repeatable failure.
- `git diff --check` passes.
- Static route/action audit is green, browser grid evidence exists, and Electron evidence exists. Until all are true, this plan remains in progress.

## Delegation protocol

Luna agents receive one disjoint file area or verification boundary at a time. They must inspect all callers before editing, preserve dirty work, make the smallest root-cause repair, add or extend the owning test when behaviour changes, and report exact commands and results. Parallel agents never edit the same file; integration happens only after their checks pass.
