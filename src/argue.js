// The argument court: two models argue a question, a third judges.
//
// The court's ordinary failure mode on a contested question is agreement. Every
// peasant runs the same CLI on the same model with the same house prompt, so
// asking two of them produces one opinion twice — and the orchestrator, reading two
// confident answers that match, treats a coin-flip as settled. Independent
// samples of one model are not independent evidence.
//
// So an argument is deliberately staffed ACROSS CLIs: the arguers are different
// vendors' models, and the judge is a third that did not argue. A debater
// grading its own case is the one arrangement guaranteed to produce a verdict
// nobody should trust.
//
// These are not court members. They have no worktree, no inbox, no MCP tools
// and no session — they are one-shot text calls through the same `ask()` the
// advisor and summariser use, and they are gone when the verdict is written.
// A permanent pair of debating peasants would cost prompt tokens in the orchestrator's
// bench forever for something asked a few times a week.
import { ask } from './advisor.js';

/** Rounds beyond the first are rebuttals. Two is where new arguments stop. */
export const DEFAULT_ROUNDS = 2;
const CAP = 6_000;          // per argument; a debate is not a document

const trim = (s) => {
  const t = String(s ?? '').trim();
  return t.length > CAP ? `${t.slice(0, CAP)}\n[truncated]` : t;
};

/**
 * Who argues and who judges.
 *
 * Distinct CLIs first, because that is the whole point — two models from one
 * vendor share training data, refusal style and blind spots, and will agree
 * with each other for reasons that have nothing to do with the question.
 * Distinct models on one CLI is the fallback, and it is a weaker panel: say so
 * rather than presenting it as the same thing.
 */
export function pickPanel(config) {
  const models = config?.models ?? {};
  const clis = Object.keys(models).filter((c) => models[c]?.length);
  const spec = (cli, i = 0) => ({ cli, model: models[cli][i], skipPermissions: true });

  if (clis.length >= 3) {
    return {
      arguers: [spec(clis[0]), spec(clis[1])],
      judge: spec(clis[2]),
      quality: 'three vendors',
    };
  }
  if (clis.length === 2) {
    // The judge shares a CLI with an arguer but never its model.
    const [a, b] = clis;
    return {
      arguers: [spec(a), spec(b)],
      judge: spec(a, Math.min(1, models[a].length - 1)),
      quality: models[a].length > 1
        ? 'two vendors, judge shares a vendor with one arguer'
        : 'two vendors, judge IS one arguer\'s model — treat the verdict with suspicion',
    };
  }
  if (clis.length === 1 && models[clis[0]].length >= 2) {
    const c = clis[0];
    return {
      arguers: [spec(c, 0), spec(c, 1)],
      judge: spec(c, Math.min(2, models[c].length - 1)),
      quality: 'ONE vendor — the arguers share training data and will agree more than they should',
    };
  }
  return null;
}

const POSITIONS = ['FOR', 'AGAINST'];

function openingPrompt(question, side, context) {
  return `You are arguing a contested question in front of a judge. Your side is ${side}.\n\n`
    + `QUESTION:\n${question}\n\n`
    + (context ? `CONTEXT YOU MAY USE:\n${context}\n\n` : '')
    + `Make the strongest honest case for ${side}. Read the code in the current `
    + `directory if it bears on the question — a concrete file, line or measured `
    + `number beats any amount of reasoning. State your evidence and where it came `
    + `from.\n\n`
    + `If the honest answer is that your side is wrong, SAY SO plainly and explain `
    + `why. You are not here to win; a debate where both sides argue positions they `
    + `do not hold produces a confident verdict on a fiction.\n\n`
    + `Under 400 words. No preamble.`;
}

function rebuttalPrompt(question, side, mine, theirs) {
  return `You are arguing ${side} on this question:\n${question}\n\n`
    + `YOUR CASE SO FAR:\n${mine}\n\n`
    + `THE OPPOSING CASE:\n${theirs}\n\n`
    + `Attack the opposing case where it is actually weak — an unsupported claim, a `
    + `wrong fact, a measurement that does not show what they say it shows. Concede `
    + `explicitly anything they got right; a rebuttal that concedes nothing tells the `
    + `judge you are not reading.\n\n`
    + `Under 300 words. No preamble.`;
}

function judgePrompt(question, transcript) {
  return `You are judging an argument. You did NOT argue in it.\n\n`
    + `QUESTION:\n${question}\n\n`
    + `THE ARGUMENT:\n${transcript}\n\n`
    + `Decide it. Your answer must be, in this order and with these exact headings:\n\n`
    + `VERDICT: one sentence, the actual answer to the question.\n`
    + `BECAUSE: the two or three points that decided it, naming which side made them.\n`
    + `DISSENT: the strongest surviving point AGAINST your verdict. Never write "none" `
    + `— if the losing side made no surviving point, say what evidence would have `
    + `changed your mind instead.\n`
    + `CONFIDENCE: high, medium or low, and what would raise it.\n\n`
    + `Judge the EVIDENCE, not the confidence. The side that sounded more certain is `
    + `not thereby right, and a side that admitted it was wrong has told you the answer. `
    + `If both sides missed something that decides the question, say that and decide it `
    + `yourself. Under 350 words.`;
}

/**
 * Run the argument. Returns { transcript, verdict, panel } — or throws when no
 * panel can be staffed, because a one-model "debate" is worse than no debate:
 * it looks like corroboration and is not.
 */
