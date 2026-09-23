import { strict as a } from 'node:assert';
import { readFileSync } from 'node:fs';
import { changeStage, pushState } from '../ui/views/pages.js';
import { modelLabel } from '../ui/views/util.js';
import { lastMessageIdFor } from '../ui/sidebar.js';
import { taskMeta, visibleQueueRows } from '../ui/views/home.js';
import { resolvedOutcome } from '../ui/views/approvals.js';
import { cancelMetrics, loadMetrics, metricsView, recommendationFor, warningFor } from '../ui/views/usage.js';

const settingsSource = readFileSync(new URL('../ui/views/settings.js', import.meta.url), 'utf8');
const automationsSource = readFileSync(new URL('../ui/views/automations.js', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../ui/views/home.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../ui/sidebar.js', import.meta.url), 'utf8');
const assetsSource = readFileSync(new URL('../ui/assets.js', import.meta.url), 'utf8');
const graphSource = readFileSync(new URL('../ui/graph.js', import.meta.url), 'utf8');
const petSource = readFileSync(new URL('../ui/pet.js', import.meta.url), 'utf8');
const courtPreloadSource = readFileSync(new URL('../electron/court-preload.cjs', import.meta.url), 'utf8');
const electronMainSource = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const threadSource = readFileSync(new URL('../ui/thread.js', import.meta.url), 'utf8');
const utilSource = readFileSync(new URL('../ui/views/util.js', import.meta.url), 'utf8');
const runSource = readFileSync(new URL('../ui/run.js', import.meta.url), 'utf8');
const usageSource = readFileSync(new URL('../ui/views/usage.js', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../ui/store.js', import.meta.url), 'utf8');

const state = { base: 'main', notices: [], changeLifecycle: {} };
a.equal(changeStage(state, 'coder', '1 file | 2 ++').status, 'review', 'a changed worktree starts ready for review');

state.changeLifecycle.coder = { status: 'requested', stat: '1 file | 2 ++' };
a.equal(changeStage(state, 'coder', '1 file | 2 ++').status, 'requested', 'the merge request stays visible while it runs');

state.changeLifecycle.coder = { status: 'merged', stat: '1 file | 2 ++' };
a.equal(changeStage(state, 'coder', '1 file | 2 ++').status, 'merged', 'a successful merge has an explicit result');
a.equal(changeStage(state, 'coder', '2 files | 3 ++').status, 'review', 'new work resets the prior result to review');

state.changeLifecycle.coder = { status: 'review', stat: '2 files | 3 ++' };
state.notices.push({ type: 'mergeFailed', peasant: 'coder', message: 'conflict' });
a.equal(changeStage(state, 'coder', '2 files | 3 ++').status, 'failed', 'a refused merge keeps a retryable result');

const code = { modeDef: { worktrees: true, merge: true }, approvals: [] };
a.equal(pushState(code), 'ready', 'Code exposes the final push gate when no worktree is outstanding');
a.equal(pushState(code, true), 'merge-first', 'the push gate waits for unmerged work');
a.equal(pushState({ ...code, approvals: [{ kind: 'push', resolved: false }] }), 'pending', 'a live push request is not duplicated');
a.equal(pushState({ modeDef: { worktrees: true, merge: false }, approvals: [] }), 'unavailable', 'non-Code modes cannot push');
a.equal(lastMessageIdFor({ messages: [
  { id: 3, conversation_id: 'c-1' }, { id: 9, conversationId: 'c-1' }, { id: 12, conversationId: 'c-2' },
] }, 'c-1'), 9, 'branching uses the newest message in the selected conversation');

const pagesOnlySource = readFileSync(new URL('../ui/views/pages.js', import.meta.url), 'utf8');
const changesSource = readFileSync(new URL('../ui/views/changes.js', import.meta.url), 'utf8');
const approvalsSource = readFileSync(new URL('../ui/views/approvals.js', import.meta.url), 'utf8');
const viewSources = Object.fromEntries(['approvals', 'changes', 'usage', 'activity', 'messages', 'agents', 'objective', 'memory', 'notes', 'doctor']
  .map((name) => [name, readFileSync(new URL(`../ui/views/${name}.js`, import.meta.url), 'utf8')]));
const pagesSource = [pagesOnlySource, ...Object.values(viewSources)].join('\n');
const visibleCopySource = [homeSource, pagesSource, settingsSource].join('\n');

for (const [name, source] of Object.entries({ ...viewSources, automations: automationsSource, settings: settingsSource })) {
  a.doesNotMatch(source, new RegExp(`export async function mount${name[0].toUpperCase()}${name.slice(1)}`), `${name} must return cleanup before its initial request settles`);
}
a.doesNotMatch(mainSource, /const cleanup = typeof mounted\?\.then === 'function' \? await mounted : mounted;/, 'the shell must receive view cleanup synchronously');
a.doesNotMatch(pagesOnlySource, /\/\* Changes -{4,}/, 'the page registry must not absorb the Changes implementation again');
a.match(changesSource, /export function renderChanges/, 'the Changes view must own its renderer');
a.doesNotMatch(pagesOnlySource, /\/\* Approvals -{4,}/, 'the page registry must not absorb the Approvals implementation again');
a.match(approvalsSource, /export function renderApprovals/, 'the Approvals view must own its renderer');
for (const [name, source] of Object.entries(viewSources)) {
  const title = name[0].toUpperCase() + name.slice(1);
  a.match(source, new RegExp(`export function render${title}`), `${name} must own its renderer`);
  a.doesNotMatch(pagesOnlySource, new RegExp(`/\\* ${title} -{4,}`), `the page registry must not absorb ${name}`);
}
a.match(pagesSource, /post\('summon'/, 'the Team page must request a summon approval');
a.doesNotMatch(pagesSource, /on && member\.awake \? 'sleep' : 'wake'/, 'adding an agent must not bypass approval with wake');
a.match(settingsSource, /picked\.path/, 'the native repository picker result must use its returned path');
a.match(settingsSource, /aria-label': 'Settings sections'/, 'Settings navigation must have a spoken region name');
a.match(settingsSource, /\['efficiency', 'Models & efficiency'\]/, 'Settings must consolidate model cost controls into one section');
a.match(settingsSource, /\['appearance', 'Appearance'\]/, 'Settings must expose wallpaper under Appearance');
a.doesNotMatch(settingsSource, /themeOf|setPrefs\(\{ theme:/, 'Appearance must not offer a theme choice — Hiveory is dark-only, the toggle is gone');
a.doesNotMatch(settingsSource, /\['summary', 'Summaries'\]|\['advisor', 'Advisor'\]/, 'Settings must not keep separate Summary and Advisor tabs');
a.match(settingsSource, /type: 'button', style: \{ backgroundImage/, 'Settings asset tiles must never submit a surrounding form');
a.match(settingsSource, /tab\.setAttribute\('aria-current', 'page'\)/, 'Settings must expose its active section to assistive technology');
a.match(settingsSource, /picked\.error/, 'a rejected native repository pick must be visible in Settings');
a.match(settingsSource, /try \{\s*const picked = await window\.kingdomShell\.chooseRepo\(\);[\s\S]*?catch \(error\)/, 'a native repository picker rejection must be visible in Settings');
a.match(settingsSource, /Could not attach that repository\./, 'a failed repository attach must be visible in Settings');
a.match(settingsSource, /attach\.disabled = false/, 'a failed repository attach must be retryable');
a.match(settingsSource, /Attached: \$\{result\.repo \?\? value\}/, 'a successful repository attach must be confirmed immediately');
a.match(settingsSource, /window\.kingdomShell\?\.openPet \? window\.kingdomShell\.openPet\(\) : window\.open/, 'the native desk-pet control must use its IPC bridge');
a.match(courtPreloadSource, /openPet: \(\) => ipcRenderer\.send\('pet:open'\)/, 'the court preload must expose the desk-pet command');
a.match(electronMainSource, /ipcMain\.on\('pet:open', openPet\)/, 'the native main process must reopen the desk pet');
a.match(electronMainSource, /spawn\(node, \[[\s\S]*?windowsHide: true/, 'the daemon spawn must not flash a console window on Windows startup');

// Issue #42 (reopened): attachRepo refuses a live repo swap on purpose
// (src/kingdom.js, locked in by test/t-control.js's "requires a fresh
// court" pin) — the real gap was that nothing in the app could actually end
// the court and start a fresh one. Settings now offers that, gated to the
// exact wall attachRepo hits, wired through a dedicated shell bridge.
a.match(settingsSource, /if \(\/fresh court\/\.test\(result\.error \?\? ''\) && window\.kingdomShell\?\.switchRepo\) switchRepo\.hidden = false;/, 'the repository switcher must only appear once attach has actually hit the fresh-court wall');
a.match(settingsSource, /const result = await window\.kingdomShell\.switchRepo\(path\.value\.trim\(\)\);/, 'switching repositories must go through the dedicated shell bridge, not attachRepo');
a.match(settingsSource, /if \(result\?\.canceled\)/, 'a cancelled repository switch must leave the control usable again, not stuck disabled');
a.match(courtPreloadSource, /switchRepo: \(path\) => ipcRenderer\.invoke\('court:switchRepo', path\)/, 'the court preload must expose the repository-switch command');
a.match(electronMainSource, /ipcMain\.handle\('court:switchRepo', async \(event, rawPath\) => switchRepo\(rawPath, \{/, 'the native main process must own ending and respawning the court');
// The step sequence itself (validate before confirm, confirm before
// shutdown, shutdown before startDaemon, reload only after it answers) is a
// plain function in electron/switch-repo.js, exercised end-to-end without
// Electron in test/t-repo-switch.js — including the exact ordering risk
// Greptile flagged on PR #69 (a bad path reaching the destructive steps).
// This suite only has to pin that main.js wires REAL dependencies into it.
a.match(electronMainSource, /import \{ assertRepo \} from '\.\.\/src\/worktree\.js'/, 'a repository switch must validate the target with a real git check (assertRepo), not an existsSync(.git) peek a corrupt or empty entry would pass');
a.match(electronMainSource, /assertRepo,\s*\n\s*confirm: async \(repo\) => \{/, 'a repository switch must use the real git validator, not a bespoke check');
a.match(electronMainSource, /buttons: \['Cancel', 'End court and switch'\][\s\S]*?return response === 1;/, 'ending a court is destructive — it must be confirmed natively before anything is torn down');
a.match(electronMainSource, /shutdown: \(\) => fetch\(`\$\{ORIGIN\}\/api\/shutdown`, \{ method: 'POST' \}\)/, 'a repository switch must end the running court through its own shutdown endpoint');
a.match(electronMainSource, /courtOnPort,\s*\n\s*startDaemon,/, 'a repository switch must poll the real port state and start the fresh court through the same path the app itself boots with');
a.match(electronMainSource, /reload: \(\) => BrowserWindow\.fromWebContents\(event\.sender\)\?\.loadURL\(`\$\{ORIGIN\}\/`\)/, 'a successful repository switch must reload the window instead of resuming a stale event cursor from the old repo');
a.match(automationsSource, /workflow-run-message/, 'a manual workflow run must leave visible feedback');
a.match(automationsSource, /result\?\.steps/, 'workflow feedback must report the returned run trace');
a.match(automationsSource, /automationEditor/, 'live updates must not discard an open workflow editor');
a.match(automationsSource, /workflow\.nodes\.splice\(0, workflow\.nodes\.length, \.\.\.parsed\)/, 'JSON editor changes must survive returning to graph mode');
a.match(automationsSource, /Workflow nodes must be an array\./, 'invalid graph JSON must stay visible instead of being discarded');
a.match(automationsSource, /const parseNodes = \(\) => \{[\s\S]*?Array\.isArray\(parsed\)/, 'JSON workflow nodes must be checked at one shared editor boundary');
a.match(automationsSource, /nodes = parseNodes\(\)/, 'saving directly from JSON mode must validate the node graph too');
a.match(automationsSource, /field\('Trigger detail', detail\)/, 'conditional trigger input must have an explicit label');
a.match(automationsSource, /const enabled = check\(workflow\.enabled !== false\)/, 'editing an automation must show its current enabled state');
a.match(automationsSource, /field\('Enabled', enabled/, 'automation editing must expose an enabled control');
a.match(automationsSource, /enabled: enabled\.checked/, 'automation saves must persist the enabled control state');
a.match(automationsSource, /field\('Nodes JSON', raw\)/, 'JSON editor must have an explicit label');
a.match(automationsSource, /node\.type === 'http' && key === 'body' && \['GET', 'HEAD'\]\.includes/, 'GET and HEAD automation nodes must not expose an unusable body editor');
a.match(automationsSource, /if \(key === 'method'\) paintInspector\(node\)/, 'changing an HTTP method must repaint its supported fields');
a.doesNotMatch(automationsSource, /graph\?\.dropNew\(type, graphHost\.clientWidth \/ 2, graphHost\.clientHeight \/ 2\)/, 'new workflow nodes must not treat local dimensions as screen coordinates');
a.match(automationsSource, /const graphRect = graphHost\.getBoundingClientRect\(\)/, 'new workflow nodes must use the graph bounds for screen coordinates');
a.match(automationsSource, /rawField\.hidden = !rawField\.hidden/, 'JSON mode must hide the labelled control as one unit');
a.match(automationsSource, /workflow-action-message/, 'workflow save and delete failures need visible feedback');
a.match(automationsSource, /root\.isConnected === false/, 'stale workflow loads must not repaint a detached editor');
a.match(automationsSource, /state\.workflowsRequest !== token/, 'stale automation responses must not repaint a newer visit');
a.match(automationsSource, /root\.isConnected === false \|\| root\.dataset\.automationEditor === '1'/, 'workflow mutations must not repaint after leaving the list');
a.match(automationsSource, /root\.isConnected && root\.dataset\.automationEditor !== '1'/, 'live workflow updates must not repaint detached roots or open editors');
a.match(automationsSource, /function disposeEditor\(root\)/, 'closing an automation editor must own its graph cleanup');
a.match(automationsSource, /disposeEditor\(root\)/, 'workflow list transitions must dispose the previous graph');
a.match(automationsSource, /kind === 'number'/, 'numeric workflow fields must use numeric controls');
a.match(automationsSource, /control\.classList\.remove\('bad'\)/, 'valid workflow inspector input must clear its old error state');
a.match(automationsSource, /const invalidFields = new Set\(\)/, 'workflow inspector must retain invalid JSON state across selection changes');
a.match(automationsSource, /invalidFields\.add\(fieldKey\)/, 'invalid workflow inspector JSON must be recorded instead of silently retaining stale values');
a.match(automationsSource, /else if \(invalidFields\.size\) \{[\s\S]*?Fix the invalid node fields before saving\./, 'workflow save must refuse stale payloads after invalid inspector JSON');
a.match(automationsSource, /invalidFields\.clear\(\)/, 'valid raw JSON replacement must clear obsolete inspector errors');
a.match(graphSource, /function destroy\(\)/, 'workflow graphs must expose lifecycle cleanup');
a.match(graphSource, /removeEventListener\('pointerdown', onPointerDown\)/, 'graph cleanup must remove its surface listener');
a.match(graphSource, /pointercancel.*cancel/, 'cancelling a wire drag must not rewrite the saved connection');
a.match(automationsSource, /data\?\.ok === false/, 'workflow list refresh failures must not be rendered as a list');
a.match(automationsSource, /state\.workflowsLoading/, 'Automations must distinguish loading from an empty list');
a.match(automationsSource, /state\.workflowsError/, 'automation refresh failures must keep a separate visible error state');
a.match(automationsSource, /button\('Retry'/, 'automation refresh failures must offer a direct retry');
a.match(automationsSource, /if \(!state\.workflows \|\| state\.workflows\?\.ok === false\)/, 'automation refresh failures may stop only when no last-known list exists');
a.doesNotMatch(automationsSource, /state\.workflowsLoading = false; state\.workflows = data; workflowList\(state, root\); \}/, 'a failed automation refresh must not overwrite the last-known list');
a.match(automationsSource, /add\.disabled = Boolean\(state\.workflowsLoading\)/, 'Automations must not start a new workflow before its list loads');
a.match(automationsSource, /Array\.isArray\(source\)/, 'an initial workflow load failure must render an error instead of crashing');
a.match(homeSource, /const homeStateKey =/, 'Home must identify the state that can change its visible decisions');
a.match(homeSource, /if \(next === snapshot\) return;/, 'unrelated stream events must not repaint Overview');
a.match(homeSource, /let queueExpanded = false/, 'Home queue disclosure must survive live store repaints');
a.match(homeSource, /visibleQueueRows\(queueRows, queueExpanded\)/, 'Home must render the full queue when its disclosure is expanded');
a.match(homeSource, /setQueueExpanded/, 'Home queue disclosure must have a local toggle action');
a.match(homeSource, /state\.ready === false/, 'Home must not present empty data before the first court snapshot');
a.doesNotMatch(homeSource, /home-card-empty/, 'sparse Home must not render empty secondary cards');
a.match(homeSource, /class: 'home-empty'/, 'an empty Home must keep one quiet next-step cue');
a.match(homeSource, /!taskFailure && !queueVisible && !workingVisible && !changesVisible/, 'Home must only show secondary blocks when they contain work');
a.doesNotMatch(homeSource, /home-mode-card|modeCard/, 'Overview must not carry a mode card — mode lives in the header and drawer only');
a.match(homeSource, /home-objective/, 'Home must keep the objective as an ambient card');
a.match(homeSource, /grid\.append\(ambient\);[\s\S]*?if \(!runSummary && !next && !urgent\.length/, 'the objective must render last, after every urgent and secondary card');
// Seen live 2026-09-21 on a fresh court: the lead "Next step" card and the
// ambient "Start here" card rendered the same sentence and the same two
// buttons, one above the other, and the empty-state line said it a third time.
a.match(homeSource, /card\.dataset\.lead = 'objective';/, 'the lead card must say when it is already the objective prompt');
a.match(homeSource, /else if \(!leadAsksForObjective\) ambient\.append/, 'the ambient card must not repeat a prompt the lead card is already making');
a.match(homeSource, /if \(ambient\.children\.length > 1\) grid\.append\(ambient\);/, 'an ambient card reduced to its heading must not render at all');
a.match(homeSource, /const urgent = \[/, 'Home must rank approvals, failed members, and blocked tasks into one urgency list');
a.match(homeSource, /approvals\.map\(\(a\) => \(\{[\s\S]*?tone: tone\('blocked'\),/, 'pending approvals must carry the shared attention tone, not render as a plain nav row');
a.match(homeSource, /attention\.map\(\(\[name, member\]\) => \{[\s\S]*?tone: tone\(label\),/, 'failed or rate-limited members must carry their real status tone, not render as a plain nav row');
a.doesNotMatch(homeSource, /button\(item\.text, item\.open, 'list-row'\)/, 'urgent approvals and members must not fall back to an untoned list-row button');
a.match(homeSource, /const cls = `task-row \$\{item\.tone \?\? ''\}`\.trim\(\);/, 'every urgent row must resolve to the shared task-row tone treatment, whether clickable or not');
a.match(homeSource, /h\('button', \{ class: `button \$\{cls\}`,/, 'a clickable urgent row must also carry the shared button class, or it has no hover affordance and no enforced tap target');
a.match(homeSource, /import \{ statusDot \} from '\.\.\/avatar\.js'/, 'Home rows must use the shared status-dot surface, not a bespoke indicator');
a.match(homeSource, /h\('button', \{ class: `button \$\{cls\}`, type: 'button', on: \{ click: item\.open \} \}, dot, h\('span'/, 'an urgent row must lead with the shared status dot now that the left-rule is gone');
a.match(homeSource, /queue\.append\(h\('div', \{ class: `task-row task-\$\{task\.shown\} \$\{tone\(task\.shown\)\}`\.trim\(\) \},\s*dot, h\('b'/, 'a queue row must lead with the shared status dot now that the left-rule is gone');
a.match(homeSource, /nextStepFor\(\{ urgent, changesVisible, changes, goal \}\)/, 'with no active run, Home must lead with the single most urgent next step');
// Every run the daemon creates carries no title, so the heading falls back to
// the objective and the body printed the same sentence again. Seen live
// 2026-09-21 in the run panel at every lifecycle state.
a.match(runSource, /heading === objective \? null : h\('p', \{ class: 'run-objective'/, 'the run panel must not print its objective twice when the heading already is it');
a.match(homeSource, /const shell = page\('Overview', mode\.blurb\)/, 'Home must not repeat mode and repository context in its page heading');
a.match(homeSource, /const attention =/, 'Home must separate terminal member states from active work');
a.match(homeSource, /home-attention/, 'Home must give terminal member states a direct attention surface');
a.match(homeSource, /statusLabel\(currentStatus\(name, member\)\)/, 'Home working rows must use human activity copy');
a.match(viewSources.agents, /displayStatus\(member\)/, 'Agents must share the rail status classifier');
a.match(viewSources.agents, /const dotTone = tone\(stateLabel\)/, 'Agents status dots must use the shared tone vocabulary, not a second literal-state mapping');
a.doesNotMatch(viewSources.agents, /\['awake', 'resting', 'busy', 'failed'\]\.includes/, 'Agents must not keep its own copy of the tone vocabulary');
a.doesNotMatch(viewSources.agents, /classList\.add\('busy'\)/, 'a busy member already gets the live tone class, which now pulses on its own — a second busy class would be dead weight');
a.match(viewSources.doctor, /import \{ statusDot \} from '\.\.\/avatar\.js'/, 'Doctor checks must use the shared status-dot surface, not a bespoke indicator');
a.match(viewSources.doctor, /body\.append\(h\('div', \{ class: `doctor-row \$\{item\.level\} \$\{tone\(item\.level\)\}`\.trim\(\) \}, dot,/, 'a Doctor check row must lead with the shared status dot now that the left-rule is gone');
a.match(homeSource, /working\.slice\(0, 8\)\.forEach\(\(\[name, member\]\) => card\.append\(button\([\s\S]*?open\(\{ page: 'thread', member: name \}\)/, 'Home working rows must open the selected agent thread');
a.equal(visibleQueueRows(Array.from({ length: 8 }, (_, id) => ({ id }))).length, 7, 'Home queue previews seven rows');
a.equal(visibleQueueRows(Array.from({ length: 8 }, (_, id) => ({ id })), true).length, 8, 'Home queue expansion reveals every queued row');
a.equal(taskMeta({ owner: 'coder', blockedBy: [2] }), 'Assigned to coder · Waiting on #2', 'Home queue metadata names both ownership and its blocker');
a.equal(taskMeta({ state: 'planning' }), 'Unassigned · Awaiting plan approval', 'Home queue metadata names a plan gate');
a.match(settingsSource, /editing\(root\)/, 'live Settings updates must not replace a focused control');
a.match(utilSource, /active\.tagName/, 'page bindings need a focused-control guard');
a.match(utilSource, /field-check/, 'checkbox fields must share a compact horizontal layout');
a.match(utilSource, /money\s*\}\s*from '\.\.\/store\.js'/, 'views must use the store money formatter');
a.doesNotMatch(utilSource, /export const money =/, 'views must not fork money formatting');
a.match(utilSource, /encodeURIComponent\(member\)/, 'member-page links must preserve the selected member');
a.match(utilSource, /encodeURIComponent\(conversation\)/, 'member-page links must preserve the selected conversation');
a.match(mainSource, /get\('\/api\/doctor'\)/, 'first-run routing must probe Doctor readiness');
a.match(mainSource, /function openVaultNote\(path\)/, 'vault citations must have a shell-owned note opener');
a.match(mainSource, /post\('switchConversation', \{ name: 'orchestrator', conversationId \}\)\.then\(\(result\) => \{[\s\S]*?result\?\.ok === false[\s\S]*?toast\(/, 'a failed conversation switch must remain visible instead of silently opening the wrong thread');
a.match(mainSource, /const previousView = \{ \.\.\.state\.view \};/, 'conversation switching must remember the route it is replacing');
a.match(mainSource, /state\.view\?\.page === 'thread'[\s\S]*?setView\(previousView\)[\s\S]*?navigate\(previousView\)/, 'a failed active conversation switch must restore the previous thread');
a.match(mainSource, /event\.target\?\.closest\?\.\('\.vault-link'\)/, 'vault citations must be intercepted before the hash changes');
a.match(mainSource, /\/api\/vault\?path=\$\{encodeURIComponent\(notePath\)\}/, 'vault citations must load the selected note by path');
a.match(mainSource, /detail\?\.ok === false/, 'vault citation failures must stay distinct from note content');
a.match(mainSource, /if \(name !== 'notes'\) noteRequest\+\+/, 'leaving Notes must invalidate a slow vault detail request');
// Issue #43: the advisor can flip the court from Chat into Cowork or Code on
// its own reading of one plain message (Kingdom#queueMode, by: 'advisor'),
// which is how a sovereign who typed a single line ends up with delegation,
// a task list and a crew they never asked to start. The stream event carries
// exactly who did it, so the shell must not apply it as silently as a mode
// change the sovereign picked themself.
a.match(mainSource, /event\.type === 'mode' && event\.by && event\.by !== 'sovereign'/,
  'a mode change the sovereign did not choose must be handled differently from one they clicked');
a.match(mainSource, /event\.type === 'mode' && event\.by && event\.by !== 'sovereign'[\s\S]{0,400}toast\(/,
  'an advisor-driven mode switch must raise a visible toast — "just one prompt" silently becoming autonomous delegation is the bug in #43');
a.match(viewSources.memory, /vault-link/, 'Memory note results must open the selected note');
a.match(viewSources.memory, /return \(\) => \{[\s\S]*?requestToken\(state, 'memoryRequest'\)/, 'leaving Memory must invalidate an in-flight search');
a.match(viewSources.activity, /return \(\) => \{[\s\S]*?requestToken\(state, 'activityRequest'\)/, 'leaving Activity must invalidate an in-flight search');
a.match(viewSources.notes, /return \(\) => \{[\s\S]*?requestToken\(state, 'notesRequest'\)/, 'leaving Notes must invalidate an in-flight request');
a.match(indexSource, /<title>Agentic OS<\/title>/, 'the document title must match the product name, Agentic OS');
// The product name leaked as the bare word "AgentOS" into copy text across
// several files, not just the <title> tag — the mode blurbs, the header
// brand, the sidebar brand, the boot-failure heading, and the no-script
// fallback. One guard across every source this file already loads catches
// a future reintroduction anywhere, not just the one spot each fix touched.
for (const [name, src] of Object.entries({ indexSource, mainSource, sidebarSource, homeSource })) {
  a.doesNotMatch(src, /\bAgentOS\b/, `${name} must say "Agentic OS", not the bare "AgentOS"`);
}
a.match(indexSource, /<noscript>/, 'the shell must explain its connection requirement when scripts are disabled');
a.match(indexSource, /JavaScript/, 'the no-script fallback must name the missing capability');
a.doesNotMatch(indexSource, /<section id="view"[^>]*aria-live=/, 'the rerendered view must not announce its entire page on every stream event');
a.match(mainSource, /function focusViewHeading\(root\)/, 'route changes need a page-level focus target');
a.match(mainSource, /function showBootFailure\(error\)/, 'a UI module failure must have a visible recovery state');
a.match(mainSource, /location\.reload\(\)/, 'the UI failure state must offer a direct retry');
a.match(mainSource, /return mount\(viewName\(\)\)/, 'async view mount failures must reach the boot recovery state');
a.match(mainSource, /source\?\.close\(\)/, 'boot failure must stop an already-open event stream');
a.match(mainSource, /clearTimeout\(reconnect\)/, 'boot failure must cancel a pending stream reconnect');
a.match(mainSource, /let bootFailed = false/, 'boot recovery must remember that the stream is terminal');
a.match(mainSource, /if \(bootFailed\) return;/, 'a late stream callback must not restart a failed boot');
a.match(mainSource, /function showViewFailure\(error(?:, sequence[^)]*)?\)/, 'a later route failure must have a local recovery state');
a.match(mainSource, /mountRoute\(viewName\(\)\)/, 'hash-route mount failures must reach local recovery');
a.match(mainSource, /host\.replaceChildren\(shell\);\s*focusViewHeading\(shell\)/, 'route recovery must move focus to its page heading');
a.match(mainSource, /function mountRoute\(name = viewName\(\)\)/, 'route mounts must capture their own failure sequence');
a.match(mainSource, /if \(sequence !== mountSequence\) return;/, 'a stale route failure must not replace the current page');
a.match(mainSource, /heading\.tabIndex = -1/, 'the page title must be programmatically focusable without entering normal tab order');
a.match(mainSource, /heading\.focus\(\{ preventScroll: true \}\)/, 'route focus must not jump the scroll position');
a.match(mainSource, /focusViewHeading\(root\)/, 'mounted routes must move focus to their page title');
a.match(mainSource, /report\?\.ready === false/, 'Doctor must open only when the readiness report is unhealthy');
a.match(mainSource, /if \(tasks\?\.ok !== false\) \{[\s\S]*?apply\(\{ type: 'tasks'/, 'a failed task poll must preserve the last known task list');
a.match(mainSource, /if \(changes\?\.ok !== false\)/, 'a failed change poll must preserve the last known change list');
a.match(mainSource, /state\.changesError = null/, 'a successful background change poll must clear a stale failure');
a.match(mainSource, /data\?\.ok !== false\) apply\(\{ type: 'conversations'/, 'a failed conversation refresh must preserve the roster');
a.match(mainSource, /onRepository: \(\) => \{ state\.settingsSection = 'repo'; navigate\('settings'\); \}/, 'the sidebar repository control must open the repository settings');
a.match(mainSource, /function toast\(message, danger = false\)/, 'shell errors need a visible toast callback');
a.match(mainSource, /toast, refreshLists,\n\s+sovereign/, 'Thread must receive the shell toast callback');
a.match(threadSource, /const body = node\('div', 'message-body markdown'\)/, 'thread Markdown must use the shared message typography');
a.match(threadSource, /const markdown = !entry\.mine && \(entry\.kind === 'text'/, 'untyped assistant messages must remain Markdown instead of being overwritten as plain text');
a.match(mainSource, /encodeURIComponent\(value\.member/, 'thread routes must preserve the selected member');
a.match(mainSource, /encodeURIComponent\(value\.conversation/, 'thread routes must preserve the selected conversation');
a.match(mainSource, /setView\(route\.page === 'thread' && name === 'thread' \? route : name\)/, 'reloading a thread route must restore its identity');
a.match(mainSource, /host\.scrollTop = 0/, 'route changes must start the new page at the top');
a.match(mainSource, /function openMobileNav\(\)/, 'opening mobile navigation must have one focus owner');
a.match(mainSource, /openMobileNav\(\)[\s\S]*?sidebar-mobile-close'\)\?\.focus\(\)/, 'opening the drawer must move focus inside it');
a.match(mainSource, /function closeMobileNav\(\)[\s\S]*?mobile-menu'\)\?\.focus\(\)/, 'closing the drawer must restore focus to its trigger');
a.match(mainSource, /function openMobileNav\(\)[\s\S]*?\$\('main'\)\?\.toggleAttribute\('inert', true\)/, 'opening mobile navigation must hide the covered workspace from assistive technology');
a.match(mainSource, /function closeMobileNav\(\)[\s\S]*?\$\('main'\)\?\.toggleAttribute\('inert', false\)/, 'closing mobile navigation must restore the workspace to assistive technology');
a.match(mainSource, /event\.key === 'Tab'[\s\S]*?sidebar-open/, 'mobile navigation must keep keyboard focus inside the open drawer');
a.match(sidebarSource, /active && root\.contains\(active\)/, 'live Sidebar updates must not replace a rename field');
a.match(sidebarSource, /options\.onConversation\?\.\(active\)/, 'a successful branch must open its new conversation');
a.match(sidebarSource, /form\.querySelector\('input'\)\?\.blur\(\)/, 'saving a rename must close its editor immediately');
a.match(sidebarSource, /event\.key === 'Escape'[\s\S]*?input\.blur\(\)[\s\S]*?render\(\)/, 'conversation rename must have a keyboard cancel path');
a.match(sidebarSource, /let moreOpen = false/, 'More tools must retain its user-controlled disclosure state');
a.match(sidebarSource, /more\.addEventListener\('toggle'/, 'More tools must record disclosure changes');
a.match(sidebarSource, /moreOpen \|\| items\.some/, 'More tools must stay open for its active page without collapsing on live updates');
a.match(sidebarSource, /from '\.\/icons\.js'/, 'navigation should reuse the shipped icon set');
a.match(sidebarSource, /NAV_ICONS/, 'navigation icons must have one explicit view mapping');
a.match(sidebarSource, /button\.dataset\.tip = label/, 'collapsed navigation icons must retain a visible custom hover label');
a.match(sidebarSource, /moreTitle\.dataset\.tip = 'More tools'/, 'collapsed More tools must retain a visible custom hover label');
a.match(sidebarSource, /collapse\.dataset\.tip = collapsed \? 'Expand sidebar' : 'Collapse sidebar'/, 'the collapsed rail control must describe its current action');
a.match(sidebarSource, /import \{ spendText \} from '\.\/views\/util\.js'/, 'Sidebar spend must use the shared money formatter');
a.doesNotMatch(sidebarSource, /data-member|memberOfView|attachHoverTips/, 'Team moved out of the rail — the sidebar must not keep member-click wiring for a list it no longer renders');
a.match(pagesSource, /actionMessage\.textContent = error\?\.message/, 'failed Team actions must leave visible retryable feedback');
a.match(pagesSource, /power\.disabled = false/, 'failed Team actions must re-enable their control');
a.match(pagesSource, /Team request submitted for approval\./, 'successful Team actions must remain visible before SSE catches up');
a.match(pagesSource, /function modelControls[\s\S]*model\.disabled = true/, 'failed agent model changes must lock the control while saving');
a.match(pagesSource, /model\.value = previous/, 'failed agent model changes must restore the prior model');
a.doesNotMatch(pagesSource, /\['__custom__', 'Custom/, 'Agents must not expose an unimplemented custom model option');
a.match(pagesSource, /response\?\.ok === false/, 'failed approval decisions must stay visible instead of disappearing');
a.match(pagesSource, /data\.approvals \?\? state\.approvals \?\? \[\]/, 'approval refresh failures must not replace pending decisions with an empty list');
a.match(pagesSource, /state\.approvalsError/, 'approval load failures must be visible without discarding pending decisions');
a.match(pagesSource, /apiError\(state\.changes/, 'change load failures must not look like an empty worktree');
a.match(changesSource, /state\.changesError/, 'change refresh failures must keep a separate visible error state');
a.match(changesSource, /if \(!state\.changes \|\| state\.changes\?\.ok === false\)/, 'change refresh failures may stop only when no last-known work exists');
a.match(changesSource, /button\('Retry'/, 'change refresh failures must offer a direct retry');
a.match(changesSource, /const refreshChanges = .*options\.refreshLists/, 'Changes must reuse the shell-owned list refresh');
a.doesNotMatch(changesSource, /void get\('\/api\/changes'\)/, 'Changes must not issue a duplicate initial list request');
a.match(changesSource, /button\('Retry', \(\) => diffDetail\(state, root, peasant, file\)/, 'failed file diffs must offer a local retry');
a.doesNotMatch(changesSource, /const body = root\.querySelector\('\.view-page'\);\s*body\?\.replaceChildren\(page/, 'diff loading must not nest a second page shell');
a.match(changesSource, /root\.replaceChildren\(page\('Changes', `\$\{displayName\(peasant\)\} .*reading worktree/, 'diff loading must replace the route root cleanly');
a.doesNotMatch(changesSource, /state\.changes = data;\s*renderChanges\(state, root\);/, 'a failed change refresh must not overwrite the last-known worktree data');
a.match(pagesSource, /state\.changesLoading/, 'Changes must not expose push or merge actions before the worktree load finishes');
a.match(storeSource, /case 'tasks': state\.tasks = d\.tasks \?\? \[\]; state\.tasksLoading = false; state\.tasksError = null/, 'successful task refreshes must clear the prior load error');
a.match(mainSource, /Could not load current work\./, 'task refresh failures must have a stable visible message');
a.match(mainSource, /type: 'tasksLoading'/, 'task refreshes must expose their loading state');
a.match(mainSource, /const tasksRequest = get\('\/api\/tasks'\)\.then/, 'task refreshes must settle independently of changes');
a.match(mainSource, /const changesRequest = get\('\/api\/changes'\)\.then/, 'change refreshes must settle independently of tasks');
a.match(mainSource, /Promise\.all\(\[tasksRequest, changesRequest\]\)/, 'the shared refresh must still await both independent requests');
a.match(mainSource, /let listsRequest = null/, 'the shared list poll must own one in-flight request');
a.match(mainSource, /if \(listsRequest\) return listsRequest/, 'a second list refresh must reuse the in-flight request');
a.match(mainSource, /const listsRefresh = refreshLists\(\)/, 'the first list refresh must start before the view paints');
a.match(mainSource, /await listsRefresh/, 'the mounted view must wait for its already-started list refresh');
a.doesNotMatch(mainSource, /const \[tasks, changes\] = await Promise\.all/, 'task loading must not wait for the changes response');
a.match(storeSource, /tasksLoading: false/, 'the store must own task loading state');
a.match(homeSource, /state\.tasksError/, 'Home must not turn a failed task refresh into an empty workspace');
a.match(homeSource, /state\.tasksLoading/, 'Home must distinguish task loading from an empty workspace');
a.match(homeSource, /Loading current work/, 'Home task loading must be explicit');
a.match(homeSource, /button\('Retry',[\s\S]*?refreshLists/, 'Home task failures must offer a direct retry');
a.match(pagesSource, /apiError\(metrics, 'Could not load usage\.'/, 'usage load failures must not look like zero spend');
a.match(usageSource, /state\.metricsError/, 'usage refresh failures must keep a separate visible error state');
a.match(usageSource, /state\.metrics = data;/, 'a successful usage response must become the displayed metrics');
a.match(usageSource, /if \(loadFailure && !hasMetrics\)/, 'usage refresh failures may stop only when no last-known metrics exist');
a.match(usageSource, /refresh\.textContent = 'Retry'/, 'usage refresh failures must offer a direct retry');
a.doesNotMatch(usageSource, /state\.metrics = data;\s*renderUsage\(state, root\);/, 'a failed usage refresh must not overwrite the last-known totals');
a.match(pagesSource, /state\.metricsLoading/, 'Usage must not present zero totals while metrics are loading');
a.match(usageSource, /class: 'agent-usage-grid'/, 'Usage must present per-agent metrics as wrapping semantic records');
a.match(usageSource, /class: 'agent-usage-details'/, 'per-agent records must preserve term and value relationships');
a.match(usageSource, /refresh\.dataset\.action = 'refresh-metrics'/, 'Usage refresh must keep a stable focus target');
a.match(usageSource, /aria-busy': String\(Boolean\(state\.metricsLoading\)\)/, 'Usage must scope busy state to its dashboard');
a.match(usageSource, /activeRefresh[\s\S]*?focus\(\{ preventScroll: true \}\)/, 'Usage refreshes must restore focus without moving the reader');
a.match(usageSource, /scrollHost\.scrollTop = scrollTop/, 'Usage refreshes must preserve scroll');
a.doesNotMatch(usageSource, /subscribe\(/, 'unrelated store events must not repaint Usage');
a.match(usageSource, /class: 'button link', href: recommendation\.href/, 'recommendations must use links for navigation');
a.match(usageSource, /agentAttention\(members\)/, 'the first Usage viewport must identify the agent needing cost attention');

const populatedMetrics = {
  total: { turns: 4, in: 1_000, fresh: 600, cached: 400, written: 120, out: 80, cacheRate: 40 },
  cost: { fresh: 6, cached: 2, written: 1, output: 1, total: 10, classification: 'reported' },
  auxiliary: { calls: 2, failures: 0, latencyMs: { p50: 50, p95: 90 }, byPurpose: { summary: 2 } },
  mcp: { maskedCalls: 3, maskedChars: 700 },
};
a.deepEqual(metricsView(populatedMetrics).mcp, { maskedCalls: 3, maskedChars: 700 }, 'Usage must retain populated MCP savings');
a.equal(metricsView({ total: { in: 0, cached: 0, cacheRate: 0 }, spent: 0 }).cacheRate, 0, 'zero usage must remain a real zero');
a.equal(metricsView({ total: { cacheRate: .4, cost: { total: 2, classification: 'cli-reported' } } }).cacheRate, 40, 'ratio-shaped cache rates must render as percentages');
a.equal(metricsView({ total: { cost: { total: 2, classification: 'cli-reported' } } }).cost.classification, 'reported', 'the live backend reported-cost name must retain provider provenance');
a.equal(metricsView({ total: {} }).cacheRate, null, 'missing cache data must remain unavailable');
a.equal(metricsView({ total: {}, auxiliary: null }).auxiliary, null, 'missing auxiliary data must remain unavailable');
a.equal(metricsView({ total: { in: 100, cached: 20 }, spent: 1 }).cost.classification, 'estimated', 'legacy spend must not masquerade as provider-reported');
a.equal(recommendationFor(populatedMetrics)?.condition, 'Fresh-input cost is the largest classified cost.', 'fresh-cost dominance must produce one cold-prompt recommendation');
a.equal(recommendationFor({ ...populatedMetrics, cost: { ...populatedMetrics.cost, classification: 'unpriced' }, auxiliary: { calls: 99, failures: 99 } })?.condition,
  'Some usage is unpriced.', 'unpriced usage must take precedence over secondary efficiency advice');
a.equal(recommendationFor({ ...populatedMetrics, cost: { ...populatedMetrics.cost, classification: 'mixed' }, members: [{ costClassification: 'unpriced' }] })?.condition,
  'Some usage is unpriced.', 'a mixed total must still expose an unpriced member');
a.match(recommendationFor({ total: { turns: 1 }, cost: { total: 1, fresh: .1, cached: .1, written: .1, output: .1, classification: 'reported' }, auxiliary: { calls: 4, failures: 2 } })?.condition ?? '',
  /auxiliary failures/, 'repeated auxiliary failures must take precedence over cost-shape advice');
a.equal(recommendationFor({ total: { turns: 1 }, cost: { total: 1, fresh: .25, cached: .25, written: .25, output: .25, classification: 'reported' } }), null,
  'weak evidence must not manufacture a recommendation');
a.match(warningFor({ total: { fresh: 2_000, cached: 10, cacheRate: .005 }, cost: { classification: 'reported' } })?.text ?? '', /Cache reuse is 1%/, 'Overview must surface a measured cache collapse');

const fetchBeforeMetricsCheck = globalThis.fetch;
try {
  const responses = [];
  globalThis.fetch = () => new Promise((resolve) => responses.push(resolve));
  const metricState = {};
  const first = loadMetrics(metricState);
  const second = loadMetrics(metricState, null, true);
  responses[1](new Response(JSON.stringify({ ok: true, total: { turns: 2 } }), { status: 200 }));
  await second;
  responses[0](new Response(JSON.stringify({ ok: true, total: { turns: 1 } }), { status: 200 }));
  await first;
  a.equal(metricState.metrics.total.turns, 2, 'an older refresh must not overwrite the newer response');
  const leavingState = {};
  const leaving = loadMetrics(leavingState);
  cancelMetrics(leavingState);
  responses[2](new Response(JSON.stringify({ ok: true, total: { turns: 9 } }), { status: 200 }));
  await leaving;
  a.equal(leavingState.metrics, undefined, 'a response settling after navigation must not mutate visible metrics');
  const lastGood = { ok: true, total: { turns: 6 } };
  const failureState = { metrics: lastGood };
  const failed = loadMetrics(failureState);
  a.equal(failureState.metrics, lastGood, 'refresh loading must preserve the last valid metrics');
  responses[3](new Response(JSON.stringify({ ok: false, error: 'temporary failure' }), { status: 503 }));
  await failed;
  a.equal(failureState.metrics, lastGood, 'a failed refresh must preserve the last valid metrics');
  a.equal(failureState.metricsError, 'temporary failure', 'a failed refresh must retain a retryable error');
  const retried = loadMetrics(failureState, null, true);
  responses[4](new Response(JSON.stringify({ ok: true, total: { turns: 7 } }), { status: 200 }));
  await retried;
  a.equal(failureState.metrics.total.turns, 7, 'a successful retry must replace stale metrics');
} finally {
  globalThis.fetch = fetchBeforeMetricsCheck;
}
a.match(pagesSource, /apiError\(data, 'Could not load activity\.'/, 'activity load failures must be visible');
a.match(viewSources.activity, /search\.setAttribute\('aria-label', 'Search activity'\)/, 'Activity search must have an explicit accessible name');
a.match(viewSources.activity, /filters\.setAttribute\('aria-label', 'Filter activity'\)/, 'Activity filter must have an explicit accessible name');
a.match(viewSources.activity, /const searchButton = button\(/, 'Activity search needs a named submit control for progress feedback');
a.match(viewSources.activity, /searchButton\.disabled = true/, 'Activity search must lock its submit control while loading');
a.match(viewSources.activity, /searchButton\.textContent = 'Searching/, 'Activity search must say when it is running');
a.match(viewSources.activity, /state\.activityError/, 'Activity refresh failures must keep a separate visible error state');
a.match(viewSources.activity, /button\('Retry'/, 'Activity refresh failures must offer a direct retry');
a.match(viewSources.activity, /const activityRows = Array\.isArray\(data\.rows\) \? data\.rows : \[\]/, 'Activity must ignore malformed non-array timeline payloads');
a.match(viewSources.activity, /if \(!state\.activity \|\| state\.activity\?\.ok === false\)/, 'Activity refresh failures may stop only when no last-known timeline exists');
a.match(pagesSource, /state\.activityLoading/, 'Activity must distinguish loading from an empty timeline');
a.match(viewSources.memory, /search\.setAttribute\('aria-label', 'Search memory'\)/, 'Memory search must have an explicit accessible name');
a.match(viewSources.memory, /const searchButton = button\(/, 'Memory search needs a named submit control for progress feedback');
a.match(viewSources.memory, /searchButton\.disabled = Boolean\(state\.memoryLoading\)/, 'Memory search must lock its submit control while loading');
a.match(viewSources.memory, /searchButton\.textContent = 'Searching/, 'Memory search must say when it is running');
a.match(viewSources.memory, /state\.memoryLoading/, 'Memory search loading must survive live store rerenders');
a.match(viewSources.memory, /state\.memoryError/, 'Memory search failures must keep a separate visible error state');
a.match(viewSources.memory, /button\('Retry'/, 'Memory search failures must offer a direct retry');
a.doesNotMatch(viewSources.memory, /const \[recall, vault\] = await Promise\.all/, 'Memory must not hide history behind a slower notes search');
a.match(viewSources.memory, /state\.memory = \{ \.\.\.\(state\.memory \?\? \{\}\), \[key\]: result \}/, 'Memory must retain each search result as it arrives');
a.match(viewSources.notes, /search\.setAttribute\('aria-label', 'Search notes'\)/, 'Notes search must have an explicit accessible name');
a.match(viewSources.notes, /const refreshButton = button\(/, 'Notes refresh needs a named control for progress feedback');
a.match(viewSources.notes, /refreshButton\.disabled = true/, 'Notes refresh must lock its control while loading');
a.match(viewSources.notes, /refreshButton\.textContent = 'Loading/, 'Notes refresh must say when it is running');
a.match(viewSources.notes, /async function loadDetail/, 'Notes must own one retryable detail-loading path');
a.match(viewSources.notes, /button\('Retry'/, 'Note detail failures must offer a direct retry');
a.match(viewSources.notes, /const loadFailure = state\.notesError \?\? apiError\(data, 'Could not load notes\.'\)/, 'Notes list failures must have durable error state');
a.match(viewSources.notes, /button\('Retry', list, 'primary'\)/, 'Notes list failures must offer a direct retry');
a.match(viewSources.notes, /if \(!state\.notesError\) state\.notes = result;/, 'a failed Notes refresh must preserve the last-known result');
a.match(storeSource, /notesError: null/, 'the store must reset the Notes list error state');
a.match(pagesSource, /apiError\(data\.vault, 'Could not search notes\.'/, 'notes search failures must be visible');
a.match(pagesSource, /state\.notesLoading/, 'Notes must distinguish loading from an empty vault');
a.match(pagesSource, /renderMessages[\s\S]*state\.ready === false[\s\S]*Loading messages…/, 'Messages must distinguish loading from an empty bus');
a.match(pagesSource, /state\.notesDetail/, 'an open note must survive live store rerenders');
a.match(pagesSource, /Loading note…/, 'opening a note must show its own loading state');
a.match(pagesSource, /requestToken =/, 'search views must have a shared stale-response token');
a.match(pagesSource, /state\.activityRequest !== token/, 'older activity results must not overwrite newer searches');
a.match(pagesSource, /state\.memoryRequest !== token/, 'older memory results must not overwrite newer searches');
a.match(pagesSource, /state\.notesRequest !== token/, 'older note results must not overwrite newer searches');
a.match(pagesSource, /state\.diffRequest !== token/, 'older diff results must not overwrite newer file selections');
a.match(pagesSource, /root\.isConnected === false/, 'async page mounts must not paint detached views');
a.match(changesSource, /get\(`\/api\/diff[\s\S]*?\.catch\(\(error\)/, 'a rejected diff request must render a retry instead of leaving an unhandled rejection');
a.match(pagesSource, /state\.approvalsLoading/, 'Approvals must distinguish loading from no pending decisions');
a.match(approvalsSource, /button\('Retry'/, 'Approval load failures must offer a direct retry');
a.ok(pagesSource.indexOf('if (state.approvalsLoading)') < pagesSource.indexOf('if (state.approvalsError)'), 'a retry must show its loading state before an old approval error');
a.ok(pagesSource.indexOf('if (state.changesLoading)') < pagesSource.indexOf('const loadFailure = state.changesError ?? apiError'), 'a retry must show its loading state before an old changes error');
a.ok(pagesSource.indexOf('if (state.metricsLoading && !hasMetrics)') < pagesSource.indexOf('const loadFailure = state.metricsError ?? apiError(metrics'), 'a retry must show its loading state before an old usage error');
a.ok(pagesSource.indexOf('if (state.activityLoading)') < pagesSource.indexOf('const loadFailure = state.activityError ?? apiError(data'), 'a retry must show its loading state before an old activity error');
a.ok(pagesSource.indexOf('if (state.notesLoading)') < pagesSource.indexOf("const loadFailure = state.notesError ?? apiError(data, 'Could not load notes.'"), 'a retry must show its loading state before an old notes error');
a.ok(automationsSource.indexOf('if (state.workflowsLoading)') < automationsSource.indexOf('state.workflows?.ok === false'), 'a retry must show its loading state before an old automation error');
a.match(pagesSource, /button\(state\.doctorLoading \? 'Checking/, 'Doctor must show an in-progress state');
a.match(viewSources.doctor, /section\('Readiness'/, 'Doctor checks must share the bounded view-section surface');
a.match(viewSources.doctor, /state\.doctorRequest !== token/, 'stale Doctor responses must not repaint a newer visit');
a.match(viewSources.approvals, /state\.approvalsRequest !== token/, 'stale approval responses must not repaint a newer visit');
a.match(viewSources.changes, /state\.changesRequest !== token/, 'stale change responses must not repaint a newer visit');
a.match(viewSources.usage, /state\.metricsRequest !== token/, 'stale usage responses must not repaint a newer visit');
a.match(pagesSource, /state\.doctorLoading/, 'Doctor must distinguish loading from a stale report');
a.match(pagesSource, /run\.disabled = Boolean\(state\.doctorLoading\)/, 'Doctor must lock its control while running');
a.match(pagesSource, /if \(state\.doctorLoading\)/, 'Doctor must render an explicit loading state');
a.match(storeSource, /doctorLoading: false/, 'the store must reset the Doctor loading state');
a.match(pagesSource, /clearTimeout\(state\.notesTimer\)/, 'Notes debounce must be cancellable on unmount');
a.match(pagesSource, /state\.notesTimer = null/, 'Notes debounce must not survive view cleanup');
a.match(pagesSource, /Enter an objective first\./, 'objective saves must reject empty input visibly');
a.match(pagesSource, /Could not save the objective\./, 'objective save failures must be retryable');
a.match(pagesSource, /Could not update that milestone\./, 'milestone failures must restore the checkbox');
a.match(viewSources.objective, /else milestones\.push\(\{ text: value, done: false \}\)/, 'successful milestone adds must stay in the local payload until the next snapshot');
a.match(settingsSource, /Assets\.onAssets\(redraw\)/, 'Settings must repaint after an asset changes');
a.match(settingsSource, /Assets\.onMusic\(redraw\)/, 'Settings must repaint transport state after music changes');
a.match(settingsSource, /root\.isConnected === false/, 'stale Settings loads must not attach listeners to detached views');
a.match(settingsSource, /async function uploadAssets/, 'Settings uploads must share one feedback path');
a.match(settingsSource, /result\?\.ok === false/, 'failed Settings uploads must be visible');
a.match(settingsSource, /assetUploads/, 'Settings uploads must stay disabled while files are being sent');
a.match(settingsSource, /Confirm delete/, 'asset deletion must require a deliberate second click');
a.match(settingsSource, /async function removeAsset/, 'asset deletion failures must remain visible and retryable');
a.match(settingsSource, /await Notify\.request\(\)/, 'notification permission changes must refresh Settings');
a.match(settingsSource, /unsupported.*Not supported here/, 'unsupported notification environments must say why toggles are unavailable');
a.match(settingsSource, /function settingWrite/, 'settings writes share retryable feedback');
a.match(settingsSource, /showSettingFeedback\(state, feedback, 'Saved\.'\)/, 'successful Settings writes must confirm the change');
a.match(settingsSource, /showSettingFeedback\(state, feedback, 'Saving/, 'Settings writes must expose a stable in-flow pending state');
a.match(settingsSource, /feedback\.setAttribute\('aria-live', 'polite'\)/, 'Settings save feedback must use a scoped live region');
a.match(settingsSource, /keepFocus[\s\S]*?focus\(\{ preventScroll: true \}\)/, 'Settings writes must restore the initiating control without moving the reader');
a.match(settingsSource, /if \(next\.every\(\(value, index\) => value === relevant\[index\]\)\) return;/, 'unrelated store events must not repaint Settings');
a.match(settingsSource, /group\('Automatic routing'/, 'Settings must group automatic routing by job');
a.match(settingsSource, /group\('Prompt rewriting'/, 'Settings must group prompt rewriting by job');
a.match(settingsSource, /group\('Per-turn summaries'/, 'Settings must group per-turn summaries by job');
a.match(settingsSource, /group\('Model and effort'/, 'Settings must group model and effort by job');
a.match(settingsSource, /field\('Advisor model'[^]*?field\('Summary effort'/, 'consolidated model controls must keep distinct visible and accessible names');
a.match(settingsSource, /does not restart a court member session/, 'Settings must explain session restart consequences');
a.match(settingsSource, /function rangeField/, 'range settings must expose their current value');
a.match(settingsSource, /rangeField\('Dim'/, 'wallpaper dim must show its current value');
a.match(settingsSource, /rangeField\('Blur'/, 'wallpaper blur must show its current value');
a.match(settingsSource, /rangeField\('Volume'/, 'music volume must show its current value');
a.match(settingsSource, /if \(state\.assetUploads\?\.\[kind\]\) return;/, 'asset uploads must ignore duplicate clicks while the picker is open');
const uploadStart = settingsSource.indexOf('async function uploadAssets');
const uploadPick = settingsSource.indexOf('await Assets.pick', uploadStart);
const uploadLock = settingsSource.indexOf('control.disabled = true', uploadStart);
a.ok(uploadLock >= uploadStart && uploadLock < uploadPick, 'asset upload controls must lock before awaiting the picker');
a.match(settingsSource, /catch \{[\s\S]*?Could not open the file picker\./, 'picker failures must restore the upload control with visible feedback');
a.match(settingsSource, /if \(!files\.length\) \{[\s\S]*?state\.assetUploads = \{ \.\.\.state\.assetUploads, \[kind\]: false \}/, 'cancelling the picker must clear its pending upload state');
a.match(settingsSource, /Could not save that setting\./, 'settings write failures are visible');
a.match(settingsSource, /loadDependencies\(\)\.then\([\s\S]*?\.catch\(/, 'failed Settings module loads must leave the loading state');
a.match(settingsSource, /Settings could not load/, 'failed Settings module loads must explain the recovery state');
a.match(settingsSource, /location\.reload\(\)/, 'failed Settings module loads must offer a direct retry');
a.match(settingsSource, /function efficiency[\s\S]*settingWrite\(state, feedback/, 'efficiency writes use the retryable settings path');
a.doesNotMatch(settingsSource, /\['__auto__', 'Advisor chooses'\]/, 'summaries must not expose a no-op auto model option');
a.match(assetsSource, /if \(!response\.ok \|\| result\?\.ok === false\) return assets/, 'failed asset refreshes must preserve the known list');
a.match(assetsSource, /response\.ok \? body : \{ \.\.\.body, ok: false/, 'HTTP upload failures must not masquerade as successful asset responses');
a.match(assetsSource, /if \(result\?\.ok === false\) return result/, 'failed asset deletes must remain retryable');
a.match(assetsSource, /return \(\) => \{ if \(onChange === fn\)/, 'asset listeners must be removable when Settings unmounts');
a.match(assetsSource, /function syncQueue/, 'the music queue must follow the refreshed audio asset list');
a.match(assetsSource, /globalThis\.addEventListener\?\.\('focus'/, 'a dismissed file picker must have a focus-return cancellation path');
a.match(assetsSource, /const finish = \(files = \[\]\)/, 'file-picker completion must be idempotent');
a.match(sidebarSource, /sameId\(id, active\)/, 'Sidebar selection must tolerate numeric and DOM-string conversation IDs');
a.match(sidebarSource, /Loading conversations…/, 'Sidebar must distinguish a loading roster from an empty one');
a.match(sidebarSource, /if \(sameId\(currentState\.view\?\.conversation \?\? currentState\.view\?\.conversationId, id\)\)/, 'archiving the open conversation must leave its transcript');
a.match(sidebarSource, /options\.onConversation\?\.\(conversationId\(next\)\)/, 'archiving the open conversation must open the next available thread');
a.match(sidebarSource, /options\.navigate\?\.\('home'\)/, 'archiving the last conversation must return to Overview');
a.match(threadSource, /sameId\(id, conversationId\)/, 'Thread transcript filtering must tolerate mixed conversation ID types');
a.match(threadSource, /card\?\.querySelectorAll\('button'\)/, 'Thread decisions must lock their controls while submitting');
a.match(threadSource, /const submittedApprovals = new Map/, 'inline approval success must survive store rerenders');
a.match(threadSource, /submittedApprovals\.get/, 'rerendered approval cards must retain their submitted state');
a.match(threadSource, /Approved\.|Rejected\./, 'successful inline decisions must remain visible before SSE catches up');
a.match(threadSource, /Answer submitted\./, 'successful inline answers must remain visible before SSE catches up');
a.match(threadSource, /remove\.setAttribute\('aria-label', `Remove \$\{file\.name\}`\)/, 'attachment removal must have a descriptive accessible name');
a.match(threadSource, /select\.disabled = true/, 'model controls must lock while saving');
a.match(threadSource, /model\.setAttribute\('aria-label', 'Model'\)/, 'thread model control must have an accessible name');
a.match(threadSource, /effort\.setAttribute\('aria-label', 'Reasoning effort'\)/, 'thread effort control must have an accessible name');
a.match(threadSource, /Rest requested|Wake requested/, 'successful wake and sleep actions must remain visible before SSE catches up');
a.match(threadSource, /previousMessages\.scrollHeight - previousMessages\.scrollTop/, 'live thread updates must not steal the reader\'s scroll position');
// Deliberately not anchored to a variable name: the empty-state branch moved
// from render()'s closure into threadMessages(state, ...) and this assertion
// failed on the rename alone, while the behaviour it guards was untouched.
a.match(threadSource, /\.ready === false[\s\S]*Loading conversation/, 'Thread must distinguish the first snapshot from an empty transcript');
a.match(threadSource, /message-meta/, 'Thread messages must identify their sender and time');
a.match(threadSource, /thread-control-label/, 'Thread model controls must have visible labels');
a.match(threadSource, /approval-card pending/, 'Inline decisions must retain a pending visual state');
a.match(threadSource, /button\.setAttribute\('aria-pressed', String\(selected\.has\(option\.label\)\)\)/, 'inline question choices must expose their selected state');
a.match(threadSource, /target\.setAttribute\('aria-pressed', String\(selected\.has\(target\.dataset\.option\)\)\)/, 'inline question choice changes must update their accessible state');
a.match(threadSource, /other\.setAttribute\('aria-label', `Other answer for/, 'custom question answers must have a descriptive accessible name');
a.match(threadSource, /date\(entry\.ts\)/, 'Thread message metadata must use the shared date formatter');
a.match(threadSource, /attachment-name/, 'Attachment chips must separate the filename from their remove action');
a.match(threadSource, /event\.key === 'Enter' && !event\.shiftKey/, 'the composer must send on Enter while preserving Shift+Enter for a newline');
const sendBody = threadSource.match(/async function sendMessage\(form\) \{[\s\S]*?\n  \}\n\n  async function updateModel/)?.[0] ?? '';
a.match(threadSource, /Could not attach \$\{file\.name\}/, 'dropped-file failures must be visible');
a.match(threadSource, /let uploading = false/, 'attachment uploads must have a durable pending state');
a.match(threadSource, /attach\.disabled = sending \|\| uploading/, 'attachment uploads must lock the attach control');
a.match(threadSource, /const ready = currentState\.ready !== false/, 'Thread controls must distinguish the first snapshot from a ready workspace');
a.match(threadSource, /if \(sending \|\| uploading \|\| currentState\.ready === false\) return;/, 'Thread must refuse actions before the first workspace snapshot');
a.match(threadSource, /sendButton\.disabled = sending \|\| uploading \|\| !ready/, 'sending must stay disabled until the workspace is ready');
a.match(threadSource, /attach\.textContent = uploading \? 'Uploading/, 'attachment uploads must name their pending state');
a.match(threadSource, /String\(sending \|\| uploading\)/, 'the thread must expose attachment progress as busy state');
a.match(threadSource, /sendButton\.disabled = sending \|\| uploading/, 'sending must be locked while an attachment is pending');
a.match(sendBody, /if \(sending \|\| uploading \|\| currentState\.ready === false\) return;/, 'send must reject concurrent uploads and an unready workspace');
a.match(sendBody, /attachments: files/, 'sending must persist structured attachment metadata with the assignment');
a.match(threadSource, /finally \{\s*uploading = false;\s*if \(mounted\) render\(\);\s*\}/, 'attachment failures must restore a live composer without repainting an unmounted thread');
const attachBody = threadSource.match(/async function attach\(\) \{[\s\S]*?\n  \}\n\n  async function sendMessage/)?.[0] ?? '';
const dropBody = threadSource.match(/async function onDrop\(event\) \{[\s\S]*?\n  \}\n\n  for \(const host/)?.[0] ?? '';
a.match(threadSource, /async function withUploadState\(work\)/, 'all attachment sources must share one upload guard');
a.match(attachBody, /withUploadState\(/, 'picker attachments must use the shared upload guard');
a.match(dropBody, /withUploadState\(/, 'dropped attachments must use the shared upload guard');
a.match(threadSource, /function onDragLeave\(event\)/, 'leaving a drop zone must clear its visual state');
a.match(threadSource, /relatedTarget/, 'drop-zone cleanup must tolerate movement between child elements');
a.match(threadSource, /addEventListener\('dragleave', onDragLeave\)/, 'drop-zone cleanup must be mounted');
a.match(threadSource, /removeEventListener\('dragleave', onDragLeave\)/, 'drop-zone cleanup must be unmounted');
a.match(threadSource, /fillModel\(select, currentState, member\)/, 'failed model changes must restore the known model');
a.match(threadSource, /target\.disabled = false/, 'failed wake or sleep actions must be retryable');
a.match(approvalsSource, /displayName\(approval\.from/, 'approval metadata must use the shared display-name layer');
a.match(approvalsSource, /data-question-other/, 'approval-page questions must support a custom answer');
a.match(approvalsSource, /Answer every question before submitting\./, 'approval-page questions must reject incomplete answers');
a.match(approvalsSource, /Other answer for/, 'approval-page custom answers must have a descriptive accessible name');

// A resolved approval is the sixth domain that reads as "how did this go", and
// it was the last one still naming its own colours. The label map may stay
// local (statusLabel() is the same shape for members); the tone may not.
// #6: a merge or push that was approved but did not land must say why on its
// resolved card, not just "Blocked".
a.equal(resolvedOutcome({ kind: 'merge', resolved: 'blocked', merge: { status: 'blocked', message: 'master has uncommitted changes' } }),
  ': master has uncommitted changes', 'a blocked merge card must carry the recorded failure message');
a.equal(resolvedOutcome({ kind: 'push', resolved: 'blocked', push: { status: 'blocked', message: 'no remote configured' } }),
  ': no remote configured', 'a blocked push card must carry the recorded failure message');
a.equal(resolvedOutcome({ kind: 'merge', resolved: 'approved' }), '', 'a merge with no outcome record adds nothing');
a.equal(resolvedOutcome({ kind: 'summon', resolved: 'approved', summon: { message: 'x' } }), '', 'only push and merge carry an outcome record');
a.match(approvalsSource, /resolvedStatus\(approval\.resolved, resolvedOutcome\(approval\)\)/,
  'the resolved card must render the outcome through resolvedOutcome()');
a.match(approvalsSource, /const resolvedStatus = \(resolved/, 'resolved approvals must render through one shared status helper, not a bare note');
a.match(approvalsSource, /const shared = tone\(resolved\)/, 'a resolved approval must take its tone from the shared classifier');
a.doesNotMatch(approvalsSource, /note\(`\$\{approvalStatus|note\(approvalStatus/, 'a resolved approval must not fall back to an untoned note');
a.match(utilSource, /'approved', 'answered'\]\)/, 'the shared classifier must settle an approved request and an answered question');
a.match(utilSource, /'fail', 'rejected'\]\)/, 'a rejected request must read as attention, the branch that stops work');
a.match(threadSource, /From \$\{displayName\(approval\.from\)\}/, 'inline approval metadata must use the shared display-name layer');
a.doesNotMatch(visibleCopySource, /local court|court[’']s history|source material the court|Checking the court|sovereign[’']s durable vault|The sovereign requested|list_uploads|Search what the court/, 'visible UI copy must use the team vocabulary');
a.doesNotMatch(graphSource, /Post a message to the court/, 'workflow descriptions must use the team vocabulary');
a.match(graphSource, /x\.setAttribute\('aria-label', `Delete node \$\{n\.id\}`\)/, 'workflow node deletion must have a descriptive accessible name');
a.match(graphSource, /if \(e\.target\.closest\?\.\('\.wfn-x'\)\) return/, 'deleting a workflow node must not begin a drag');
a.match(graphSource, /el\('button', 'wfport in'\)/, 'workflow input ports must be native keyboard controls');
a.match(graphSource, /keyboardWire/, 'workflow wiring must retain a keyboard connection state');
a.match(graphSource, /function onPortKeydown\(event\)/, 'workflow ports must support keyboard wiring');
a.match(graphSource, /function focusPort\(id, branch\)/, 'keyboard wiring must restore focus after repaint');
a.match(graphSource, /focusPort\(id, branch\)/, 'keyboard wiring must return focus to the selected port');
a.match(graphSource, /addEventListener\('keydown', onPortKeydown\)/, 'keyboard graph wiring must be mounted');
a.doesNotMatch(petSource, /HappyDog .*court|Court pet/, 'desk-pet labels must use the team vocabulary');

globalThis.Audio ??= class {
  constructor() { this.paused = true; this.duration = 0; this.currentTime = 0; }
  addEventListener() {}
  play() { return Promise.resolve(); }
  pause() {}
  removeAttribute() {}
  load() {}
};
const assets = await import('../ui/assets.js');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'too large' }) });
const failedUpload = await assets.upload({ name: 'too-large.png', type: 'image/png' });
globalThis.fetch = realFetch;
a.equal(failedUpload.ok, false, 'an HTTP upload failure must remain a failed result for Settings');

globalThis.fetch = async () => ({ ok: true, json: async () => ({ assets: [{ kind: 'audio', name: 'after-reload.mp3' }] }) });
await assets.refresh();
globalThis.fetch = realFetch;
a.deepEqual(assets.state().queue, ['after-reload.mp3'], 'refresh must seed the music queue for the Play control');

// #45: "it just says Opus Sonnet, not the model number at all" — every model
// selector rendered the raw config value verbatim, so a member configured
// with a short alias ("opus") or an older full id showed with no version.
{
  a.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5', 'the current Opus must show its version number');
  a.equal(modelLabel('claude-opus-5'), 'Opus 5', 'the previous Opus must still be distinguishable from the current one');
  a.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  a.equal(modelLabel('claude-haiku-4-5'), 'Haiku 4.5');
  a.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5', 'a dated id must resolve to the same readable name as its bare id');
  a.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  // The CLI's own short aliases (still valid, still accepted by agent.js)
  // must also gain a version number rather than showing as a bare family
  // name — this is the exact defect: an existing config using "opus" for a
  // member showed literally "opus" with no number anywhere.
  a.equal(modelLabel('opus'), 'Opus 5.5', 'the opus alias must show the version the CLI resolves it to (Opus 5.5), not just the family name');
  a.equal(modelLabel('sonnet'), 'Sonnet 5');
  a.equal(modelLabel('haiku'), 'Haiku 4.5');
  a.equal(modelLabel('fable'), 'Fable 5.1');
  // An id this table does not know must degrade to showing the raw id, not
  // to hiding the model or throwing — a model must never disappear from a
  // selector just because it is unrecognised (a codex/agy/opencode id, or a
  // future claude id this table has not caught up to yet).
  a.equal(modelLabel('gpt-5.6-sol'), 'gpt-5.6-sol', 'an unmapped id must fall back to itself, not vanish');
  a.equal(modelLabel(''), '', 'an empty model must not become a truthy label');
  a.equal(modelLabel(null), null, 'a null model (an unset field) must pass through unchanged');

  for (const [name, source] of [['agents', viewSources.agents], ['settings', settingsSource], ['thread', threadSource]]) {
    a.match(source, /modelLabel\(/, `${name}'s model selector must render through modelLabel(), not the raw config id`);
  }
  console.log('  every model selector shows a readable, versioned name — a bare alias never renders unlabeled');
}

console.log('t-pages.js OK — changes expose review, request, success, and failure stages');
