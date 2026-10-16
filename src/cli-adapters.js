// CLI argument and protocol boundary. No process spawning or credential reads.
// buildArgs({spec,cwd,sessionId,prompt,...}) -> argv
// parseEvent.call(agent, object, state) -> ready/text/tool/turn_end/error events.
// The receiver supplies emit(), ctxTokens() and the existing usage/context fields.
const flag = (args, name, value) => { if (value !== undefined && value !== null) args.push(name, String(value)); };
const model = (args, spec) => flag(args, '--model', spec.model);
export const AGY_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const resume = (args, spec, id, name) => { if (id) flag(args, name, id); else if (spec.continue) args.push('--continue'); };

function codexArgs({ spec = {}, cwd, sessionId, prompt, mcp }) {
  const args = sessionId ? ['exec', 'resume', sessionId] : spec.continue ? ['exec', 'resume', '--last'] : ['exec'];
  args.push('--json', '-c', `sandbox_mode=${JSON.stringify(spec.sandbox ?? 'danger-full-access')}`,
    '-c', `approval_policy=${JSON.stringify(spec.approvalPolicy ?? 'never')}`);
  if (!sessionId && !spec.continue) flag(args, '-C', cwd);
  model(args, spec);
  if (spec.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
  if (mcp) {
    args.push('-c', `mcp_servers.kingdom.command=${JSON.stringify(mcp.command)}`,
      '-c', `mcp_servers.kingdom.args=${JSON.stringify(mcp.args)}`,
      '-c', `mcp_servers.kingdom.env={${Object.entries(mcp.env ?? {}).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join(',')}}`);
  }
  args.push('-'); // prompt always goes over stdin
  return args;
}

function claudeArgs({ spec = {}, sessionId, promptFile, mcp, addDirs = [], deny = [] }) {
  const args = ['--print', '--verbose', '--output-format', spec.outputFormat ?? 'stream-json',
    '--permission-mode', spec.permissionMode ?? 'bypassPermissions', '--setting-sources', 'project'];
  if (spec.outputFormat !== 'json') args.push('--input-format', 'stream-json');
  flag(args, promptFile ? '--append-system-prompt-file' : '--append-system-prompt', promptFile ?? spec.prompt ?? '');
  if (spec.continue && !spec.resume) args.push('--continue');
  else flag(args, spec.resume || spec.outputFormat === 'json' ? '--resume' : '--session-id', sessionId);
  model(args, spec);
  if (spec.effort && !/haiku/i.test(spec.model ?? '')) flag(args, '--effort', spec.effort);
  flag(args, '--tools', spec.tools);
  flag(args, '--max-budget-usd', spec.maxBudgetUsd);
  for (const dir of addDirs) flag(args, '--add-dir', dir);
  if (deny.length) args.push('--disallowed-tools', ...deny);
  if (mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { kingdom: mcp } }), '--strict-mcp-config');
  return args;
}

function agyArgs({ spec = {}, sessionId, prompt, addDirs = [] }) {
  const args = ['--print', prompt, '--output-format', spec.outputFormat ?? 'stream-json'];
  resume(args, spec, sessionId, '--conversation');
  model(args, spec);
  if (AGY_EFFORTS.has(spec.effort)) flag(args, '--effort', spec.effort);
  flag(args, '--mode', spec.mode);
  if (spec.sandbox === true) args.push('--sandbox');
  if (spec.skipPermissions !== false) args.push('--dangerously-skip-permissions');
  flag(args, '--print-timeout', spec.printTimeout ?? '20m');
  for (const dir of addDirs) flag(args, '--add-dir', dir);
  return args;
}

function openCodeArgs({ spec = {}, sessionId, prompt }) {
  const args = ['run', prompt, '--format', 'json', '--title', spec.name ?? 'Agentic OS'];
  if (spec.skipPermissions !== false) args.push('--auto');
  resume(args, spec, sessionId, '--session');
  model(args, spec);
  flag(args, '--variant', spec.effort);
  flag(args, '--agent', spec.agent);
  return args;
}

