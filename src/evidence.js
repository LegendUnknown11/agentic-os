// One self-contained folder per completed run: what was asked for, what
// changed, what the tests said, what reviewers said, what it cost, and a
// timeline — everything HANDOFF.md's "Implemented run behavior" says a run
// record already carries, minus the SQLite file it lives in.
//
// Layout: <stateDir>/evidence/<run-id>/ — a sibling of wt/ and runs/, which
// is where worktree.js already keeps per-repo state under .agenticos/<repo>/.
// One file per section rather than one combined document, so "is section X
// present" is an fs.existsSync away and a human can open just the diff
// without parsing JSON. manifest.json is the index every section is listed
// in, plus whether the diff could be computed at all.
//
// Everything here reads the bus and the repo; nothing here mutates either —
// export is a report, not a side effect on the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, runBranch, git } from './worktree.js';
import { rates } from './forecast.js';


export const evidenceDir = (repo, runId) => join(stateDir(repo), 'evidence', String(runId));

/**
 * Unified diff + stat of the run's own branch against its captured baseline —
 * the same `base...branch` shape worktree.js's diffOf/statOf use for a
 * agent, reimplemented for a run branch (`agenticos/run/<id>`, not
 * `agenticos/<agent>`) rather than widening diffOf's signature for one caller.
 *
 * Never throws: a repo that is gone or a branch that was never created is a
 * visible "unavailable" reason in the bundle, not a failed export (operating
 * rule 3 — degrade visibly).
 */
async function diffSection(repo, run) {
  const branch = run.branch || runBranch(run.id);
  const base = run.baselineRevision;
  if (!repo || !base) {
    return { available: false, reason: 'No repository or captured baseline revision recorded on this run.', base, branch, diff: '', stat: '' };
  }
  try {
    const [{ stdout: diff }, { stdout: stat }] = await Promise.all([
      git(repo, 'diff', `${base}...${branch}`),
      git(repo, 'diff', '--stat', `${base}...${branch}`),
    ]);
    return { available: true, base, branch, diff, stat };
  } catch (e) {
    return { available: false, reason: `git diff failed: ${e.message}`, base, branch, diff: '', stat: '' };
  }
}

