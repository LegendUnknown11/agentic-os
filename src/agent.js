// One Agent = one member of the court (orchestrator, briefer, or peasant), backed by
// either the `claude` or `codex` CLI. Both are normalised to the same events:
//
//   ready(sessionId)  text(str)  tool({name,input})  turn_end({usage,costUsd})
//   error(msg)        exit(code)
//
// Transport difference that matters (see README): a claude agent is ONE
// long-lived process fed turns over stdin, so an injected message interrupts
// it immediately. A codex agent exits between turns and is resumed by thread
// id, so an injected message queues until the current turn finishes.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const IS_WIN = process.platform === 'win32';

// npm-shim CLIs have no real .exe; run the package's JS entry with our own node.
const NPM_ENTRY = {
  codex: '@openai/codex/bin/codex.js',
};
// opencode-ai ships a real native binary via its own postinstall (fetched
// into the package's own bin/), not a JS shim run under node — spawn it directly.
const NPM_NATIVE_ENTRY = {
  opencode: IS_WIN ? 'opencode-ai/bin/opencode.exe' : 'opencode-ai/bin/opencode',
};
// agy's own ladder. Narrower than codex's, and it has no 'none' or 'max' —
// passing one borrowed from another member is rejected outright.
export const AGY_EFFORTS = new Set(['low', 'medium', 'high']);
// Windows caps a command line at 32,767 chars; leave room for the exe path,
// the flags, and the model name. Above this an agy or opencode brief goes to a file.
const AGY_ARGV_BUDGET = 24_000;
const OPENCODE_ARGV_BUDGET = 24_000;
// A claude member's system prompt is fixed at spawn and grows with the roster
// (every peasant's name and description) and the court's own state. Above
// this it goes to a file instead of the command line — claude reads it via
// --append-system-prompt-file, so unlike the agy/opencode brief fallback the
// content never has to be summarised down to "go read this file".
const CLAUDE_SYSPROMPT_ARGV_BUDGET = 24_000;

const cliCache = new Map();

function npmRoots() {
  return [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
    join(homedir(), '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
}

function npmEntry(name) {
  if (!NPM_ENTRY[name]) return null;
  for (const r of npmRoots()) {
    const p = join(r, ...NPM_ENTRY[name].split('/'));
    if (existsSync(p)) return { command: process.execPath, prefixArgs: [p] };
  }
  return null;
}

function npmNativeEntry(name) {
  if (!NPM_NATIVE_ENTRY[name]) return null;
  for (const r of npmRoots()) {
    const p = join(r, ...NPM_NATIVE_ENTRY[name].split('/'));
    if (existsSync(p)) return { command: p, prefixArgs: [] };
  }
  return null;
}

/**
 * Resolve a CLI to a REAL executable + prefix args. Never `shell: true` —
 * on Windows that concatenates argv unescaped and shreds JSON arguments
 * like --mcp-config (this cost an afternoon; don't reintroduce it).
 * Override with KINGDOM_CLAUDE_BIN / KINGDOM_CODEX_BIN.
 */
export function resolveCli(name) {
  if (cliCache.has(name)) return cliCache.get(name);

  const override = process.env[`KINGDOM_${name.toUpperCase()}_BIN`];
  // A .js override runs under our own node — spawn cannot execute a script
  // directly, and this is also what lets the offline tests stub a CLI.
  let out = !override ? null
    : override.endsWith('.js') ? { command: process.execPath, prefixArgs: [override] }
    : { command: override, prefixArgs: [] };

  if (!out && IS_WIN && name === 'codex') out = npmEntry(name);
  // opencode's Windows npm shim is a .cmd/.ps1 wrapper (see the exts comment
  // below) — go straight to the real .exe the same way codex's is found above.
  if (!out && IS_WIN && name === 'opencode') out = npmNativeEntry(name);

  if (!out) {
    const dirs = [
      join(homedir(), '.local', 'bin'),
      // The Antigravity CLI installs itself here and does NOT put itself on
      // PATH, so a court that only searched PATH would report it missing on a
      // machine where it is installed and working.
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'agy', 'bin'),
      join(homedir(), 'AppData', 'Local', 'agy', 'bin'),
      ...(process.env.PATH ?? '').split(delimiter),
    ].filter(Boolean);
    const exts = IS_WIN ? ['.exe'] : ['']; // .cmd/.ps1 shims would need a shell
    outer: for (const d of dirs) {
      if (!d) continue;
      for (const e of exts) {
        const p = join(d, name + e);
        if (existsSync(p)) {
          out = { command: p, prefixArgs: [] };
          break outer;
        }
      }
    }
  }

  if (!out) out = npmEntry(name);
  if (!out) out = npmNativeEntry(name);

  if (!out) throw new Error(`Cannot find the '${name}' CLI. Set KINGDOM_${name.toUpperCase()}_BIN.`);
  cliCache.set(name, out);
  return out;
}

/** Split a stream into whole JSON lines; chunks split mid-line all the time. */
function jsonLines(onObj) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onObj(JSON.parse(line));
      } catch {
        // Non-JSON noise on stdout (banners, warnings). Ignore.
      }
    }
  };
}

