#!/usr/bin/env node
// Preflight: can this machine actually run a team?  node src/doctor.js
//
// Run this from a NORMAL terminal. Running it inside a Claude Code / Claude
// Desktop session is misleading: those set CLAUDE_CODE_* vars that put spawned
// CLIs into managed-child-session mode, where they cannot refresh their own
// OAuth token and always fail to authenticate.
//
// runDoctor() is the same probes the CLI below prints, exported so
// src/daemon.js can expose them at GET /api/doctor — a freshly installed app
// has no terminal a user is expected to open, so the first screen it shows is
// this report, not an empty dashboard and an "OAuth session expired" error.
//
// No model calls. GET /api/doctor runs on every app boot (ui/main.js
// maybeOpenDoctor), so the old live "answer OK" model probe spent
// quota on each configured CLI every time the app opened. Detection is now
// bounded, non-billing status commands (src/cli-detection.js). The cost: an
// authenticated CLI that is OUT OF QUOTA is no longer caught here; it surfaces
// on the member's first turn as a rate/usage-limit error instead.
import './legacy-boot.js'; // first: legacy env fallback and home migration, before any module reads env
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveCli, claudeEnv } from './agent.js';
import { adapters } from './cli-adapters.js';
import { detectCli } from './cli-detection.js';

const exec = promisify(execFile);

/**
 * Every probe this file knows how to run, in one place, with no process-level
 * side effect — no console.log, no process.exit, no file written. Returns
 * `{ checks: [{level: 'ok'|'warn'|'fail', message}], failures, ready }`.
 * `repo`, if given, reports that repo's token pool size and reads that repo's
 * own config (matches the CLI's own `node src/doctor.js <repo>` form).
 *
 * `detect` is injectable for tests; it defaults to the real detection.
 */
