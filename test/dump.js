// Peek at a kingdom's bus:  node test/dump.js <repo> [msgs|events]
import { resolve } from 'node:path';
import { Bus } from '../src/bus.js';
import { dbPath } from '../src/worktree.js';

const repo = resolve(process.argv[2] ?? '.');
const what = process.argv[3] ?? 'msgs';
const b = new Bus(dbPath(repo));
const flat = (s, n) => String(s).replace(/\s+/g, ' ').slice(0, n);

if (what === 'events') {
  for (const e of b.events({ limit: 400 }))
    console.log(`${e.agent} [${e.type}] ${flat(e.payload.text ?? e.payload.name ?? e.payload.message ?? '', 160)}`);
} else {
  for (const m of b.history({ limit: 100 }))
    console.log(`#${m.id} ${m.sender} -> ${m.recipient ?? '*'} [${m.kind}] ${flat(m.body, 200)}`);
}
