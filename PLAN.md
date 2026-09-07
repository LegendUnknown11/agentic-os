# Make Agentic OS dependable for autonomous app improvement

## Goal and boundaries

Approve a concrete improvement plan once, let Agentic OS execute and recover independently, then return to one combined change set and an interactive walkthrough.

- Optimize for your daily use. Prove the coding workflow on Habitable before expanding project coordination and general workspace work.
- Include fixes, polish, and explicitly approved features. New ideas discovered during execution go into the next plan.
- Stop when the approved backlog is complete. Preserve partial results and report a concrete blocker when a required gate cannot be completed.
- Use existing subscriptions only. For the pilot, let the system assign Haiku and Luna to planning, implementation, briefing, and independent review.
- Defer hosted services, broad renaming, roster replacement, and another visual redesign.

## 1. Establish an explicit execution contract

Extend the existing SQLite bus, task list, approvals, and HTTP/SSE interfaces.

- Add a durable run record containing the source snapshot, approved plan, acceptance criteria, allowed models, task IDs, recovery history, and verification evidence.
- Use explicit states: `planning`, `running`, `paused`, `blocked`, `verifying`, `ready_for_review`, `completed`, and `cancelled`. Keep chronological campaign accounting separate; another chat message must not imply completed work.
- Add optional run association to tasks and approvals. Existing records remain readable through additive, idempotent migration.
- Expose current run state through HTTP/SSE and actions to approve, pause, stop, resume, and apply reviewed work. Reuse structured questions for decisions requiring you.
- Plan approval authorizes team selection, reassignment, model changes within the approved pool, local snapshot commits, and integration inside the isolated run. It does not authorize changing your original checkout, pushing, publishing, or adding metered providers.
- Treat follow-up messages as steering the active run unless you explicitly start a separate objective.

## 2. Close the execution, recovery, and verification loop

- Make `finish_task` submit run-owned work for verification. The controller marks it done only after required checks and independent review succeed; dependent implementation tasks then receive the integrated result.
- Keep workers isolated. Integrate accepted work into one run branch automatically, resolving conflicts there. Assign overlapping edits sequentially and serialize Flutter/Gradle verification.
- Bind test results and reviews to the actual revision checked. Changes after verification invalidate the affected evidence; the combined final revision must pass the complete acceptance gate.
- Reuse existing process failure detection, retry, reassignment, and work preservation. Allow the existing transport retry followed by one reassignment or model-change recovery attempt per unresolved failure; persist this history across restarts.
- An exhausted recovery attempt produces a visible blocker with the failed operation, preserved work, and next action. Continue independent approved tasks.
- On startup, reconcile saved state with actual processes, branches, and artifacts before resuming. Prevent duplicate submissions, integrations, and approvals.
- Pause prevents new work; Stop also terminates active run-owned processes. Both survive restart. Automatically resume only previously running, approved work.
- Restrict automated model selection to the approved subscription pool. Exhausted quota must never silently fall back to paid API usage.

## 3. Make progress and final review understandable

Improve the existing Overview, thread, and Changes views.

- Lead with the objective, verified deliverables, current work, blockers, and decisions awaiting you. Keep agent conversations and detailed logs available on demand.
- Distinguish “implemented,” “verified,” and “ready for your review.” Show the last meaningful progress event and any recovery underway.
- At final review, present one combined diff, acceptance checklist, commands and results, remaining limitations, and walkthrough steps with supporting captures.
- The walkthrough uses the actual running app. Screenshots alone do not count as interactive validation.
- Applying the result requires your final approval and a source-state comparison against the captured baseline. Apply only the run’s delta; if your checkout has changed, reconcile and refresh the review first.
- Preserve the current renderer architecture and lifecycle rules. Reconcile stale documentation against source and fresh checks, including the already-implemented question feature.

## 4. Prove it on Habitable

- Create an isolated snapshot containing Habitable’s current tracked changes and relevant untracked source files. Record a manifest; exclude credentials, operational identity, caches, and build output. Preserve the original checkout and Git state.
- Read its behavioral specification and establish fresh analysis, test, coverage, build, and emulator readiness. Historical passing results are not the baseline.
- Audit the current app and demonstrate its existing flows. Produce a finite improvement backlog supported by observed defects or explicit product proposals; obtain your initial plan approval before implementation.
- Preserve offline-first storage, local-time behavior, historical scores, privacy boundaries, and generated-code rules.
- Required pilot gates: Flutter analysis, `flutter test`, the existing handwritten-code coverage requirement, debug APK build, independent review, and emulator demonstration of every changed flow.
- Include Today actions, recovery/history behavior, and export/import in the emulator acceptance checklist; add notification checks when that behavior changes.
- Missing SDK or emulator capability leaves the pilot explicitly blocked with its partial result preserved. Toolchain installation, physical-device acceptance, signing, store release, and iOS verification are separate work.

## Tests and success criteria

- Extend existing owning suites for approval scope, task dependencies, stale verification, combined integration, recovery exhaustion, subscription restrictions, restart reconciliation, and immediate Stop.
- Exercise duplicate events, worker failure after partial edits, daemon restart during verification, merge conflicts, missing tools, quota exhaustion, and source changes before final application.
- Run the complete Agentic OS suite to its terminal result, plus browser/Electron acceptance for the new run controls. Confirm regressions fail without their fixes.
- The pilot succeeds when the approved backlog passes all required gates with no reminders, manual worker restarts, or repeated context from you between initial approval and final review.
- Record elapsed time, model usage, interventions, and review findings. Compare equivalent single-Luna and team runs from identical snapshots before claiming a speed or quality advantage.
- If the audit finds no justified changes, report that result without manufacturing work; it does not prove autonomous implementation performance.

Defaults: one active improvement run per workspace, at most two implementation/review workers initially, and no changes to existing batching or timeout thresholds without fresh measurements.
