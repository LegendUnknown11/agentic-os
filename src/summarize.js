// A cheap model that watches what the court is doing and says it in one line.
//
// The complaint this answers: a member's transcript is a wall of text — every
// file read, every command, every paragraph of reasoning — and reading it is
// most of the work of using the throne room at all. So a small model condenses
// each TURN into one sentence.
//
// Per turn, not per line. A line is meaningless alone ("→ Read") and a call per
// line would cost more than the court itself. A turn is the natural unit: one
// thing the member set out to do.
import { ask } from './advisor.js';

/** Everything the sovereign can change about how summaries read. */
export const DEFAULTS = {
  enabled: true,
  cli: 'codex',
  model: 'gpt-5.4-mini',
  // gpt-5.4-mini publishes none/low/medium/high/xhigh — NOT max, which is what
  // the rest of the court runs at. Summarising is not reasoning work.
  effort: 'none',
  maxWords: 16,
  style: 'Plain past tense. Lead with the verb. Name real files and symbols. '
    + 'No preamble, no praise, no hedging.',
};

/**
 * A key the sovereign has cleared means "use the default", not "use empty".
 *
 * A plain spread does not agree: the live config carried `effort: ""` and
 * `style: ""`, and `""` is falsy, so advisor.js dropped the effort flag
 * entirely and codex ran the summariser at ITS default — medium reasoning — on
 * a job the comment above calls "not reasoning work". With `maxWords` at 40
 * against a default of 16, one cosmetic one-line summary could cost more than
 * the peasant turn it was describing. Nothing caught it because the test
 * asserted DEFAULTS.effort rather than the resolved value.
 */
export const settingsOf = (cfg) => {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(cfg?.summarizer ?? {})) {
    if (v !== '' && v !== null && v !== undefined) out[k] = v;
  }
  return out;
};

/** Effort ladders differ per model, and mini does not go to "max". */
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

const CAP = 14_000;   // per turn; the tail is what a summary is actually about
const ACTION = /^(added|answered|checked|changed|compared|created|described|explained|fixed|found|implemented|merged|removed|renamed|ran|read|refactored|reviewed|tested|updated|verified|wrote)\b/i;

/**
 * Fold one turn's raw events into the text the summariser sees.
 *
 * Tool calls are collapsed to names and counts: fifteen consecutive Reads are
 * one fact, not fifteen, and the file contents they returned are already the
 * reason the transcript is unreadable.
 */
export function transcriptOf(events) {
  const parts = [];
  let run = null;

  const flush = () => {
    if (!run) return;
    parts.push(run.n > 1 ? `[${run.name} x${run.n}]` : `[${run.name}]`);
    run = null;
  };

  for (const e of events) {
    if (e.kind === 'tool') {
      const name = e.payload?.name ?? 'tool';
      if (run?.name === name) run.n++;
      else { flush(); run = { name, n: 1 }; }
    } else if (e.kind === 'text') {
      flush();
      const t = (e.payload?.text ?? '').trim();
      if (t) parts.push(t);
    }
  }
  flush();

  const joined = parts.join('\n');
  return joined.length > CAP ? `…\n${joined.slice(-CAP)}` : joined;
}

/** Use an already-good final action sentence without paying for a second model. */
export function fastSummary(events, maxWords) {
  const text = [...events].reverse()
    .find((e) => e.kind === 'text' && typeof e.payload?.text === 'string')?.payload.text?.trim();
  if (!text || text.includes('\n') || !/[.!?]$/.test(text) || !ACTION.test(text)) return null;
  if (text.split(/\s+/).length > maxWords || clean(text, maxWords) !== text) return null;
  return text;
}

/**
 * One line describing what `name` just did. Returns null when there is nothing
 * worth saying, or when the call fails — a missing summary is a cosmetic loss,
 * so it must never surface as an error or block the turn.
 */
export async function summarize(settings, { name, role, events }, opts = {}) {
  if (!settings.enabled) return null;
  const fast = fastSummary(events, settings.maxWords);
  if (fast) return fast;
  const body = transcriptOf(events);
  if (body.replace(/\[[^\]]*\]/g, '').trim().length < 24) return null;   // tools only: nothing to say

  // Two kinds of turn, and the difference matters. A turn that ACTS is summed
  // up by what it changed. A turn that only ANSWERS is summed up by what it
  // said — an earlier version asked only "what did they do", and a member that
  // gave a perfectly good answer was reported as "Accomplished nothing."
  const q = `Below is one turn from "${name}", a ${role} in an AI software team.
Summarise it in at most ${settings.maxWords} words.

${settings.style}

Two kinds of turn:
- If they changed or inspected something, say what they changed or found.
- If they only answered or explained, say what they ACTUALLY SAID — the substance
  of the answer, not the fact that an answer was given.
Only say nothing was achieved if the turn genuinely failed or was empty. Producing
an answer is not nothing.

Never quote the text back. Never say "the agent" or "they" — start with the verb.
Reply with the sentence and nothing else.

--- TURN ---
${body}`;

  const out = await ask({ cli: settings.cli, model: settings.model, effort: settings.effort },
    q, { ...opts, purpose: 'summary' });
  return out ? clean(out, settings.maxWords) : null;
}

/**
 * Models add quotes, bullets, trailing rationale and "Summary:" prefixes no
 * matter how firmly they are asked not to. Strip rather than re-prompt.
 */
export function clean(text, maxWords) {
  let s = String(text).trim()
    .replace(/^```[\s\S]*?```$/g, '')
    .split('\n').find((l) => l.trim()) ?? '';
  s = s.trim()
    .replace(/^(summary|answer|result)\s*[:\-–]\s*/i, '')
    .replace(/^[-*•]\s+/, '')
    .trim();

  // A model that quotes its answer often keeps talking afterwards
  // (`"Fixed the race." It was in session.dart`). Stripping only the outermost
  // quote characters left a dangling one mid-sentence, so take what is INSIDE
  // the quotes and drop the commentary.
  const quoted = s.match(/^["'`](.+?)["'`](?:\s|$)/s);
  if (quoted) s = quoted[1].trim();
  else s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  const words = s.split(/\s+/);
  // A hard cap the model cannot talk its way past. The ellipsis is honest: it
  // says the sentence was cut, rather than pretending it ended there.
  if (words.length > maxWords + 4) s = `${words.slice(0, maxWords).join(' ')}…`;
  return s || null;
}
