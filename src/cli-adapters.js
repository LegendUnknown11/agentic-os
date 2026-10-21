// CLI argument and protocol boundary. No process spawning or credential reads.
//
//   buildArgs({spec, cwd, sessionId, prompt, promptFile, mcp, addDirs, deny}) -> argv
//   parseEvent.call(agent, object, state) -> ready/text/tool/turn_end/error events
//
// The receiver is the Agent itself: it supplies emit(), ctxTokens(), spec and
// the usage/context fields. `state` is per turn (a fresh Map each spawn).
//
// Unknown usage stays null. A CLI that reports no token counts must not be
// turned into a zero-token turn — that reads as "free" in the spend ledger.

const flag = (args, name, value) => { if (value !== undefined && value !== null) args.push(name, String(value)); };
const model = (args, spec) => flag(args, '--model', spec.model);

// A prompt passed as a trailing positional is parsed as an option when it
// starts with '-' (a resumed turn that opens with "--- " or "-v" would become
// an unknown flag and fail the turn). A leading newline is inert to the model
// and makes the argument unambiguous to commander/yargs-style parsers.
export const positional = (prompt) => (/^-/.test(prompt ?? '') ? `\n${prompt}` : prompt);

const message = (value, fallback) => {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.data?.message === 'string' && value.data.message) return value.data.message;
    try { return JSON.stringify(value); } catch { /* fall through */ }
  }
  return fallback;
};

// agy's own ladder. Narrower than codex's, and it has no 'none' or 'max' —
// passing one borrowed from another member is rejected outright (measured
// against agy 1.1.x). The cli-integrations branch claimed a later agy
// publishes xhigh/max; that was not re-verified, so the measured ladder stays.
export const AGY_EFFORTS = new Set(['low', 'medium', 'high']);

// Cursor's binary has been published as `cursor-agent` and, later, `agent`.
// `cursor` itself is the IDE launcher and is never spawned.
export const CURSOR_ALIASES = ['cursor', 'cursor-agent', 'agent'];
export const isCursor = (cli) => CURSOR_ALIASES.includes(cli);

function codexArgs({ spec = {}, cwd, sessionId, mcp }) {
  // `exec resume` accepts a strict SUBSET of `exec`'s flags — no -C/--cd, no
  // -s/--sandbox, no -p/--profile. Anything needed on every turn goes via -c,
  // which both forms accept. Codex needs danger-full-access to keep MCP tools:
  // under any confining sandbox codex 0.145.0 denies every MCP call.
  const args = sessionId ? ['exec', 'resume', sessionId] : ['exec'];
  args.push('--json',
    '-c', `sandbox_mode=${JSON.stringify(spec.sandbox ?? 'danger-full-access')}`,
    '-c', 'approval_policy="never"');
  // First turn only. A resumed session keeps its original cwd anyway.
  if (!sessionId) flag(args, '-C', cwd);
  model(args, spec);
  // codex has no --effort flag; reasoning effort is a config override.
  if (spec.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
  if (mcp) {
    // codex parses -c values as TOML; args/env need TOML array/inline-table.
    args.push('-c', `mcp_servers.kingdom.command=${JSON.stringify(mcp.command)}`,
      '-c', `mcp_servers.kingdom.args=${JSON.stringify(mcp.args)}`,
      '-c', `mcp_servers.kingdom.env={${Object.entries(mcp.env ?? {})
        .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(',')}}`);
  }
  // The prompt goes down STDIN, never argv: Windows caps a command line at
  // 32,767 chars and spawn throws ENAMETOOLONG synchronously above it.
  args.push('-');
  return args;
}

function claudeArgs({ spec = {}, sessionId, promptFile, mcp, addDirs = [], deny = [] }) {
  const json = spec.outputFormat === 'json';
  const args = ['--print', '--verbose'];
  // Persistent mode feeds turns as stream-json on stdin; json mode is one
  // process per turn with the prompt as plain text on stdin.
  if (!json) args.push('--input-format', 'stream-json');
  args.push('--output-format', json ? 'json' : 'stream-json',
    '--permission-mode', spec.permissionMode ?? 'bypassPermissions',
    // Peasants must not inherit the operator's hooks/plugins/CLAUDE.md.
    '--setting-sources', 'project');
  // append, not --system-prompt: replacing it strips Claude Code's own
  // tool-use guidance. Above the argv budget the caller stages a file.
  if (promptFile) args.push('--append-system-prompt-file', promptFile);
  else args.push('--append-system-prompt', spec.prompt ?? '');
  // json mode: the first turn has no id yet (the CLI mints one and reports it
  // on `result`); every later turn resumes it.
  if (sessionId) args.push(spec.resume || json ? '--resume' : '--session-id', sessionId);
  model(args, spec);
  // Haiku takes no effort flag.
  if (spec.effort && !/haiku/i.test(spec.model ?? '')) flag(args, '--effort', spec.effort);
  // `--tools ""` removes every built-in tool schema for a delegating member.
  flag(args, '--tools', spec.tools);
  if (spec.maxBudgetUsd) args.push('--max-budget-usd', String(spec.maxBudgetUsd));
  for (const dir of addDirs) flag(args, '--add-dir', dir);
  if (deny.length) args.push('--disallowed-tools', ...deny);
  if (mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: { kingdom: mcp } }), '--strict-mcp-config');
  return args;
}

