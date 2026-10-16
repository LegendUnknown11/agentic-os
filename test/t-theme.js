// The new shell is intentionally one flat material. This test keeps palette
// changes cheap: colours belong in :root and selectors consume variables.
import { strict as a } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dirname, '..', 'ui', 'app.css'), 'utf8');
const index = readFileSync(join(import.meta.dirname, '..', 'ui', 'index.html'), 'utf8');
const main = readFileSync(join(import.meta.dirname, '..', 'ui', 'main.js'), 'utf8');
const sidebar = readFileSync(join(import.meta.dirname, '..', 'ui', 'sidebar.js'), 'utf8');
const util = readFileSync(join(import.meta.dirname, '..', 'ui', 'views', 'util.js'), 'utf8');
const thread = readFileSync(join(import.meta.dirname, '..', 'ui', 'thread.js'), 'utf8');
const avatar = readFileSync(join(import.meta.dirname, '..', 'ui', 'avatar.js'), 'utf8');
const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root\s*\{[\s\S]*?\n\}/, '');

const token = (name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root)?.[1].trim();
// The neutral workspace replaces the former paper/teal direction (2026-10-16).
a.equal(token('color-scheme'), 'dark');
const palette = {
  '--bg': '#18181b', '--surface': '#202023', '--raised': '#27272b',
  '--text': '#e5e5eb', '--muted': '#a6a6b0', '--faint': '#a6a6b0',
  '--line': '#3a3a40', '--accent': '#dedee7', '--accent-hover': '#ffffff',
  '--accent-ink': '#18181b', '--tone-live': '#8db9f5',
  '--tone-settled': '#8ecaaa', '--tone-attention': '#f0a49b',
  '--tone-idle': '#a6a6b0', '--gold': '#d9bd82',
};
for (const [name, value] of Object.entries(palette)) {
  a.equal(token(name), value, name);
  a.equal(token(name + '-rgb'), value.slice(1).match(/../g).map((v) => parseInt(v, 16)).join(' '), name + ' channel twin');
}
const luminance = (hex) => hex.slice(1).match(/../g).map((v) => {
  const n = parseInt(v, 16) / 255;
  return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
}).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
const contrast = (fg, bg) => {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
for (const foreground of ['--text', '--muted', '--faint', '--accent', '--tone-live', '--tone-settled', '--tone-attention', '--tone-idle', '--gold']) {
  for (const background of ['--bg', '--surface', '--raised']) {
    a.ok(contrast(token(foreground), token(background)) >= 4.5, foreground + ' on ' + background + ' must clear AA');
  }
}
a.ok(contrast(token('--accent-ink'), token('--accent')) >= 4.5, 'primary button text must clear AA');
a.equal(token('--danger'), 'var(--tone-attention)');
a.equal(token('--danger-rgb'), 'var(--tone-attention-rgb)');
a.equal(token('--ok'), 'var(--tone-settled)');
a.equal(token('--ok-rgb'), 'var(--tone-settled-rgb)');
a.equal(token('--radius-ctl'), '6px');
a.equal(token('--radius-card'), '10px');
a.equal(token('--radius-pill'), '999px');
a.equal(token('--tap-target-min'), '44px');
a.equal(token('--fast'), '150ms');
a.equal(token('--grain'), 'none');
a.match(css, /--display:.*"Segoe UI", sans-serif/, 'headings share the local product sans');
a.match(index, /<meta name="color-scheme" content="dark">/);
a.doesNotMatch(index, /<script>(?!\s*<\/script>)/, 'the shell obeys the daemon script CSP');
a.doesNotMatch(css, /@import|fonts\.googleapis/, 'offline UI must not fetch fonts');
a.match(css, /body \{[^}]*background:\s*var\(--wash\), var\(--bg\);/, 'optional wash stays tokenised');
a.match(css, /\.task-manage-controls select \{ height: var\(--tap-target-min\)/);
a.match(css, /\.run-spend-line\s*\{[^}]*stroke:\s*var\(--accent\)/, 'the run spend line wears the accent, the one series colour');
a.match(css, /\.run-spend-cap\s*\{[^}]*stroke:\s*var\(--tone-attention\)[^}]*stroke-dasharray/, 'the run ceiling is a dashed attention line');
a.match(css, /\.run-spend-line\s*\{[^}]*vector-effect:\s*non-scaling-stroke/, 'a stretched chart must not stretch its 2px line');
a.match(css, /\.mode-switcher\s*\{[^}]*border-radius:\s*var\(--radius-pill\)/, 'work modes must read as one segmented control');
a.match(css, /\.mode-option\.selected\s*\{[^}]*background:\s*var\(--accent\)/, 'the active work mode needs one clear accent state');
// 2026-09-23: reverses the line above. Read against a populated demo court,
// "AGENTIC OS / WORKSPACE" repeated identically on all 14 views carried no
// information and cost real space above the fold of a dense tool. A prior
// session already removed it once for the same reason and it came back —
// so this is now a ban, not a requirement, to stop a well-meaning future
// edit from "restoring" it a second time.
a.doesNotMatch(css, /content:\s*"AGENTIC OS \/ WORKSPACE"/, 'the page eyebrow carried no information and must not be reintroduced');
// The heading itself was the kit's MARKETING scale (`clamp(32px, 5vw, 48px)`,
// a display face) although PLAN.md section 1 requires the PRODUCT scale
// throughout — a 48px page title over 16px cards was that rule skipped for
// the one heading every view shares. Pinned at the smaller scale so it does
// not drift back up either.
a.match(css, /\.view-heading h1\s*\{[^}]*font-size:\s*clamp\(20px, 2\.4vw, 26px\);/, 'the page heading must stay on the product scale, not the marketing one');
a.match(css, /\.thread-header\s*\{[^}]*background:\s*transparent/, 'thread controls share the conversation ground');
a.doesNotMatch(css, /--mono:\s*['"]?(IBM Plex Mono|Playfair Display)/, 'this app runs offline in Electron — no webfont stack for --mono');

// Metadata stays readable and quiet; only code, diffs and logs need monospace.
for (const sel of ['\\.card-meta', '\\.message-meta', '\\.metric-label', '\\.mode-kicker', '\\.sidebar-heading', '\\.brand-tag', '\\.thread-control-label', '\\.field-label', '\\.data-table th']) {
  a.match(css, new RegExp(`${sel}\\s*\\{[^}]*var\\(--ui\\)`),
    `${sel.replace(/\\\\/g, '')} metadata uses product sans`);
  a.match(css, new RegExp(`${sel}\\s*\\{[^}]*text-transform:\\s*none`),
    `${sel.replace(/\\\\/g, '')} metadata stays sentence case`);
}
// What is NOT metadata stays in the product sans: a status badge states a
// status, and a control is a control. The kit sets both in its own sans.
for (const sel of ['\\.button\\.chip', '\\.field-value', '\\.run-badge', '\\.task-row b']) {
  a.doesNotMatch(css, new RegExp(`${sel}\\s*\\{[^}]*font-family:\\s*var\\(--mono\\)|${sel}\\s*\\{[^}]*\\bvar\\(--mono\\)`),
    `${sel.replace(/\\\\/g, '')} states a status or is a control — not metadata, so not mono`);
  a.doesNotMatch(css, new RegExp(`${sel}\\s*\\{[^}]*text-transform:\\s*uppercase`),
    `${sel.replace(/\\\\/g, '')} states a status or is a control — not metadata, so not uppercase-tracked`);
}
// The kit's StatusBadge: a pill filled with its own hue at 12%, no border.
a.match(css, /\.run-badge\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-pill\);[^}]*background:\s*rgb\(var\(--muted-rgb\) \/ \.12\)/, 'the run badge is the kit\'s StatusBadge — a tinted pill, not a bordered one');
a.match(css, /\.run-badge\.live\s*\{[^}]*background:\s*rgb\(var\(--accent-rgb\) \/ \.12\);[^}]*color:\s*var\(--accent\)/, 'each badge tone fills with its own hue at 12%');
a.match(css, /grid-template:\s*"sidebar main" 1fr \/ 260px/);
a.match(css, /#bg\s*\{[\s\S]*?z-index:\s*0;/, 'wallpaper must sit between the body and shell');
a.match(css, /body\.has-bg\s*\{[\s\S]*?--shell-alpha:\s*\.82;/, 'wallpaper selection must open the shell surfaces');
a.match(css, /--surface-alpha\s*:\s*1;/, 'shell opacity must be tokenised with an opaque default');
// 2026-09-23: reverses the 2026-09-21 "flat surfaces must not reintroduce
// glass" guard this line used to hold. The sovereign asked for a Hiveory-
// inspired translucent/glass feel adopted *within* the paper system (#48 is
// superseded by the paper kit; the glass feel is the part that survives).
// Glass is scoped to chrome and floating surfaces only — never the flat,
// hairline-bordered cards (`.view-section`) this system already keeps
// shadowless at rest, so that rule is pinned as a negative here rather than
// dropped.
for (const sel of ['#header', '#sidebar', '#composer', '\\.hover-tip']) {
  a.match(css, new RegExp(`${sel}\\s*\\{[^}]*backdrop-filter:\\s*blur\\(var\\(--glass-blur\\)\\)\\s*saturate\\(var\\(--glass-saturate\\)\\)`),
    `${sel.replace(/\\\\/g, '')} is chrome or floating and must carry the glass blur`);
}
a.match(css, /body\.sidebar-open #sidebar-scrim\s*\{[^}]*backdrop-filter:\s*blur\(6px\)/, 'the drawer scrim blurs the content it covers');
a.doesNotMatch(css, /\.view-section\s*\{[^}]*backdrop-filter/, 'cards at rest stay flat — glass is for chrome, not content');
// Every glass alpha is measured against the worst ground this app can ever
// put behind it (a fully black wallpaper image), not the paper default —
// see the :root comment for the blend arithmetic. Pin the two numbers so a
// future edit cannot "round them up" without redoing that measurement.
a.equal(token('--glass-chrome-alpha'), '1', 'neutral chrome remains opaque');
a.equal(token('--glass-panel-alpha'), '1', 'neutral panels remain opaque');
// A browser without backdrop-filter, or a person who has asked for less
// transparency, gets the pre-glass opaque paint back — never the thinner
// alpha uncomposited against whatever sits behind it.
a.match(css, /@supports not \(backdrop-filter:\s*blur\(1px\)\)\s*\{[\s\S]*?#header,\s*\.hover-tip\s*\{\s*background:\s*var\(--raised\);/, 'a browser without backdrop-filter must fall back to the opaque paint');
a.match(css, /@media \(prefers-reduced-transparency:\s*reduce\)\s*\{[\s\S]*?backdrop-filter:\s*none;/, 'reduced transparency must turn glass back into the opaque paint');
a.match(css, /#composer:empty\s*\{\s*display:\s*none;/, 'non-chat pages must not leave an empty composer bar');
a.match(css, /#view\.view-changing\s*\{[^}]*opacity:\s*0;[^}]*transform:/, 'view changes need a bounded visual entry state');
a.match(css, /\.sidebar-nav-button/, 'the primary workspace navigation needs an explicit, testable treatment');
a.match(css, /\.sidebar-nav-button\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:/, 'navigation labels and icons must share one alignment spine');
a.match(css, /\.sidebar-nav-button \.icon\s*\{[^}]*flex:\s*none;/, 'navigation icons must not collapse before their labels');
a.match(css, /\.sidebar-heading\s*\{[^}]*margin:\s*0;/, 'sidebar headings must not retain browser margins');
a.match(css, /\.sidebar-empty\s*\{[^}]*margin:\s*0;[^}]*padding:/, 'sidebar empty states must use the shell spacing rhythm');
a.match(css, /\.sidebar-new\s*\{[^}]*padding:\s*0 var\(--space-3\);/, 'the new-conversation control must have an intentional hit area');
a.match(css, /\.sidebar-brand\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/, 'narrow drawers must let the brand yield to its controls');
a.match(css, /\.sidebar-new\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/, 'narrow drawers must keep the new-conversation control inside the header');
a.match(css, /\.app-identity\s*\{[^}]*display:\s*none;/, 'expanded desktop must not repeat the rail identity in the main header');
a.match(css, /body\.sidebar-collapsed \.app-identity\s*\{[^}]*display:\s*grid;/, 'the collapsed rail must restore a readable app identity in the header');
a.match(css, /\.mode-switcher/, 'the shell needs a visible mode switcher');
a.match(css, /\.sidebar-mode/, 'the sidebar needs the same mode choices');
a.match(sidebar, /options\.modes/, 'the sidebar renders the shared mode choices');
a.match(sidebar, /dataset\.action = 'mode'/, 'sidebar mode choices use the shared action path');
a.match(thread, /`thread-heading\$\{sovereign \? ' sovereign' : ''\}`/, 'the open thread must mark whether it is the orchestrator, once, at render time');
a.match(thread, /`Team \$\{awake\}\/\$\{members\.length\} awake`/, 'the header work-context fact must name what "N/M" counts, not read as a bare fraction — issue #39');
a.match(css, /\.thread-heading\.sovereign h1\s*\{[^}]*var\(--gold\)/, 'the orchestrator must use the dedicated gold identity token, never a status colour');
a.doesNotMatch(css, /\.thread-heading\.sovereign h1\s*\{[^}]*var\(--accent\)/, 'the orchestrator heading must not reuse the live-status accent');
a.doesNotMatch(css, /#d8ac54|--crown/, 'the old gold role color must not survive the prototype reskin');
a.match(util, /class: `button \$\{cls\}`/, 'page controls inherit the shared button treatment');
a.match(util, /role: 'progressbar'[\s\S]*?'aria-valuenow'/, 'visual meters must expose their value without relying on geometry or colour');
a.match(css, /\.button, \.icon-button \{[^}]*transition:/, 'primary controls need a restrained interaction transition');
a.match(css, /a:focus-visible, summary:focus-visible, button:focus-visible, input:focus-visible/, 'links and native disclosures must retain a visible keyboard focus ring');
a.match(css, /\.button\.link\s*\{[^}]*min-height:\s*var\(--tap-target-min\);[^}]*padding:\s*var\(--space-1\) 0;/, 'quiet link buttons must retain the enforced tap target');
a.match(thread, /tag === 'button'.*`button \$\{className/, 'thread controls inherit the shared button treatment');
a.match(avatar, /className = 'status-dot'/, 'member status uses the shared status-dot surface');

// One status vocabulary (ui/views/util.js#tone) replaces the five different
// status-colour mechanisms the views used to invent independently.
a.match(util, /export function tone\(status\)/, 'a single status classifier must exist for every domain that reads as "how is this going"');
a.match(util, /return '';\s*\}/, 'an unrecognised status must get no tone class, not a guessed one');
const status = readFileSync(join(import.meta.dirname, '..', 'ui', 'status.js'), 'utf8');
a.doesNotMatch(status, /export function toneOf/, 'the old, uncalled per-domain tone classifier must not coexist with the shared one');
const run = readFileSync(join(import.meta.dirname, '..', 'ui', 'run.js'), 'utf8');
a.match(run, /run-item \$\{statusClass\(status\)\} \$\{tone\(status\)\}/, 'run deliverables must carry the shared tone class');
a.match(run, /run-badge \$\{tone\(status\)\}/, 'the run badge must carry the shared tone class');
a.match(css, /\.doctor-row\.settled\s*\{[^}]*color:\s*var\(--ok\)/, 'passing checks need a positive cue');
a.match(css, /\.doctor-row\.attention\s*\{[^}]*color:\s*var\(--danger\)/, 'warnings and failures share one attention cue, not two different colours');
a.match(css, /\.approval-status\.settled\s*\{[^}]*color:\s*var\(--ok\)/, 'a settled decision must use the shared positive cue');
a.match(css, /\.approval-status\.attention\s*\{[^}]*color:\s*var\(--danger\)/, 'a rejected decision must use the shared attention cue, not a colour of its own');

// Issue #39/#48: "status reads through a dot, not a left rule" — applied to
// the genuinely row-shaped families (task/doctor/quota, run deliverables).
// The card-shaped families (.activity-row, .review-command, pinned above and
// below) deliberately keep their left-rule geometry — they aren't rows.
a.doesNotMatch(css, /\.task-row, \.doctor-row, \.quota \{[^}]*border-left/, 'task/doctor/quota rows must not keep the left-rule geometry the dot replaces');
a.doesNotMatch(css, /\.task-row\.live, \.doctor-row\.live|\.task-row\.idle, \.doctor-row\.idle/, 'the retired border-left-color tone variants must not survive the dot conversion');
a.doesNotMatch(css, /\.run-item \{[^}]*border-left/, 'run deliverables must not keep the left-rule geometry the dot replaces');
a.doesNotMatch(css, /\.run-item\.live \{|\.run-item\.attention \{|\.run-item\.settled \{/, 'the retired run-item border-left-color variants must not survive the dot conversion');
a.match(css, /\.run-item-label\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:/, 'a run item\'s dot must sit in its own aligned group so space-between still separates label from status');
a.match(css, /\.doctor-row > span:not\(\.status-dot\)\s*\{[^}]*flex:\s*1;/, 'a doctor check\'s message must fill the row now that a dot leads it');
a.match(util, /TONE_ATTENTION = new Set\(\[[^\]]*'fail'/, 'Doctor emits level "fail"; a hard failure must read as attention, not untoned');
a.match(css, /\.agent-card\.requested \.status-dot\s*\{[^}]*animation:\s*none/, 'an agent awaiting approval is not working yet, so its dot must not pulse');
a.match(run, /import \{ statusDot \} from '\.\/avatar\.js'/, 'run deliverables must use the shared status-dot surface, not a bespoke indicator');
a.match(run, /h\('span', \{ class: 'run-item-label' \}, dot, h\('span'/, 'a run item must lead with the shared status dot');
a.match(css, /\.status-dot\.live\s*\{[^}]*box-shadow:\s*0 0 0 4px rgb\(var\(--tone-live-rgb\) \/ \.13\);[^}]*animation:\s*busy 1\.6s/, 'the live tone must pulse everywhere it appears, not only on a separately-flagged busy dot');
a.doesNotMatch(css, /\.status-dot\.busy/, 'busy is a case of the live tone now, not a second animated class the dot needs');
a.doesNotMatch(css, /\.home-mode-card|\.home-lead/, 'Overview must not carry its own mode display — mode has exactly one home, the header and drawer control');
a.match(css, /\.home-objective\s*\{[^}]*grid-column:\s*1 \/ -1;/, 'the Home objective must lead the grid full width now that it stands alone');
// .run-summary spans 1 / -1, so auto-fit can never collapse an empty track:
// at 1080px the grid held four 261px columns and the Queue card rendered in
// one of them, four words wide, beside 800px of nothing.
a.match(css, /\.home-grid\s*\{[^}]*minmax\(min\(100%, 420px\), 1fr\)/, 'the Home grid must size its columns for cards that share a row with the full-width run panel');
a.match(css, /\.approval-card, \.agent-card, \.home-card,[^}]*align-content:\s*start;/, 'a card must hug its content rather than spread it down the height of its tallest neighbour');
a.match(css, /\.view-section\s*\{[^}]*align-content:\s*start;/, 'a view section must hug its content');
a.match(css, /\.run-grid\s*\{[^}]*align-items:\s*start;/, 'run panels must be as tall as what they hold, not as tall as their tallest neighbour');
a.match(css, /\.home-attention\s*\{[^}]*border-color:\s*rgb\(var\(--danger-rgb\)/, 'Home attention states need a local danger treatment');
a.match(css, /\.home-empty\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*color:\s*var\(--faint\);/, 'an empty Home must use one quiet full-width cue');
a.match(css, /\.sidebar-mode\s*\{\s*display:\s*none;/, 'desktop must not duplicate the header mode switcher in the sidebar');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?body\.sidebar-open #sidebar \.sidebar-mode\s*\{\s*display:\s*grid;/, 'the mobile navigation drawer must retain the mode switcher');
a.match(css, /@media \(min-width: 721px\)[\s\S]*?body\.sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*64px/, 'collapsed rail width must be desktop-only');
a.match(css, /@media \(min-width: 721px\)[\s\S]*?\.sidebar\.collapsed \.sidebar-conversations/, 'collapsed rail detail hiding must be desktop-only so mobile navigation can reopen');
a.match(css, /\.sidebar\.collapsed \.sidebar-conversations[\s\S]*?\.sidebar\.collapsed \.sidebar-footer/, 'collapsed rail must hide dense details without hiding navigation');
a.match(css, /\.sidebar\.collapsed \.sidebar-nav-button\s*\{[^}]*font-size:\s*0;/, 'collapsed rail navigation must retain icon-only controls');
a.match(css, /\.sidebar\.collapsed \.sidebar-nav > \.sidebar-heading\s*\{[^}]*display:\s*none;/, 'collapsed rail must not clip its workspace heading');
a.match(css, /\.sidebar\.collapsed \.sidebar-more > summary::after\s*\{[^}]*font-size:\s*16px;/, 'collapsed rail must keep the More tools disclosure glyph visible');
a.match(css, /\.task-row\.attention b\s*\{[^}]*color:\s*var\(--danger\)/, 'blocked queue work must have a danger cue');
a.match(css, /\.task-row\.live b\s*\{[^}]*color:\s*var\(--accent\)/, 'active queue work must have an accent cue');
a.match(util, /TONE_ATTENTION = new Set\(\[[^\]]*'blocked'/, 'the shared status vocabulary must classify blocked work as attention');
a.match(util, /TONE_IDLE = new Set\(\[[^\]]*'planning'/, 'the shared status vocabulary must classify planning work as idle, not live');
a.match(css, /\.task-row > span:not\(\.status-dot\)\s*\{[^}]*flex:\s*1;[^}]*text-align:\s*left;/, 'queue titles must scan from the status label into a readable left-aligned measure');
a.match(css, /\.question-option/, 'inline question choices need an intentional control treatment');
a.match(css, /\.question label\s*\{[^}]*display:\s*flex;[^}]*padding:\s*var\(--space-2\);[^}]*border:/, 'approval question choices must read as interactive rows');
a.match(css, /\.question label input\s*\{[^}]*accent-color:\s*var\(--accent\)/, 'approval question controls must use the shared accent');
a.match(css, /\.note\s*\{[^}]*margin:\s*0;/, 'inline notes must not inherit browser paragraph margins');
a.match(css, /\.button-row > \.note\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 240px;[^}]*overflow-wrap:\s*anywhere;/, 'long action feedback must wrap without displacing its retry control');
// Merge results and timeline rows both render as .activity-row, so one shared
// tone treatment (not a per-domain merged/failed/requested or error/done
// selector) now covers both.
a.match(css, /\.activity-row\.settled\s*\{[^}]*border-left-color:\s*var\(--ok\)/, 'merged work and completed timeline entries need a positive result cue');
a.match(css, /\.activity-row\.attention\s*\{[^}]*border-left-color:\s*var\(--danger\)/, 'failed merges and timeline errors need a danger result cue');
a.match(css, /\.activity-row\.live\s*\{[^}]*border-left-color:\s*var\(--accent\)/, 'pending merges need an accent result cue');
a.match(util, /TONE_SETTLED = new Set\(\[[^\]]*'merged'/, 'the shared status vocabulary must classify merged results as settled');
a.match(css, /\.settings-tabs\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/, 'Settings tabs must stay compact and scroll inside their strip');
a.match(css, /\.search-row input\s*\{[^}]*flex:\s*1 1 280px;[^}]*min-width:\s*min\(100%, 240px\);/, 'search fields must use the available row width before wrapping');
a.match(css, /\.thread-header\s*\{[^}]*flex-wrap:\s*wrap;/, 'thread header controls must wrap instead of widening narrow viewports');
a.match(css, /\.thread-control\s*\{[^}]*display:\s*grid;[^}]*gap:/, 'thread model controls need visible compact labels');
a.match(css, /\.thread-input\s*\{[^}]*min-width:\s*0;/, 'thread composer input must surrender intrinsic width on narrow screens');
a.doesNotMatch(css, /\.thread-input:focus\s*\{[^}]*outline:\s*none;/, 'thread composer focus must not erase the shared keyboard ring');
a.match(css, /\.thread-attach:hover[^}]*border-color:\s*var\(--accent\)/, 'thread attach must expose the shared hover affordance');
a.match(css, /\.thread-attach:disabled, \.thread-send:disabled[^}]*opacity:\s*\.5/, 'thread actions must look unavailable while sending or uploading');
a.match(css, /\.wfgraph/, 'the surviving workflow editor needs a visible editing surface');
a.match(css, /\.wfport\[aria-pressed="true"\]\s*\{[^}]*box-shadow:/, 'keyboard-selected graph ports need a visible pending cue');
a.match(css, /\.usage-lead\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/, 'Usage must lead with four cost-decision metrics');
a.match(css, /\.agent-usage-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(100%, 280px\), 1fr\)\)/, 'per-agent records must wrap without a wide table');
a.match(css, /\.usage-breakdown\.compact\s*\{[^}]*gap:\s*var\(--space-1\)/, 'the auxiliary breakdown\'s denser row count needs a tighter rhythm than the other breakdown lists, not the unstyled modifier it had before');
a.match(css, /\.agent-usage-details\s*\{[^}]*grid-template-columns:/, 'per-agent definition lists need a readable desktop relationship');
a.match(css, /\.agent-usage-card h3, \.agent-usage-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/, 'long agent and model names must wrap instead of clipping');
a.match(css, /\.usage-recommendation\s*\{[^}]*border:\s*1px solid var\(--line\);[^}]*border-left:\s*3px solid var\(--danger\)/, 'Usage advice must use the shared attention-row geometry');
a.match(css, /\.settings-group\s*\{[^}]*border:\s*1px solid var\(--line\)/, 'consolidated Settings jobs must retain one semantic boundary');
// 2026-09-23: read directly on Models & efficiency and Notifications — a
// bordered .view-section wrapping bordered .settings-group fieldsets with
// nothing of its own between the two borders, a card nested in a panel.
a.match(css, /\.settings-shell \.view-section:has\(> \.settings-group\)\s*\{[^}]*border:\s*0;/, 'a settings tab that only holds groups must not also draw its own outer card');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.agent-usage-details\s*\{[^}]*grid-template-columns:\s*1fr;/, 'agent definition lists must stack on narrow screens');
a.match(css, /@media \(forced-colors: active\)/, 'forced-colors users must retain metric and status boundaries');
a.match(css, /\.form-grid > label input/, 'nested workflow form controls must inherit the shell field treatment');
a.match(css, /\.form-grid > label:last-child\s*\{[^}]*grid-column:\s*1 \/ -1;/, 'conditional form details must span the full form measure');
a.match(css, /\.field input:not\(\[type="checkbox"\]\):not\(\[type="range"\]\), \.field select, \.field textarea/, 'text fields must not style native checkbox and range controls as text boxes');
a.match(css, /\.field input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--accent\)/, 'checkboxes need a compact native control treatment');
a.match(css, /\.field-check\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\)/, 'checkbox fields must align the control beside its label');
a.match(css, /\.field-check > input\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1 \/ span 2;/, 'checkbox fields must keep the control beside both label lines');
a.match(css, /\.field input\[type="range"\]\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*accent-color:\s*var\(--accent\)/, 'range controls need a compact native control treatment');
a.match(css, /\.field-label\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/, 'field labels must make room for live range values');
a.doesNotMatch(css, /\.field-value\s*\{[^}]*font-family:\s*var\(--mono\)/, 'range values are ordinary UI metadata, not code — mono is reserved for code/terminal/diff/log content');
a.match(css, /@media \(max-width: 900px\)/, 'the compact header must protect the required 800px layout');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.search-row input\s*\{[^}]*flex:\s*1 1 100%;[^}]*min-width:\s*0;/, 'phone search rows must give the query its own full-width line');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.thread-controls\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*stretch;/, 'phone thread controls must use the available row width');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.thread-control\s*\{[^}]*flex:\s*1 1 120px;/, 'phone thread controls must share one compact row before wrapping');
a.match(css, /\.agent-heading/, 'agent cards need a horizontal identity row');
a.match(css, /\.status-dot\.attention\s*\{[^}]*background:\s*var\(--danger\)/, 'failed members need a distinct status state');
a.match(css, /\.empty\s*\{[^}]*padding:\s*var\(--space-4\)/, 'empty cards must stay compact in the flat dashboard');
a.match(css, /\.view-page h1, \.view-page h2, \.view-page h3, \.view-page h4,\s*\.view-page p \{ margin: 0; \}/, 'page copy must use the shell spacing rhythm instead of browser defaults');
a.match(css, /\.view-section\s*\{[^}]*background:\s*var\(--surface\);/, 'sections must sit below raised cards in the material hierarchy');
a.match(css, /\.boot-failure\s*\{[^}]*display:\s*grid;[^}]*max-width:/, 'module-load failures must have a styled recovery surface');
a.match(css, /\.markdown > \* \+ \*, \.message-body > \* \+ \* \{ margin-top: var\(--space-3\); \}/, 'multi-paragraph content must retain readable separation after the margin reset');
a.match(css, /\.message-meta\s*\{[^}]*color:\s*var\(--faint\)/, 'thread metadata must recede behind message content');
a.match(css, /\.thread-message\.theirs \.message-body\s*\{[^}]*background:\s*transparent/, 'assistant replies sit directly on the conversation ground');
a.match(css, /\.message-body > :first-child\s*\{[^}]*margin-top:\s*0;/, 'thread markdown must not keep a browser margin before its first paragraph');
a.match(css, /\.markdown h1, \.markdown h2, \.markdown h3\s*\{[^}]*margin:\s*0;[^}]*line-height:/, 'markdown headings must use the thread type rhythm');
a.match(css, /\.markdown blockquote\s*\{[^}]*margin:[^;]+;[^}]*padding:[^;]+;[^}]*border-left:/, 'markdown quotes need a bounded readable treatment');
a.match(css, /\.markdown table\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*auto;/, 'markdown tables must stay inside the message width');
a.match(css, /\.message-body pre\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*auto;/, 'thread code blocks must stay readable inside the message width');
a.match(css, /\.thread-message\.failed \.message-body\s*\{[^}]*border-color:\s*rgb\(var\(--danger-rgb\)/, 'failed thread messages need a local danger cue');
a.match(css, /\.attachment-chip\s*\{[^}]*display:\s*inline-flex;[^}]*max-width:/, 'attachment chips must stay bounded and align their controls');
a.match(css, /\.attachment-name\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/, 'long attachment names must truncate before the remove control');
a.match(css, /\.attachment-chip button\s*\{[^}]*width:\s*var\(--tap-target-min\);[^}]*min-height:\s*var\(--tap-target-min\);[^}]*border:\s*0;/, 'attachment removal must keep a full borderless touch target');
a.match(css, /body\.sidebar-open #sidebar/, 'small screens need an explicit open-sidebar state');
a.match(css, /body\.sidebar-open #sidebar\s*\{[^}]*width:\s*min\(320px,\s*85vw\)/, 'mobile navigation drawer must cap at 320px without widening narrow phones');
a.match(css, /body\.sidebar-open #sidebar-scrim/, 'small screens need a scrim behind the open navigation');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mode-switcher \{ display: none; \}/, 'phone headers must move mode switching out of the header and into the drawer');
a.doesNotMatch(css, /\.mode-explainer|\.mode-name|\.mode-blurb/, 'mode must not keep a third header display once the switcher and drawer already show it');
a.match(css, /\.sidebar-mobile-close\s*\{\s*display:\s*none;/, 'the mobile close control must stay out of the desktop rail');
a.match(css, /\.sidebar-repo\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/, 'the repository control must not inherit native button chrome');
a.match(css, /\.sidebar\.collapsed \.sidebar-new\s*\{[^}]*width:\s*var\(--tap-target-min\);[^}]*font-size:\s*0;[^}]*text-indent:\s*0;/, 'the collapsed rail must keep a full new-conversation touch target');
a.match(css, /\.sidebar\.collapsed \.sidebar-new::before\s*\{[^}]*content:\s*"\+";/, 'the collapsed new button must render its plus glyph');
a.match(css, /\.sidebar\.collapsed \.sidebar-collapse\s*\{[^}]*width:\s*var\(--tap-target-min\);[^}]*font-size:\s*0;/, 'the collapsed rail control must keep a full touch target');

// Three defects the live 2026-09-21 session found and no source suite could.
// Each assertion names the measurement, so a later edit that reverts one
// fails here instead of shipping.
a.match(css, /#sidebar\.collapsed\s*\{[^}]*padding-inline:\s*var\(--space-2\);/, 'the collapsed rail measured 34x44 buttons inside its 16px inset; 8px is what leaves 44');
a.match(css, /body\.sidebar-open #sidebar \.sidebar-mode\s*\{[^}]*flex-shrink:\s*0;/, 'the drawer mode section measured 287x0 and painted through the nav below it');
a.match(css, /body\.sidebar-open #sidebar\s*\{[^}]*overflow-y:\s*auto;/, 'the drawer ran 122px past the viewport and swallowed the conversation list; it scrolls as one column');
a.match(css, /body\.sidebar-open #sidebar \.sidebar-conversations\s*\{[^}]*flex:\s*none;/, 'the conversation list must keep its natural height in the drawer, not absorb a deficit');
a.match(css, /body\.sidebar-open #sidebar \.sidebar-collapse\s*\{[^}]*display:\s*none;/, 'the collapse control is a rail affordance and there is no rail at drawer width');
// 2026-09-23: with a populated court (twelve conversations, More tools open)
// the desktop rail's own sections could outgrow #sidebar's height, and its
// overflow: hidden clipped the footer (Settings/Collapse, half off the
// bottom of the viewport at 1280x720) and squeezed Conversations to one row.
// .sidebar-scroll carries the scrolling; header and footer sit outside it so
// they are never the thing that gets clipped.
a.match(css, /\.sidebar-scroll\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/, 'the rail middle must scroll on its own so the header and footer are never clipped');
a.match(css, /body\.sidebar-open #sidebar \.sidebar-scroll\s*\{[^}]*flex:\s*none;[^}]*overflow:\s*visible;/, 'the 720px drawer keeps scrolling as one column, not a nested scroller');
a.match(css, /\.sidebar\.collapsed \.sidebar-collapse::before\s*\{[^}]*content:\s*"[^"}]+";/, 'the collapsed rail must retain a visible expand affordance');
a.match(css, /\.conversation-row:hover \.conversation-actions, \.conversation-row:focus-within \.conversation-actions/, 'conversation actions must be visible to keyboard users');
// Measured live 2026-09-21 at 1440x900: with .selected here too, the selected
// row's three actions held 150px of a 225px rail and its title rendered
// "Conv...". Hover, focus-within and the <=720px touch rule cover every input.
a.doesNotMatch(css, /\.conversation-row\.selected \.conversation-actions/, 'the selected row must not spend its title width on permanently visible actions');
a.match(css, /\.conversation-list\s*\{[^}]*align-content:\s*start;/, 'conversation rows must keep their own height instead of stretching to fill the list');
a.match(css, /\.sidebar-section\s*\{[^}]*align-content:\s*start;/, 'a rail section must not spread its heading across the free space below it');
a.match(css, /\.sidebar-conversations\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'the conversation list, not the heading, takes the height the rail has left');
a.match(css, /\.conversation-actions\s*\{[^}]*flex:\s*none;/, 'conversation actions must keep their own width beside the title');
a.match(css, /\.conversation-action\s*\{[^}]*min-height:\s*var\(--tap-target-min\);[^}]*padding:[^;]+;[^}]*white-space:\s*nowrap;/, 'conversation actions need full touch-sized labels');
// Measured live 2026-09-21: both were under the 44px this system enforces —
// the conversation title at 210x24 and the repository control at 227x27.
a.match(css, /\.conversation-open\s*\{[^}]*min-height:\s*var\(--tap-target-min\);/, 'the conversation title is the row tap target and must carry the enforced minimum');
a.match(css, /\.sidebar-repo\s*\{[^}]*min-height:\s*var\(--tap-target-min\);/, 'the repository control must carry the enforced minimum');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.conversation-actions\s*\{\s*display:\s*flex;/, 'conversation actions must remain reachable on touch-sized navigation drawers');
a.match(css, /\.wfn-x\s*\{[^}]*min-width:\s*var\(--tap-target-min\);[^}]*min-height:\s*var\(--tap-target-min\);[^}]*padding:\s*var\(--space-1\);/, 'workflow deletion needs a full touch-sized target');
a.match(css, /\.wfport::after\s*\{[^}]*inset:\s*-18px;/, 'workflow ports need a full touch target around the visible dot');
a.match(css, /\.attachment-chip button\s*\{[^}]*width:\s*var\(--tap-target-min\);[^}]*min-height:\s*var\(--tap-target-min\);/, 'attachment removal needs a full touch target');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.wfn-x\s*\{\s*opacity:\s*1;/, 'workflow deletion must remain reachable on touch-sized editors');
a.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none\s*!important;/, 'reduced-motion users must not receive a running animation');
a.doesNotMatch(css, /\.section\s*\{|\.card\s*\{|\.row\s*\{|\.nav\s*\{|\.composer-form\s*\{|\.message\s*\{/, 'deleted window components must not leave a second styling vocabulary');

// 2026-09-23: a populated demo court's Chat page showed a fenced code block
// rendering on bare browser defaults — no background, no wrap handling, so a
// long line pushed the message bubble past the thread column. mdToHtml
// (ui/markdown.js) already emits real <pre><code>/<code>; the gap was purely
// that ui/app.css never styled them.
a.match(css, /\.markdown pre\s*\{[^}]*overflow-x:\s*auto;[^}]*font-family:\s*var\(--mono\);/, 'a fenced code block must scroll inside its own box, not stretch the message bubble');
a.match(css, /\.markdown code\s*\{[^}]*font-family:\s*var\(--mono\);/, 'inline code must read as code, not as prose in a monospace accident');
a.match(main, /class="mobile-menu"/, 'small screens need a menu control');
a.match(main, /sidebar-scrim/, 'small screens need a native close target outside the rail');
a.doesNotMatch(main, /const action = document\.createElement\('small'\)/, 'mode tabs must not repeat the header explainer copy');
a.doesNotMatch(css, /\.mode-option small/, 'mode tabs must not reserve space for duplicate explainer copy');
// 2026-09-23: the same defect came back under a different tag. Read directly
// on a populated demo court: three two-line mode pills dominated the header
// and pushed "Connected" to the far end looking detached. The button's own
// dataset.tip/aria-label (ui/main.js) already carry the description, and
// attachHoverTips(document.body) already surfaces it on hover, so hiding the
// always-visible copy loses no information — it moves from mandatory to
// on-demand, which is this app's own established convention for exactly this
// (see HANDOFF.md's .hover-tip rule).
a.match(css, /\.mode-option span\s*\{\s*display:\s*none;\s*\}/, 'mode tabs must not reserve space for duplicate explainer copy under any tag name');
a.match(main, /button\.disabled = modeRequest > 0 \|\| !ready/, 'mode controls must wait for the first workspace snapshot');
a.match(main, /if \(state\.ready === false \|\| !backend \|\| !choice \|\| modeRequest\)/, 'mode changes must reject requests before the workspace snapshot');
a.match(sidebar, /button\.disabled = currentState\.ready === false/, 'mobile mode controls must wait for the first workspace snapshot');
a.match(main, /const selected = ready && button\.dataset\.mode === choice\.id/, 'the header must not visually select a default mode before the workspace is ready');
a.match(main, /goal\.textContent = ready \? [\s\S]*? : 'Waiting for workspace state…'/, 'the header must not claim an objective before the workspace is ready');
a.match(main, /conn\.textContent = state\.conn === 'up' \? 'Connected' : state\.conn === 'down' \? 'Reconnecting' : 'Connecting\.\.\.'/ , 'the header must show a readable connection state');
a.match(main, /event\.key === 'Escape'/, 'Escape must close the open mobile navigation');
a.match(main, /let mountSequence = 0/, 'view mounts need a stale-completion guard');
a.match(main, /const root = document\.createElement\('div'\)/, 'each view needs its own detached render root');
a.match(main, /view-changing/, 'route changes must drive the view transition contract');
a.match(sidebar, /sidebar-mobile-close/, 'the mobile sidebar needs a close control');

const userModes = /export const USER_MODES = Object\.freeze\(\[(.*?)\]\);/s.exec(main)?.[1] ?? '';
a.deepEqual([...userModes.matchAll(/id: '([^']+)'/g)].map((m) => m[1]), ['chat', 'cowork', 'code']);
a.deepEqual([...userModes.matchAll(/backend: '([^']+)'/g)].map((m) => m[1]), ['chat', 'cowork', 'code']);
a.match(userModes, /Chat.*direct conversation/s);
a.match(userModes, /Cowork.*multi-step workspace work/s);
a.match(userModes, /Code.*repository.*tests.*review/s);

// A literal colour outside the token block cannot follow a palette change.
const hex = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
a.deepEqual(hex, [], `stray literal colours: ${hex.join(', ')}`);
const rgb = [...rules.matchAll(/rgba?\(\s*\d+\s*[, ]\s*\d+\s*[, ]\s*\d+/g)].map((m) => m[0]);
a.deepEqual(rgb.filter((v) => {
  const n = v.match(/(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/).slice(1).map(Number);
  return !(n[0] === n[1] && n[1] === n[2]);
}), [], 'coloured rgb literals must come from channel tokens');

console.log('t-theme.js OK — neutral workspace tokens, AA contrast, layout and accessibility contracts');
