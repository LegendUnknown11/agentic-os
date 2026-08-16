// A real spend ceiling, and context recycling for ANY member.
//
// Both guard failures seen in a live run: a $5 cap that let a session reach
// $41 (because --max-budget-usd counts per process, and every restart reset
// it), and a king whose context reached 227k tokens with no recycle at all.
//
//   node test/t-budget.js
import { strict as a } from 'node:assert';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(join(tmpdir(), 'kingdom-budget-'));
const git = (...x) => execFileSync('git', x, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'k@kingdom');
git('config', 'user.name', 'kingdom');
writeFileSync(join(repo, 'README.md'), '# t\n');
git('add', '-A');
git('commit', '-qm', 'init');

const configPath = join(repo, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  maxBudgetUsd: 1,
  maxKingdomUsd: 10,
  recycleAtTokens: 100000,
  king: { name: 'king', cli: 'codex' },
  jester: { name: 'jester', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

/**
 * Use REAL agents so the orchestrator's own turn_end/error listeners are
 * attached — injecting a fake into the map bypasses all the wiring under test.
 * Codex members spawn no process until sent a turn, so patching send/stop on
 * the instance keeps this offline while leaving the plumbing genuine.
 */
function neuter(agent, { answerHandover = false } = {}) {
  agent.sent = [];
  agent.stopped = false;
  agent.send = function (t) {
    this.sent.push(t);
    if (answerHandover && /handover/i.test(t)) {
      setImmediate(() => {
        this.emit('text', 'Goal: ship tier 1. Coder merged. Coverage still pending.');
        this.emit('turn_end', { usage: {}, costUsd: 0 });
      });
    }
  };
  agent.stop = function () { this.stopped = true; };
  return agent;
}

const k = new Kingdom(repo, configPath);
await k.start();

// --- cumulative spend stops a member, and SURVIVES a restart ----------
await k.wake('coder');
const coder = neuter(k.agents.get('coder'));

const budgetEvents = [];
k.on('budget', (e) => budgetEvents.push(e));

// Four turns of $0.30 = $1.20, over the $1 member cap.
for (let i = 0; i < 4; i++) coder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0.3 });
await wait(200);

a.equal(budgetEvents.length, 1, 'crossing the member cap must fire exactly once');
a.equal(budgetEvents[0].scope, 'member');
a.equal(budgetEvents[0].name, 'coder');
a.ok(budgetEvents[0].spent >= 1, `spend should be >= cap, got ${budgetEvents[0].spent}`);
a.equal(coder.stopped, true, 'the over-budget member must actually be stopped');
a.ok(!k.agents.has('coder'), 'and removed from the awake set');

// This is the bit --max-budget-usd cannot do: persist across a restart.
const spentBefore = Number(k.bus.get('spent:coder'));
a.ok(spentBefore >= 1.2 - 1e-9, `cumulative spend recorded, got ${spentBefore}`);
await k.stop();

const k2 = new Kingdom(repo, configPath);
await k2.start();
a.equal(Number(k2.bus.get('spent:coder')), spentBefore,
  'cumulative spend must survive a restart — this is why $5 became $41');

// The sovereign can lift the ceiling deliberately.
k2.clearSpend('coder');
a.equal(Number(k2.bus.get('spent:coder')), 0, 'clearSpend must reset it');

// --- ANY member recycles on context, not just the jester --------------
const king = neuter(k2.agents.get('king'), { answerHandover: true });

const recycled = [];
k2.on('recycled', (e) => recycled.push(e));

// One turn whose replayed context is over the 100k threshold.
const bigTurn = () => king.emit('turn_end', {
  usage: { cache_read_input_tokens: 95000, input_tokens: 12000 },
  costUsd: 0.01,
});

// ...but never on the FIRST turn. One file-reading turn clears any threshold
// by itself, so recycling on it buys a handover turn to replace a session
// with a single turn in it — measured on a real run, the architect did this
// twice in a row and never accumulated anything worth inheriting.
const tokensBefore = Number(k2.bus.get('tokens') ?? 0);
bigTurn();
await wait(600);
a.equal(recycled.length, 0, 'a member must not be recycled after a single turn');

// Tokens are tracked alongside dollars, and they must be ALL the tokens the
// model read. This used to add `usage.input_tokens` raw, which for a claude
// member means the cache read is left out entirely — 12,000 counted out of
// 107,000 actually read. Same drift as everywhere else: the shape differs per
// CLI, so it has to go through usage.js.
a.equal(Number(k2.bus.get('tokens')) - tokensBefore, 107_000,
  'a claude turn must count its cache read too, not just the uncached remainder');
