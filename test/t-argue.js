// `/argue` in the throne room.
//
// The argument mechanics — cross-vendor panel, judge that never argued,
// compulsory dissent — are pinned by src/argue.js's own self-check. What this
// covers is the WIRING, which is where a settings-shaped command goes wrong:
// it must answer the sovereign directly, never post itself to the court as
// work, and refuse cleanly when the kingdom cannot staff a panel.
//
// Deliberately never reaches a real model: every path here is one the court
// takes BEFORE spawning anything.
//
//   node test/t-argue.js
import { strict as a } from 'node:assert';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';

const repo = mkdtempSync(join(tmpdir(), 'kingdom-argue-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'kingdom.config.json');
const write = (models) => writeFileSync(configPath, JSON.stringify({
  models,
  king: { name: 'king', cli: 'codex' },
  jester: { name: 'jester', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

/* ---------- one model cannot argue with itself -------------------------- */
write({ codex: ['gpt-5.6-luna'] });
const solo = new Kingdom(repo, configPath);
solo.config.advisor = { autoModel: false, promptEngineer: false };
const said = [];
solo.on('compact', (d) => said.push(d.message));
const posted = () => solo.bus.history({ limit: 1000 }).length;

const before = posted();
const r1 = await solo.command('/argue should the settle window be longer?');
a.ok(r1.local, 'a refusal must answer the sovereign, not be posted to the court');
a.match(said.at(-1), /two different models/,
  'a single model arguing with itself is corroboration theatre — it must be refused, not faked');
a.equal(posted(), before, 'and nothing may reach the bus');

/* ---------- a question is required -------------------------------------- */
write({ claude: ['opus'], codex: ['gpt-5.6-luna'], agy: ['gemini-3.6-flash-high'] });
const k = new Kingdom(repo, configPath);
k.config.advisor = { autoModel: false, promptEngineer: false };
const heard = [];
k.on('compact', (d) => heard.push(d.message));
const argued = [];
k.on('argued', (d) => argued.push(d));

await k.command('/argue');
a.match(heard.at(-1), /Nothing to argue/);
a.equal(argued.length, 0, 'an empty question must not start a panel');

/* ---------- a real question names its panel before spending anything ---- */
// Stand in for the three model calls. Everything AFTER the argument — the vault
// note, the king's notice, the completion event — is what this exercises, and
// spawning three real CLIs to reach it would make the suite cost money.
const vault = mkdtempSync(join(tmpdir(), 'kingdom-vault-'));
k.config.vault = vault;
k.config.vaultWriteDir = 'Kingdom';
let sawCwd = null;
k.argueImpl = async (question, opts) => {
  sawCwd = opts.cwd;
  opts.onProgress?.({ stage: 'opening' });
  return {
    question,
    transcript: '### FOR\nthe window absorbs bursts\n\n### AGAINST\nit delays the human',
    verdict: 'VERDICT: keep it.\nBECAUSE: bursts dominate.\nDISSENT: the human waits.\nCONFIDENCE: medium',
    panel: opts.panel,
  };
};

const n = k.bus.history({ limit: 1000 }).length;
const r2 = await k.command('/argue is the 90s settle window too long?');
a.ok(r2.local, 'the command answers immediately — an argument is 3+ model calls, never awaited');
a.match(heard.at(-1), /judged by/, 'the sovereign must see who is arguing and who judges');
a.match(heard.at(-1), /three vendors/, 'and how strong that panel is');
// Nothing an argument produces may be WORK. The verdict notice below is
// allowed — it rides along with real traffic — but an assignment would buy the
// king a full context replay for a question it never asked.
a.equal(k.bus.history({ since: n, limit: 1000 }).filter((x) => x.kind !== 'notice').length, 0,
  'an argument must never post work to the court — only a notice that rides along');

// The panel it announced must be the cross-vendor one, or the whole point is
// lost: two samples of one model agree for reasons unrelated to the question.
const start = argued.find((d) => d.stage === 'start');
a.ok(start, 'the run must announce itself for the UI');
a.equal(new Set([...start.panel.arguers.map((s) => s.cli), start.panel.judge.cli]).size, 3);

// ...and then the verdict has to actually land somewhere.
// Poll rather than await an event: the argument is fired, not awaited, so with
// a fast implementation it has already finished by the time we could listen —
// and a listener attached too late waits for ever.
const waitFor = async (pred, ms = 5_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const hit = argued.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { error: 'the argument never finished' };
};
const done = await waitFor((d) => d.stage === 'done' || d.error);
a.ok(!done.error, `the argument must complete: ${done.error ?? ''}`);
a.equal(sawCwd, repo, 'arguers must run in the repo so they can read the code in dispute');
a.ok(done.path && existsSync(done.path), 'the verdict must be written to the vault, not just emitted');
const note = readFileSync(done.path, 'utf8');
a.match(note, /VERDICT: keep it/);
a.match(note, /DISSENT/, 'the dissent must survive into the record, not be edited out');
a.match(note, /<details>/, 'the full argument is kept but folded — the verdict is what gets read');

const last = k.bus.history({ limit: 1000 }).at(-1);
a.equal(last.kind, 'notice',
  'the king did not ask for this: it must ride along with real traffic, not buy a replay');
a.match(last.body, /VERDICT: keep it/);
a.match(last.body, /AWARENESS ONLY/);

/* ---------- an ordinary order is untouched ------------------------------ */
const m = k.bus.history({ limit: 1000 }).length;
await k.command('/argue-with-me is not a command');
const after = k.bus.history({ since: m, limit: 1000 });
// Assert the MESSAGE ITSELF arrived, not merely that the count moved. Counting
// passed even with the bug present, because the spurious argument it started
// posted its own verdict notice and made up the difference.
a.equal(after.length, 1);
a.equal(after[0].kind, 'assignment',
  'a word that merely STARTS with /argue is an ordinary order to the king — a word '
  + 'boundary sits before the hyphen, so \\b matched it and swallowed the message');
a.match(after[0].body, /is not a command/, 'and the whole message must survive intact');

rmSync(vault, { recursive: true, force: true });

for (const x of [solo, k]) x.bus.close?.();
rmSync(repo, { recursive: true, force: true });
console.log('t-argue.js OK — panel staffed across vendors, refused when it cannot be, never billed');