// A turn-based CLI that hangs looks exactly like thinking: the process is
// alive, the CPU is idle, and nothing in the court says a word. agy is given
// --print-timeout for this; codex had no bound of any kind, so a wedged turn
// would hold `busy` forever and the member would never take another message.
// Not observed hanging in a run — this closes the gap before it is.
const TURN_TIMEOUT_MS = Number(process.env.KINGDOM_TURN_TIMEOUT_MS ?? 20 * 60_000);

/**
 * Kill a turn that overruns, and make sure it ENDS rather than just dying.
 * Returns {clear, timedOut()} — the exit handler must call clear().
 */
function armTurnWatchdog(agent, cli, proc) {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    agent.emit('error',
      `${cli} turn exceeded ${Math.round(TURN_TIMEOUT_MS / 60_000)} minutes and was stopped.`);
    proc.kill();
  }, TURN_TIMEOUT_MS);
  return { clear: () => clearTimeout(timer), timedOut: () => fired };
}

/**
 * spawn() that cannot wedge a member.
 *
 * Some failures (ENOENT, ENAMETOOLONG, E2BIG) throw SYNCHRONOUSLY rather than
 * emitting 'error'. The turn-based CLIs clear `busy` and end the turn in
 * proc.on('exit') — which never fires for a process that never existed. The
 * member then stays busy forever while the orchestrator has already acked its
 * mail, so the order is lost and the court goes quiet with no explanation.
 * Returns null when the spawn failed; the caller must return.
 */
function spawnGuarded(agent, cli, command, args, opts) {
  try {
    return spawn(command, args, opts);
  } catch (e) {
    agent.busy = false;
    agent.proc = null;
    agent.emit('error', `${cli} could not be started: ${e.message}`);
    agent.emit('turn_end', { usage: null, costUsd: 0, ctx: agent.ctxTokens() });
    return null;
  }
}

/**
 * resolveCli() throws SYNCHRONOUSLY when a binary can't be found anywhere —
 * that throw was landing after `busy = true` and before spawnGuarded's own
 * try/catch, at every one of its four call sites, so a missing CLI wedged
 * the member busy forever with no 'error' or 'turn_end' emitted at all (the
 * exact silent-hang failure spawnGuarded exists to prevent). Same recovery,
 * one place. Returns null when the CLI could not be resolved; the caller
 * must return.
 */
function resolveCliGuarded(agent, cli) {
  try {
    return resolveCli(cli);
  } catch (e) {
    agent.busy = false;
    agent.proc = null;
    agent.emit('error', `${cli} could not be started: ${e.message}`);
    agent.emit('turn_end', { usage: null, costUsd: 0, ctx: agent.ctxTokens() });
    return null;
  }
}

// Commands a peasant has no business running. Publishing, history rewriting,
// and worktree/branch surgery all reach outside its own branch.
export const DEFAULT_DENY = [
  'Bash(git push:*)',
  'Bash(git remote:*)',
  'Bash(git worktree:*)',
  'Bash(git reset --hard:*)',
  'Bash(git checkout master:*)',
  'Bash(git checkout main:*)',
  'Bash(git branch -D:*)',
  'Bash(git rebase:*)',
];

// Real auth, which must survive sanitising.
const AUTH_VARS = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)$/;
// Host-session markers. If the kingdom is launched from inside a Claude Code or
// Claude Desktop session, children inherit these, believe they are a managed
// child session, and refuse to authenticate ("OAuth session expired and could
// not be refreshed"). A peasant must be an independent session.
const HOST_SESSION_VARS = /^CLAUDE(CODE|_CODE|_PID|_AGENT|_EFFORT|_PREVIEW)/;

