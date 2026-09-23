#!/usr/bin/env node
// Preflight: can this machine actually run a kingdom?  node src/doctor.js
//
// Run this from a NORMAL terminal. Running it inside a Claude Code / Claude
// Desktop session is misleading: those set CLAUDE_CODE_* vars that put spawned
// CLIs into managed-child-session mode, where they cannot refresh their own
// OAuth token and always fail to authenticate.
//
// runDoctor() is the same probes the CLI below prints, exported so
// src/daemon.js can expose them at GET /api/doctor — a freshly installed app
// has no terminal a user is expected to open, so the first screen it shows is
// this report, not an empty throne room and an "OAuth session expired" error.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveCli } from './agent.js';
import { parseModels } from './cli-parse.js';

const exec = promisify(execFile);

/**
 * These CLIs report "logged out" via a non-zero exit and sometimes write to
 * stderr, so the useful output must be read whether the call succeeded or not.
 */
async function tryExec(cmd, args) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { windowsHide: true });
    return { ok: true, out: (stdout || stderr || '').trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout ?? '') + (e.stderr ?? '')).trim() || e.message };
  }
}

/**
 * Every probe this file knows how to run, in one place, with no process-level
 * side effect — no console.log, no process.exit. Returns
 * `{ checks: [{level: 'ok'|'warn'|'fail', message}], failures, ready }`.
 * `repo`, if given, also reports that repo's token store (matches the CLI's
 * own `node src/doctor.js <repo>` form).
 */
