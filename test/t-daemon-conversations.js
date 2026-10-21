// Conversations are meant to isolate a member's session, not just decorate
// the UI with tabs. This is the daemon-layer half of that promise: `/stream`
// must actually scope both its snapshot and its live push to whichever
// conversation a tab asked for, and the new conversation ACTIONS must reach
// the right bus/kingdom methods. bus.js's own self-check already covers the
// storage layer (isolation, migration, pending() scoping); this covers the
// HTTP surface on top of it.
//
//   node test/t-daemon-conversations.js
// Never let a daemon this suite spawns touch the real ~/.kingdom/courts.json
// on the machine running the tests — see test/t-registry-isolation.js.
import './isolate-registry.js';
import { strict as a } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../src/bus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7991 + (process.pid % 40);
const base = `http://127.0.0.1:${PORT}`;

const fakeHome = mkdtempSync(join(tmpdir(), 'kingdom-home-'));
// A codex "CLI" that is really just node given codex's own argv: it exits
// almost immediately without ever printing a session line, the same stub
// t-onboarding.js uses to spawn a member without touching a real API.
const childEnv = {
  ...process.env, USERPROFILE: fakeHome, HOME: fakeHome,
  KINGDOM_CODEX_BIN: process.execPath, KINGDOM_SETTLE_MS: '200',
};

const configPath = join(fakeHome, 'agenticos.config.json');
writeFileSync(configPath, JSON.stringify({
  orchestrator: { name: 'orchestrator', cli: 'codex' },
  briefer: { name: 'briefer', cli: 'codex' },
  peasants: [],
  advisor: { promptEngineer: false, autoModel: false },
}));

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
};

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then((r) => r.json());

const snapshotOf = async (qs = '') => {
  const res = await fetch(`${base}/stream${qs}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
};

/** A live stream that keeps reading in the background and collects every push. */
function tapStream(qs) {
  const seen = [];
  let reader;
  const done = (async () => {
    const res = await fetch(`${base}/stream${qs}`);
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: over } = await reader.read();
      if (over) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
      }
    }
  })().catch(() => {});
  return { seen, close: () => reader?.cancel(), done };
}

let d;
try {
  d = spawn(process.execPath, [join(HERE, '..', 'src', 'daemon.js'), '--port', String(PORT), '--config', configPath],
    { stdio: 'ignore', env: childEnv });
  a.ok(await up(), 'daemon must come up with no repo attached — Chat mode needs none');

  /* ---------- boot registers the orchestrator's default conversation ---- */
  let convs = await fetch(`${base}/api/conversations?member=orchestrator`).then((r) => r.json());
  a.deepEqual(convs.conversations.map((c) => c.id), ['default'],
    'the orchestrator must be registered into "default" the moment it spawns');

  /* ---------- /stream snapshot scoping ----------------------------------- */
  await post('/api/command', { text: 'alpha msg', conversationId: 'conv-a' });
  await post('/api/command', { text: 'beta msg', conversationId: 'conv-b' });
  await wait(200);

  const snapA = await snapshotOf('?conversation=conv-a');
  a.ok(snapA.messages.some((m) => m.body === 'alpha msg'), 'a scoped snapshot must contain its own conversation');
  a.ok(!snapA.messages.some((m) => m.body === 'beta msg'), 'and nothing from a sibling conversation');

  const snapB = await snapshotOf('?conversation=conv-b');
  a.ok(snapB.messages.some((m) => m.body === 'beta msg'));
  a.ok(!snapB.messages.some((m) => m.body === 'alpha msg'));

  const snapAll = await snapshotOf('');
  a.ok(snapAll.messages.some((m) => m.body === 'alpha msg') && snapAll.messages.some((m) => m.body === 'beta msg'),
    'an unscoped tab (every non-Chat panel) must still see everything');

  const invalidCursor = await snapshotOf('?since=Infinity');
  a.ok(invalidCursor.messages.some((m) => m.body === 'alpha msg') && invalidCursor.messages.some((m) => m.body === 'beta msg'),
    'an invalid reconnect cursor must recover as a fresh snapshot, not appear empty');

  // The roster is persisted separately from the live process. A torn older
  // write must not turn a new SSE connection into a wedged response.
  const state = new Bus(join(fakeHome, '.kingdom', 'workspace', 'kingdom.db'));
  state.set('roster', '{broken');
  state.close();
  const corruptRoster = await snapshotOf('');
  a.deepEqual(corruptRoster.roster, [], 'a corrupt persisted roster must degrade to an empty SSE roster');

  console.log('  /stream scopes its snapshot to the requested conversation, and stays unfiltered without one');

  /* ---------- live push scoping ------------------------------------------ */
  const tapA = tapStream('?conversation=conv-a');
  const tapB = tapStream('?conversation=conv-b');
  await wait(150); // let both connections register before the switch fires

  const switched = await post('/api/switchConversation', { name: 'orchestrator', conversationId: 'conv-a' });
  a.equal(switched.ok, true, 'switchConversation must succeed against a real (if stubbed) member');
  await wait(400);

  convs = await fetch(`${base}/api/conversations?member=orchestrator`).then((r) => r.json());
  a.equal(convs.active, 'conv-a', '/api/conversations must report which one is actually live');

  a.ok(tapA.seen.some((e) => e.type === 'conversationSwitched' && e.conversationId === 'conv-a'),
    'the tab scoped to the switched-to conversation must hear about it live');
  a.ok(!tapB.seen.some((e) => e.type === 'conversationSwitched'),
    'a tab scoped to an unrelated conversation must not — this is what shouldDeliver exists to guarantee');
  tapA.close(); tapB.close();

  console.log('  live SSE push is filtered per-client by conversation, court-wide events excepted');

  /* ---------- the new ACTIONS reach the right bus/kingdom methods ------- */
  convs = await fetch(`${base}/api/conversations?member=orchestrator`).then((r) => r.json());
  a.deepEqual(convs.conversations.map((c) => c.id).sort(), ['conv-a', 'default'],
    'switchConversation must have created and registered conv-a');

  const renamed = await post('/api/renameConversation', { id: 'conv-a', title: 'Renamed A' });
  a.equal(renamed.ok, true);
  convs = await fetch(`${base}/api/conversations?member=orchestrator`).then((r) => r.json());
  a.equal(convs.conversations.find((c) => c.id === 'conv-a')?.title, 'Renamed A');

  const archived = await post('/api/archiveConversation', { id: 'conv-a' });
  a.equal(archived.ok, true);
  convs = await fetch(`${base}/api/conversations?member=orchestrator`).then((r) => r.json());
  a.ok(!convs.conversations.some((c) => c.id === 'conv-a'), 'an archived conversation must drop out of the sidebar list');

  console.log('  renameConversation/archiveConversation reach the bus and take effect immediately');
  console.log('t-daemon-conversations.js OK — /stream scopes by conversation, live and at rest');
} finally {
  d?.kill();
  await wait(300);
  try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
}
