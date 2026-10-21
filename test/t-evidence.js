// A completed run exports a self-contained evidence folder: diff, tests,
// review verdicts, cost, timeline, plus a manifest indexing all of them. This
// suite asserts every section both exists AND matches the run record it came
// from, not just that a file was written.
//   node test/t-evidence.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { assertRepo, createRunWorktree, revisionOf, runBranch } from '../src/worktree.js';
import { evidenceDir, exportEvidence, timelineOf } from '../src/evidence.js';
import { removeRepo } from './cleanup.js';

// Sandbox homedir(): the no-repo case below exports into stateDir(null),
// which is the REAL ~/.agenticos/workspace otherwise. os.homedir() reads these
// at call time, so setting them before the export is enough.
const fakeHome = mkdtempSync(join(tmpdir(), 'agenticos-evidence-home-'));
const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

// --- a real repo with a real run branch, same shape test/t-merge.js builds.
const repo = mkdtempSync(join(tmpdir(), 'agenticos-evidence-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'math.js'), 'export const add = (a,b) => a+b;\n');
git('add', '-A');
git('commit', '-qm', 'init');
const base = await assertRepo(repo);
const baselineRevision = await revisionOf(repo);

const runId = 'run-evidence-1';
const runWt = await createRunWorktree(repo, runId, base);
writeFileSync(join(runWt, 'subtract.js'), 'export const subtract = (a,b) => a-b;\n');
// commitAll is agent-scoped (wt/<agent>); a run worktree lives under
// runs/<runId>, so commit onto it directly, same shell shape as the agent
// setup above.
execFileSync('git', ['add', '-A'], { cwd: runWt, stdio: 'pipe' });
execFileSync('git', ['commit', '-qm', 'add subtract'], { cwd: runWt, stdio: 'pipe' });

const bus = new Bus(':memory:');
const created = bus.createRun({
  id: runId,
  objective: 'add a subtract helper',
  acceptanceCriteria: ['subtract(a,b) exists and is exported'],
  approvedPlan: { steps: ['write subtract.js'] },
  sourceSnapshot: { revision: baselineRevision },
  baselineRevision,
  branch: runBranch(runId),
});
a.equal(created.branch, `agenticos/run/${runId}`, 'sanity: the run carries the branch its worktree was cut on');

// Recovery history + revision-bound verification evidence, the shape
// agenticos.js actually writes (see #recordRecovery and finish_task's evidence
// object) — not an invented shape.
bus.updateRun(runId, {
  recoveryHistory: [{ name: 'coder', operation: 'process', message: 'transient spawn failure, retried', at: created.createdTs + 10 }],
  verificationEvidence: [{
    agent: 'coder', ran: true, ok: true, stale: false, valid: true,
    revision: 'deadbeef', submittedRevision: 'deadbeef', currentRevision: 'deadbeef',
    submittedAt: created.createdTs + 20, submissionId: 1,
    summary: 'subtract helper done', output: 'node --test\n# pass 1',
  }],
});

// An approval tied to this run, and its resolution — "what a reviewer said".
const approvalId = bus.post('orchestrator', 'user', 'Approve the plan for run-evidence-1?', 'approval', 'default', [], runId);
bus.set(`resolved:${approvalId}`, 'approved');
// A turn_end event inside the run's window, so cost has something real to sum.
bus.logEvent('coder', 'turn_end', { usage: { input_tokens: 1000, output_tokens: 100 } });

bus.transitionRun(runId, 'running');
bus.transitionRun(runId, 'verifying');
bus.transitionRun(runId, 'ready_for_review');
bus.approveRun(runId);
const completed = bus.applyRun(runId);
a.equal(completed.state, 'completed', 'sanity: the fixture run really is completed before export');

/* ---------- the export itself ------------------------------------------- */
const specOf = () => ({ cli: 'codex', model: 'gpt-5.6-luna' });
const { dir, manifest } = await exportEvidence(bus, repo, runId, { specOf });

a.equal(dir, evidenceDir(repo, runId), 'export must land at the documented per-run path');
a.ok(existsSync(dir), 'the folder must actually exist on disk');
a.equal(manifest.runId, runId);
a.equal(manifest.state, 'completed');
a.equal(manifest.diffAvailable, true, 'a repo with a real baseline and branch must produce a real diff');

const read = (name) => readFileSync(join(dir, name), 'utf8');
const readJson = (name) => JSON.parse(read(name));

/* manifest names every section, and every named file exists */
const sectionNames = ['run', 'objective', 'diffPatch', 'diffStat', 'tests', 'review', 'cost', 'timeline'];
for (const key of sectionNames) {
  a.ok(manifest.sections[key], `manifest must list a path for "${key}"`);
  a.ok(existsSync(join(dir, manifest.sections[key])), `the file the manifest names for "${key}" must exist`);
}

/* no pilot section unless the caller actually ran the pilot evidence gate
 * and passed its result in — evidence.js never runs Flutter itself */
a.equal(manifest.pilotIncluded, false, 'pilotIncluded must be false when no pilotEvidence was passed');
a.equal(manifest.sections.pilot, undefined, 'no pilot section must be written when nothing was passed');

/* run.json is the run record itself, byte-for-byte reconstructable */
const runOut = readJson('run.json');
a.equal(runOut.id, runId);
a.equal(runOut.objective, 'add a subtract helper');
a.deepEqual(runOut.acceptanceCriteria, ['subtract(a,b) exists and is exported']);
a.equal(runOut.baselineRevision, baselineRevision);

/* objective section mirrors the plan/acceptance fields on the actual record */
const objOut = readJson('objective.json');
a.equal(objOut.objective, bus.run(runId).objective);
a.deepEqual(objOut.acceptanceCriteria, bus.run(runId).acceptanceCriteria);
a.deepEqual(objOut.approvedPlan, { steps: ['write subtract.js'] });

/* diff is a REAL git diff of the run branch against the captured baseline */
const diffPatch = read('diff.patch');
a.ok(diffPatch.includes('subtract.js'), 'the diff must show the file actually added on the run branch');
a.ok(diffPatch.includes('export const subtract'), 'the diff must show the actual added content');
const diffStat = read('diff.stat.txt');
a.ok(diffStat.includes('subtract.js'), 'the stat must name the changed file');

/* tests section is exactly the run's own revision-bound verification evidence */
const testsOut = readJson('tests.json');
a.deepEqual(testsOut, bus.run(runId).verificationEvidence, 'tests.json must match the record field-for-field, not a summary of it');
a.equal(testsOut[0].output, 'node --test\n# pass 1', 'the actual test output text must survive into the bundle');

/* review verdicts: only this run's approval, with its resolution */
const reviewOut = readJson('review.json');
a.equal(reviewOut.length, 1);
a.equal(reviewOut[0].outcome, 'approved');
a.equal(reviewOut[0].body, 'Approve the plan for run-evidence-1?');

/* cost: a real, computed figure from the recorded usage, not invented */
const costOut = readJson('cost.json');
a.equal(costOut.members.length, 1);
a.equal(costOut.members[0].name, 'coder');
a.equal(costOut.members[0].turns, 1);
a.ok(costOut.totalUsd > 0, 'a priced member must yield a positive, real dollar figure');

/* timeline: matches timelineOf(run) exactly, and includes the recovery entry */
const timelineOut = readJson('timeline.json');
a.deepEqual(timelineOut, timelineOf(bus.run(runId)));
a.ok(timelineOut.some((e) => e.kind === 'recovery' && e.label.includes('coder')), 'the recovery entry must be in the timeline');
a.ok(timelineOut.some((e) => e.label === 'completed'), 'the completed transition must be in the timeline');

/* ---------- an optional pilot section, only when handed one ------------- */
const fakePilotEvidence = { blocked: false, ok: true, steps: { analyze: { ok: true } } };
const withPilot = await exportEvidence(bus, repo, runId, { specOf, pilotEvidence: fakePilotEvidence });
a.equal(withPilot.manifest.pilotIncluded, true, 'pilotIncluded must be true once pilotEvidence is passed');
a.ok(withPilot.manifest.sections.pilot, 'a pilot section must be listed once pilotEvidence is passed');
a.deepEqual(JSON.parse(readFileSync(join(withPilot.dir, withPilot.manifest.sections.pilot), 'utf8')), fakePilotEvidence,
  'pilot.json must be exactly what the pilot evidence gate produced, not a summary of it');

/* ---------- guardrails: a non-completed run refuses, visibly ------------ */
const midRunId = 'run-evidence-mid';
await createRunWorktree(repo, midRunId, base);
bus.createRun({ id: midRunId, objective: 'still going', baselineRevision, branch: runBranch(midRunId) });
await a.rejects(() => exportEvidence(bus, repo, midRunId), /only a completed run exports evidence/i,
  'a run still in flight must refuse to export rather than produce a half-true bundle');
bus.stopRun(midRunId); // a bus allows at most one active run; free the slot for the next fixture

/* ---------- guardrails: missing repo/branch degrades visibly, not a throw */
const noRepoId = 'run-evidence-norepo';
bus.createRun({ id: noRepoId, objective: 'no repo attached' });
bus.transitionRun(noRepoId, 'running');
bus.transitionRun(noRepoId, 'verifying');
bus.transitionRun(noRepoId, 'ready_for_review');
bus.approveRun(noRepoId);
bus.applyRun(noRepoId);
const { dir: noRepoDir, manifest: noRepoManifest } = await exportEvidence(bus, null, noRepoId, { specOf });
a.ok(noRepoDir.startsWith(fakeHome), `a no-repo export lands in the sandboxed home, not the real one: ${noRepoDir}`);
a.equal(noRepoManifest.diffAvailable, false, 'no baseline revision must be reported, not crash the export');
a.ok(noRepoManifest.diffUnavailableReason, 'the manifest must say WHY the diff is missing');

bus.close();
removeRepo(repo);
for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-evidence.js OK — every section present and field-for-field matching the run record, degrades visibly when repo/baseline is missing');