export async function runDoctor({ repo } = {}) {
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
  if (repo) {
    const { kingdomDir } = await import('./worktree.js');
    const store = join(kingdomDir(resolve(repo)), 'tokens.json');
    const envPool = (process.env.KINGDOM_CLAUDE_TOKENS ?? '').split(',').filter((s) => s.trim());
    if (envPool.length) {
      ok(`token pool: ${envPool.length} from KINGDOM_CLAUDE_TOKENS`);
    } else {
      try {
        const n = (JSON.parse(readFileSync(store, 'utf8')).claude ?? []).filter(Boolean).length;
        if (n) ok(`token pool: ${n} in ${store}`); else warn(`token store empty: ${store}`);
      } catch {
        mkdirSync(dirname(store), { recursive: true });
        writeFileSync(store, JSON.stringify({ claude: [] }, null, 2));
        warn(`created empty token store — paste tokens into: ${store}`);
      }
    }
  }

  // --- the CLIs actually answering -------------------------------------
  async function probe(cli) {
    let resolved;
    try {
      resolved = resolveCli(cli);
    } catch (e) {
      return fail(`${cli}: ${e.message}`);
    }
    ok(`${cli} binary: ${resolved.command}${resolved.prefixArgs[0] ? ' ' + resolved.prefixArgs[0] : ''}`);

    // Ask the CLI directly before spending a token on an API probe. This is the
    // authoritative answer: a Claude *Desktop* login does not log in the CLI, and
    // the difference is invisible until something tries to spawn one.
    // A token supplied via the environment overrides the stored login, and
    // `claude auth status` still reports loggedIn:false in that case — so check
    // the env FIRST or you will chase a phantom auth failure.
    const ENV_AUTH = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
    const envAuth = ENV_AUTH.filter((k) => process.env[k]);

    if (cli === 'claude' && envAuth.length) {
      // Never print the value.
      ok(`claude auth supplied via ${envAuth.join(' + ')} (value not shown)`);
    } else if (cli === 'claude') {
      const { out } = await tryExec(resolved.command, [...resolved.prefixArgs, 'auth', 'status']);
      try {
        const st = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
        if (!st.loggedIn) {
          return fail(
            `claude CLI is NOT logged in (authMethod: ${st.authMethod}). `
            + `Being signed into the Claude desktop app does NOT log in the CLI. `
            + `Fix it in a normal terminal with any of: `
            + `claude auth login (browser OAuth), `
            + `claude setup-token (long-lived token), `
            + `or set CLAUDE_CODE_OAUTH_TOKEN=... (token via environment).`
          );
        }
        ok(`claude logged in via ${st.authMethod}`);
      } catch {
        warn(`could not parse \`claude auth status\`: ${out.slice(0, 120)}`);
      }
    }

    if (cli === 'codex') {
      const r = await tryExec(resolved.command, [...resolved.prefixArgs, 'login', 'status']);
      if (!r.ok || /not logged in/i.test(r.out)) return fail(`codex is not logged in. Run: codex login`);
      ok(`codex: ${r.out || 'logged in'}`);
    }

    if (cli === 'agy') {
      // `agy models` is the cheapest thing that requires auth: it round-trips to
      // the account, costs no tokens, and an unauthenticated CLI returns nothing.
      // `agy models` does NOT exit when its stdio is piped — it sits waiting on a
      // terminal it does not have. Measured: the same command that returns in a
      // second interactively hangs past three minutes under execFile. So: detach
      // stdin, and cap it. A probe that can hang is worse than no probe.
      const out = await new Promise((res) => {
        const p = spawn(resolved.command, [...resolved.prefixArgs, 'models'],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let buf = '';
        p.stdout.on('data', (d) => (buf += d));
        p.stderr.on('data', (d) => (buf += d));
        const t = setTimeout(() => { p.kill(); res(buf); }, 25_000);
        p.on('exit', () => { clearTimeout(t); res(buf); });
        p.on('error', (e) => { clearTimeout(t); res(`spawn failed: ${e.message}`); });
      });
      const models = parseModels(out);
      if (!models.length) {
        return fail('agy returned no models — it is probably not signed in. '
          + 'Run `agy` in a normal terminal and complete the Google sign-in.');
      }
      ok(`agy: ${models.length} models available`);

      // The one thing that silently makes an Antigravity member useless: headless
      // agy reads ONLY the global MCP config, so without the kingdom declared
      // there it has no send_message and no declare_done.
      try {
        const g = JSON.parse(readFileSync(join(homedir(), '.gemini', 'config', 'mcp_config.json'), 'utf8'));
        if (g?.mcpServers?.kingdom) ok('agy: kingdom MCP server declared globally');
        else warn('agy: the kingdom MCP server is NOT in ~/.gemini/config/mcp_config.json. '
          + 'Antigravity members will have no kingdom tools. Starting the court installs it.');
      } catch {
        warn('agy: no ~/.gemini/config/mcp_config.json yet — starting the court writes it.');
      }
    }

    if (cli === 'opencode') {
      const r = await tryExec(resolved.command, [...resolved.prefixArgs, '--version']);
      if (r.ok) ok(`opencode: ${r.out || 'installed'}`);
    }

    // Per CLI, because they share no argument surface at all. This used to be a
    // claude/else ternary, so `agy` was handed codex's `exec --json` and reported
    // as "gave an unrecognised response" — the CLI was fine, the probe was wrong.
    const PROBES = {
      claude: ['-p', 'reply with the single word OK', '--model', 'haiku'],
      codex: ['exec', '--json', '--skip-git-repo-check', 'reply with the single word OK'],
      // The prompt is --print's VALUE since agy 1.1.11, not a trailing
      // positional. Passed the old way, agy reads the next flag as the prompt
      // and cheerfully answers a question about it — see #runAgyTurn.
      agy: ['--print', 'reply with the single word OK',
        '--output-format', 'text', '--model', 'gemini-3.6-flash-low'],
      opencode: ['run', 'reply with the single word OK', '--format', 'json', '--auto'],
    };
    const args = PROBES[cli];
    if (!args) {
      // Better to say the harness does not know this CLI than to guess at its
      // flags and blame the CLI for the mismatch.
      warn(`${cli}: no probe defined for this CLI — cannot verify it works. `
        + `Add one to PROBES in src/doctor.js.`);
      return;
    }

    const out = await new Promise((res) => {
      const p = spawn(resolved.command, [...resolved.prefixArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let buf = '';
      p.stdout.on('data', (d) => (buf += d));
      p.stderr.on('data', (d) => (buf += d));
      const t = setTimeout(() => { p.kill(); res(buf + '\n[timed out after 120s]'); }, 120_000);
      p.on('exit', () => { clearTimeout(t); res(buf); });
      p.on('error', (e) => { clearTimeout(t); res(`spawn failed: ${e.message}`); });
    });

    if (/authenticate|OAuth|not logged in|unauthorized/i.test(out)) {
      fail(`${cli} is NOT authenticated for spawned processes: ${out.split('\n').filter(Boolean).pop()}`);
    } else if (/usage limit|rate limit|quota/i.test(out)) {
      warn(`${cli} authenticated but OUT OF QUOTA — peasants will stall`);
    } else if (/OK/i.test(out)) {
      ok(`${cli} answered — authenticated and in quota`);
    } else {
      fail(`${cli} gave an unrecognised response: ${out.slice(-300)}`);
    }
  }

  const clis = new Set();
  try {
    const cfg = JSON.parse(readFileSync(new URL('../kingdom.config.json', import.meta.url), 'utf8'));
    for (const m of [cfg.orchestrator, cfg.briefer, ...cfg.peasants]) clis.add(m.cli ?? 'claude');
    // The advisor and the summariser are not court members, but they are real
    // model calls on real CLIs and they fail the same way. Leaving them out meant
    // a summariser on a CLI that was broken or logged out was never checked.
    for (const s of [cfg.advisor, cfg.summarizer]) if (s?.cli) clis.add(s.cli);
  } catch {
    clis.add('claude');
    clis.add('codex');
  }
  for (const c of clis) await probe(c);

  const failures = checks.filter((c) => c.level === 'fail').length;
  return { checks, failures, ready: failures === 0 };
}

// --- CLI entry point, unchanged behaviour: colored lines, exit code --------
if (process.argv[1]?.endsWith('doctor.js')) {
  const paint = { ok: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✘\x1b[0m' };
  const { checks, failures } = await runDoctor({ repo: process.argv[2] });
  for (const { level, message } of checks) console.log(`${paint[level]} ${message}`);
  console.log(failures
    ? `\n\x1b[31m${failures} blocking problem(s).\x1b[0m The kingdom will not work until these are fixed.`
    : '\n\x1b[32mReady. Run: npm start\x1b[0m');
  process.exit(failures ? 1 : 0);
}