export async function runDoctor({ repo, detect = detectCli } = {}) {
  const checks = [];
  const ok = (message) => checks.push({ level: 'ok', message });
  const warn = (message) => checks.push({ level: 'warn', message });
  const fail = (message) => checks.push({ level: 'fail', message });

  // --- node ------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 24) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} — need 24+ for node:sqlite`);

  try {
    await import('node:sqlite');
    ok('node:sqlite available');
  } catch {
    fail('node:sqlite missing — the bus cannot start');
  }

  // --- git -------------------------------------------------------------
  try {
    const { stdout } = await exec('git', ['--version'], { windowsHide: true });
    ok(stdout.trim());
  } catch {
    fail('git not found on PATH');
  }

  // --- host-session contamination --------------------------------------
  const contaminating = Object.keys(process.env).filter((k) => /^CLAUDE(CODE|_CODE|_PID|_AGENT)/.test(k));
  if (contaminating.length) {
    warn(
      `running inside a Claude Code/Desktop session (${contaminating.length} CLAUDE_* vars set). `
      + `Spawned claude CLIs inherit managed-child-session auth and WILL fail here. `
      + `Re-run this from a plain terminal before believing any claude result below.`
    );
  }

  // --- credentials -----------------------------------------------------
  // Reads only the expiry timestamps; no token value is ever reported.
  try {
    const c = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth;
    if (c) {
      const exp = Number(c.expiresAt ?? 0);
      const rexp = Number(c.refreshTokenExpiresAt ?? 0);
      if (exp === 0) {
        warn('claude access token is zeroed (expiresAt=0) — the host app owns auth. '
          + 'Run `claude` in a normal terminal and `/login` to mint a standalone token.');
      } else if (exp < Date.now()) {
        warn(`claude access token expired ${new Date(exp).toISOString()} (refresh may still work)`);
      } else {
        ok(`claude token valid until ${new Date(exp).toISOString()}`);
      }
      if (rexp && rexp < Date.now()) warn('claude refresh token has ALSO expired — /login required');
    }
  } catch {
    warn('no ~/.claude/.credentials.json (fine if you only use codex)');
  }

  // --- token pool -------------------------------------------------------
  // Counted, never created: a GET must not write files (it used to create an
  // empty tokens.json as a side effect of every boot).
  let stateDir = null;
  if (repo) {
    ({ stateDir } = await import('./worktree.js'));
    const store = join(stateDir(resolve(repo)), 'tokens.json');
    const envPool = (process.env.AGENTICOS_CLAUDE_TOKENS ?? '').split(',').filter((s) => s.trim());
    if (envPool.length) {
      ok(`token pool: ${envPool.length} from AGENTICOS_CLAUDE_TOKENS`);
    } else if (existsSync(store)) {
      try {
        const n = (JSON.parse(readFileSync(store, 'utf8')).claude ?? []).filter(Boolean).length;
        if (n) ok(`token pool: ${n} in ${store}`); else warn(`token store empty: ${store}`);
      } catch {
        warn(`token store unreadable: ${store}`);
      }
    }
  }

  // --- the CLIs ---------------------------------------------------------
  const cleanEnv = claudeEnv();
  async function probe(cli, required) {
    const r = await detect(cli, { resolveCli, env: cli === 'claude' ? cleanEnv : process.env });
    // An optional CLI that is not installed is not a finding.
    if (!required && !r.installed) return;
    const tag = required ? '' : ' (optional, not configured)';
    if (!r.installed) return fail(`${cli}: not installed. Install it or set its AGENTICOS_*_BIN override.`);
    const where = r.resolved ? ` — ${r.resolved.command}${r.resolved.prefixArgs?.[0] ? ' ' + r.resolved.prefixArgs[0] : ''}` : '';
    if (r.available === false) return (required ? fail : warn)(`${cli}: ${r.reason}${where}${tag}`);
    if (r.authenticated === false) {
      const guidance = cli === 'claude'
        ? ' Being signed into the Claude desktop app does NOT log in the CLI. Fix it in a normal '
          + 'terminal with any of: claude auth login (browser OAuth), claude setup-token '
          + '(long-lived token), or set CLAUDE_CODE_OAUTH_TOKEN=... (token via environment).'
        : cli === 'codex' ? ' Run: codex login'
          : cli === 'agy' ? ' Run `agy` in a normal terminal and complete the Google sign-in.'
            : '';
      return (required ? fail : warn)(`${cli}: ${r.reason}.${guidance}${tag}`);
    }
    if (r.authenticated === true) ok(`${cli}: ${r.reason}${where}${tag}`);
    else warn(`${cli}: ${r.reason}${where}${tag}`);

    // The one thing that silently makes an Antigravity member useless:
    // headless agy reads ONLY the global MCP config, so without the team
    // declared there it has no send_message and no declare_done.
    if (cli === 'agy') {
      try {
        const g = JSON.parse(readFileSync(join(homedir(), '.gemini', 'config', 'mcp_config.json'), 'utf8'));
        if (g?.mcpServers?.agenticos) ok('agy: agenticos MCP server declared globally');
        else warn('agy: the agenticos MCP server is NOT in ~/.gemini/config/mcp_config.json. '
          + 'Antigravity members will have no AgenticOS tools. Starting the team installs it.');
      } catch {
        warn('agy: no ~/.gemini/config/mcp_config.json yet — starting the team writes it.');
      }
    }
  }

  // The config the team actually runs: the repo's own copy if it has one
  // (src/agenticos.js defaultConfigPath), else the shipped template. Read only.
  const local = repo && stateDir ? join(stateDir(resolve(repo)), 'agenticos.config.json') : null;
  const configured = new Set();
  try {
    const source = local && existsSync(local) ? local : new URL('../agenticos.config.json', import.meta.url);
    const cfg = JSON.parse(readFileSync(source, 'utf8'));
    for (const m of [cfg.orchestrator, cfg.briefer, ...cfg.agents]) configured.add(canonical(m.cli ?? 'claude'));
    // The advisor and the summariser are not team members, but they are real
    // model calls on real CLIs and they fail the same way. Leaving them out meant
    // a summariser on a CLI that was broken or logged out was never checked.
    for (const s of [cfg.advisor, cfg.summarizer]) if (s?.cli) configured.add(canonical(s.cli));
  } catch {
    configured.add('claude');
    configured.add('codex');
  }
  // Configured CLIs block readiness; every other known CLI is reported only
  // when it is actually installed.
  for (const c of new Set([...configured, ...Object.keys(adapters)])) await probe(c, configured.has(c));

  const failures = checks.filter((c) => c.level === 'fail').length;
  return { checks, failures, ready: failures === 0 };
}

const canonical = (cli) => (['cursor-agent', 'agent'].includes(cli) ? 'cursor' : cli);

// --- CLI entry point, unchanged behaviour: colored lines, exit code --------
if (process.argv[1]?.endsWith('doctor.js')) {
  const paint = { ok: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✘\x1b[0m' };
  const { checks, failures } = await runDoctor({ repo: process.argv[2] });
  for (const { level, message } of checks) console.log(`${paint[level]} ${message}`);
  console.log(failures
    ? `\n\x1b[31m${failures} blocking problem(s).\x1b[0m The team will not work until these are fixed.`
    : '\n\x1b[32mReady. Run: npm start\x1b[0m');
  process.exit(failures ? 1 : 0);
}
