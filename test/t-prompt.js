// The cached system prefix, pinned byte for byte.
//
// This is a CHARACTERIZATION test. It is not testing that the prompt is
// correct — it is testing that the prompt does not CHANGE without somebody
// deciding it should. That distinction matters here more than anywhere else in
// the codebase, because a change to this string is billed rather than thrown:
//
//   #doSpawn's own comment: "a changed system prefix is a changed prefix — the
//   whole cached context is then billed at the fresh rate ... new input was 28%
//   of a $101 bill while 96% of the tokens were replay."
//
// Eight suites touch #promptFor indirectly. Before this one, none asserted what
// it produces, so a reordered roster, a moved block or a stray newline silently
// repriced every session and nothing failed.
//
// briefFor(name) is the seam: it is public and calls #promptFor with
// seedPrompt = null and orientation = null, which is the resumed-member path.
//
// WHEN THIS FAILS: read the diff it prints. If you meant to change the prompt,
// update EXPECT and say so in the commit — you are choosing to rebill every
// live session. If you did not, you just broke prefix stability.
//
//   node test/t-prompt.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { removeRepo } from './cleanup.js';

process.env.AGENTICOS_CODEX_BIN = process.execPath;
process.env.AGENTICOS_SETTLE_MS = '150';

const repo = mkdtempSync(join(tmpdir(), 'agenticos-prompt-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

// Fixed in every respect that reaches the prompt: names, order, descriptions,
// titles. No vault, no goal, no advisor — each of those is varied deliberately
// below rather than left to whatever the machine happens to have.
const cfg = join(repo, 'agenticos.config.json');
writeFileSync(cfg, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  agents: [
    { name: 'coder', cli: 'codex', title: 'Master of Works', description: 'writes code' },
    { name: 'researcher', cli: 'codex', description: 'finds things out' },
  ],
  rolesSeeded: true,
  advisor: { promptEngineer: false, autoModel: false },
  summarizer: { enabled: false },
}));

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

// Filled by running this file with --print. Each entry is
// `${mode}/${member}` -> [sha256-16, byteLength].
//
// Two numbers, not one: a length alone would miss a same-length reordering, and
// a hash alone tells you nothing about HOW far the prompt moved when it breaks.
// Re-pinned 2026-10-21 by the de-theming rename: the words
// changed to team/user/agent/add_agent and nothing else, in src/ and in the
// shipped skills/ index every prompt carries; every prompt got 23-58 bytes
// shorter (measured: 6926->6873 for code/orchestrator).
const EXPECT = {
  'code/orchestrator': ['ed7136c7ef7cd20a', 6873],
  'code/briefer': ['826cdfe3d56f2606', 3780],
  'code/coder': ['c63816523ff9c2ad', 7167],
  'chat/orchestrator': ['77dd97142ebb9f70', 7225],
  'chat/briefer': ['35d23ebf097048e9', 4132],
  'chat/coder': ['bd5b13fa56d7e5ba', 7519],
};

const PRINT = process.argv.includes('--print');
const MEMBERS = ['orchestrator', 'briefer', 'coder'];
// code and chat, because the mode reaches the prompt and these two differ most.
// Measured: in chat the bench collapses to "none in this mode" (crew is empty),
// yet the orchestrator's prompt is LONGER — 6799 bytes against code's 6513 —
// because chat's own guidance outweighs the roster it drops. Pinning only one
// mode would have missed every block that varies by mode.
const MODES = ['code', 'chat'];

let failures = 0;
const seen = {};

try {
  const k = new AgenticOS(repo, cfg);
  k.on('error', () => {});
  await k.start();

  for (const mode of MODES) {
    k.setMode(mode);
    for (const member of MEMBERS) {
      const key = `${mode}/${member}`;
      const prompt = k.briefFor(member);
      a.ok(typeof prompt === 'string' && prompt.length > 200,
        `${key}: briefFor must return a real prompt, got ${typeof prompt}`);
      seen[key] = [sha(prompt), prompt.length];

      if (PRINT) continue;
      const want = EXPECT[key];
      a.ok(want, `${key}: no expectation recorded — rerun with --print`);
      if (want[0] !== seen[key][0] || want[1] !== seen[key][1]) {
        failures += 1;
        console.error(
          `\n  ${key} CHANGED\n`
          + `    was ${want[0]} (${want[1]} bytes)\n`
          + `    now ${seen[key][0]} (${seen[key][1]} bytes)\n`
          + `    ${seen[key][1] - want[1] >= 0 ? '+' : ''}${seen[key][1] - want[1]} bytes`
        );
      }
    }
  }

  // The prefix must not depend on anything outside the config. A second team
  // built from the same file, in a different directory, has to produce the
  // same bytes — otherwise every machine pays a fresh cache write.
  k.setMode('code');
  const twice = k.briefFor('coder');
  a.equal(sha(twice), seen['code/coder'][0],
    'briefFor must be deterministic within one team');

  await k.stop();

  if (PRINT) {
    console.log('const EXPECT = {');
    for (const [key, [h, n]] of Object.entries(seen)) console.log(`  '${key}': ['${h}', ${n}],`);
    console.log('};');
  } else if (failures) {
    console.error(
      `\n${failures} prompt(s) changed. If that was deliberate, rerun with --print `
      + 'and paste the new EXPECT — you are choosing to rebill every live session.\n'
    );
    process.exit(1);
  } else {
    console.log(`  ${Object.keys(seen).length} prompts byte-stable across ${MODES.length} modes`);
  }
} finally {
  removeRepo(repo);
}