a.equal(Number(k2.bus.get('tokens:king')) > 0, true, 'and to the member who spent them');

bigTurn();
await wait(600);

a.equal(recycled.length, 1, 'the KING must recycle on context, not only the jester');
a.equal(recycled[0].name, 'king');
a.match(recycled[0].note, /Coverage still pending/, 'the handover note must be captured');
a.equal(king.stopped, true, 'the exhausted king must be retired');

const successor = k2.agents.get('king');
a.ok(successor && successor !== king, 'a successor king must be spawned');
a.match(successor.spec.prompt, /HANDOVER FROM YOUR PREDECESSOR/,
  'the successor must inherit the note');
a.match(successor.spec.prompt, /Coverage still pending/);

await k2.stop();

// --- a codex court can be capped at all --------------------------------
//
// The gap this closes: codex and agy hardcode `costUsd: 0`, and the whole live
// court is codex. So `#enforceBudget` compared 0 against the cap on every turn
// and neither maxBudgetUsd nor maxKingdomUsd could ever fire — the automatic
// runaway protection did not exist for the configuration actually in use.
// Now an unreported cost is priced from the rate card.
const repo3 = mkdtempSync(join(tmpdir(), 'kingdom-priced-'));
const git3 = (...x) => execFileSync('git', x, { cwd: repo3, stdio: 'pipe' });
git3('init', '-q');
git3('config', 'user.email', 'k@kingdom');
git3('config', 'user.name', 'kingdom');
writeFileSync(join(repo3, 'README.md'), '# t\n');
git3('add', '-A');
git3('commit', '-qm', 'init');

const cfg3 = join(repo3, 'kingdom.config.json');
writeFileSync(cfg3, JSON.stringify({
  // $3, so all three turns land before the cap trips. At $1 it fired on turn
  // one and the differencing below was never exercised.
  maxBudgetUsd: 3,
  recycleAtTokens: 10_000_000,          // not what is under test here
  king: { name: 'king', cli: 'codex', model: 'gpt-5.6-luna' },
  jester: { name: 'jester', cli: 'codex', model: 'gpt-5.6-luna' },
  peasants: [
    { name: 'coder', cli: 'codex', model: 'gpt-5.6-luna' },
    { name: 'mason', cli: 'codex', model: 'gpt-9-unreleased' },
  ],
}));

const k3 = new Kingdom(repo3, cfg3);
await k3.start();
await k3.wake('coder');
const priced = neuter(k3.agents.get('coder'));
const capped = [];
k3.on('budget', (e) => capped.push(e));

// codex-shaped, so CUMULATIVE: three readings climbing to 3M output. On luna
// ($1.20/Mtok out) that is $3.60, past the $3 cap. Reported cost: $0.00.
for (const out of [1e6, 2e6, 3e6]) {
  priced.emit('turn_end', {
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: out },
    costUsd: 0,
  });
}
await wait(300);

a.ok(Number(k3.bus.get('spent:coder')) > 0,
  'a codex member reporting $0 must still accrue spend from its rate card');
a.equal(capped.length, 1, 'and must trip the cap — this could never fire before');
a.equal(capped[0].name, 'coder');
a.equal(priced.stopped, true, 'the over-budget codex member must actually be stopped');

// Cumulative readings must not be summed: 1M+2M+3M reads as 3M of output, not 6M.
a.equal(Number(k3.bus.get('tokens:coder')), 3e6 + 10,
  'cumulative codex usage must be differenced, not added up');

// A model with no published price spends nothing rather than an invented
// amount — a cap enforced against a guess is worse than no cap.
await k3.wake('mason');
const unpriced = neuter(k3.agents.get('mason'));
unpriced.emit('turn_end', {
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 9e6 },
  costUsd: 0,
});
await wait(300);
a.equal(Number(k3.bus.get('spent:mason') ?? 0), 0,
  'an unpriced model must not have a price invented for it');
a.equal(capped.length, 1, 'and must not be stopped on the strength of one');
a.equal(unpriced.stopped, false);

await k3.stop();

for (const d of [repo, kingdomDir(repo), repo3, kingdomDir(repo3)]) {
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}
console.log('t-budget.js OK — cumulative ceiling survives restarts, codex courts can be capped, any member recycles');
