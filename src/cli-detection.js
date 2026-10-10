import { spawn } from 'node:child_process';
import { adapterFor } from './cli-adapters.js';
import { parseModels } from './cli-parse.js';

// Bounded, non-billing checks only. Raw output stays private: status output can
// contain account identifiers or API key fragments, and is never a log message.
export function statusCommand(resolved, args, { env = process.env, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let output = '', settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, output }); };
    let child, timer;
    try {
      child = spawn(resolved.command, [...resolved.prefixArgs, ...args],
        { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { finish(false); return; }
    timer = setTimeout(() => { child.kill(); finish(false); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      output = (output + chunk).slice(-64000);
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

export async function detectCli(cli, { resolveCli, env = process.env, run = statusCommand } = {}) {
  let resolved;
  try { resolved = resolveCli(cli); } catch { return { installed: false, available: false, authenticated: null, reason: 'binary missing' }; }
  let adapter;
  try { adapter = adapterFor(cli); } catch { return { installed: true, authenticated: null, reason: 'unsupported CLI', resolved }; }
  const version = await run(resolved, ['--version'], { env });
  if (!version.ok) return { installed: true, available: false, authenticated: null, reason: 'version check failed', resolved };
  if (!adapter.authArgs) return { installed: true, authenticated: null, reason: 'no non-billing authentication status command; interactive only', resolved };
  if (cli === 'claude' && ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((k) => env[k])) {
    return { installed: true, authenticated: null, reason: 'authentication supplied via environment; validity unverified', resolved };
  }
  if (['cursor', 'cursor-agent', 'agent'].includes(cli) && env.CURSOR_API_KEY) {
    return { installed: true, authenticated: null, reason: 'authentication supplied via environment; validity unverified', resolved };
  }
  const result = await run(resolved, adapter.authArgs, { env });
  result.output = result.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  let authenticated = null;
  if (cli === 'codex') {
    if (/not logged in/i.test(result.output)) authenticated = false;
    else if (result.ok && /logged in/i.test(result.output)) authenticated = true;
  } else if (cli === 'agy') {
    if (result.ok && parseModels(result.output).length) authenticated = true;
    else if (/not authenticated|sign.in|unauthorized/i.test(result.output)) authenticated = false;
  } else if (cli === 'opencode') {
    const match = result.output.match(/(\d+) credentials?/i);
    if (result.ok && match) authenticated = Number(match[1]) > 0;
  } else {
    try {
      const status = JSON.parse(result.output);
      const value = status.loggedIn ?? status.authenticated ?? status.isAuthenticated;
      if (typeof value === 'boolean' && (result.ok || value === false)) authenticated = value;
    } catch { /* Unknown status schema must not become a false auth claim. */ }
  }
  return { installed: true, authenticated, resolved,
    reason: authenticated === true ? 'authentication status confirmed (quota unverified)'
      : authenticated === false ? 'not authenticated; sign in with the CLI'
        : 'authentication status unavailable; run the CLI status command in a terminal' };
}
