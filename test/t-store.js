import { strict as a } from 'node:assert';
import { readFileSync } from 'node:fs';
import { apply, get, money, post, resetForTest, sameId, state } from '../ui/store.js';
import { displayStatus } from '../ui/sidebar.js';
import { statusLabel } from '../ui/status.js';
import { setView as route } from '../ui/views/util.js';

resetForTest();

// The roster is the only source allowed to admit a member. A replayed event or
// message for a name that left the roster must not grow a ghost row again.
apply({
  type: 'snapshot',
  roster: [
    { name: 'orchestrator', role: 'orchestrator', added: true, awake: true },
    { name: 'coder', role: 'agent', added: true, awake: false },
  ],
  events: [], messages: [], approvals: [],
});
apply({ type: 'roster', roster: [{ name: 'orchestrator', role: 'orchestrator', added: true, awake: true }] });
apply({
  type: 'snapshot',
  roster: [{ name: 'orchestrator', role: 'orchestrator', added: true, awake: true }],
  events: [{ id: 1, agent: 'coder', type: 'text', payload: { text: 'old transcript' } }],
  messages: [{ id: 1, sender: 'coder', body: 'old message' }], approvals: [],
});
a.equal(state.removed.has('coder'), true, 'roster removal is remembered');
a.equal(state.members.has('coder'), false, 'replay cannot resurrect a removed member');

// Role defaults apply on create only. An agent lifecycle event may omit role,
// or carry a generic one, but neither is allowed to demote the orchestrator.
resetForTest();
apply({ type: 'snapshot', roster: [{ name: 'orchestrator', role: 'orchestrator', added: true, awake: true }] });
apply({ type: 'agent', name: 'orchestrator', role: 'agent', state: 'ready' });
a.equal(state.members.get('orchestrator').role, 'orchestrator');

resetForTest();
apply({
  type: 'snapshot',
  roster: [
    { name: 'awake', role: 'agent', added: true, awake: true },
    { name: 'resting', role: 'agent', added: true, awake: false },
    { name: 'off', role: 'agent', added: false, awake: false },
  ],
});
a.equal(state.members.get('awake').state, 'awake');
a.equal(state.members.get('resting').state, 'resting');
a.equal(state.members.get('off').state, 'off');

// Membership and activity are separate facts. A verifier is still awake, but
// the rail must not flatten its live work into the quiet awake state; a quota
// limit must remain visibly unhealthy until the member is restarted.
resetForTest();
apply({ type: 'snapshot', roster: [{ name: 'coder', role: 'agent', added: true, awake: true }] });
apply({ type: 'agent', name: 'coder', state: 'verifying' });
a.equal(state.members.get('coder').status, 'verifying', 'agent activity must survive reducer normalisation');
a.equal(displayStatus(state.members.get('coder')), 'busy', 'verification must render as busy');
apply({ type: 'event', name: 'coder', kind: 'tool', payload: { name: 'Read' } });
a.equal(state.members.get('coder').status, 'reading', 'live tool events must expose a useful activity verb');
a.equal(displayStatus(state.members.get('coder')), 'busy', 'specific activity verbs must still render as busy');
apply({ type: 'event', name: 'coder', kind: 'turn_end', payload: {} });
a.equal(displayStatus(state.members.get('coder')), 'awake', 'a completed turn must clear the busy state');
apply({ type: 'limited', name: 'coder' });
apply({ type: 'event', name: 'coder', kind: 'tool', payload: { name: 'Read' } });
a.equal(state.members.get('coder').status, 'limited', 'a terminal limit must survive later tool noise');
a.equal(displayStatus(state.members.get('coder')), 'failed', 'a limited member must not look awake');
a.equal(statusLabel('verifying'), 'verifying', 'backend verification must have stable human copy');
a.equal(statusLabel('mcp_tool_call'), 'working', 'unknown backend activity must degrade to readable copy');

resetForTest();
apply({
  type: 'snapshot',
  roster: [{ name: 'orchestrator', role: 'orchestrator', added: true, awake: true }],
  events: [
    { id: 1, agent: 'orchestrator', type: 'text', conversation_id: 'branch-a', payload: { text: 'A' } },
    { id: 2, agent: 'orchestrator', type: 'text', conversation_id: 'branch-b', payload: { text: 'B' } },
  ],
});
a.deepEqual(state.log.get('orchestrator').map((event) => event.conversation_id), ['branch-a', 'branch-b'], 'event logs must retain conversation scope');

