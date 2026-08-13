// The advisor: a small, cheap, single-shot model call that answers a question
// and exits. It is NOT a court member — no bus, no MCP, no session, no memory,
// no worktree. Two features ride on it:
//
//   * the prompt engineer, which rewrites what the sovereign typed before the
//     king ever sees it;
//   * the model selector, which picks each member's model and effort.
//
// Both are advisory: if the call fails, times out, or answers with nonsense,
// the caller keeps what it already had. A broken advisor must never be able to
// stop the court, so every failure here returns null rather than throwing.
import { spawn } from 'node:child_process';
import { resolveCli, AGY_EFFORTS } from './agent.js';

const TIMEOUT_MS = 90_000;

/**
 * One question, one answer, no tools. Returns the model's text, or null.
 *
 * read-only sandbox on purpose: the advisor reasons about text it was handed,
 * so it has no business writing, and read-only costs nothing to enforce. (The
 * usual caveat about confining sandboxes killing MCP does not apply — the
 * advisor is given no MCP server to lose.)
 */
export function ask(spec, prompt, { cwd = process.cwd(), timeoutMs = TIMEOUT_MS, onFail } = {}) {
  const cli = spec?.cli ?? 'codex';
  // agy is a natural fit for these two jobs: they are one-shot text calls that
  // need no tools at all, which is exactly the part of agy that works headless.
  // It also bills against a different quota from codex, so moving the
  // per-turn summariser here takes that load off the court's own budget.
  const args = cli === 'agy'
    ? ['--print', '--output-format', 'stream-json',
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort && AGY_EFFORTS.has(spec.effort) ? ['--effort', spec.effort] : []),
      // Measured: agy reaches for a shell command even on a pure text task, and
      // headless mode auto-denies it, so the run produces NOTHING. The only
      // switch that fixes it auto-approves every tool — far too wide a grant to
      // turn on quietly for a job that should touch nothing. Opt in per
      // kingdom with `"skipPermissions": true`, and know what it means.
      ...(spec.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      '--print-timeout', '5m',
      prompt]
    : cli === 'codex'
    ? ['exec', '--json', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
      // The advisor only reasons about text it was handed and cannot write
      // anything, so codex's "is this a trusted git repo" guard protects
      // nothing here — but without this flag it refuses to start at all, and
      // the advisor would look permanently broken outside a git checkout.
      '--skip-git-repo-check',
      '-C', cwd,
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['-c', `model_reasoning_effort="${spec.effort}"`] : []),
      prompt]
    : ['--print', '--output-format', 'stream-json', '--verbose',
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--effort', spec.effort] : []),
      prompt];

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };

    let proc;
    try {
      const { command, prefixArgs } = resolveCli(cli);
      proc = spawn(command, [...prefixArgs, ...args], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      onFail?.(e.message);
      return finish(null);
    }

    // Kill the whole turn if it overruns: an advisor that hangs would hold up
    // every message the sovereign sends.
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      onFail?.(`no answer within ${Math.round(timeoutMs / 1000)}s`);
      finish(null);
    }, timeoutMs);

    let out = '';
    let buf = '';
    let err = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        // codex: item.completed / agent_message. claude: assistant / content[].text
        if (o.type === 'item.completed' && o.item?.type === 'agent_message') out += o.item.text ?? '';
        // agy: fragments on agent_response steps, plus a whole answer on result.
        else if (o.event === 'result') out = o.result?.response ?? out;
        else if (o.event === 'step_update' && o.step_update?.step_type === 'agent_response') {
          out += o.step_update.text_delta ?? '';
        }
        else if (o.type === 'assistant') {
          for (const c of o.message?.content ?? []) if (c.type === 'text') out += c.text ?? '';
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    proc.on('error', (e) => { err = e.message; finish(null); });
    proc.on('exit', () => {
      const text = out.trim();
      // Degrading to "no advice" is correct, but degrading SILENTLY is how a
      // permanently misconfigured advisor stays invisible forever — it just
      // looks like the feature does nothing. Say why, once, per failure.
      if (!text) onFail?.(err.trim() || 'the advisor produced no output');
      finish(text || null);
    });
  });
}

/**
 * Pull one JSON object out of an answer. Models wrap JSON in prose and fences
 * however they feel like it, and a strict JSON.parse of the whole reply fails
 * on the wrapping rather than on the content.
 */
