// Asks src/mcp.js who it thinks it is, with an EMPTY environment.
//
// That is the situation every Antigravity member is in: headless agy reads one
// global mcp_config.json shared by the whole team, so the server's env can
// name nobody. Identity has to come from the working directory instead. If this
// ever prints "unknown", every agy member posts to the bus as the same agent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? process.cwd();
process.chdir(dir);

let id = {};
for (const d of [process.cwd(), join(process.cwd(), '..')]) {
  try {
    id = JSON.parse(readFileSync(join(d, '.agents', 'agenticos-id.json'), 'utf8'));
    break;
  } catch { /* not this one */ }
}

process.stdout.write(`${id.agent ?? 'unknown'}|${id.role ?? 'agent'}`);
