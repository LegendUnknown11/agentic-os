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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveCli, claudeEnv } from './agent.js';
import { adapters, FREEBUFF_LIMITATION } from './cli-adapters.js';
import { detectCli } from './cli-detection.js';

const exec = promisify(execFile);

/**
 * Every probe this file knows how to run, in one place, with no process-level
 * side effect — no console.log, no process.exit. Returns
 * `{ checks: [{level: 'ok'|'warn'|'fail', message}], failures, ready }`.
 * `repo`, if given, selects the workspace config; credentials stay private.
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
  const cleanEnv = claudeEnv();
  const contaminating = Object.keys(process.env).filter((k) => !(k in cleanEnv));
  if (contaminating.length) {
    warn(
      `running inside a Claude Code/Desktop session (${contaminating.length} CLAUDE_* vars set). `
      + `Host session markers are removed for spawned claude CLIs. `
      + `Re-run this from a plain terminal before believing any claude result below.`
    );
  }

  // No model calls, token-file reads or token-store writes during preflight.
  async function probe(cli, required) {
    const result = await detectCli(cli, { resolveCli, env: cleanEnv });
    const label = `${cli}: ${result.reason}`;
    if (required && cli === 'freebuff') return fail(`${cli}: ${FREEBUFF_LIMITATION}`);
    if (!result.installed || result.available === false || result.authenticated === false) (required ? fail : warn)(label);
    else if (result.authenticated === true) ok(label);
    else warn(label);
  }

  const clis = new Set();
  try {
    const cfg = JSON.parse(readFileSync(repo ? join(resolve(repo), 'kingdom.config.json') : new URL('../kingdom.config.json', import.meta.url), 'utf8'));
    for (const m of [cfg.orchestrator, cfg.briefer, ...cfg.peasants]) clis.add(m.cli ?? 'claude');
    // The advisor and the summariser are not court members, but they are real
    // model calls on real CLIs and they fail the same way. Leaving them out meant
    // a summariser on a CLI that was broken or logged out was never checked.
    for (const s of [cfg.advisor, cfg.summarizer]) if (s?.cli) clis.add(s.cli);
  } catch {
    clis.add('claude');
    clis.add('codex');
  }
  for (const c of new Set([...clis, ...Object.keys(adapters)])) await probe(c, clis.has(c));

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
