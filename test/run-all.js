// Every check that needs no API quota. `npm test`
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const suites = [
  ['bus self-check', join(HERE, '..', 'src', 'bus.js')],
  ['context audit', join(HERE, '..', 'src', 'ctx.js')],
  ['usage accounting', join(HERE, '..', 'src', 'usage.js')],
  ['delivery replay', join(HERE, '..', 'src', 'replay.js')],
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

let failed = 0;
for (const [label, file] of suites) {
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`\x1b[31mFAILED: ${label}\x1b[0m`);
  }
}
// t-agent.js and t-comms.js spend real API quota, so they stay opt-in.
console.log(failed ? `\n\x1b[31m${failed} suite(s) failed\x1b[0m` : '\n\x1b[32mall suites passed\x1b[0m');
process.exit(failed ? 1 : 0);
