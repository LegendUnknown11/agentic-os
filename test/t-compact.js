// `/autocompact` — the user changing the compaction window at runtime.
//
// The window used to be reachable only by editing agenticos.config.json and
// restarting the team. This drives the real AgenticOS to check the three things
// that make a settings command a settings command: it changes the setting, it
// PERSISTS it, and it never reaches the team as work.
//
//   node test/t-compact.js
import { strict as a } from 'node:assert';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticOS } from '../src/agenticos.js';
import { removeRepo } from './cleanup.js';

const repo = mkdtempSync(join(tmpdir(), 'agenticos-compact-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@agenticos');
git('config', 'user.name', 'agenticos');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  recycleAtTokens: 80_000,
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex', recycleAtTokens: 20_000 },
  agents: [{ name: 'coder', cli: 'codex' }],
}));

const k = new AgenticOS(repo, configPath);
// The advisor would make command() spawn a real model process.
k.config.advisor = { autoModel: false, promptEngineer: false };

const said = [];
k.on('compact', (d) => said.push(d.message));
const posted = () => k.bus.history({ limit: 1000 }).length;

/* ---------- a settings command is not work ------------------------------ */
const before = posted();
const r = await k.command('/autocompact 300k');
a.ok(r.local, 'a settings command must answer locally, not return a posted order');
a.equal(posted(), before,
  'nothing may reach the bus — a window change that costs the team a turn is self-defeating');
a.equal(k.config.recycleAtTokens, 300_000);
a.match(said.at(-1), /80k → 300k/, 'the user must see what changed, from what');

/* ---------- persisted, or the restart it avoids would undo it ----------- */
a.equal(JSON.parse(readFileSync(configPath, 'utf8')).recycleAtTokens, 300_000,
  'the window must survive a restart — that is the whole point of not editing the file by hand');

/* ---------- a bare call reads, it does not set -------------------------- */
await k.command('/autocompact');
a.equal(k.config.recycleAtTokens, 300_000, 'asking must not change anything');
a.match(said.at(-1), /300k tokens/);

/* ---------- a mistyped window answers, it does not throw or post -------- */
await k.command('/autocompact soon');
a.equal(k.config.recycleAtTokens, 300_000, 'a rejected window must leave the old one alone');
a.match(said.at(-1), /auto/, 'the error must name the forms that do work');
a.equal(posted(), before, 'still nothing to the team');

/* ---------- per member, in that member's own pane ----------------------- */
k.speakTo('briefer', '/autocompact 30k');
a.equal(k.specOf('briefer').recycleAtTokens, 30_000);
a.equal(k.config.recycleAtTokens, 300_000,
  "a member's pane must set that member's window, not the team-wide default");
a.equal(posted(), before, 'and must not be spoken to the briefer as an instruction');

// The orchestrator's pane is routed to command(); the local command must be caught
// BEFORE that, or the orchestrator's own window would silently become everyone's.
k.speakTo('orchestrator', '/autocompact 120k');
a.equal(k.specOf('orchestrator').recycleAtTokens, 120_000);
a.equal(k.config.recycleAtTokens, 300_000, "the orchestrator's pane is the orchestrator's, not the team's");

/* ---------- auto derives from measurement ------------------------------- */
// 40 turns whose contexts sit well below the current 300k window, so the tail
// is genuinely observed rather than truncated by compaction.
for (let i = 0; i < 40; i++) {
  k.bus.logEvent('coder', 'turn_end', { ctx: 20_000 + i * 500, usage: {} });
}
k.speakTo('coder', '/autocompact auto');
const derived = k.specOf('coder').recycleAtTokens;
a.ok(derived >= 35_000 && derived <= 45_000,
  `auto must land near the p90 of what was measured, got ${derived}`);
a.match(said.at(-1), /p90/, 'the user must be told the number was derived, not chosen');

// ...and must refuse when the data cannot answer. Compaction truncates the
// very tail auto measures, so a p90 hugging the window proves nothing — and
// re-deriving from it would ratchet the window down until the team did
// nothing but write handovers.
k.speakTo('coder', '/autocompact auto');
a.equal(k.specOf('coder').recycleAtTokens, derived,
  'a second auto on censored data must keep the window, not shrink it again');
a.match(said.at(-1), /[Nn]ot enough|censor|truncat/, 'and must say why it declined');

/* ---------- an ordinary order still goes through ------------------------ */
await k.command('ship the auth branch');
a.equal(posted(), before + 1, 'real work must still reach the team');

k.bus.close?.();
removeRepo(repo);
console.log('t-compact.js OK — window set, persisted, scoped per member, never billed as a turn');
