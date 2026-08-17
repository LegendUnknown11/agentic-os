// Every check that needs no API quota. `npm test`
//
// Suites run in a small concurrency pool, not one after another. Nearly all the
// wall-clock here is a suite sitting in `await wait(...)` for a settle window or
// a git subprocess, so the CPU is idle almost the whole run — measured on this
// machine: 185.2s sequential (35 suites) -> 50-105s at 4-wide (38 suites). The
// spread is how much memory the box had free at the time, not noise in the
// measurement — see the retry note below. One run on a badly loaded box took
// 513.7s, with t-stt's cold model load alone accounting for 208s of it, so a
// slow run here is a reading of the machine and not of this file.
//
// Output is buffered per suite and printed when that suite finishes. Interleaved
// live output from four processes is unreadable, and the point of the printout
// is to tell you WHICH suite failed.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const suites = [
  ['bus self-check', join(HERE, '..', 'src', 'bus.js')],
  ['context audit', join(HERE, '..', 'src', 'ctx.js')],
  ['usage accounting', join(HERE, '..', 'src', 'usage.js')],
  ['turn pricing', join(HERE, '..', 'src', 'price.js')],
  ['approval payloads', join(HERE, '..', 'src', 'approval.js')],
  ['delivery replay', join(HERE, '..', 'src', 'replay.js')],
  ['recycle threshold', join(HERE, '..', 'src', 'recycle.js')],
  ['court vs roster', join(HERE, '..', 'ui', 'court.js')],
  ['doctor cli parsing', join(HERE, 't-doctor.js')],
  ['court memory + instructions', join(HERE, '..', 'src', 'memory.js')],
  ['concurrency', join(HERE, 't-concurrent.js')],
  ['token pool', join(HERE, 't-tokens.js')],
  ['worktree + merge', join(HERE, 't-merge.js')],
  ['jester recycle', join(HERE, 't-recycle.js')],
  ['compaction window', join(HERE, '..', 'src', 'compact.js')],
  ['/autocompact', join(HERE, 't-compact.js')],
  ['argument panel', join(HERE, '..', 'src', 'argue.js')],
  ['/argue', join(HERE, 't-argue.js')],
  ['repo creation', join(HERE, 't-ensure-repo.js')],
  ['turn batching', join(HERE, 't-batching.js')],
  ['obsidian vault', join(HERE, 't-vault.js')],
  ['budget + recycling', join(HERE, 't-budget.js')],
  ['incremental reads', join(HERE, 't-incremental.js')],
  ['accession briefing', join(HERE, 't-accession.js')],
  ['context measurement', join(HERE, 't-context.js')],
  ['dictation (SpeechBird)', join(HERE, 't-stt.js')],
  ['codex resume args', join(HERE, 't-codex-args.js')],
  ['stranded work rescue', join(HERE, 't-rescue.js')],
  ['standing court roles', join(HERE, 't-roles.js')],
  ['approvals and resting crew', join(HERE, 't-approvals.js')],
  ['real MCP approval chain', join(HERE, 't-mcp-chain.js')],
  ['summon payload validation', join(HERE, 't-summon-validation.js')],
  ['advisor: prompt engineer + model selector', join(HERE, 't-advisor.js')],
  ['wallpaper and music assets', join(HERE, 't-assets.js')],
  ['metrics, diff and vault panels', join(HERE, 't-panels.js')],
  ['antigravity (agy) backend', join(HERE, 't-agy.js')],
  ['turn summaries', join(HERE, 't-summarize.js')],
  ['the standing goal', join(HERE, 't-goal.js')],
  ['skill set + observation masking', join(HERE, 't-skills.js')],
];

// Four is not tuning for this machine's core count — the suites are waiting, not
// computing, so more workers keeps helping long past the CPUs. It is the point
// where the slowest suite (t-batching, ~30s of deliberate sleeping) stops being
// the thing everything else is queued behind. Capped by cores anyway so a small
// box does not thrash. `KINGDOM_TEST_WIDTH=1` reproduces the old serial run.
const WIDTH = Math.max(1, Math.min(
  Number(process.env.KINGDOM_TEST_WIDTH ?? 4), availableParallelism()));

/**
 * Run one suite to completion, capturing its output.
 *
 * Never throws. `spawnSync` always came back with a status; `spawn` can fail to
 * start a process at all, and then no 'close' ever arrives. That is not
 * hypothetical — on a box down to its last gigabyte this run died outright with
 * `Error: spawn UNKNOWN (errno -4094)` after 30 green suites, losing every
 * result with it. A test runner that cannot report "this one did not start" is
 * worse than a slow one, so a start failure is just another failed suite, and
 * the retry below gets to try again once the pool has drained.
 */
const run = ([label, file]) => new Promise((resolve) => {
  const done = (ok, out) => resolve({ label, out, ok });
  let out = '';
  let p;
  try {
    p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return done(false, `could not start ${label}: ${e.message}\n`);
  }
  p.on('error', (e) => done(false, `${out}\ncould not run ${label}: ${e.message}\n`));
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  // 'close' rather than 'exit': exit can fire before the pipes have drained, and
  // a truncated failure message is worse than no parallelism.
  p.on('close', (status) => done(status === 0, out));
});

// Running concurrently means competing for things a suite alone had to itself,
// and these suites use real resources: t-batching sleeps against the live 300ms
// tick loop, t-stt loads a Whisper model that wants gigabytes, several spawn git
// and bind ports. All three failure modes were seen here on a box with under a
// gigabyte free: `verified 0 !== 1` (t-batching), `mkl_malloc: failed to
// allocate memory` (t-stt), and neighbours dying beside it with 0xC0000409
// (t-agy, t-panels). Every one of them except t-stt passed when re-run alone.
//
// So a failure is RETRIED once, serially, with nothing else in flight, and the
// retry is what counts. That covers contention for memory, for timing and for
// ports without this file having to guess a per-worker memory budget or carry a
// list of suites to quarantine — both of which were tried here first and were
// wrong: the quarantine list only grew, and t-stt failed alone anyway when the
// machine itself was out of memory. A genuinely broken suite still fails twice
// and is still reported; it just costs one extra run of an already-failing test.
const started = Date.now();
const suspect = [];
const queue = suites.slice();
await Promise.all(Array.from({ length: WIDTH }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const r = await run(next);
    // A pass is final and printed now, so the run still shows progress as it
    // goes. Only failures are held back, and only until the pool is empty —
    // retrying one while three others still run would prove nothing.
    if (r.ok) process.stdout.write(r.out);
    else suspect.push(next);
  }
}));

let failed = 0;
for (const s of suspect) {
  const r = await run(s);                                 // alone this time
  process.stdout.write(r.out);
  if (r.ok) console.error(`\x1b[33mflaky (failed in the pool, passed alone): ${r.label}\x1b[0m`);
  else {
    failed++;
    console.error(`\x1b[31mFAILED: ${r.label}\x1b[0m`);
  }
}
console.log(`\n${suites.length} suites, ${WIDTH}-wide, ${((Date.now() - started) / 1000).toFixed(1)}s`
  + (suspect.length ? `, ${suspect.length} retried alone` : ''));

// t-agent.js and t-comms.js spend real API quota, so they stay opt-in.
console.log(failed ? `\n\x1b[31m${failed} suite(s) failed\x1b[0m` : '\n\x1b[32mall suites passed\x1b[0m');
process.exit(failed ? 1 : 0);
