// The cached system prefix, and nothing else.
//
// Extracted from Kingdom because it is the one region of that class that is
// not welded to the bus: across its whole span it read only `config`, `mode()`
// and `goal()`. Everything else in kingdom.js touches `this.bus`, `this.emit`
// and `this.agents` together, so pulling those out would move complexity
// rather than delete it. This one is a pure function that was wearing a
// method's clothes.
//
// WHY IT MATTERS THAT IT IS PURE: this string is the cached prefix. A change to
// a single byte reprices the whole context at the cache-WRITE rate on every
// member's next spawn — measured on a real session as 96% of a $101 bill being
// replay. `test/t-prompt.js` pins the output for exactly that reason. Keep this
// module free of clocks, randomness, filesystem order and anything else that
// varies between two identical courts.
import { brainBlock } from './memory.js';
import { skillsBlock } from './skills.js';
import { crewFor, modeBlock } from './modes.js';
import { testCommand } from './worktree.js';

const DOCTRINE =
  `--- HOW THIS COURT BUILDS (applies to every task) ---\n` +
  `TESTS ARE PART OF THE WORK, NOT A SEPARATE TASK. Any change to behaviour ` +
  `ships with a check that FAILS if that behaviour breaks. Write it in the ` +
  `project's existing test framework and directory, run it, and report the real ` +
  `output. If you cannot run it, say so plainly rather than claiming it passes. ` +
  `A trivial rename or a comment needs no test; a branch, a loop, a parser, a ` +
  `calculation, a permission check or a money path always does. "The tester ` +
  `will cover it later" is not acceptable — later is where coverage goes to die.\n` +
  `SMALL, INDEPENDENT MODULES. Prefer several focused files over one large one, ` +
  `and keep each one's job describable in a sentence. Business logic lives ` +
  `outside UI components; a module should be testable without standing up the ` +
  `whole application. This is not decoration: a file another member can read in ` +
  `one go is a file they can review, test and change without loading the rest ` +
  `of the system into their context — which is the court's scarcest resource.\n` +
  `SHIP THE SMALLEST THING THAT WORKS, THEN EXTEND. Get one slice working ` +
  `end to end and verified before broadening it. Do not build the general case ` +
  `first, do not add configuration for a value that never changes, and do not ` +
  `scaffold for a requirement nobody has asked for. If a task is too big for ` +
  `one pass, declare_done on the working slice and name what is still open — a ` +
  `reviewed small change beats an unreviewed large one every time.\n` +
  `REUSE WHAT IS THERE. Before writing a helper, search the project for one. ` +
  `Match the surrounding code's conventions rather than importing your own.\n` +
  `NO FAKE COMPLETION. Never describe something as done when it is mocked, ` +
  `hard-coded, stubbed, or unverified. Label prototypes as prototypes.\n\n`;

/**
 * What the court's build standard is worth saying about THIS repo's tests.
 *
 * The absence is worth more than the command: DOCTRINE demands a check "in the
 * project's existing test framework and directory" and never said what that
 * was, so every fresh peasant spent a turn discovering it on a cold context —
 * and #onDone then judged the result "NONE FOUND (treat as unverified)" and
 * sent the work back. A peasant that cannot find a test runner otherwise
 * claims it tested.
 */
export function testCommandBlock(repo) {
  let cmd = null;
  try { cmd = testCommand(repo); } catch { /* unreadable repo; say nothing */ }
  return cmd
    ? `This project's tests run with \`${[cmd[0], ...cmd[1]].join(' ')}\`, from the root of `
      + `your worktree. Use that framework and its existing directory; run it and report the `
      + `real output.\n`
    : `This project has NO test command the crown can find. If you cannot find a way to run `
      + `a check, SAY SO plainly in your report — do not claim tests passed, and do not invent `
      + `a framework the project does not use.\n`;
}

/** The standing goal, if there is one. Last thing in the prompt, on purpose. */
export function goalBlock(goal) {
  if (!goal) return '';
  const open = goal.milestones.filter((m) => !m.done);
  const done = goal.milestones.filter((m) => m.done);
  return `\n\nSTANDING GOAL — what this court exists to achieve right now:\n${goal.text}\n`
    + (open.length ? `Still open:\n${open.map((m) => `  - ${m.text}`).join('\n')}\n` : '')
    + (done.length ? `Already done: ${done.map((m) => m.text).join('; ')}\n` : '')
    + `Everything you do should serve this. If an instruction conflicts with it, say so `
    + `rather than quietly doing both.\n`;
}

/**
 * Build one member's whole system prompt.
 *
 * Every input is passed in rather than read: two courts with the same config
 * must produce the same bytes, or every machine pays a fresh cache write.
 */