function cursorArgs({ spec = {}, cwd, sessionId, prompt, addDirs = [], mcp }) {
  const args = ['--print', '--output-format', spec.outputFormat ?? 'stream-json', '--workspace', cwd];
  resume(args, spec, sessionId, '--resume');
  model(args, spec);
  flag(args, '--mode', spec.mode);
  flag(args, '--sandbox', spec.sandbox);
  if (spec.skipPermissions !== false) args.push('--force');
  if (spec.trust ?? Boolean(mcp)) args.push('--trust');
  if (spec.approveMcps ?? Boolean(mcp)) args.push('--approve-mcps');
  for (const dir of addDirs) flag(args, '--add-dir', dir);
  args.push(prompt);
  return args;
}

// Verified in the installed Cursor print transport: inputTokens is fresh input,
// after cacheReadTokens/cacheWriteTokens have already been subtracted.
export function cursorUsage(usage) {
  if (!usage || usage.inputTokens === undefined) return usage ?? null;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
  };
}

function cursorEvent(o) {
  const id = o.session_id ?? o.sessionId;
  if (id && id !== this.sessionId) { this.sessionId = id; this.emit('ready', id); }
  if (o.type === 'assistant') for (const b of o.message?.content ?? []) {
    if (b.type === 'text') { this.ctxChars += (b.text ?? '').length; this.emit('text', b.text ?? ''); }
    else if (b.type === 'tool_use') this.emit('tool', { name: b.name, input: b.input });
  }
  if (o.type === 'tool_call' && o.subtype === 'started') {
    const call = o.tool_call?.tool ?? o.tool_call;
    if (call?.case) this.emit('tool', { name: call.case, input: call.value?.args ?? call.value });
    else for (const [name, value] of Object.entries(call ?? {})) this.emit('tool', { name, input: value.args ?? value });
  }
  if (o.type === 'result') {
    if (this.spec.outputFormat === 'json' && typeof o.result === 'string') this.emit('text', o.result);
    if (o.is_error) this.emit('error', o.result ?? 'cursor turn failed');
    this.lastUsage = cursorUsage(o.usage);
    this.emit('turn_end', { usage: this.lastUsage, costUsd: 0, costReported: false, ctx: this.ctxTokens() });
  }
  if (o.type === 'error') this.emit('error', o.error?.message ?? o.message ?? 'cursor failed');
}

export const FREEBUFF_LIMITATION = 'Freebuff 0.2.26 exposes an interactive UI only; no non-interactive prompt or JSON output mode. Use another CLI for agents.';

// Filled by the protocol functions below; one adapter per installed CLI family.
export const adapters = {
  codex: { buildArgs: codexArgs, parseEvent: codexEvent, authArgs: ['login', 'status'], input: 'stdin' },
  claude: { buildArgs: claudeArgs, parseEvent: claudeEvent, authArgs: ['auth', 'status'], input: 'stream-json' },
  agy: { buildArgs: agyArgs, parseEvent: agyEvent, authArgs: ['models'], input: 'argv' },
  opencode: { buildArgs: openCodeArgs, parseEvent: openCodeEvent, authArgs: ['auth', 'list'], input: 'argv' },
  cursor: { buildArgs: cursorArgs, parseEvent: cursorEvent, authArgs: ['status', '--format', 'json'], input: 'argv',
    mcpConfig: (mcp, current = {}) => ({ ...current, mcpServers: { ...current.mcpServers, kingdom: mcp } }) },
  freebuff: { buildArgs() { throw new Error(FREEBUFF_LIMITATION); }, parseEvent() {}, authArgs: null, input: null },
};

export function adapterFor(cli) {
  const adapter = adapters[cli === 'cursor-agent' || cli === 'agent' ? 'cursor' : cli];
  if (!adapter) throw new Error(`Unsupported agent CLI: ${cli}`);
  return adapter;
}

// NDJSON or a single pretty-printed JSON object. Flush the tail on close.
export function jsonStream(onObject) {
  let buffer = '';
  let document = '';
  const parse = (value) => {
    let object;
    try { object = JSON.parse(value); } catch { return false; }
    if (object === null || typeof object !== 'object') return true;
    onObject(object);
    return true;
  };
  return {
    write(chunk) {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (document || line === '{' || line === '[') {
          document += line + '\n';
          if (parse(document)) document = '';
        } else if (line) parse(line);
      }
    },
    end() { if ((document + buffer).trim()) parse((document + buffer).trim()); buffer = ''; document = ''; },
  };
}