export async function argue(question, {
  panel, rounds = DEFAULT_ROUNDS, cwd = process.cwd(), onProgress,
} = {}) {
  if (!panel?.arguers?.length) throw new Error('No panel: the argument court needs at least two models.');
  const q = String(question ?? '').trim();
  if (!q) throw new Error('Nothing to argue.');

  const say = (stage, who) => onProgress?.({ stage, who });
  const opts = (label) => ({ cwd, onFail: (m) => say('failed', `${label}: ${m}`) });

  // Both openings at once: they are independent by construction, and running
  // them in sequence doubles the wall-clock of the slowest stage for nothing.
  say('opening');
  const cases = await Promise.all(panel.arguers.map((spec, i) =>
    ask(spec, openingPrompt(q, POSITIONS[i], panel.context), opts(POSITIONS[i]))
      .then((t) => trim(t))));

  if (cases.some((c) => !c)) {
    throw new Error('An arguer produced nothing — check the CLI is installed and authenticated.');
  }

  const transcript = panel.arguers.map((_, i) =>
    `### ${POSITIONS[i]} (${panel.arguers[i].cli}/${panel.arguers[i].model}) — opening\n${cases[i]}`);

  let latest = cases;
  for (let r = 1; r < rounds; r++) {
    say('rebuttal', `round ${r + 1}`);
    const next = await Promise.all(panel.arguers.map((spec, i) =>
      ask(spec, rebuttalPrompt(q, POSITIONS[i], latest[i], latest[1 - i]), opts(POSITIONS[i]))
        .then((t) => trim(t))));
    // A silent arguer keeps its previous case rather than blanking the record.
    latest = next.map((t, i) => t || latest[i]);
    panel.arguers.forEach((_, i) => {
      if (next[i]) transcript.push(`### ${POSITIONS[i]} — rebuttal ${r}\n${next[i]}`);
    });
  }

  say('judging');
  const verdict = trim(await ask(panel.judge, judgePrompt(q, transcript.join('\n\n')), opts('judge')));
  if (!verdict) throw new Error('The judge produced nothing — the argument stands undecided.');

  return { question: q, transcript: transcript.join('\n\n'), verdict, panel };
}

/** The vault note an argument leaves behind. */
export function verdictNote(result, when) {
  const p = result.panel;
  const who = (s) => `${s.cli}/${s.model}`;
  return `---\ntype: decision\nstatus: active\nupdated: ${when}\nrecorded_by: argument-court\n`
    + `tags:\n  - kingdom\n  - decision\n---\n\n`
    + `**Question:** ${result.question}\n\n`
    + `${result.verdict}\n\n`
    + `---\n\n`
    + `Argued by ${p.arguers.map(who).join(' vs ')}, judged by ${who(p.judge)} `
    + `(${p.quality}).\n\n`
    + `<details><summary>The argument</summary>\n\n${result.transcript}\n\n</details>\n`;
}

if (process.argv[1] && /(^|[\\/])argue\.js$/.test(process.argv[1]) && !process.argv[2]) {
  const { strict: a } = await import('node:assert');

  const three = pickPanel({ models: { claude: ['opus'], codex: ['gpt-5.6-luna'], agy: ['gemini-3.6-flash-high'] } });
  a.equal(three.arguers.length, 2);
  a.equal(three.judge.cli, 'agy', 'with three vendors the judge must be the one that did not argue');
  a.ok(new Set([three.arguers[0].cli, three.arguers[1].cli, three.judge.cli]).size === 3);

  const two = pickPanel({ models: { claude: ['opus', 'haiku'], codex: ['gpt-5.6-luna'] } });
  a.notEqual(two.judge.model, two.arguers[0].model, 'the judge must never be an arguer verbatim');
  a.match(two.quality, /two vendors/);

  const one = pickPanel({ models: { codex: ['gpt-5.6-luna', 'gpt-5.2'] } });
  a.equal(one.arguers[0].cli, 'codex');
  a.notEqual(one.arguers[0].model, one.arguers[1].model, 'one vendor still means two DIFFERENT models');
  a.match(one.quality, /ONE vendor/, 'a weaker panel must announce itself, not pass as a real one');

  a.equal(pickPanel({ models: { codex: ['only-one'] } }), null,
    'one model cannot argue with itself — that is corroboration theatre');
  a.equal(pickPanel({ models: {} }), null);

  // The judge prompt must forbid an empty dissent: "DISSENT: none" is how a
  // judge launders a coin-flip into a settled question.
  a.match(judgePrompt('q', 't'), /Never write "none"/);
  a.match(openingPrompt('q', 'FOR'), /If the honest answer is that your side is wrong/);

  const note = verdictNote({
    question: 'Should we cache?', verdict: 'VERDICT: yes', transcript: '### FOR\nbecause',
    panel: three,
  }, '2026-08-13');
  a.match(note, /type: decision/);
  a.match(note, /judged by agy/);
  a.match(note, /<details>/, 'the full argument must be foldable — the verdict is what gets read');

  await a.rejects(() => argue('', { panel: three }), /Nothing to argue/);
  await a.rejects(() => argue('q', { panel: null }), /at least two models/);

  console.log('argue.js self-check OK — cross-vendor panel, judge never argues, dissent compulsory');
}
