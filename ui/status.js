// What a member is DOING, in one word.
//
// The UI used to show the last thing an agent said, truncated to 26
// characters: "Got it. Staying grounded …", "Fixed — coder, reviewer, …".
// Seven of those is a wall of half-sentences that reads like information and
// contains none. A single verb fits, is legible at a glance, and is the only
// thing you actually want from across the room. The full text is still one
// click away in the member's panel.

// Claude tool names and codex item types, normalised to the same verbs.
const VERBS = {
  Read: 'reading', Grep: 'reading', Glob: 'reading', NotebookRead: 'reading',
  Edit: 'editing', Write: 'editing', MultiEdit: 'editing', NotebookEdit: 'editing',
  file_change: 'editing', patch_apply: 'editing',
  Bash: 'running', command_execution: 'running', local_shell_call: 'running',
  WebFetch: 'searching', WebSearch: 'searching', web_search: 'searching',
  Task: 'delegating', reasoning: 'thinking', agent_message: 'speaking',
  todo_list: 'planning',
};

// Kingdom tools are worth naming individually — "messaging" lighting up is the
// whole point of this court.
const KINGDOM_VERBS = {
  send_message: 'messaging', broadcast: 'messaging', brief_orchestrator: 'briefing',
  vault_search: 'consulting', vault_read: 'consulting', vault_write: 'recording',
  read_bus: 'catching up', read_events: 'catching up', roster: 'catching up',
  read_diff: 'reviewing', request_merge: 'proposing', send_back: 'rejecting',
  declare_done: 'finishing', assign: 'assigning', summon: 'summoning',
  propose_role: 'proposing',
};

/** Severity ordering — a blocked member must not be relabelled by a stray tool. */
export const STICKY = new Set(['limited', 'failed', 'blocked']);

export function verbFor(payload = {}) {
  const name = payload.name;
  if (name === 'mcp_tool_call') {
    const tool = payload.input?.tool ?? payload.input?.name;
    return KINGDOM_VERBS[tool] ?? 'coordinating';
  }
  return VERBS[name] ?? (name ? 'working' : 'thinking');
}

/** Colour class for the one word. */
export function toneOf(status) {
  if (status === 'limited' || status === 'failed' || status === 'blocked') return 'bad';
  if (status === 'asleep' || status === 'idle') return 'quiet';
  if (status === 'messaging' || status === 'briefing') return 'talk';
  return 'busy';
}