function claudeEvent(o) {
  if (o.type === 'system' && o.subtype === 'init') {
    this.sessionId = o.session_id;
    this.emit('ready', o.session_id);
    return;
  }
  if (o.session_id && o.session_id !== this.sessionId) {
    this.sessionId = o.session_id;
    this.emit('ready', o.session_id);
  }
  if (o.type === 'assistant') {
    const u = o.message?.usage;
    if (u) {
      this.ctxExact = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0);
    }
    for (const block of o.message?.content ?? []) {
      if (block.type === 'text' && block.text) this.emit('text', block.text);
      else if (block.type === 'tool_use') this.emit('tool', { name: block.name, input: block.input });
    }
    if (o.error || o.is_api_error_message) {
      this.emit('error', o.message?.content?.[0]?.text ?? 'api error');
    }
    return;
  }
  if (o.type === 'result') {
    if (this.spec.outputFormat === 'json' && typeof o.result === 'string') this.emit('text', o.result);
    this.busy = false;
    this.lastUsage = o.usage ?? null;
    const rawCost = o.total_cost_usd;
    const cost = Number(rawCost);
    const reported = rawCost !== undefined && rawCost !== null && Number.isFinite(cost);
    this.costUsd += reported ? cost : 0;
    if (o.is_error) this.emit('error', o.result ?? 'turn failed');
    this.emit('turn_end', {
      usage: o.usage,
      costUsd: reported ? cost : 0,
      costReported: reported,
      ctx: this.ctxTokens(),
    });
  }

}

function codexEvent(o) {
  switch (o.type) {
    case 'thread.started':
      this.sessionId = o.thread_id;
      this.emit('ready', o.thread_id);
      break;
    case 'item.completed': {
      const item = o.item ?? {};
      // Everything in an item — reasoning, command output, file contents —
      // stays in the thread, so it is what the context is made of.
      this.ctxChars += JSON.stringify(item).length;
      if (item.type === 'agent_message') this.emit('text', item.text ?? '');
      else this.emit('tool', { name: item.type, input: item });
      break;
    }
    case 'turn.completed':
      this.lastUsage = o.usage ?? null;
      // Context stays the chars-in-the-thread estimate. Two alternatives were
      // tried against real data and both are unsound: input_tokens/calls
      // needs a call count codex does not report, and `input - cached` is
      // itself a per-call sum, so a hundred-tool-call turn inflates it just
      // as badly as the raw aggregate. codex exposes nothing per call, so
      // there is nothing better to derive it from.
      // codex reports no cost, and its usage is a turn aggregate — see ctxTokens().
      this.emit('turn_end', { usage: o.usage, costUsd: 0, costReported: false, ctx: this.ctxTokens() });
      break;
    case 'turn.failed':
    case 'error':
      this.emit('error', o.error?.message ?? o.message ?? (typeof o === 'string' ? o : JSON.stringify(o)));
      break;
  }

}

function agyEvent(o, steps = new Map()) {
  if (o.event === 'init') {
    const id = o.conversation_id ?? o.init?.conversation_id;
    if (id && id !== this.sessionId) {
      this.sessionId = id;
      this.emit('ready', id);
    }
    return;
  }

  if (o.event === 'step_update') {
    const s = o.step_update ?? {};
    const i = s.step_index;
    if (s.text_delta) steps.set(i, (steps.get(i) ?? '') + s.text_delta);
    if (s.state !== 'DONE') return;

    const body = (steps.get(i) ?? '').trim();
    steps.delete(i);
    this.ctxChars += JSON.stringify(s).length;

    if (s.step_type === 'agent_response') {
      if (body) this.emit('text', body);
      steps.textSeen = true;
    } else if (s.step_type !== 'user_input' && s.step_type !== 'checkpoint'
               && s.step_type !== 'unknown') {
      // Everything else is the model acting: a command, an edit, an MCP call.
      this.emit('tool', { name: s.step_type, input: s });
    }
    return;
  }

  if (o.event === 'result' || (!o.event && o.status && o.response !== undefined)) {
    const r = o.result ?? o;
    const id = o.conversation_id ?? r.conversation_id;
    if (id && id !== this.sessionId) { this.sessionId = id; this.emit('ready', id); }
    if (!steps.textSeen && r.response) this.emit('text', r.response);
    if (r.status && r.status !== 'SUCCESS') {
      this.emit('error', `agy turn ${r.status}${r.error ? `: ${r.error}` : ''}`);
    }
    const u = r.usage ?? null;
    if (u) this.ctxExact = u.total_tokens ?? u.input_tokens ?? this.ctxExact;
    this.lastUsage = u;
    // agy reports no price; like codex it bills against a plan, not per call.
    this.emit('turn_end', { usage: u, costUsd: 0, costReported: false, ctx: this.ctxTokens() });
  }

}