export function claudeEnv(extra) {
  const env = { ...process.env, ...(extra ?? {}) };
  for (const k of Object.keys(env)) {
    if (HOST_SESSION_VARS.test(k) && !AUTH_VARS.test(k)) delete env[k];
  }
  return env;
}

/**
 * Sandbox modes that make codex deny every MCP tool call. Confining the
 * sandbox silently costs a member all of its kingdom tools, so callers check
 * this and say so out loud rather than letting it be discovered over days.
 */
export const MUTES_KINGDOM_TOOLS = new Set(['workspace-write', 'read-only']);

export class Agent extends EventEmitter {
  /**
   * @param {object} spec  roster entry: {name, cli, model, prompt, ...}
   * @param {object} opts  {cwd, mcp: {command,args,env}, sessionId}
   */
  constructor(spec, opts = {}) {
    super();
    this.spec = spec;
    this.name = spec.name;
    this.cli = spec.cli ?? 'claude';
    this.cwd = opts.cwd ?? process.cwd();
    this.mcp = opts.mcp ?? null;
    this.addDirs = opts.addDirs ?? [];
    this.env = opts.env ?? null; // per-agent auth, so the court can spread quota
    this.sessionId = opts.sessionId ?? null;
    this.proc = null;
    this.busy = false;
    this.queue = [];
    this.alive = false;
    this.lastUsage = null;
    this.costUsd = 0;
    // Context size. See ctxTokens() — this is NOT the turn's usage total.
    this.ctxExact = null;
    this.ctxChars = (opts.ctxSeed ?? 0) * 4;
  }

  /**
   * How big this member's conversation actually is.
   *
   * The turn-level `usage` both CLIs report is summed over every model call in
   * the turn, so a turn with a hundred tool calls reports a hundred replays of
   * the context. That is a measure of work done, not of conversation size, and
   * reading it as context is what produced a "30378k ctx" coder.
   *
   *   claude — each `assistant` message carries the usage of ONE call, which is
   *            exactly the context at that moment. Exact.
   *   codex  — reports nothing per call, so estimate from what has actually
   *            passed through: prompts in, items out, 4 chars to a token.
   */
  ctxTokens() {
    // Nothing has a two-million-token window; a figure that large means the
    // field was an aggregate after all, so fall back to the estimate.
    if (this.ctxExact && this.ctxExact < 2_000_000) return this.ctxExact;
    return Math.round(this.ctxChars / 4);
  }

  start() {
    if (this.cli === 'claude') this.#startClaude();
    // codex has no persistent process; the first send() spawns a turn.
    else this.alive = true;
    return this;
  }