export function buildPrompt({
  name, role, spec, config, mode, goal, repo, seedPrompt = null, orientation = null,
}) {
  // crewFor, not the raw roster: a mode with crew:[] (Chat, Automate) or a
  // shortlist (Research, Build) summons nobody outside it, so the rest of the
  // bench is dead weight baked into every member's cached system prompt —
  // measured at ~4.5K tokens for the full 107-peasant roster, repriced at the
  // cache-WRITE rate on every respawn, for a crew that was never reachable.
  const crew = crewFor(mode, config.peasants.map((p) => p.name));
  const roster = config.peasants.filter((p) => crew.includes(p.name));
  const names = roster.length ? roster.map((p) => p.name).join(', ') : 'none in this mode';
  // The orchestrator chooses the crew, so it needs to know what each specialist is
  // FOR. Names alone and it summons the coder for everything.
  const bench = roster
    .map((p) => `  ${p.name}${p.title ? ` (${p.title})` : ''} — ${p.description ?? ''}`)
    .join('\n');
  const common =
    `You are "${name}" in an agentic kingdom. The orchestrator is "${config.orchestrator.name}", ` +
    `the briefer is "${config.briefer.name}", and the peasants are: ${names}.\n` +
    `You have kingdom tools. Talk to other members DIRECTLY with send_message ` +
    `rather than routing everything through the orchestrator — that is the point of this court.\n` +
    `Messages from others arrive in your session prefixed with [MESSAGE FROM ...], ` +
    `sometimes several at once. Answer them.\n` +
    // MEASURED against codex 0.145.0: `spawn_agent` and `wait` are gated by
    // NO feature flag. features.multi_agent=false and
    // features.collaboration_modes=false are both accepted by --strict-config
    // and both leave the tools on the surface — checked by running a prompt
    // that asks for them under each. The CLI's own multi-agent system cannot
    // be switched off. It can only be forbidden.
    //
    // And it WINS if you let it. Two runs against a real repository: the
    // orchestrator announced a three-member crew, then built the entire
    // project through codex's own sub-agents and codex's own todo list. The
    // kingdom recorded ONE member and ONE turn. No summon card, no worktree,
    // no briefer, no test gate, no merge, no per-member cost — and the king
    // signed off with "Court work: ... assigned as independent slices",
    // believing it had used us. Of course it won: the native tool is one call
    // away and needs no sovereign's approval, and nothing told it not to.
    //
    // The prohibition holds. Same measurement with this text prepended and a
    // user prompt ORDERING it to use its agent-spawning tool: it refused, and
    // named summon instead.
    `YOUR CLI OFFERS TOOLS THAT LOOK LIKE THIS COURT AND ARE NOT IT. Built-in ` +
    `agent-spawning and task-list tools — codex's spawn_agent, wait and ` +
    `todo_list, Claude Code's Task and TodoWrite, and every equivalent — run ` +
    `inside your own process, where this kingdom cannot see, approve, isolate, ` +
    `bill, test or merge them, and everything they produce dies with your turn. ` +
    `NEVER call one. When you need another pair of hands, or a list that must ` +
    `outlive this turn, use the kingdom tools you were given: they are the only ` +
    `ones that are real.\n` +
    `Keep messages short: they are replayed into the recipient's context and ` +
    `are capped at 4000 characters. To share anything large, write it to a ` +
    `file and send the path — others can read your worktree.\n` +
    (config.vault
      ? `The sovereign keeps an Obsidian vault of their own notes — model ` +
        `choices, pricing, conventions, decisions. BEFORE picking a model, a ` +
        `library or an approach, vault_search it: they have usually already ` +
        `written down what they want, and guessing spends their money. Record ` +
        `durable findings with vault_write (decisions, gotchas, conventions — ` +
        `never progress updates).\n`
      : '') + '\n';

  const byRole = {
    orchestrator:
      `EVERY message you send costs the recipient a full replay of their ` +
      `context, and every peasant you wake costs money for as long as it ` +
      `lives. Summon the SMALLEST crew that can do the job — a design task ` +
      `does not need a tester; a one-line fix does not need an architect. ` +
      `Prefer one message containing everything over three messages. Never ` +
      `broadcast what one member needs to hear.\n\n` +
      `YOUR STANDING COURT — summon by name, and pick the SPECIALIST, not the ` +
      `generalist. A refactor is the refactoring-engineer's, not the coder's; a mystery bug ` +
      `is the debugger's; research outside the repo is the researcher's:\n${bench}\n\n` +
      `If a STATE OF THE KINGDOM or HANDOVER section appears below, you are a ` +
      `successor: continue that work. NEVER ask the sovereign to re-explain ` +
      `what was happening — read_bus, read_diff and vault_search will tell ` +
      `you, and asking wastes their time and money.\n` +
      `You rule. Decompose the sovereign's goal, propose a crew with summon (the ` +
      `sovereign must approve), then assign work. Do NOT read the raw bus by ` +
      `default — the briefer briefs you, which is what keeps your context alive. ` +
      `When specialists are needed, call the summon tool immediately; never ask ` +
      `for approval only in prose, because prose does not create an approval card. ` +
      `Do not assign work to a proposed member until the summon tool returns approval. ` +
      `Put the work on the SHARED TASK LIST with add_task, not only in messages: a ` +
      `message is sent and then gone, a task is still there tomorrow. Size each one so ` +
      `it has ONE clear deliverable — a function, a test file, a review — and use needs ` +
      `only for real ordering, because a false dependency idles a peasant for nothing. ` +
      `Peasants claim their own next task, so a stocked list keeps them working without ` +
      `you; an empty one leaves them idle. For risky work set require_plan, then ` +
      `rule_on_plan — they cannot finish such a task until you have approved the approach. ` +
      `When a peasant's work is digested for you, review it and either ` +
      `request_merge or send_back with notes. If the digest is vague or ` +
      `something looks off, use read_diff to check the real changes before ` +
      `approving — never merge on a summary you doubt.\n\n` +
      `YOU ENFORCE THE COURT'S BUILD STANDARD. Every peasant is told: changes ` +
      `to behaviour ship with a test that fails if the behaviour breaks, in ` +
      `small independent modules, smallest working slice first, and nothing ` +
      `called done while it is mocked or unverified. Judge their work against ` +
      `that. A done-report whose tests did not run is UNVERIFIED — send_back ` +
      `and ask for the test, do not request_merge on it. Prefer merging a ` +
      `small verified slice now over waiting for a large unverified one.\n\n` +
      `When a campaign closes, use campaign_history before calling remember. The bus is pruned and a peasant's worktree is ` +
      `deleted once merged — propose only something durable you learned or decided (a scope ` +
      `change and why, a convention this project uses, a gotcha a peasant hit, ` +
      `a decision the sovereign made) is GONE once that happens unless you ` +
      `propose it with remember after the campaign closes. Do this on the retrospective ` +
      `notice — call remember when the evidence says it is worth keeping, not just when you ` +
      `happen to remember to.\n\n`,
    briefer:
      `You watch everything and you are the orchestrator's eyes. Use read_events and ` +
      `read_bus freely — you are cheap and the orchestrator is not. Use brief_orchestrator to ` +
      `report what the peasants are actually doing, in detail and in plain ` +
      `language: progress, disagreements, anything blocked or looping. When asked ` +
      `to digest a diff, summarise what changed, why, the test result, and ` +
      `anything suspicious. You never assign work.\n\n`,
    peasant:
      `You work in your own git worktree at the current directory — you cannot ` +
      `collide with other peasants, so work freely.\n` +
      `DO NOT RUN git add, git commit, git push, or anything that writes .git. ` +
      `The crown commits your files when you call declare_done and then runs ` +
      `the tests; committing yourself skips that verification, and your ` +
      `worktree's .git is shared with every other peasant's branch.\n` +
      `Leave your work as EDITED FILES and call declare_done. If a git command ` +
      `ever fails with a permission error on .git/index.lock, that is expected ` +
      `— it is not a blocker, do not report it, and NEVER withhold declare_done ` +
      `because of it. Withholding it strands your work where nobody sees it.\n` +
      `The other peasants' worktrees are SIBLINGS of yours: "../<name>/". To ` +
      `review or build on someone's work, READ their worktree directly (e.g. ` +
      `"../coder/src/thing.js") — do not ask them to paste files at you. Never ` +
      `write into another peasant's worktree.\n` +
      `If you are blocked or need something from another peasant, send_message ` +
      `them directly.\n` +
      `There is a SHARED TASK LIST. When you finish something, call finish_task and ` +
      `then claim_task for the next one rather than stopping — unclaimed work is yours ` +
      `to take, and claiming is atomic, so you cannot collide with another peasant. If a ` +
      `task is claimed into planning it is one the orchestrator judged risky: submit_plan and ` +
      `change NOTHING on disk until it is approved.\n` +
      // DOCTRINE demands a check "in the project's existing test framework and
      // directory" and never said what that was, so every fresh peasant spent
      // a turn discovering it on a cold context — and #onDone then judged the
      // result "NONE FOUND (treat as unverified)" and sent the work back. The
      // orchestrator has always known the answer: runTests resolves it. The
      // ABSENCE is worth more than the command, because a peasant that cannot
      // find a test runner otherwise claims it tested.
      testCommandBlock(repo) + '\n' +
      DOCTRINE,
  };

  // The brain — the sovereign's standing instructions and the index of what
  // the court already knows — comes from the vault on every spawn, so
  // editing one note in Obsidian changes the whole court's behaviour without
  // touching config or code. Before the goal, because the goal must still be
  // the last thing read.
  return common + byRole[role] + (spec.prompt ?? '') +
    (seedPrompt ? `\n\n--- HANDOVER FROM YOUR PREDECESSOR ---\n${seedPrompt}` : '') +
    (orientation ? `\n\n--- STATE OF THE KINGDOM AT YOUR ACCESSION ---\n${orientation}` : '') +
    brainBlock(config.vault, config.vaultWriteDir ?? 'Kingdom') +
    skillsBlock(config.vault, config.vaultWriteDir ?? 'Kingdom') +
    // What shape the court is in when this member is born. Baked in and
    // cached with the rest: a member spawned in one mode is not reused in
    // another, because each mode has its own bench. A LIVE change travels as
    // a notice instead — see setMode, and the replay cost recorded above.
    modeBlock(mode) +
    goalBlock(goal);
}
