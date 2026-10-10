// One Agent = one member of the court (orchestrator, briefer, or peasant), backed by
// a CLI adapter. Supported protocols are normalised to the same events:
//
//   ready(sessionId)  text(str)  tool({name,input})  turn_end({usage,costUsd})
//   error(msg)        exit(code)
//
// Transport difference that matters (see README): a claude agent is ONE
// long-lived process fed turns over stdin, so an injected message interrupts
// it immediately. A codex agent exits between turns and is resumed by thread
// id, so an injected message queues until the current turn finishes.
import { adapterFor, jsonStream, AGY_EFFORTS } from './cli-adapters.js';
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
export { AGY_EFFORTS };
// Windows caps a command line at 32,767 chars; leave room for the exe path,
// the flags, and the model name. Above this an agy or opencode brief goes to a file.
const BRIEF_ARGV_BUDGET = 24_000;
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

  const cursor = ['cursor', 'cursor-agent', 'agent'].includes(name);
  const override = process.env[`KINGDOM_${name.toUpperCase()}_BIN`]
    ?? (cursor ? process.env.KINGDOM_CURSOR_BIN ?? process.env.KINGDOM_CURSOR_AGENT_BIN : undefined);
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
        for (const binary of (['cursor', 'cursor-agent', 'agent'].includes(name) ? ['cursor-agent', 'agent'] : [name])) {
          const p = join(d, binary + e);
          if (existsSync(p)) {
            out = { command: p, prefixArgs: [] };
            break outer;
          }
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
    return failedStart(agent, cli, e);
  }
}