export function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  // Walk to the matching brace so trailing commentary does not break the parse.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const ENGINEER = `You rewrite instructions for an AI software-engineering team.
Rewrite the sovereign's message below into a brief that is unambiguous and
directly actionable. Rules:
- Preserve every requirement, constraint and named file. Add nothing they did not ask for.
- Do NOT answer the request, plan it, or propose a solution. You only rewrite.
- Keep it SHORTER than a plan: one paragraph, or a short list if they asked for several things.
- Resolve vague pronouns and "this/that" where the message makes the referent clear; leave genuinely
  ambiguous points as an explicit open question at the end instead of guessing.
- If the message is already clear, return it close to unchanged.
- Never invent file paths, versions, or acceptance criteria.
Reply with ONLY the rewritten brief. No preamble, no commentary, no code fences.`;

/** Rewrites the sovereign's message. Returns the original on any failure. */
export async function engineerPrompt(spec, text, opts = {}) {
  const out = await ask(spec, `${ENGINEER}\n\n--- SOVEREIGN'S MESSAGE ---\n${text}`, opts);
  if (!out) return null;
  // A "rewrite" many times the original is the model answering the request
  // instead of restating it. Rather than feed the court a hallucinated plan,
  // fall back to what the sovereign actually typed.
  if (out.length > Math.max(1200, text.length * 6)) return null;
  return out;
}

/**
 * The sovereign's own selection policy, from the vault (References/Model
 * Guidance, Effort Levels, GPT 5.6 Luna/Terra/Sol). Overridable per kingdom via
 * `advisor.guidance` — this is a preference, not a fact, and it will go stale
 * when prices move.
 *
 * Note it argues the OPPOSITE of the obvious "turn effort down to save money":
 * on Luna effort is nearly free, so the lever that matters is which MODEL runs,
 * not how hard it thinks.
 */
export const DEFAULT_GUIDANCE = `Choosing the MODEL matters far more than choosing the effort.

- gpt-5.6-luna costs $0.2/$1.2 per million tokens. Effort is close to free on it,
  and it performs best at "max", so default every member on Luna to "max".
  Do NOT lower a member's effort to save money — on Luna there is almost nothing
  to save, and you only make it worse at its job.
- gpt-5.6-terra costs 10x Luna. Justify it or do not pick it. Its one real
  advantage is memory across a long task, so it is for work that must stay
  coherent over many turns. If you do pick it, use effort "high" — at low or
  medium use Luna instead, and Terra is not worth xhigh or above.
- The expensive mistake is putting a member on a pricier model for a task that
  did not need it. It is not spending effort on the cheap one.

A member the task barely touches can simply be left alone — omit it.`;

/**
 * Picks a model and effort per member from `allowed`.
 *
 * `allowed` is the sovereign's restriction, checked again on the way out —
 * a model is only ever applied if it was on the list, so a creative answer
 * cannot spend money on a tier they excluded.
 */
export async function pickModels(spec, { goal, members, allowed, efforts, guidance }, opts = {}) {
  if (!allowed.length || !members.length) return {};
  guidance ??= DEFAULT_GUIDANCE;

  const menu = allowed.map((a) => {
    const model = a.split('/').slice(1).join('/');
    return `  ${a}   efforts: ${(efforts[model] ?? ['low', 'medium', 'high']).join(', ')}`;
  }).join('\n');

  const roster = members
    .map((m) => `  ${m.name} — ${m.title ?? m.name}: ${m.description ?? ''}`.trim())
    .join('\n');

  const q = `Assign a model and reasoning effort to each member of a software team for ONE task.

TASK:
${goal}

MEMBERS:
${roster}

ALLOWED (you may use nothing else):
${menu}

${guidance}

Reply with ONLY JSON, no prose:
{"member-name": {"model": "codex/gpt-5.6-luna", "effort": "medium"}, ...}
Omit any member you would leave alone.`;

  const picks = parseJson(await ask(spec, q, opts));
  if (!picks || typeof picks !== 'object') return {};

  const names = new Set(members.map((m) => m.name));
  const ok = new Set(allowed);
  const out = {};
  for (const [name, v] of Object.entries(picks)) {
    if (!names.has(name) || !v || typeof v !== 'object') continue;
    const ref = String(v.model ?? '');
    if (!ok.has(ref)) continue;                       // the restriction, enforced
    const [cli, ...rest] = ref.split('/');
    const model = rest.join('/');
    const effort = String(v.effort ?? '');
    if (effort && !(efforts[model] ?? []).includes(effort)) continue;  // model-specific
    out[name] = { cli, model, effort: effort || undefined };
  }
  return out;
}
