// The advisor: a small, cheap, single-shot model call that answers a question
// and exits. It is NOT a court member — no bus, no MCP, no session, no memory,
// no worktree. Two features ride on it:
//
//   * the prompt engineer, which rewrites what the sovereign typed before the
//     orchestrator ever sees it;
//   * the model selector, which picks each member's model and effort.
//
// Both are advisory: if the call fails, times out, or answers with nonsense,
// the caller keeps what it already had. A broken advisor must never be able to
// stop the court, so every failure here returns null rather than throwing.
import { spawn } from 'node:child_process';
import { resolveCli, AGY_EFFORTS } from './agent.js';
import { adapterFor, cursorUsage, isCursor } from './cli-adapters.js';
import { MODE_NAMES } from './modes.js';
import { deltaOf, hasUsage, totalsOf } from './usage.js';
import { costClassOf, costOf, PRICES } from './price.js';

const TIMEOUT_MS = 90_000;

const usageFrom = (o) => o?.usage ?? o?.message?.usage ?? o?.result?.usage
  ?? o?.step_update?.usage ?? null;

const costFrom = (o) => {
  for (const value of [o?.total_cost_usd, o?.cost_usd, o?.cost,
    o?.result?.total_cost_usd, o?.result?.cost_usd, o?.result?.cost]) {
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};

const telemetryOf = ({ spec, purpose, started, usage, reported, success, failure, table }) => {
  const normalized = usage && hasUsage(usage) ? totalsOf(usage) : null;
  const cli = spec?.cli ?? 'codex';
  const model = spec?.model ?? null;
  const cost = reported ?? (normalized ? costOf(normalized, cli, model, table) : null);
  return {
    purpose,
    cli,
    model,
    effort: spec?.effort ?? null,
    elapsedMs: Math.max(0, Date.now() - started),
    success: Boolean(success),
    failure: failure ? String(failure).slice(0, 240) : null,
    usage: normalized,
    costUsd: cost,
    costClassification: costClassOf({
      usage: normalized, reported, cli, model, table,
    }),
  };
};

/**
 * One question, one answer, no tools. Returns the model's text, or null.
 *
 * read-only sandbox on purpose: the advisor reasons about text it was handed,
 * so it has no business writing, and read-only costs nothing to enforce. (The
 * usual caveat about confining sandboxes killing MCP does not apply — the
 * advisor is given no MCP server to lose.)
 */
export function ask(spec, prompt, {
  cwd = process.cwd(), timeoutMs = TIMEOUT_MS, onFail, onTelemetry,
  purpose = 'advisor', priceTable = PRICES,
} = {}) {
  const cli = spec?.cli ?? 'codex';
  // agy is a natural fit for these two jobs: they are one-shot text calls that
  // need no tools at all, which is exactly the part of agy that works headless.
  // It also bills against a different quota from codex, so moving the
  // per-turn summariser here takes that load off the court's own budget.
  // Cursor: read-only `ask` mode, no --force — the advisor touches nothing.
  const args = isCursor(cli)
    ? adapterFor(cli).buildArgs({ spec: { ...spec, mode: 'ask', skipPermissions: false, outputFormat: undefined }, cwd, prompt })
    : cli === 'opencode'
    ? ['run', prompt, '--format', 'json', '--auto',
      ...(spec.model ? ['--model', spec.model] : []),
      // opencode's reasoning-effort flag is --variant, not --effort —
      // confirmed against the real CLI's own `run --help`.
      ...(spec.effort ? ['--variant', spec.effort] : [])]
    : cli === 'agy'
    // The prompt is --print's VALUE since agy 1.1.11; see agent.js#runAgyTurn.
    ? ['--print', prompt, '--output-format', 'stream-json',
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort && AGY_EFFORTS.has(spec.effort) ? ['--effort', spec.effort] : []),
      // Measured: agy reaches for a shell command even on a pure text task, and
      // headless mode auto-denies it, so the run produces NOTHING. The only
      // switch that fixes it auto-approves every tool — far too wide a grant to
      // turn on quietly for a job that should touch nothing. Opt in per
      // kingdom with `"skipPermissions": true`, and know what it means.
      ...(spec.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      '--print-timeout', '5m']
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
    let timer;
    let latestUsage = null;
    let reportedCost = null;
    let sentTelemetry = false;
    const report = (success, failure = null) => {
      if (sentTelemetry) return;
      sentTelemetry = true;
      try {
        onTelemetry?.(telemetryOf({
          spec, purpose, started, usage: latestUsage, reported: reportedCost,
          success, failure, table: priceTable,
        }));
      } catch { /* telemetry is observational; it must not change the answer */ }
    };
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const started = Date.now();

    let proc;
    try {
      const { command, prefixArgs } = resolveCli(cli);
      proc = spawn(command, [...prefixArgs, ...args], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      onFail?.(e.message);
      report(false, e.message);
      return finish(null);
    }

    // Kill the whole turn if it overruns: an advisor that hangs would hold up
    // every message the sovereign sends.
    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      onFail?.(`no answer within ${Math.round(timeoutMs / 1000)}s`);
      report(false, `no answer within ${Math.round(timeoutMs / 1000)}s`);
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
        const usage = usageFrom(o);
        latestUsage = (isCursor(cli) ? cursorUsage(usage) : usage) ?? latestUsage;
        reportedCost = costFrom(o) ?? reportedCost;
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
        else if (isCursor(cli) && o.type === 'result' && typeof o.result === 'string') out = o.result;
        // opencode: text, message, or part text
        else if (o.type === 'text' && o.text) out += o.text;
        else if (o.type === 'message' && typeof o.content === 'string') out += o.content;
        else if (o.part?.type === 'text' && o.part?.text) out += o.part.text;
        else if (o.result?.response) out = o.result.response;
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    proc.on('error', (e) => { err = e.message; report(false, e.message); finish(null); });
    proc.on('exit', () => {
      const text = out.trim();
      // Degrading to "no advice" is correct, but degrading SILENTLY is how a
      // permanently misconfigured advisor stays invisible forever — it just
      // looks like the feature does nothing. Say why, once, per failure.
      if (!text) onFail?.(err.trim() || 'the advisor produced no output');
      report(Boolean(text), text ? null : (err.trim() || 'the advisor produced no output'));
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

Then classify what the sovereign is actually asking for, as exactly one of:
- "code"     — write, change, fix, test or review code in this repository
- "chat"     — talk it through; a question about this court itself; thinking out loud
- "cowork"   — delegate multi-step research, writing, notes, tasks, configuration, or an automation/workflow
When it is genuinely both, pick the one the sovereign wants FIRST.

Reply with ONLY this JSON object and nothing else:
{"mode":"chat|cowork|code","brief":"the rewritten brief"}`;

/**
 * Rewrite the sovereign's message, and say what kind of work it is.
 *
 * Classification rides on the rewrite rather than taking a call of its own. The
 * rewrite already blocks — it changes the words the court acts on, so it must
 * land before the message posts — and a second blocking call would put a second
 * model's latency between pressing enter and the orchestrator hearing anything. This
 * costs one more line of output on a call that was happening regardless.
 *
 * Returns `{text, mode}`, or null if there is nothing usable. `mode` is null
 * whenever the model did not answer with one of the modes — an unclassified
 * message leaves the court in the shape it was already in, which is the same
 * thing that happens when the advisor is off.
 */
export async function engineerPrompt(spec, text, opts = {}) {
  const out = await ask(spec, `${ENGINEER}\n\n--- SOVEREIGN'S MESSAGE ---\n${text}`,
    { ...opts, purpose: 'prompt-engineering' });
  if (!out) return null;
  // A model that ignored the schema still produced a usable rewrite, and taking
  // its raw text is precisely what this function did before modes existed. Only
  // the classification is lost, and losing it costs nothing but a manual switch.
  const json = parseJson(out);
  const brief = typeof json?.brief === 'string' && json.brief.trim() ? json.brief.trim() : out;
  const mode = MODE_NAMES.includes(json?.mode) ? json.mode : null;
  // A "rewrite" many times the original is the model answering the request
  // instead of restating it. Rather than feed the court a hallucinated plan,
  // fall back to what the sovereign actually typed.
  if (brief.length > Math.max(1200, text.length * 6)) return null;
  return { text: brief, mode };
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
export const DEFAULT_GUIDANCE = `Choose the least expensive allowed model that can do the task.
Use the supplied rate card as the source of pricing, not remembered prices.
Use the highest useful effort on cheap models; reserve expensive models for work
that needs their extra context or reasoning. A member the task barely touches
can simply be left alone — omit it.`;

function priceContext(allowed, table) {
  return allowed.map((ref) => {
    const rate = table[ref];
    return rate
      ? `  ${ref} — $${rate[0]}/M fresh, $${rate[1]}/M cached, $${rate[2]}/M output`
      : `  ${ref} — price unavailable`;
  }).join('\n');
}

/**
 * What this court has actually spent on output at each recorded effort.
 *
 * A turn snapshots its CLI/model/effort when it ends, rather than looking at
 * the member's current settings. Otherwise an effort change would rewrite the
 * past and make a low-effort result appear to belong to the later high-effort
 * choice. Older turns have no such snapshot and are deliberately omitted.
 */
export function outputEvidence(events = [], { names = null, table = PRICES } = {}) {
  const wanted = names ? new Set(names) : null;
  const previous = new Map();
  const grouped = new Map();
  for (const e of events) {
    const p = e.payload ?? {};
    const usage = p.usage ?? {};
    const d = deltaOf(previous.get(e.agent), usage);
    if (hasUsage(usage)) previous.set(e.agent, totalsOf(usage));
    if (wanted && !wanted.has(e.agent)) continue;
    if (!p.cli || !p.model || !p.effort || !p.usage) continue;
    const key = `${e.agent}\u0000${p.cli}\u0000${p.model}\u0000${p.effort}`;
    const row = grouped.get(key) ?? {
      name: e.agent, cli: p.cli, model: p.model, effort: p.effort,
      turns: 0, output: 0, outputCost: 0, priced: true,
    };
    row.turns++;
    row.output += d.out;
    const outputCost = costOf({ out: d.out }, p.cli, p.model, table);
    if (outputCost === null) row.priced = false;
    else row.outputCost += outputCost;
    grouped.set(key, row);
  }
  const rows = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name)
    || a.cli.localeCompare(b.cli) || a.model.localeCompare(b.model)
    || a.effort.localeCompare(b.effort));
  if (!rows.length) return 'No measured output history is available for this court yet.';
  return ['MEASURED OUTPUT HISTORY — observed usage, not a quality score:']
    .concat(rows.map((r) => `- ${r.name} · ${r.cli}/${r.model} · ${r.effort}: ${r.turns} turns, `
      + `${r.output} output tokens, ${r.priced ? '$' + r.outputCost.toFixed(6) : 'unpriced output'}`))
    .join('\n');
}

/**
 * Picks a model and effort per member from `allowed`.
 *
 * `allowed` is the sovereign's restriction, checked again on the way out —
 * a model is only ever applied if it was on the list, so a creative answer
 * cannot spend money on a tier they excluded.
 */
export async function pickModels(spec, {
  goal, members, allowed, efforts, guidance, measurements, table = PRICES,
}, opts = {}) {
  const choices = [...new Set(allowed)];
  if (!choices.length || !members.length) return {};
  guidance ??= DEFAULT_GUIDANCE;

  // No model can add information when the menu has one item. Keep this path
  // deterministic and free; the effort ladder is already repository config.
  if (choices.length === 1) {
    const ref = choices[0];
    const [cli, ...rest] = ref.split('/');
    const model = rest.join('/');
    const effort = efforts[model]?.at(-1);
    return Object.fromEntries(members.map((m) => [m.name, {
      cli, model, ...(effort ? { effort } : {}),
    }]));
  }

  const menu = choices.map((a) => {
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

RATE CARD (dollars per million tokens; fresh/cache/output):
${priceContext(choices, table)}

${guidance}

${measurements ?? 'No measured output history is available for this court yet.'}
Use that history only as a cost observation. It does not measure correctness,
quality, or task difficulty; do not treat token count as a quality score.

Reply with ONLY JSON, no prose:
{"member-name": {"model": "codex/gpt-5.6-luna", "effort": "medium"}, ...}
Omit any member you would leave alone.`;

  const picks = parseJson(await ask(spec, q, { ...opts, purpose: 'model-selection' }));
  if (!picks || typeof picks !== 'object') return {};

  const names = new Set(members.map((m) => m.name));
  const ok = new Set(choices);
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