function failedStart(agent, cli, e) {
  for (const key of ['briefFile', 'sysPromptFile']) {
    if (agent[key]) { rmSync(agent[key], { force: true }); agent[key] = null; }
  }
  agent.busy = false;
  agent.proc = null;
  agent.emit('error', `${cli} could not be started: ${e.message}`);
  agent.emit('turn_end', { usage: null, costUsd: 0, ctx: agent.ctxTokens() });
  return null;
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
    return failedStart(agent, cli, e);
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
    this.adapter = adapterFor(this.cli);
    if (this.sessionId && this.cli === 'claude') this.spec = { ...spec, resume: true };
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
    if (this.cli === 'claude' && this.spec.outputFormat !== 'json') this.#startClaude();
    // codex has no persistent process; the first send() spawns a turn.
    else this.alive = true;
    return this;
  }

  /** Deliver a turn. Injected mid-flight for claude, queued for codex. */
  send(text) {
    if (this.cli === 'claude' && this.spec.outputFormat !== 'json') {
      if (!this.proc) this.#startClaude();
      if (!this.proc) return;
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
    if (this.busy || !this.queue.length || !this.alive) return;
    this.busy = true;
    const text = this.queue.shift();
    const prompt = this.sessionId || this.cli === 'claude' ? text : `${this.spec.prompt ?? ''}\n\n---\n\n${text}`;
    this.ctxChars += prompt.length;
    let args;
    try {
      args = this.adapter.buildArgs({ spec: this.spec, cwd: this.cwd, sessionId: this.sessionId,
        prompt: this.adapter.input === 'argv' ? this.#stagedPrompt(this.cli, prompt) : prompt,
        promptFile: this.cli === 'claude' ? this.#stageSystemPrompt() : undefined,
        mcp: this.mcp, addDirs: this.addDirs, deny: this.spec.deny ?? DEFAULT_DENY });
    } catch (e) { failedStart(this, this.cli, e); return; }
    this.#spawnTurn(this.cli, args, ['stdin', 'stream-json'].includes(this.adapter.input) ? prompt : undefined);
  }

  stop(reason = 'stopped') {
    this.stopped = true;
    this.stopReason = reason;
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

  #stageSystemPrompt() {
    // A stale staged file from a previous spawn (a resume after a crash, say)
    // must not linger — it is never read again once this call picks a fresh one.
    if (this.sysPromptFile) { rmSync(this.sysPromptFile, { force: true }); this.sysPromptFile = null; }
    const prompt = this.spec.prompt ?? '';
    if (prompt.length > CLAUDE_SYSPROMPT_ARGV_BUDGET) {
      const file = join(tmpdir(), `kingdom-sysprompt-${this.name}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 });
      this.sysPromptFile = file;
    }
    return this.sysPromptFile;
  }

  #startClaude() {
    this.sessionId ??= randomUUID();
    const promptFile = this.#stageSystemPrompt();
    const args = this.adapter.buildArgs({ spec: this.spec, sessionId: this.sessionId,
      promptFile, mcp: this.mcp, addDirs: this.addDirs,
      deny: this.spec.deny ?? DEFAULT_DENY });

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
    const stream = jsonStream((o) => this.adapter.parseEvent.call(this, o));
    proc.stdout.on('data', (d) => stream.write(d));
    proc.stdout.on('end', () => stream.end());
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


  /**
   * One child process for one turn, shared by every turn-based CLI: spawn it
   * guarded, stream its JSON to the adapter, and make sure the turn ENDS
   * however the child does. `input`, when given, goes down stdin.
   */
  #spawnTurn(cli, args, input) {
    const resolved = resolveCliGuarded(this, cli);
    if (!resolved) return;
    const { command, prefixArgs } = resolved;
    const proc = spawnGuarded(this, cli, command, [...prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Otherwise every turn flashes a console window on the sovereign's desktop.
      windowsHide: true,
      env: cli === 'claude' ? claudeEnv(this.env) : { ...process.env, ...(this.env ?? {}) },
    });
    if (!proc) return;
    if (input !== undefined) {
      proc.stdin.on('error', () => {}); // a child that dies early must not throw EPIPE
      proc.stdin.end(input);
    }
    this.proc = proc;
    this.alive = true;

    let completion = null;
    const originalEmit = this.emit;
    // Parse through a receiver so completion cannot end a multi-step turn early.
    const receiver = Object.create(this);
    receiver.emit = (event, ...values) => {
      if (event === 'turn_end') completion = values[0];
      else originalEmit.call(this, event, ...values);
    };
    let spoke = false;   // did this turn produce ANY protocol output?
    let err = '';
    proc.stdout.setEncoding('utf8');
    const stream = jsonStream((o) => {
      spoke = true;
      this.adapter.parseEvent.call(receiver, o, steps);
      for (const key of ['sessionId', 'lastUsage', 'ctxChars', 'ctxExact', 'costUsd']) this[key] = receiver[key];
    });
    const steps = new Map();
    proc.stdout.on('data', (d) => stream.write(d));
    proc.stdout.on('end', () => stream.end());
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-600); this.emit('stderr', d); });
    const dog = armTurnWatchdog(this, cli, proc);
    proc.on('error', (e) => this.emit('error', e.message));
    proc.on('close', (code) => {
      stream.end();
      dog.clear();
      // A staged brief is read once, at the start of the turn it belongs to.
      // Leaving them behind would strew 50kB files through temp for every
      // long order the court ever takes.
      for (const key of ['briefFile', 'sysPromptFile']) {
        if (this[key]) { rmSync(this[key], { force: true }); this[key] = null; }
      }
      this.busy = false;
      this.proc = null;
      // A turn that produced nothing at all is the failure mode that hides:
      // bad arguments, a missing session, a dead binary. Silence used to look
      // exactly like thinking, so say it out loud and end the turn.
      if (!spoke) {
        this.emit('error',
          `${cli} produced no output (exit ${code}). ${err.trim() || 'No error text.'}`);
      }
      // A killed turn never reaches its completion event, so the orchestrator
      // would never see it end — no spend, no context, no recycle, no redelivery.
      if (code && spoke && !dog.timedOut()) this.emit('error', `${cli} exited (${code}). ${err.trim() || 'Turn failed.'}`);
      if (completion && !dog.timedOut()) this.emit('turn_end', completion);
      else {
        if (spoke && !dog.timedOut() && !code) this.emit('error', `${cli} produced no completed turn. Check the CLI session and output format.`);
        this.emit('turn_end', { usage: null, costUsd: 0, ctx: this.ctxTokens() });
      }
      if (this.queue.length) this.#runTurn();
    });
  }

  /**
   * agy and opencode take the prompt only as an argument, so a long brief
   * cannot go on the command line: Windows caps it at 32,767 chars and spawn
   * throws ENAMETOOLONG. Measured — a 53,214-char sovereign brief died in 0.2s.
   *
   * But both ARE agentic CLIs with file tools, so hand them the brief as a
   * file and ask them to read it. The file goes to the OS temp directory, NEVER the
   * member's cwd: a peasant's cwd is a git worktree and `commitAll` does
   * `git add -A`, so a brief written there would be committed into the
   * sovereign's repository and merged.
   *
   * Returns the prompt to actually pass on the command line.
   */
  #stagedPrompt(cli, prompt) {
    if (prompt.length <= BRIEF_ARGV_BUDGET) return prompt;
    try {
      const file = join(tmpdir(), `kingdom-brief-${this.name}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 });
      this.briefFile = file;   // removed when the turn exits
      return `Your full instructions are in a file — they are too long for this command `
        + `line. Read it and follow it exactly as if it had been typed here:\n\n${file}\n\n`
        + `Read that file FIRST, before doing anything else. Do not summarise it back to me.`;
    } catch (e) {
      // Falling back to the raw prompt means spawnGuarded reports ENAMETOOLONG
      // and the order is redelivered — worse than the file, better than silence.
      this.emit('error', `Could not stage a long ${cli} brief (${e.message}); sending it inline.`);
      return prompt;
    }
  }

}