  /** Deliver a turn. Injected mid-flight for claude, queued for codex. */
  send(text) {
    if (this.cli === 'claude') {
      if (!this.proc) this.#startClaude();
      this.busy = true;
      this.proc.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
        }) + '\n'
      );
      return;
    }
    this.queue.push(text);
    // agy is turn-based like codex: no persistent process, one child per turn.
    if (!this.busy) this.#runTurn();
  }

  /** codex, agy, and opencode all spawn a fresh child per turn; claude holds one open. */
  #runTurn() {
    if (this.cli === 'agy') return this.#runAgyTurn();
    if (this.cli === 'opencode') return this.#runOpenCodeTurn();
    return this.#runCodexTurn();
  }

  stop() {
    this.stopped = true;
    this.alive = false;
    this.queue.length = 0;
    if (this.proc) {
      // ponytail: SIGTERM is enough for both CLIs; they flush and exit.
      // On Windows there is no SIGTERM, so kill() maps to TerminateProcess.
      this.proc.kill();
      this.proc = null;
    }
  }

  /**
   * A member the orchestrator deliberately killed did not fail.
   *
   * `stop()` kills the process, but its `exit` lands a tick later, and every
   * exit handler here reads a turn that produced no output as a crash —
   * because from inside the turn that is exactly what a crash looks like. The
   * spurious `error` that followed had nobody left to catch it on a shutdown
   * path, so Node promoted it to an unhandled 'error' event and killed the
   * process. It failed the suite roughly half the time, in whichever test
   * happened to stop a court while a turn was in flight.
   *
   * Guarding every emit site would be four guards that the fifth exit handler
   * forgets. One gate, where they all pass through.
   *
   * `stopped`, not `alive`: `alive` goes false on ordinary CLI failures too,
   * and those errors are the whole point of having an error event.
   */
  emit(event, ...args) {
    return this.stopped ? false : super.emit(event, ...args);
  }

  // --- claude: one process, many turns --------------------------------

  #startClaude() {
    this.sessionId ??= randomUUID();
    // A stale staged file from a previous spawn (a resume after a crash, say)
    // must not linger — it is never read again once this call picks a fresh one.
    if (this.sysPromptFile) { rmSync(this.sysPromptFile, { force: true }); this.sysPromptFile = null; }
    const prompt = this.spec.prompt ?? '';
    const args = [
      '--print',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      // Peasants must not inherit the operator's hooks/plugins/CLAUDE.md —
      // otherwise every peasant gets the user's global prompt injected.
      '--setting-sources', 'project',
    ];
    // append, not --system-prompt: replacing it strips Claude Code's own
    // tool-use guidance and lobotomises the agent. Inline above the budget
    // and spawn() throws ENAMETOOLONG synchronously — the file form is real
    // (verified against the installed CLI), not a documented-only flag.
    if (prompt.length <= CLAUDE_SYSPROMPT_ARGV_BUDGET) {
      args.push('--append-system-prompt', prompt);
    } else {
      const file = join(tmpdir(), `kingdom-sysprompt-${this.name}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(file, prompt, 'utf8');
      this.sysPromptFile = file;
      args.push('--append-system-prompt-file', file);
    }
    if (this.spec.resume) args.push('--resume', this.sessionId);
    else args.push('--session-id', this.sessionId);
    if (this.spec.model) args.push('--model', this.spec.model);
    // Haiku takes no effort flag; passing one is meaningless at best.
    if (this.spec.effort && !/haiku/i.test(this.spec.model ?? '')) {
      args.push('--effort', this.spec.effort);
    }
    // Built-in tool schemas are re-sent on EVERY turn. A member that delegates
    // rather than edits (orchestrator, briefer) needs none of them — `--tools ""`
    // removes the lot. This also enforces the role boundary for free.
    if (this.spec.tools !== undefined) args.push('--tools', this.spec.tools);
    if (this.spec.maxBudgetUsd) args.push('--max-budget-usd', String(this.spec.maxBudgetUsd));
    // Without this a peasant cannot read its siblings' worktrees to review them.
    for (const d of this.addDirs) args.push('--add-dir', d);
    // Claude Code has no OS sandbox on Windows, so confinement here is
    // mitigation, not a guarantee: deny the commands that escape the worktree
    // or publish work nobody approved. The sovereign's Merge button is the only
    // sanctioned way anything leaves a branch.
    const denied = this.spec.deny ?? DEFAULT_DENY;
    if (denied.length) args.push('--disallowed-tools', ...denied);
    if (this.mcp) {
      args.push(
        '--mcp-config',
        JSON.stringify({ mcpServers: { kingdom: this.mcp } }),
        '--strict-mcp-config'
      );
    }

    const resolved = resolveCliGuarded(this, 'claude');
    if (!resolved) return;
    const { command, prefixArgs } = resolved;
    const proc = spawnGuarded(this, 'claude', command, [...prefixArgs, ...args], {
      cwd: this.cwd,
      env: claudeEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!proc) return;
    this.proc = proc;
    this.alive = true;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', jsonLines((o) => this.#onClaudeEvent(o)));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => this.emit('stderr', d));
    // A write to a dead pipe emits on the SOCKET, and an 'error' with no
    // listener is not an error — it is Node throwing, which takes the daemon
    // and every other member down with it. #runCodexTurn has always guarded
    // this; the long-lived claude process, which is exposed to it on every
    // turn rather than once, did not.
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      this.alive = false;
      this.proc = null;
      // The CLI already read this at spawn; a resume stages a fresh one.
      if (this.sysPromptFile) { rmSync(this.sysPromptFile, { force: true }); this.sysPromptFile = null; }
      // The CLI created this session, so a restart must RESUME it. Left false,
      // #startClaude passes --session-id with an id that already exists, claude
      // refuses it, and the member is permanently dead while the roster still
      // reports it awake.
      this.spec.resume = true;
      // A turn that died mid-flight never reaches the `result` event, so `busy`
      // would stay true forever: the ripeness gate is skipped by the backstop,
      // every later batch is fed to a corpse and acked, and the sovereign's
      // orders vanish with nothing logged. Say so instead — "produced no
      // output" is what #rewindForRetry already watches for, so the batch is
      // redelivered without a second mechanism.
      if (this.busy) {
        this.busy = false;
        this.emit('error', `claude exited (${code}) mid-turn and produced no output.`);
        this.emit('turn_end', { usage: null, costUsd: 0, ctx: this.ctxTokens() });
      }
      this.emit('exit', code);
    });
    proc.on('error', (e) => this.emit('error', e.message));
  }

  #onClaudeEvent(o) {
    if (o.type === 'system' && o.subtype === 'init') {
      this.sessionId = o.session_id;
      this.emit('ready', o.session_id);
      return;
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
      this.busy = false;
      this.lastUsage = o.usage ?? null;
      this.costUsd += o.total_cost_usd ?? 0;
      if (o.is_error) this.emit('error', o.result ?? 'turn failed');
      this.emit('turn_end', { usage: o.usage, costUsd: o.total_cost_usd ?? 0, ctx: this.ctxTokens() });
    }
  }

  // --- codex: one process per turn, resumed by thread id --------------

  #runCodexTurn() {
    const text = this.queue.shift();
    if (text === undefined) return;
    this.busy = true;

    // `exec resume` accepts a strict SUBSET of `exec`'s flags. It has no
    // -C/--cd, no -s/--sandbox, no -p/--profile, no --oss. Passing any of them
    // is a fatal `unexpected argument` before a single line of output — the
    // process flashes a console window and dies, and the member simply never
    // answers. Anything needed on EVERY turn therefore goes through -c, which
    // both forms accept.
    //
    // SANDBOX vs KINGDOM TOOLS — you cannot have both on codex 0.145.0.
    //
    // Under ANY confining sandbox, `codex exec` denies every MCP tool call with
    // "user cancelled MCP tool call". Measured, not assumed: the MCP server
    // starts and stays alive, so it is a denial, not a connection failure, and
    // it happens under approval_policy never / on-failure / on-request alike.
    // `sandbox_workspace_write.writable_roots` does not help because the gate
    // is approval, not file access. Only danger-full-access lets a tool call
    // through.
    //
    // A court member with no send_message, no declare_done and no vault is not
    // a court member, so the default is the one that works. The cost is real:
    // codex members now have the same posture as claude members — prompt and
    // policy, not an OS boundary. Set "sandbox" per member to take it back, and
    // accept that member losing every kingdom tool.
    const sandbox = this.spec.sandbox ?? 'danger-full-access';
    const args = ['exec', '--json',
      '-c', `sandbox_mode="${sandbox}"`,
      '-c', 'approval_policy="never"'];
    // First turn only. A resumed session keeps its original cwd anyway, and we
    // set the child's cwd regardless.
    if (!this.sessionId) args.push('-C', this.cwd);
    if (this.spec.model) args.push('--model', this.spec.model);
    // codex has no --effort flag; reasoning effort is a config override.
    if (this.spec.effort) args.push('-c', `model_reasoning_effort="${this.spec.effort}"`);
    if (this.mcp) {
      // codex parses -c values as TOML; args/env need TOML array/inline-table.
      args.push('-c', `mcp_servers.kingdom.command=${JSON.stringify(this.mcp.command)}`);
      args.push('-c', `mcp_servers.kingdom.args=${JSON.stringify(this.mcp.args)}`);
      args.push(
        '-c',
        `mcp_servers.kingdom.env={${Object.entries(this.mcp.env ?? {})
          .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
          .join(',')}}`
      );
    }
    // Persona rides along with the first turn; codex has no --append-system-prompt.
    const prompt = this.sessionId ? text : `${this.spec.prompt ?? ''}\n\n---\n\n${text}`;
    this.ctxChars += prompt.length;
    if (this.sessionId) args.splice(1, 0, 'resume', this.sessionId);
    // The prompt goes down STDIN, not argv. Windows caps a command line at
    // 32,767 chars, and a long sovereign brief blows past it: spawn throws
    // ENAMETOOLONG synchronously, so `exit` never fires, `busy` never clears,
    // and the member is wedged for the rest of the session with its message
    // already acked. `-` means "read the prompt from stdin", on both `exec`
    // and `exec resume`.
    args.push('-');

    const resolved = resolveCliGuarded(this, 'codex');
    if (!resolved) return;
    const { command, prefixArgs } = resolved;
    const proc = spawnGuarded(this, 'codex', command, [...prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Otherwise every turn flashes a console window on the sovereign's desktop.
      windowsHide: true,
    });
    if (!proc) return;
    proc.stdin.on('error', () => {}); // a child that dies early must not throw EPIPE
    proc.stdin.end(prompt);
    this.proc = proc;
    this.alive = true;

    let spoke = false;   // did this turn produce ANY protocol output?
    let err = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', jsonLines((o) => { spoke = true; this.#onCodexEvent(o); }));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-600); this.emit('stderr', d); });
    const dog = armTurnWatchdog(this, 'codex', proc);
    proc.on('error', (e) => this.emit('error', e.message));
    proc.on('exit', (code) => {
      dog.clear();
      this.busy = false;
      this.proc = null;
      // A turn that produced nothing at all is the failure mode that hides:
      // bad arguments, a missing session, a dead binary. Silence used to look
      // exactly like thinking, so say it out loud and end the turn.
      if (!spoke) {
        this.emit('error',
          `codex produced no output (exit ${code}). ${err.trim() || 'No error text.'}`);
      }
      // A killed turn never reaches turn.completed, so the orchestrator would
      // never see it end — no spend, no context, no recycle, no redelivery.
      if (!spoke || dog.timedOut()) {
        this.emit('turn_end', { usage: null, costUsd: 0, ctx: this.ctxTokens() });
      }
      if (this.queue.length) this.#runCodexTurn();
    });
  }

  /**
   * One turn on the Antigravity CLI (`agy`).
   *
   * Protocol, measured against agy 1.1.10 rather than taken from the docs:
   *   {"event":"init","conversation_id":..,"init":{model,cwd,tools[],permission_mode}}
   *   {"event":"step_update","step_update":{step_index,state,step_type,text_delta,usage}}
   *   {"event":"result","result":{status,response,num_turns,usage}}
   *
   * Three things differ from codex and all three matter:
   *  - Text arrives as `text_delta` FRAGMENTS. Emitting each one would put a
   *    token per line in the transcript, so deltas are accumulated per step and
   *    emitted once the step reports DONE.
   *  - The session id is `conversation_id` and resuming takes `--conversation`.
   *  - MCP servers cannot be passed as flags at all; they are read from
   *    `.agents/mcp_config.json` in the workspace. kingdom.js writes that file.
   *
   * The prompt is the VALUE of `--print`, not a trailing positional.
   * agy 1.1.10 took `--print` as a boolean and the prompt as the last argument;
   * 1.1.11 (which the CLI installs by itself — there is an agy.exe.*.old lying
   * beside the binary) made `--print` take the prompt, with `--prompt` as an
   * alias for it. Under the old form its Go flag parser read the NEXT FLAG as
   * the prompt: the orchestrator spent its turn answering a chat question about what
   * `--output-format` means, emitted no JSONL at all, and was reported as
   * having produced no output and failed.
   */
  /**
   * agy has no stdin prompt and no --prompt-file, so a long brief cannot go on
   * the command line: Windows caps it at 32,767 chars and spawn throws
   * ENAMETOOLONG. Measured — a 53,214-char sovereign brief died in 0.2s.
   *
   * But agy IS an agentic CLI with file tools, so hand it the brief as a file
   * and ask it to read it. The file goes to the OS temp directory, NEVER the
   * member's cwd: a peasant's cwd is a git worktree and `commitAll` does
   * `git add -A`, so a brief written there would be committed into the
   * sovereign's repository and merged.
   *
   * Returns the prompt to actually pass on the command line.
   */
  #agyPrompt(prompt) {
    if (prompt.length <= AGY_ARGV_BUDGET) return prompt;
    try {
      const file = join(tmpdir(), `kingdom-brief-${this.name}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(file, prompt, 'utf8');
      this.briefFile = file;   // removed when the turn exits
      return `Your full instructions are too long for this command line, so they are in a `
        + `file. Read it and follow it exactly as if it had been typed here:\n\n${file}\n\n`
        + `Read that file FIRST, before doing anything else. Do not summarise it back to me.`;
    } catch (e) {
      // Falling back to the raw prompt means spawnGuarded reports ENAMETOOLONG
      // and the order is redelivered — worse than the file, better than silence.
      this.emit('error', `Could not stage a long agy brief (${e.message}); sending it inline.`);
      return prompt;
    }
  }

  #runAgyTurn() {
    if (this.busy || !this.queue.length || !this.alive) return;
    this.busy = true;
    const text = this.queue.shift();

    const prompt = this.sessionId ? text : `${this.spec.prompt ?? ''}\n\n---\n\n${text}`;
    this.ctxChars += prompt.length;

    const args = ['--print', this.#agyPrompt(prompt), '--output-format', 'stream-json'];
    if (this.sessionId) args.push('--conversation', this.sessionId);
    if (this.spec.model) args.push('--model', this.spec.model);
    // agy's ladder is only low|medium|high — it has no xhigh/max/none, so a
    // value borrowed from a codex member would be rejected outright.
    if (this.spec.effort && AGY_EFFORTS.has(this.spec.effort)) {
      args.push('--effort', this.spec.effort);
    }
    // Without this every tool call is soft-denied in print mode, which is the
    // same trap codex sprang: the member looks alive and can do nothing.
    if (this.spec.skipPermissions !== false) args.push('--dangerously-skip-permissions');
    args.push('--print-timeout', this.spec.printTimeout ?? '20m');

    // agy has no stdin prompt, so a long brief still cannot be sent to it —
    // but it must fail LOUDLY rather than wedging the member forever.
    const resolved = resolveCliGuarded(this, 'agy');
    if (!resolved) return;
    const { command, prefixArgs } = resolved;
    const proc = spawnGuarded(this, 'agy', command, [...prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!proc) return;
    this.proc = proc;
    this.alive = true;

    let spoke = false;
    let err = '';
    const steps = new Map();   // step_index -> accumulated text

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', jsonLines((o) => { spoke = true; this.#onAgyEvent(o, steps); }));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-600); this.emit('stderr', d); });
    const dog = armTurnWatchdog(this, 'agy', proc);
    proc.on('error', (e) => this.emit('error', e.message));
    proc.on('exit', (code) => {
      dog.clear();
      // A staged brief is read once, at the start of the turn it belongs to.
      // Leaving them behind would strew 50kB files through temp for every
      // long order the court ever takes.
      if (this.briefFile) {
        rmSync(this.briefFile, { force: true });
        this.briefFile = null;
      }
      this.busy = false;
      this.proc = null;
      if (!spoke) {
        this.emit('error',
          `agy produced no output (exit ${code}). ${err.trim() || 'No error text.'}`);
      }
      if (!spoke || dog.timedOut()) {
        this.emit('turn_end', { usage: null, costUsd: 0, ctx: this.ctxTokens() });
      }
      if (this.queue.length) this.#runAgyTurn();
    });
  }

  #onAgyEvent(o, steps) {
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
      } else if (s.step_type !== 'user_input' && s.step_type !== 'checkpoint'
                 && s.step_type !== 'unknown') {
        // Everything else is the model acting: a command, an edit, an MCP call.
        this.emit('tool', { name: s.step_type, input: s });
      }
      return;
    }

    if (o.event === 'result') {
      const r = o.result ?? {};
      if (r.status && r.status !== 'SUCCESS') {
        this.emit('error', `agy turn ${r.status}${r.error ? `: ${r.error}` : ''}`);
      }
      const u = r.usage ?? null;
      if (u) this.ctxExact = u.total_tokens ?? u.input_tokens ?? this.ctxExact;
      this.lastUsage = u;
      // agy reports no price; like codex it bills against a plan, not per call.
      this.emit('turn_end', { usage: u, costUsd: 0, ctx: this.ctxTokens() });
    }
  }

  #onCodexEvent(o) {
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
        this.emit('turn_end', { usage: o.usage, costUsd: 0, ctx: this.ctxTokens() });
        break;
      case 'turn.failed':
      case 'error':
        this.emit('error', o.error?.message ?? o.message ?? (typeof o === 'string' ? o : JSON.stringify(o)));
        break;
    }
  }

  // --- opencode: turn-based CLI with --format json streaming ----------

  #opencodePrompt(prompt) {
    if (prompt.length <= OPENCODE_ARGV_BUDGET) return prompt;
    try {
      const file = join(tmpdir(), `kingdom-brief-${this.name}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(file, prompt, 'utf8');
      this.briefFile = file;
      return `Your full instructions are in a file. Read it and follow it exactly as if it had been typed here:\n\n${file}\n\n`
        + `Read that file FIRST, before doing anything else. Do not summarise it back to me.`;
    } catch (e) {
      this.emit('error', `Could not stage a long opencode brief (${e.message}); sending it inline.`);
      return prompt;
    }
  }

  #runOpenCodeTurn() {
    if (this.busy || !this.queue.length || !this.alive) return;
    this.busy = true;
    const text = this.queue.shift();

    const prompt = this.sessionId ? text : `${this.spec.prompt ?? ''}\n\n---\n\n${text}`;
    this.ctxChars += prompt.length;

    // --title skips opencode's own auto-generated-title turn (a separate,
    // small-model LLM call on every single run) — measured live: with no
    // title it ran google/gemini-3.7-flash first and, on this account, that
    // call errored out on an unrelated credit cap before the real turn ever
    // started streaming.
    const args = ['run', this.#opencodePrompt(prompt), '--format', 'json', '--auto', '--title', this.name];
    if (this.sessionId) args.push('--session', this.sessionId);
    if (this.spec.model) args.push('--model', this.spec.model);
    // Not gated against a local allowlist, unlike agy: opencode's reasoning
    // flag is --variant, not --effort, and the valid values are per-model
    // (kingdom.js's effortsFor()/config.efforts.byModel is what already
    // decides what's offered — trust it, the same way claude/codex do below).
    if (this.spec.effort) args.push('--variant', this.spec.effort);
    if (this.spec.agent) args.push('--agent', this.spec.agent);

    const resolved = resolveCliGuarded(this, 'opencode');
    if (!resolved) return;
    const { command, prefixArgs } = resolved;
    const proc = spawnGuarded(this, 'opencode', command, [...prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!proc) return;
    this.proc = proc;
    this.alive = true;

    let spoke = false;
    let err = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', jsonLines((o) => { spoke = true; this.#onOpenCodeEvent(o); }));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-600); this.emit('stderr', d); });
    const dog = armTurnWatchdog(this, 'opencode', proc);
    proc.on('error', (e) => this.emit('error', e.message));
    proc.on('exit', (code) => {
      dog.clear();
      if (this.briefFile) {
        rmSync(this.briefFile, { force: true });
        this.briefFile = null;
      }
      this.busy = false;
      this.proc = null;
      if (!spoke) {
        this.emit('error',
          `opencode produced no output (exit ${code}). ${err.trim() || 'No error text.'}`);
      }
      if (!spoke || dog.timedOut()) {
        this.emit('turn_end', { usage: null, costUsd: 0, ctx: this.ctxTokens() });
      }
      if (this.queue.length) this.#runOpenCodeTurn();
    });
  }

  #onOpenCodeEvent(o) {
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
      const input = o.part?.input ?? o.input ?? {};
      this.ctxChars += JSON.stringify(input).length;
      this.emit('tool', { name, input });
    }

    // Result / turn completion
    if (o.type === 'result' || o.type === 'step_finish' || o.type === 'done' || o.event === 'result') {
      if (o.is_error || o.error) {
        this.emit('error', o.error ?? o.result ?? 'opencode turn failed');
      }
      const u = o.usage ?? {
        input_tokens: o.tokens_in ?? o.input_tokens ?? 0,
        output_tokens: o.tokens_out ?? o.output_tokens ?? 0,
        total_tokens: (o.tokens_in ?? o.input_tokens ?? 0) + (o.tokens_out ?? o.output_tokens ?? 0),
      };
      this.lastUsage = u;
      if (u.total_tokens || u.input_tokens) {
        this.ctxExact = u.total_tokens ?? u.input_tokens;
      }
      this.costUsd += o.total_cost_usd ?? o.cost ?? 0;
      this.emit('turn_end', { usage: u, costUsd: o.total_cost_usd ?? o.cost ?? 0, ctx: this.ctxTokens() });
    }

    if (o.type === 'error' && !o.is_error) {
      this.emit('error', o.error?.message ?? o.message ?? (typeof o === 'string' ? o : JSON.stringify(o)));
    }
  }
}
