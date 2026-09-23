// A real spend ceiling, and context recycling for ANY member.
//
// Both guard failures seen in a live run: a $5 cap that let a session reach
// $41 (because --max-budget-usd counts per process, and every restart reset
// it), and an orchestrator whose context reached 227k tokens with no recycle at all.
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
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
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

// --- ANY member recycles on context, not just the briefer --------------
const orchestrator = neuter(k2.agents.get('orchestrator'), { answerHandover: true });

const recycled = [];
k2.on('recycled', (e) => recycled.push(e));

// One turn whose replayed context is over the 100k threshold.
const bigTurn = () => orchestrator.emit('turn_end', {
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
a.equal(Number(k2.bus.get('tokens:orchestrator')) > 0, true, 'and to the member who spent them');

bigTurn();
await wait(600);

a.equal(recycled.length, 1, 'the KING must recycle on context, not only the briefer');
a.equal(recycled[0].name, 'orchestrator');
a.match(recycled[0].note, /Coverage still pending/, 'the handover note must be captured');
a.equal(orchestrator.stopped, true, 'the exhausted orchestrator must be retired');

const successor = k2.agents.get('orchestrator');
a.ok(successor && successor !== orchestrator, 'a successor orchestrator must be spawned');
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
  orchestrator: { name: 'orchestrator', cli: 'codex', model: 'gpt-5.6-luna' },
  briefer: { name: 'briefer', cli: 'codex', model: 'gpt-5.6-luna' },
  peasants: [
    { name: 'coder', cli: 'codex', model: 'gpt-5.6-luna' },
    { name: 'refactoring-engineer', cli: 'codex', model: 'gpt-9-unreleased' },
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
await k3.wake('refactoring-engineer');
const unpriced = neuter(k3.agents.get('refactoring-engineer'));
unpriced.emit('turn_end', {
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 9e6 },
  costUsd: 0,
});
await wait(300);
a.equal(Number(k3.bus.get('spent:refactoring-engineer') ?? 0), 0,
  'an unpriced model must not have a price invented for it');
a.equal(capped.length, 1, 'and must not be stopped on the strength of one');
a.equal(unpriced.stopped, false);

await k3.stop();

// --- a subscription quota stops the whole CLI before another turn --------
const repo4 = mkdtempSync(join(tmpdir(), 'kingdom-quota-'));
const git4 = (...x) => execFileSync('git', x, { cwd: repo4, stdio: 'pipe' });
git4('init', '-q');
git4('config', 'user.email', 'k@kingdom');
git4('config', 'user.name', 'kingdom');
writeFileSync(join(repo4, 'README.md'), '# t\n');
git4('add', '-A');
git4('commit', '-qm', 'init');

const cfg4 = join(repo4, 'kingdom.config.json');
writeFileSync(cfg4, JSON.stringify({
  recycleAtTokens: 10_000_000,
  quotas: { codex: { label: 'Tiny Test Plan', limitTokens: 20 } },
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

const k4 = new Kingdom(repo4, cfg4);
await k4.start();
await k4.wake('coder');
const quotaCoder = neuter(k4.agents.get('coder'));
const quotaEvents = [];
const quotaFailures = [];
k4.on('budget', (e) => quotaEvents.push(e));
k4.on('failure', (e) => quotaFailures.push(e));

// Exactly the configured allowance. A ceiling is not an advisory percentage.
quotaCoder.emit('turn_end', { usage: { input_tokens: 20 }, costUsd: 0 });
await wait(200);

a.equal(quotaEvents.length, 1, 'reaching a subscription quota must surface one event');
a.deepEqual(quotaEvents[0], { scope: 'quota', cli: 'codex', label: 'Tiny Test Plan', used: 20, cap: 20 });
a.equal(quotaCoder.stopped, true, 'the member that reached the plan ceiling must stop');
a.ok(!k4.agents.has('coder') && !k4.agents.has('orchestrator'),
  'every member on the exhausted CLI must stop, not just the one that reported last');
a.match(quotaFailures.find((e) => /Tiny Test Plan/.test(e.message))?.message ?? '', /Tiny Test Plan.*20.*20/i,
  'the sovereign must be told which quota stopped the court and why');

const turnsBefore = k4.bus.events({ type: 'turn_end', limit: 100 }).length;
k4.bus.post('sovereign', 'coder', 'do not start another paid turn', 'assignment');
await k4.wake('coder');
await wait(500);
a.equal(k4.agents.has('coder'), false, 'waking an exhausted CLI must refuse before delivery');
a.equal(k4.bus.events({ type: 'turn_end', limit: 100 }).length, turnsBefore,
  'the refused wake must not spend a second turn');

await k4.stop();

// --- the kingdom-wide ceiling can be raised or lowered live --------------
//
// maxKingdomUsd used to take effect only at the process that read the
// config file — a court running hot had no lever except a restart, which
// is itself billed and stops nothing in the meantime.
const repo5 = mkdtempSync(join(tmpdir(), 'kingdom-livecap-'));
const git5 = (...x) => execFileSync('git', x, { cwd: repo5, stdio: 'pipe' });
git5('init', '-q');
git5('config', 'user.email', 'k@kingdom');
git5('config', 'user.name', 'kingdom');
writeFileSync(join(repo5, 'README.md'), '# t\n');
git5('add', '-A');
git5('commit', '-qm', 'init');

const cfg5 = join(repo5, 'kingdom.config.json');
writeFileSync(cfg5, JSON.stringify({
  maxKingdomUsd: 100,   // high enough that nothing below trips it before the live change
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

const k5 = new Kingdom(repo5, cfg5);
await k5.start();
neuter(k5.agents.get('orchestrator'));
neuter(k5.agents.get('briefer'));
await k5.wake('coder');
const liveCoder = neuter(k5.agents.get('coder'));
const liveEvents = [];
k5.on('budget', (e) => liveEvents.push(e));

a.throws(() => k5.setBudget(-1), /must be a number/, 'a negative ceiling must be refused');

const setResult = k5.setBudget(1);
a.equal(setResult.cap, 1);
a.equal(liveEvents.length, 1, 'setBudget must announce the change on its own, not wait for a trip');
a.deepEqual(liveEvents[0], { scope: 'kingdom', cap: 1, changed: true });

// $0.60 x 2 = $1.20 — under the CONFIGURED $100 cap, over the LIVE $1 one.
liveCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0.6 });
liveCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0.6 });
await wait(200);

a.equal(liveEvents.length, 2, 'the live ceiling must be the one #enforceBudget actually checks');
a.equal(liveEvents[1].scope, 'kingdom');
a.equal(liveEvents[1].cap, 1, 'the trip must report the LIVE cap, not the config default of 100');
a.equal(liveCoder.stopped, true, 'crossing the live ceiling must still stop the court for real');

await k5.stop();

// --- issue #41: a per-session TURN budget, beside the dollar ceilings ----
//
// maxBudgetUsd/maxKingdomUsd only ever fire once a model IS priced — a court
// running an unpriced or misconfigured model had NO ceiling of any kind.
// setTurnBudget()/turnBudget() mirror setBudget()/#kingdomBudget() exactly
// (a live override in the bus, config as the fallback), but #enforceTurnBudget
// PAUSES the court (the sovereign's own pause/resume machinery) rather than
// sleeping members, because a turn budget is a session-wide brake, not a
// per-member spend cap.
const repo6 = mkdtempSync(join(tmpdir(), 'kingdom-turnbudget-'));
const git6 = (...x) => execFileSync('git', x, { cwd: repo6, stdio: 'pipe' });
git6('init', '-q');
git6('config', 'user.email', 'k@kingdom');
git6('config', 'user.name', 'kingdom');
writeFileSync(join(repo6, 'README.md'), '# t\n');
git6('add', '-A');
git6('commit', '-qm', 'init');

const cfg6 = join(repo6, 'kingdom.config.json');
writeFileSync(cfg6, JSON.stringify({
  turnBudget: 2,   // low and explicit, so the DEFAULT_TURN_BUDGET fallback never matters here
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

const k6 = new Kingdom(repo6, cfg6);
await k6.start();
neuter(k6.agents.get('orchestrator'));
neuter(k6.agents.get('briefer'));
await k6.wake('coder');
const turnBudgetCoder = neuter(k6.agents.get('coder'));
const turnBudgetEvents = [];
k6.on('budget', (e) => { if (e.scope === 'turns') turnBudgetEvents.push(e); });
const pausedEvents = [];
k6.on('paused', (e) => pausedEvents.push(e));

a.throws(() => k6.setTurnBudget(-1), /must be a number/, 'a negative turn budget must be refused');
a.equal(k6.turnBudget(), 2, 'the configured turnBudget must be read back exactly');
a.equal(k6.paused, false, 'sanity: the court is not paused yet');

turnBudgetCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(200);
a.equal(k6.paused, false, 'one turn under a budget of two must not pause anything');

turnBudgetCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(200);
a.equal(k6.paused, true, 'reaching the turn budget must pause the court — the same mechanism as a manual pause');
a.equal(turnBudgetEvents.length, 1, 'the trip must announce itself on the shared "budget" event, same as the dollar ceilings');
a.equal(turnBudgetEvents[0].cap, 2);
a.equal(turnBudgetEvents[0].turns, 2);
a.ok(pausedEvents.some((e) => e.paused && /turn budget/i.test(e.why ?? '')),
  'the pause reason must name the turn budget, or the sidebar cannot tell it apart from a manual pause '
  + 'to decide whether to offer "raise and resume"');

// A resumed court whose cap is still unmet must not spend a second full turn
// pausing itself again immediately — no new turn can even be granted while
// paused (#deliver's own `if (this.paused) return`), so this only proves the
// mechanism does not double-fire on the SAME already-counted turn.
const turnsBeforeResume = turnBudgetEvents.length;
k6.resume();
await wait(50);
a.equal(turnBudgetEvents.length, turnsBeforeResume, 'resuming alone must not re-announce a trip that already happened');

// The one-click raise-and-resume action: both effects from one call, so a
// still-too-low cap cannot leave the button looking like it did nothing.
const raised = k6.raiseTurnBudget(8);
a.equal(raised.cap, 10, 'raising by 8 from 2 session turns makes the session cap 10');
a.equal(k6.sessionTurnCap(), 10, 'the raised cap must be the one #enforceTurnBudget now checks');
a.equal(k6.turnBudget(), 2, 'a raise extends THIS session only — the configured budget is not overwritten');
a.throws(() => k6.raiseTurnBudget(0), /positive number/, 'a raise must be a positive number of turns');
a.equal(k6.paused, false, 'raiseTurnBudget must also resume — a raise with no resume leaves the court looking stuck');

turnBudgetCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(200);
a.equal(k6.paused, false, 'a third turn under the newly-raised cap of 10 must not re-pause the court');

// Lowering the cap below what this session already took must pause NOW, not
// after one more turn_end has spent another turn.
k6.setTurnBudget(1);
a.equal(k6.paused, true, 'setTurnBudget below the current session count must pause the court immediately');
k6.resume();
k6.setTurnBudget(0);
a.equal(k6.paused, false, 'a budget of 0 turns the guard off and must not pause');
k6.bus.db.prepare("delete from state where k = 'turnBudget'").run(); // back to the config value

// A malformed config value must not switch the runaway guard off: NaN is
// falsy, which sessionTurnCap() would read as "off". A numeric string must
// become a number, not be concatenated with the session extension.
const savedCfgBudget = k6.config.turnBudget;
const budgetWarnings = [];
k6.on('error', (e) => budgetWarnings.push(e.message));
k6.config.turnBudget = 'abc';
a.equal(k6.turnBudget(), 500, 'a malformed turnBudget must fall back to the default, never disable the guard');
a.ok(k6.sessionTurnCap() > 0, 'the guard must stay on under a malformed config value');
a.ok(budgetWarnings.some((m) => /turnBudget "abc"/.test(m)), 'a malformed turnBudget must be reported, not silently replaced');
k6.config.turnBudget = '7';
a.equal(k6.turnBudget(), 7, 'a numeric string must be read as a number');
a.equal(typeof k6.sessionTurnCap(), 'number', 'the session cap must be numeric, never a concatenated string');
k6.config.turnBudget = savedCfgBudget;

await k6.stop();

// --- issue #41 follow-up: SESSION-scoped budget, not lifetime ------------
//
// #countTurns() feeds a LIFETIME, restart-safe counter (bus 'turns'), same
// discipline as spentUsd. Comparing turnBudget directly against THAT meant
// any existing court that had already taken turnBudget-or-more turns in its
// life paused on the very first turn after upgrading to this feature, and
// "add 100 turns" only ever bought 100 against a number that never resets.
// turnsThisSession() fixes it by measuring from a baseline latched once —
// the first time start() ever runs for this bus — and left alone on every
// later restart: recomputing it on every restart would let a crash-restart
// loop silently hand itself a fresh budget on every bounce, which is
// precisely the failure mode a per-session cap exists to prevent.
const repo7 = mkdtempSync(join(tmpdir(), 'kingdom-turnbudget-session-'));
const git7 = (...x) => execFileSync('git', x, { cwd: repo7, stdio: 'pipe' });
git7('init', '-q');
git7('config', 'user.email', 'k@kingdom');
git7('config', 'user.name', 'kingdom');
writeFileSync(join(repo7, 'README.md'), '# t\n');
git7('add', '-A');
git7('commit', '-qm', 'init');

const cfg7 = join(repo7, 'kingdom.config.json');
writeFileSync(cfg7, JSON.stringify({
  turnBudget: 3,
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'coder', cli: 'codex' }],
}));

// Simulate an existing, heavily-used court from before this feature existed:
// 1000 lifetime turns already on the bus, no baseline recorded yet — exactly
// what an upgrade finds on disk.
const k7 = new Kingdom(repo7, cfg7);
k7.bus.set('turns', '1000');
await k7.start();

a.equal(k7.turnsLifetime(), 1000, 'sanity: the pre-existing lifetime count is read back exactly');
a.equal(k7.turnsThisSession(), 0,
  'a fresh session must start at 0 regardless of lifetime history — the whole point of the baseline');
a.equal(k7.paused, false,
  'an existing court with 1000 lifetime turns must NOT pause on boot just because 1000 exceeds turnBudget — '
  + 'that is the exact regression this fix closes');

neuter(k7.agents.get('orchestrator'));
neuter(k7.agents.get('briefer'));
await k7.wake('coder');
const sessionCoder = neuter(k7.agents.get('coder'));

sessionCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(150);
a.equal(k7.paused, false, 'one session turn under a budget of 3 must not pause anything, however large the lifetime count is');
a.equal(k7.turnsLifetime(), 1001, 'the lifetime counter keeps counting normally');
a.equal(k7.turnsThisSession(), 1, 'the session counter is relative to the baseline, not to zero or to the lifetime total');

sessionCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
sessionCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(150);
a.equal(k7.paused, true, 'the budget must still fire after exactly `cap` SESSION turns, counted from the baseline');
a.equal(k7.turnsThisSession(), 3);
a.equal(k7.turnsLifetime(), 1003);

// Raise-and-resume, relative to session usage (the sidebar computes exactly
// this: turnsThisSession() + 100 — see ui/sidebar.js's raise-turn-budget
// handler) rather than to a stale cached cap.
const raised7 = k7.raiseTurnBudget(3);
a.equal(raised7.cap, 6);
a.equal(k7.paused, false, 'raiseTurnBudget must resume the court');
sessionCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
sessionCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(150);
a.equal(k7.paused, false, 'two more turns under the newly-raised cap of 6 (session turns now 5) must not immediately re-pause');
sessionCoder.emit('turn_end', { usage: { input_tokens: 10 }, costUsd: 0 });
await wait(150);
a.equal(k7.paused, true, 'and the turn that REACHES the raised cap must still fire — the raise is not a permanent exemption');

await k7.stop();

// Restart-safety: a second start() against the SAME bus must not move the
// baseline, or a crash-restart loop would grant itself a fresh session
// budget on every bounce.
const k7b = new Kingdom(repo7, cfg7);
await k7b.start();
a.equal(k7b.bus.get('turnBudgetBaseline'), '1000',
  'the baseline must be left exactly where it was — a restart must not silently grant a fresh budget');
a.equal(k7b.turnsThisSession(), 6, 'session turns must read as a continuation across the restart, not reset to 0');
a.equal(k7b.paused, true, 'a restart must not clear a pause the sovereign has not resolved — same discipline as `this.paused` itself');
a.equal(k7b.sessionTurnCap(), 6, 'a court still paused for its budget keeps its raised cap across the restart');

// Once the sovereign resumes, the next daemon run is a NEW session: the
// baseline re-latches and the raise extension is dropped, so the court gets
// its full configured budget back instead of a lifetime cap that keeps
// pausing it every few turns forever.
k7b.resume();
await k7b.stop();
const k7c = new Kingdom(repo7, cfg7);
await k7c.start();
a.equal(k7c.bus.get('turnBudgetBaseline'), '1006', 'a new daemon run re-latches the baseline to the lifetime count');
a.equal(k7c.turnsThisSession(), 0, 'a new session starts at 0 turns');
a.equal(k7c.sessionTurnCap(), 3, 'a new session gets the full configured budget, not the previous session\'s raise');
a.equal(k7c.turnBudget(), 3, 'the configured budget was never overwritten by the raise');
a.equal(k7c.paused, false);
await k7c.stop();

for (const d of [
  repo, kingdomDir(repo), repo3, kingdomDir(repo3), repo4, kingdomDir(repo4),
  repo5, kingdomDir(repo5), repo6, kingdomDir(repo6), repo7, kingdomDir(repo7),
]) {
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}
console.log('t-budget.js OK — cumulative ceiling survives restarts, codex courts can be capped, any member recycles, '
  + 'a per-session turn budget pauses the court visibly and raises back in one call, and an existing court\'s '
  + 'lifetime turn history cannot pause a fresh session or be reset by a restart');