/**
 * agy: the prompt is the VALUE of `--print` since agy 1.1.11 (under the old
 * positional form its flag parser read the NEXT FLAG as the prompt). MCP is
 * not passed as a flag at all; kingdom.js writes `.agents/kingdom-id.json`.
 * No `--add-dir`: it was never passed before and is not verified for agy, and
 * an unknown flag would fail every peasant turn (peasants always get addDirs).
 */
function agyArgs({ spec = {}, sessionId, prompt }) {
  const args = ['--print', prompt, '--output-format', spec.outputFormat === 'json' ? 'json' : 'stream-json'];
  flag(args, '--conversation', sessionId);
  model(args, spec);
  if (AGY_EFFORTS.has(spec.effort)) flag(args, '--effort', spec.effort);
  // Without this every tool call is soft-denied in print mode.
  if (spec.skipPermissions !== false) args.push('--dangerously-skip-permissions');
  flag(args, '--print-timeout', spec.printTimeout ?? '20m');
  return args;
}

/**
 * opencode: `--title` skips opencode's own auto-title model call (measured:
 * that extra call failed on an unrelated credit cap before the real turn).
 * Reasoning effort is `--variant`; valid values are per model.
 */
function openCodeArgs({ spec = {}, sessionId, prompt }) {
  const args = ['run', positional(prompt), '--format', 'json'];
  if (spec.skipPermissions !== false) args.push('--auto');
  args.push('--title', spec.name ?? 'Agentic OS');
  flag(args, '--session', sessionId);
  model(args, spec);
  flag(args, '--variant', spec.effort);
  flag(args, '--agent', spec.agent);
  return args;
}

/**
 * Cursor's headless agent (`cursor-agent` / `agent`). Flags are taken from
 * the cli-integrations branch's reading of the installed help on 2026-10-10;
 * they are NOT verified in this repository against a real binary.
 * No `--add-dir`: unverified for Cursor, and an unknown flag would fail every
 * peasant turn. MCP comes from `<workspace>/.cursor/mcp.json` (kingdom.js).
 */
function cursorArgs({ spec = {}, cwd, sessionId, prompt, mcp }) {
  const args = ['--print', '--output-format', spec.outputFormat === 'json' ? 'json' : 'stream-json'];
  flag(args, '--workspace', cwd);
  flag(args, '--resume', sessionId);
  model(args, spec);
  flag(args, '--mode', spec.mode);
  flag(args, '--sandbox', spec.sandbox);
  if (spec.skipPermissions !== false) args.push('--force');
  // Headless runs cannot answer the workspace-trust or MCP-approval prompts.
  // --approve-mcps approves EVERY server in the workspace config, which is why
  // kingdom.js refuses to merge into a repository's own .cursor/mcp.json.
  if (spec.trust ?? Boolean(mcp)) args.push('--trust');
  if (spec.approveMcps ?? Boolean(mcp)) args.push('--approve-mcps');
  args.push(positional(prompt));
  return args;
}

const present = (v) => v !== undefined && v !== null;

/**
 * Cursor reports camelCase usage. Per the branch author's reading of the
 * installed print transport, inputTokens is fresh input with the cache parts
 * already subtracted — the Anthropic "alongside" shape (see usage.js). Only
 * fields Cursor actually reported are carried; none reported -> null.
 */
export function cursorUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (!present(usage.inputTokens) && !present(usage.outputTokens)) {
    // Already snake_case (or unknown): pass through only if it has numbers.
    return Object.values(usage).some((v) => typeof v === 'number') ? usage : null;
  }
  const out = {};
  if (present(usage.inputTokens)) out.input_tokens = usage.inputTokens;
  if (present(usage.outputTokens)) out.output_tokens = usage.outputTokens;
  if (present(usage.cacheReadTokens)) out.cache_read_input_tokens = usage.cacheReadTokens;
  if (present(usage.cacheWriteTokens)) out.cache_creation_input_tokens = usage.cacheWriteTokens;
  return out;
}

/**
 * opencode `step_finish` tokens: {input, output, reasoning, cache:{read,write}}.
 * opencode normalises `input` to EXCLUDE the cache read (remembered from its
 * session usage code, not re-read here), so the cache parts map to the
 * Anthropic alongside fields — mapping cache.read to codex's nested
 * `cached_input_tokens` would undercount input in usage.js.
 */