state.messages.push({ id: 1, body: 'stale' });
state.approvals.push({ id: 1, resolved: false });
resetForTest();
a.equal(state.messages.length, 0, 'test reset must clear delivered messages');
a.equal(state.approvals.length, 0, 'test reset must clear approval rows');

state.conversations = [{ id: 'default', title: 'Conversation' }];
apply({ type: 'conversationSwitched', name: 'orchestrator', conversationId: 'new-thread' });
a.ok(state.conversations.some((conversation) => sameId(conversation.id, 'new-thread')),
  'a live conversation switch must add the new thread to the sidebar list');
resetForTest();

apply({ type: 'snapshot', roster: [{ name: 'orchestrator', role: 'orchestrator', added: true, awake: true }] });
apply({ type: 'conversations', conversations: [{ id: 'default' }, { id: 'branch-a' }], active: 'branch-a' });
a.equal(state.members.get('orchestrator').conversationId, 'branch-a',
  'the active conversation from the list response must survive the store boundary');
route({ page: 'thread', member: 'orchestrator' });
a.equal(state.view.conversation, 'branch-a',
  'opening Chat without an explicit thread must use the restored active conversation');
resetForTest();

apply({ type: 'tasks', tasks: [{ id: 1, state: 'pending' }] });
apply({ type: 'tasksLoading', loading: true });
a.equal(state.tasksLoading, true, 'task refreshes must expose their in-flight state');
apply({ type: 'tasksError', error: 'offline' });
a.equal(state.tasksLoading, false, 'a failed task refresh must leave the loading state');
a.equal(state.tasksError, 'offline', 'a failed task refresh must retain its visible error');
a.deepEqual(state.tasks, [{ id: 1, state: 'pending' }], 'a failed task refresh must preserve the last known list');
apply({ type: 'tasksLoading', loading: true });
apply({ type: 'tasks', tasks: [] });
a.equal(state.tasksError, null, 'a successful task refresh must clear its prior error');
resetForTest();

a.equal(money(0.001), '$0.001');
a.equal(money(0.0099), '$0.010');
a.equal(money(0.01), '$0.01');
a.equal(money(1.319), '$1.32');
a.equal(sameId(42, '42'), true, 'numeric API IDs and DOM string IDs refer to one conversation');
a.equal(sameId('42', '43'), false);