/** Chronological merge of state timestamps and recovery history — pure. */
export function timelineOf(run) {
  const stamped = [
    ['created', run.createdTs],
    ['plan approved', run.approvedTs],
    ['final review approved', run.finalApprovedTs],
    ['applied', run.appliedTs],
    ['completed', run.completedTs],
    ['cancelled', run.cancelledTs],
  ].filter(([, at]) => at != null).map(([label, at]) => ({ at, kind: 'state', label }));
  const recovery = (run.recoveryHistory ?? []).map((e) => ({
    at: e.at, kind: 'recovery', label: `${e.name} · ${e.operation}`, detail: e.message,
  }));
  return [...stamped, ...recovery].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/**
 * "What reviewers said": approvals raised against this run, each with its
 * resolution. Approvals are the one place a human verdict on a run (plan,
 * final review, push) is actually recorded — pure, given the rows bus.js
 * already exposes publicly (approvals(), get()).
 */
export function reviewOf(bus, run) {
  return (bus.approvals?.() ?? [])
    .filter((appr) => String(appr.runId ?? appr.run_id ?? '') === String(run.id))
    .map((appr) => ({
      id: appr.id, ts: appr.ts, sender: appr.sender, body: appr.body,
      outcome: bus.get(`resolved:${appr.id}`) ?? 'pending',
    }));
}

/**
 * What the run cost, from the same turn_end usage forecast.js already turns
 * into dollars — never an invented figure. A run carries no direct link to a
 * campaign or cost total of its own, so this sums real per-agent usage inside
 * the run's own [createdTs, completedTs] window.
 * ponytail: window-based, not member-scoped — a name active outside this run
 * but mid-turn inside the window would leak in. Narrow to run.taskIds' owners
 * and recoveryHistory names if that proves to matter.
 */
export function costOf(bus, run, { specOf, quotaClis = [], table } = {}) {
  const from = run.createdTs ?? 0;
  const until = run.completedTs ?? run.cancelledTs ?? run.updatedTs ?? Date.now();
  // bus.events()'s `since` filters by row id, not timestamp — there is no
  // id boundary that corresponds to "when this run started", so every
  // turn_end is fetched and the run's own [createdTs, until] window is
  // applied here on `ts` instead.
  const events = (bus.events?.({ type: 'turn_end', limit: Number.MAX_SAFE_INTEGER }) ?? [])
    .filter((e) => (e.ts ?? 0) >= from && (e.ts ?? 0) <= until);
  const members = [...rates(events, { specOf, quotaClis, ...(table ? { table } : {}) }).values()];
  const priced = members.filter((m) => m.metered);
  return {
    members,
    totalUsd: priced.length ? priced.reduce((t, m) => t + m.usd, 0) : null,
    totalTokens: members.reduce((t, m) => t + m.tokens, 0),
    unpriced: members.filter((m) => !m.metered).map((m) => m.name),
  };
}

/**
 * Write one folder that reconstructs `runId`'s story without the database.
 * Only a completed run exports — mid-run evidence is not the finished story
 * the backlog item asks for, and would go stale the moment the run moved on.
 */
export async function exportEvidence(bus, repo, runId, opts = {}) {
  const run = bus.run(runId);
  if (!run) throw new Error(`No run ${runId}.`);
  if (run.state !== 'completed') throw new Error(`Run ${runId} is "${run.state}"; only a completed run exports evidence.`);

  const dir = evidenceDir(repo, run.id);
  mkdirSync(dir, { recursive: true });

  const diff = await diffSection(repo, run);
  const write = (name, value) => {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return name;
  };

  const sections = {
    run: write('run.json', run),
    objective: write('objective.json', {
      objective: run.objective,
      acceptanceCriteria: run.acceptanceCriteria,
      approvedPlan: run.approvedPlan,
      sourceSnapshot: run.sourceSnapshot,
    }),
    diffPatch: write('diff.patch', diff.diff ?? ''),
    diffStat: write('diff.stat.txt', diff.stat ?? ''),
    tests: write('tests.json', run.verificationEvidence ?? []),
    review: write('review.json', reviewOf(bus, run)),
    cost: write('cost.json', costOf(bus, run, opts)),
    timeline: write('timeline.json', timelineOf(run)),
    // Only present when the caller ran the Habitable pilot's evidence gate
    // (src/pilot-evidence.js's runPilotEvidenceGate) against this run's
    // worktree and passed the result in — evidence.js stays decoupled from
    // Flutter entirely; it only ever writes what it is handed.
    ...(opts.pilotEvidence ? { pilot: write('pilot.json', opts.pilotEvidence) } : {}),
  };

  const manifest = {
    runId: run.id,
    state: run.state,
    exportedAt: Date.now(),
    diffAvailable: diff.available,
    ...(diff.available ? {} : { diffUnavailableReason: diff.reason }),
    pilotIncluded: Boolean(opts.pilotEvidence),
    sections,
  };
  write('manifest.json', manifest);
  return { dir, manifest };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/src/evidence.js')) {
  const { strict: a } = await import('node:assert');

  // Pure sections, checked without git or a real database.
  const run = {
    id: 'run-x', createdTs: 100, approvedTs: 150, finalApprovedTs: 300,
    completedTs: 400, cancelledTs: null, appliedTs: 350,
    recoveryHistory: [{ name: 'coder', operation: 'process', message: 'restarted', at: 200 }],
  };
  const tl = timelineOf(run);
  a.deepEqual(tl.map((e) => e.label), ['created', 'plan approved', 'coder · process', 'final review approved', 'applied', 'completed'],
    'timeline interleaves state transitions and recovery in time order');
  a.equal(timelineOf({ id: 'r' }).length, 0, 'a run with no timestamps and no recovery has an empty, not crashing, timeline');

  const fakeBus = {
    approvals: () => [
      { id: 1, ts: 120, sender: 'orchestrator', body: 'approve plan', runId: 'run-x' },
      { id: 2, ts: 130, sender: 'orchestrator', body: 'unrelated', runId: 'run-other' },
    ],
    get: (k) => (k === 'resolved:1' ? 'approved' : undefined),
    events: () => [
      { ts: 110, agent: 'coder', type: 'turn_end', payload: { usage: { input_tokens: 1000, output_tokens: 100 } } },
      { ts: 9999, agent: 'coder', type: 'turn_end', payload: { usage: { input_tokens: 5000, output_tokens: 500 } } },
    ],
  };
  const review = reviewOf(fakeBus, run);
  a.equal(review.length, 1, 'only approvals carrying this run\'s id are included');
  a.equal(review[0].outcome, 'approved', 'a resolved approval reports its outcome');

  const specOf = () => ({ cli: 'codex', model: 'gpt-5.6-luna' });
  const cost = costOf(fakeBus, run, { specOf });
  a.equal(cost.members[0].turns, 1, 'usage after the run\'s completedTs is excluded from its own cost');
  a.ok(cost.totalUsd > 0, 'a priced member produces a real, non-null total');

  console.log('evidence.js self-check OK — timeline interleaves, review scopes by run id, cost windows by completedTs');
}