export function openCodeUsage(o) {
  if (o.usage && typeof o.usage === 'object') return o.usage;
  const t = o.part?.tokens ?? o.tokens;
  if (t && typeof t === 'object') {
    const out = {};
    if (present(t.input)) out.input_tokens = t.input;
    if (present(t.output)) out.output_tokens = t.output;
    if (present(t.reasoning)) out.reasoning_tokens = t.reasoning;
    if (present(t.cache?.read)) out.cache_read_input_tokens = t.cache.read;
    if (present(t.cache?.write)) out.cache_creation_input_tokens = t.cache.write;
    return Object.keys(out).length ? out : null;
  }
  const out = {};
  if (present(o.tokens_in ?? o.input_tokens)) out.input_tokens = o.tokens_in ?? o.input_tokens;
  if (present(o.tokens_out ?? o.output_tokens)) out.output_tokens = o.tokens_out ?? o.output_tokens;
  return Object.keys(out).length ? out : null;
}

function cursorEvent(o) {
  const id = o.session_id ?? o.sessionId;
  if (id && id !== this.sessionId) { this.sessionId = id; this.emit('ready', id); }
  if (o.type === 'assistant') for (const b of o.message?.content ?? []) {
    if (b.type === 'text' && b.text) { this.ctxChars += b.text.length; this.emit('text', b.text); }
    else if (b.type === 'tool_use') this.emit('tool', { name: b.name, input: b.input });
  }
  if (o.type === 'tool_call' && o.subtype === 'started') {
    const call = o.tool_call?.tool ?? o.tool_call;
    if (call?.case) this.emit('tool', { name: call.case, input: call.value?.args ?? call.value });
    else for (const [name, value] of Object.entries(call ?? {})) {
      this.ctxChars += JSON.stringify(value ?? '').length;
      this.emit('tool', { name, input: value?.args ?? value });
    }
  }
  if (o.type === 'result') {
    if (this.spec.outputFormat === 'json' && typeof o.result === 'string') this.emit('text', o.result);
    if (o.is_error) this.emit('error', message(o.result, 'cursor turn failed'));
    this.lastUsage = cursorUsage(o.usage);
    // Cursor bills against a plan and reports no per-call price.
    this.emit('turn_end', { usage: this.lastUsage, costUsd: 0, costReported: false, ctx: this.ctxTokens() });
  }
  if (o.type === 'error') this.emit('error', message(o.error ?? o.message, 'cursor failed'));
}

function claudeEvent(o) {
  if (o.type === 'system' && o.subtype === 'init') {
    this.sessionId = o.session_id;
    this.emit('ready', o.session_id);
    return;
  }
  // json mode reports its session only on `result`.
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
    if (o.is_error) this.emit('error', message(o.result, 'turn failed'));
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
      // Everything in an item stays in the thread, so it is what the context is made of.
      this.ctxChars += JSON.stringify(item).length;
      if (item.type === 'agent_message') this.emit('text', item.text ?? '');
      else this.emit('tool', { name: item.type, input: item });
      break;
    }
    case 'turn.completed':
      this.lastUsage = o.usage ?? null;
      // Context stays the chars-in-the-thread estimate: codex reports usage
      // only as a turn aggregate. It reports no cost.
      this.emit('turn_end', { usage: o.usage ?? null, costUsd: 0, costReported: false, ctx: this.ctxTokens() });
      break;
    case 'turn.failed':
    case 'error':
      this.emit('error', message(o.error ?? o.message, JSON.stringify(o)));
      break;
  }
}

/**
 * agy, measured against agy 1.1.10:
 *   {"event":"init","conversation_id":..}
 *   {"event":"step_update","step_update":{step_index,state,step_type,text_delta,usage}}
 *   {"event":"result","result":{status,response,num_turns,usage}}
 * Text arrives as fragments, accumulated per step and emitted on DONE.
 * `--output-format json` (opt-in, unverified) yields one bare result object.
 */
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
      this.emit('error', `agy turn ${r.status}${r.error ? `: ${message(r.error, '')}` : ''}`);
    }
    const u = r.usage ?? null;
    if (u) this.ctxExact = u.total_tokens ?? u.input_tokens ?? this.ctxExact;
    this.lastUsage = u;
    // agy reports no price; it bills against a plan.
    this.emit('turn_end', { usage: u, costUsd: 0, costReported: false, ctx: this.ctxTokens() });
  }
}

/**
 * opencode `run --format json`. One process may run several model steps,
 * each closing with `step_finish`; usage and cost accumulate across them and
 * the Agent emits the LAST turn_end once, when the process closes.
 */
