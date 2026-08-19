// A document the sovereign uploads (see daemon.js's DOCUMENT set, /api/assets)
// must be discoverable by a court member through list_uploads — name, kind,
// and a real path its own file-reading tool can open. Non-document uploads
// (images, audio) must not clutter that list.
//
//   node test/t-uploads.js
import { strict as a } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kingdom-uploads-'));
const db = join(dir, 'kingdom.db');
const assets = join(dir, 'assets');
mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, 'spec.pdf'), 'not a real pdf, just bytes');
writeFileSync(join(assets, 'notes.txt'), 'plain text upload');
writeFileSync(join(assets, 'wallpaper.png'), 'not a real png either');

function invoke(role) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-uploads', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_uploads', arguments: {} } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc,
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_AGENT: 'orchestrator', KINGDOM_ROLE: role, KINGDOM_DB: db },
  });
  a.equal(r.status, 0, `mcp.js exited ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);
  const messages = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return messages.find((m) => m.id === 2)?.result?.content?.[0]?.text ?? '';
}

try {
  const text = invoke('orchestrator');
  a.match(text, /spec\.pdf/, 'a pdf upload must be listed');
  a.match(text, /notes\.txt/, 'a text upload must be listed');
  a.ok(text.includes(join(assets, 'spec.pdf')), 'must give the real path, not just the name — that is what a file-read tool needs');
  a.ok(!/wallpaper\.png/.test(text), 'a non-document upload (image/audio) must not appear as something to read');

  // every role that can already vault_search/vault_read can list_uploads too —
  // it is the same "check what the sovereign left you before doing the work" shape
  for (const role of ['peasant', 'briefer']) {
    a.match(invoke(role), /spec\.pdf/, `${role} must also see uploaded documents`);
  }

  console.log('t-uploads.js OK — list_uploads surfaces documents by real path, skips media, open to every role');
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
