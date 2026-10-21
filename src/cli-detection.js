// Bounded, non-billing CLI checks: `--version`, then the CLI's own auth-status
// command. Never a model prompt, never a token file. Raw output stays private:
// status output can contain account identifiers or key fragments, so it is
// parsed here and never returned or logged.
import { spawn } from 'node:child_process';
import { adapterFor, isCursor } from './cli-adapters.js';
import { parseModels } from './cli-parse.js';

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Run one status command. stdin is detached: `agy models` was measured
 * hanging past three minutes with a piped stdin, waiting on a terminal it
 * does not have. Never `shell: true` (see resolveCli).
 */
export function statusCommand(resolved, args, { env = process.env, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    let timer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output });
    };
    try {
      child = spawn(resolved.command, [...resolved.prefixArgs, ...args],
        { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { finish(false); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(false); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      output = (output + chunk).slice(-64_000);
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

const ENV_AUTH = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  cursor: ['CURSOR_API_KEY'],
};

/** The first {...} span in mixed output (warnings often precede the JSON). */
function jsonIn(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * Parse one CLI's auth-status output into true / false / null. Unknown or
 * unparseable output is null — "could not tell" — never a guess either way.
 */
export function parseAuth(cli, { ok, output }) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (cli === 'codex') {
    if (/not logged in/i.test(text)) return false;
    if (ok && /logged in/i.test(text)) return true;
    return null;
  }
  if (cli === 'agy') {
    if (ok && parseModels(text).length) return true;
    if (/not authenticated|sign.?in|unauthori[sz]ed/i.test(text)) return false;
    return null;
  }
  if (cli === 'opencode') {
    // Counts stored credentials only. Zero is NOT "logged out": opencode
    // also authenticates providers from environment variables, which this
    // count does not see, so zero stays unverified.
    const match = text.match(/(\d+)\s+credentials?/i);
    if (ok && match && Number(match[1]) > 0) return true;
    return null;
  }
  const status = jsonIn(text);
  const value = status?.loggedIn ?? status?.authenticated ?? status?.isAuthenticated;
  // A logged-out CLI often exits non-zero, so false is believed either way;
  // true only from a successful run.
  if (value === false) return false;
  if (value === true && ok) return true;
  return null;
}

/**
 * {installed, available, authenticated: true|false|null, reason, resolved}.
 * `run` and `resolveCli` are injectable so tests never spawn a real CLI.
 */
export async function detectCli(cli, { resolveCli, env = process.env, run = statusCommand } = {}) {
  let resolved;
  try { resolved = resolveCli(cli); } catch {
    return { installed: false, available: false, authenticated: null, reason: 'not installed' };
  }
  let adapter;
  try { adapter = adapterFor(cli); } catch {
    return { installed: true, available: false, authenticated: null, reason: 'unsupported CLI', resolved };
  }
  const version = await run(resolved, ['--version'], { env });
  if (!version.ok) {
    return { installed: true, available: false, authenticated: null, reason: 'found, but `--version` failed', resolved };
  }
  const family = isCursor(cli) ? 'cursor' : cli;
  const supplied = (ENV_AUTH[family] ?? []).filter((k) => env[k]);
  if (supplied.length) {
    // A token supplied via the environment overrides the stored login, and
    // `claude auth status` still reports loggedIn:false then — so check the
    // env FIRST. Presence is not validity. Names only; never the value.
    return { installed: true, available: true, authenticated: null, resolved,
      reason: `auth supplied via ${supplied.join(' + ')} (value not shown; validity unverified)` };
  }
  const result = await run(resolved, adapter.authArgs, { env, timeout: adapter.authTimeoutMs ?? DEFAULT_TIMEOUT_MS });
  const authenticated = parseAuth(family, result);
  return { installed: true, available: true, authenticated, resolved,
    reason: authenticated === true ? 'authentication status confirmed (quota unverified)'
      : authenticated === false ? 'not authenticated'
        : 'authentication status unavailable; run its status command in a terminal' };
}