function openCodeEvent(o, state = new Map()) {
  const sid = o.sessionID ?? o.sessionId ?? o.session_id ?? (o.type === 'session' ? (o.id ?? o.sessionID) : null);
  if (sid && sid !== this.sessionId) {
    this.sessionId = sid;
    this.emit('ready', sid);
  }

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

  if (o.type === 'tool_use' || o.type === 'tool') {
    const name = o.part?.tool ?? o.tool ?? o.name ?? 'tool';
    const input = o.part?.state?.input ?? o.part?.input ?? o.input ?? {};
    this.ctxChars += JSON.stringify(input).length;
    this.emit('tool', { name, input });
  }

  if (o.type === 'result' || o.type === 'step_finish' || o.type === 'done' || o.event === 'result') {
    if (o.is_error || o.error) this.emit('error', message(o.error ?? o.result, 'opencode turn failed'));

    // Usage: sum step_finish steps; a final result's own usage wins if given.
    const u = openCodeUsage(o);
    if (o.type === 'step_finish') {
      if (u) {
        const total = state.get('usage') ?? {};
        for (const [k, v] of Object.entries(u)) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
        state.set('usage', total);
      }
    } else if (u) state.set('usage', { ...u });
    const usage = state.has('usage') ? { ...state.get('usage') } : null;
    this.lastUsage = usage;

    // Cost: per step it is additive; a final result reports the turn total.
    const rawCost = o.total_cost_usd ?? o.cost ?? o.part?.cost;
    const reported = present(rawCost) && Number.isFinite(Number(rawCost));
    const before = state.get('cost') ?? 0;
    const after = !reported ? before : o.type === 'step_finish' ? before + Number(rawCost) : Number(rawCost);
    if (reported) { state.set('cost', after); state.set('costReported', true); }
    this.costUsd += after - before;

    this.emit('turn_end', {
      usage,
      costUsd: after,
      costReported: state.get('costReported') === true,
      ctx: this.ctxTokens(),
    });
  }

  if (o.type === 'error' && !o.is_error) {
    this.emit('error', message(o.error ?? o.message, 'opencode failed'));
  }
}

// One adapter per CLI family. `input` says how the turn's prompt travels:
// 'stdin' (raw text), 'stream-json' (Claude's persistent stdin protocol; in
// json mode, raw text) or 'argv' (staged to a file above the argv budget).
export const adapters = {
  codex: { buildArgs: codexArgs, parseEvent: codexEvent, authArgs: ['login', 'status'], input: 'stdin' },
  claude: { buildArgs: claudeArgs, parseEvent: claudeEvent, authArgs: ['auth', 'status'], input: 'stdin' },
  agy: { buildArgs: agyArgs, parseEvent: agyEvent, authArgs: ['models'], input: 'argv', authTimeoutMs: 25_000 },
  opencode: { buildArgs: openCodeArgs, parseEvent: openCodeEvent, authArgs: ['auth', 'list'], input: 'argv' },
  cursor: { buildArgs: cursorArgs, parseEvent: cursorEvent, authArgs: ['status', '--format', 'json'], input: 'argv' },
};

export function adapterFor(cli) {
  const adapter = adapters[isCursor(cli) ? 'cursor' : cli];
  if (!adapter) throw new Error(`Unsupported agent CLI: ${cli}`);
  return adapter;
}

// Bounds a pretty-printed document that never closes, so a stray "{" banner
// line cannot swallow every event after it.
const DOCUMENT_LIMIT = 1_000_000;

/**
 * NDJSON, or a single pretty-printed JSON document. Non-JSON lines (banners,
 * warnings) are ignored. end() flushes a final line with no trailing newline.
 */
export function jsonStream(onObject) {
  let buffer = '';
  let document = '';
  const tryParse = (value) => {
    try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false }; }
  };
  // A throwing handler is swallowed, exactly as the old jsonLines did: an
  // 'error' emitted with no listener throws, and from a stdout 'data' handler
  // that would take the daemon and every other member down with it.
  const deliver = (value) => {
    if (value === null || typeof value !== 'object') return;
    try { onObject(value); } catch { /* see above */ }
  };
  const line = (text) => {
    if (document) {
      // A complete object on its own line means the open document was noise.
      const alone = text.startsWith('{') ? tryParse(text) : { ok: false };
      if (alone.ok) { document = ''; deliver(alone.value); return; }
      document += text + '\n';
      const whole = tryParse(document);
      if (whole.ok) { document = ''; deliver(whole.value); }
      else if (document.length > DOCUMENT_LIMIT) document = '';
      return;
    }
    if (text === '{' || text === '[') { document = text + '\n'; return; }
    if (!text) return;
    const parsed = tryParse(text);
    if (parsed.ok) deliver(parsed.value);
  };
  return {
    write(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        line(text);
      }
    },
    end() {
      const tail = buffer.trim();
      buffer = '';
      if (tail) line(tail);
      document = '';
    },
  };
}