function openCodeEvent(o, state = new Map()) {
  // Session tracking
  const sid = o.sessionID ?? o.sessionId ?? o.session_id ?? (o.type === 'session' ? (o.id ?? o.sessionID) : null);
  if (sid && sid !== this.sessionId) {
    this.sessionId = sid;
    this.emit('ready', sid);
  }

  // Text messages
  if (o.type === 'text' && o.text) {
    this.ctxChars += o.text.length;
    this.emit('text', o.text);
  } else if (o.type === 'message' && o.content) {
    const text = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
    this.ctxChars += text.length;
    this.emit('text', text);
  } else if (o.part?.type === 'text' && o.part?.text) {
    this.ctxChars += o.part.text.length;
    this.emit('text', o.part.text);
  } else if (o.type === 'assistant') {
    for (const block of o.message?.content ?? []) {
      if (block.type === 'text' && block.text) this.emit('text', block.text);
      else if (block.type === 'tool_use') this.emit('tool', { name: block.name, input: block.input });
    }
  }

  // Tool use
  if (o.type === 'tool_use' || o.type === 'tool') {
    const name = o.part?.tool ?? o.tool ?? o.name ?? 'tool';
    const input = o.part?.state?.input ?? o.part?.input ?? o.input ?? {};
    this.ctxChars += JSON.stringify(input).length;
    this.emit('tool', { name, input });
  }

  // Result / turn completion
  if (o.type === 'result' || o.type === 'step_finish' || o.type === 'done' || o.event === 'result') {
    if (o.is_error || o.error) {
      this.emit('error', o.error ?? o.result ?? 'opencode turn failed');
    }
    const tokens = o.part?.tokens;
    let u = o.usage ?? (tokens ? {
      input_tokens: tokens.input ?? 0,
      output_tokens: tokens.output ?? 0,
      cached_input_tokens: tokens.cache?.read ?? 0,
    } : {
      input_tokens: o.tokens_in ?? o.input_tokens ?? 0,
      output_tokens: o.tokens_out ?? o.output_tokens ?? 0,
      total_tokens: (o.tokens_in ?? o.input_tokens ?? 0) + (o.tokens_out ?? o.output_tokens ?? 0),
    });
    if (o.type === 'step_finish') {
      const aggregate = state.get('usage') ?? {};
      for (const [key, value] of Object.entries(u)) if (typeof value === 'number') aggregate[key] = (aggregate[key] ?? 0) + value;
      state.set('usage', aggregate);
      u = { ...aggregate };
    } else if (!o.usage && state.has('usage')) u = state.get('usage');
    this.lastUsage = u;
    const rawCost = o.total_cost_usd ?? o.cost ?? o.part?.cost;
    const cost = Number.isFinite(Number(rawCost)) ? Number(rawCost) : 0;
    const reported = rawCost !== undefined && rawCost !== null && Number.isFinite(Number(rawCost));
    this.costUsd += o.type !== 'step_finish' && reported ? cost - (state.get('cost') ?? 0) : cost;
    if (o.type === 'step_finish') state.set('cost', (state.get('cost') ?? 0) + cost);
    if (reported) state.set('costReported', true);
    this.emit('turn_end', {
      usage: u,
      costUsd: o.type === 'step_finish' ? state.get('cost') : rawCost == null ? state.get('cost') ?? 0 : cost,
      costReported: reported || state.get('costReported') === true,
      ctx: this.ctxTokens(),
    });
  }

  if (o.type === 'error' && !o.is_error) {
    this.emit('error', o.error?.message ?? o.message ?? 'opencode failed');
  }

}