// A closed EventSource can still deliver a queued callback. The stream token
// must make old onopen/onmessage/onerror handlers inert after reconnect.
const mainSource = readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
a.match(mainSource, /function connect\(\) \{[\s\S]*?if \(reconnect\) clearTimeout\(reconnect\);\s*reconnect = null;[\s\S]*?const attempt = \+\+connectionAttempt;/,
  'a fresh stream scope must cancel an old scheduled reconnect before opening its replacement');
a.match(mainSource, /const attempt = \+\+connectionAttempt;/,
  'stream reconnects must identify the current connection');
a.match(mainSource, /source\.onopen = \(\) => \{\s*if \(attempt !== connectionAttempt\) return;/,
  'a stale stream must not mark a replacement connection up');
a.match(mainSource, /source\.onmessage = \(message\) => \{\s*if \(attempt !== connectionAttempt\) return;/,
  'a stale stream must not replay events into the current state');
a.match(mainSource, /source\.onerror = \(\) => \{\s*if \(attempt !== connectionAttempt\) return;/,
  'a stale stream must not close or reconnect the current stream');
a.match(mainSource, /const scopeChanged = conversation !== connectedConversation;/,
  'a conversation change must be distinct from an ordinary stream reconnect');
a.match(mainSource, /if \(!scopeChanged && state\.cursor\) params\.set\('since', String\(state\.cursor\)\);/,
  'a changed conversation must request its retained transcript instead of applying a global cursor');
a.match(mainSource, /params\.set\('conversation', conversation\);/,
  'the renderer must ask the daemon for the active conversation scope');
a.match(mainSource, /setView\(route\.page === 'thread' && name === 'thread' \? route : name\);\s*syncStreamScope\(\);/,
  'routing into or out of Chat must reconnect the shared stream at the matching scope');
a.match(mainSource, /event\.type === 'snapshot'\) get\('\/api\/conversations'\)\.then\(\(data\) => \{\s*if \(attempt !== connectionAttempt \|\| bootFailed\) return;/,
  'a stale snapshot response must not repaint conversations after reconnect or boot failure');
a.match(mainSource, /function showBootFailure\(error\) \{[\s\S]*?currentCleanup\(\);\s*currentCleanup = \(\) => \{\};/,
  'boot failure must release the active view cleanup before rendering recovery');

// Returning Home must not leave its primary action pointed at a prior specialist.
state.view = { page: 'thread', member: 'coder', conversation: 'branch-b' };
route('home');
a.deepEqual(state.view, { page: 'home' }, 'leaving a thread must clear its member and conversation route state');
route({ page: 'thread', member: 'orchestrator' });
a.deepEqual(state.view, { page: 'thread', member: 'orchestrator', conversation: 'default' });

// The UI consumes JSON, not the Response shell. Keep the shared transport seam
// honest: a raw Response makes every page look empty and turns failed writes
// into apparent successes.
const fetchBeforeStoreCheck = globalThis.fetch;
try {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const failed = url === '/api/fail';
    return new Response(JSON.stringify(failed ? { error: 'nope' } : { ok: true, value: 7 }), { status: failed ? 500 : 200, headers: { 'content-type': 'application/json' } });
  };
  a.deepEqual(await get('/api/test'), { ok: true, value: 7 });
  a.deepEqual(await get('/api/fail'), { error: 'nope', ok: false });
  a.deepEqual(await post('test', { answer: 42 }), { ok: true, value: 7 });
  a.equal(calls[2].url, '/api/test');
  a.equal(JSON.parse(calls[2].options.body).answer, 42);
  const circular = {}; circular.self = circular;
  a.deepEqual(await post('test', circular), { ok: false }, 'a non-serializable write must fail as a normal UI result');
  a.equal(calls.length, 3, 'a failed serialization must not start a partial network request');
} finally {
  globalThis.fetch = fetchBeforeStoreCheck;
}

state.myTasksError = 'stale';
apply({ type: 'myTasks', tasks: [{ id: 7, title: 'call the bank' }] });
a.deepEqual(state.myTasks, [{ id: 7, title: 'call the bank' }], "a broadcast of the user's list replaces it whole");
a.equal(state.myTasksError, null, 'and clears a stale load error');
apply({ type: 'inbox', items: [{ id: 'run:r1', tone: 'attention' }] });
a.deepEqual(state.inbox, [{ id: 'run:r1', tone: 'attention' }], 'the inbox broadcast feeds the rail count');

// The context meter's state: seeded by the snapshot, moved by each 'spend'
// event for that member, zeroed by a recycle or a compaction — which still
// reach the notice list as they always did.
resetForTest();
apply({
  type: 'snapshot',
  roster: [{ name: 'orchestrator', role: 'orchestrator', added: true, awake: true }],
  context: [{ name: 'orchestrator', tokens: 100_000, window: 400_000, pct: 25 }, { name: 'coder', tokens: 5, window: null, pct: null }],
  spend: { today: { day: '2026-10-21', usd: 1.5, turns: 3, tokens: 9, timeZone: 'UTC' } },
});
a.equal(state.context.orchestrator.tokens, 100_000, 'the snapshot seeds the context meter');
a.equal(state.spend.today.usd, 1.5, 'and today\'s spend rides in spend');
apply({ type: 'spend', name: 'orchestrator', ctx: 200_000, window: 400_000, total: 2, today: { day: '2026-10-21', usd: 2, turns: 4, tokens: 10, timeZone: 'UTC' } });
a.deepEqual([state.context.orchestrator.tokens, state.context.orchestrator.pct], [200_000, 50], 'a spend event moves its member\'s meter');
a.equal(state.spend.today.usd, 2, 'and replaces today');
apply({ type: 'spend', name: 'coder', ctx: 800 });
a.equal(state.context.coder.window, null, 'an unknown window stays unknown');
const noticesBefore = state.notices.length;
apply({ type: 'compacted', name: 'orchestrator', before: 200_000, after: 0 });
a.deepEqual([state.context.orchestrator.tokens, state.context.orchestrator.pct], [0, 0], 'a compaction empties the meter');
a.equal(state.notices.length, noticesBefore + 1, 'and is still a notice');
apply({ type: 'spend', name: 'orchestrator', ctx: 300 });
apply({ type: 'recycled', name: 'orchestrator', note: 'n' });
a.equal(state.context.orchestrator.tokens, 0, 'a threshold recycle empties it too');

console.log('t-store.js OK — reducer keeps removal, roles, three states, money semantics, and the context meter');
