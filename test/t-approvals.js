// Approval requests are durable bus records, not transient UI events.
//
//   node test/t-approvals.js
import { strict as a } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kingdom } from '../src/kingdom.js';
import { kingdomDir } from '../src/worktree.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'kingdom-approvals-'));
const repo = join(dir, 'repo');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['config', 'user.email', 'k@kingdom'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'kingdom'], { cwd: repo });
writeFileSync(join(repo, 'README.md'), '# approvals\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

const configPath = join(dir, 'kingdom.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [{ name: 'designer', cli: 'codex' }],
  rolesSeeded: true,
}));

const k = new Kingdom(repo, configPath);
const seen = [];
k.on('approval', (p) => seen.push(p));
a.match(k.briefFor('orchestrator'), /call the summon tool immediately/,
  'the orchestrator must create an approval record through the tool, not prose');
k.bus.post('orchestrator', null,
  JSON.stringify({ kind: 'summon', names: ['designer'], reason: 'design probe' }), 'approval');
await k.start();

a.ok(k.approvals.size, 'a pending approval must survive startup');
a.ok(seen.some((p) => p.kind === 'summon' && p.names[0] === 'designer'),
  'startup must surface a pending approval');

k.bus.post('orchestrator', null,
  JSON.stringify({ kind: 'summon', names: ['designer'], reason: 'second probe' }), 'approval');
await wait(700);
a.equal(k.approvals.size, 2, 'new approval must be picked up by the delivery loop');

await k.wake('designer');
await k.stop();
const k2 = new Kingdom(repo, configPath);
await k2.start();
const roster = JSON.parse(k2.bus.get('roster'));
const designer = roster.find((r) => r.name === 'designer');
a.equal(designer.summoned, true, 'a woken member stays in the standing crew');
a.equal(designer.awake, false, 'a standing member may restore asleep after restart');

await k2.stop();
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
try { rmSync(kingdomDir(repo), { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
console.log('t-approvals.js OK â€” pending approvals and resting crew survive restart');
