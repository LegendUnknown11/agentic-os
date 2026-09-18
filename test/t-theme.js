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
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').slice(css.indexOf('* { box-sizing'));

const token = (name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root)?.[1].trim();
// Hiveory (github.com/raktim-yoddha/hiveory), adopted in full per PLAN.md
// section 1: literal values read from its shipped app.css, dark only (no
// light/dark toggle survives the swap). This app's own token discipline
// (:root, -rgb twins, no literal colour outside :root, gold identifies the
// orchestrator alone) is unaffected by which palette supplies the values.
a.equal(token('color-scheme'), 'dark');
a.equal(token('--bg'), '#111418');
a.equal(token('--bg-rgb'), '17 20 24');
a.equal(token('--bg-alt'), '#0f141a');
a.equal(token('--bg-alt-rgb'), '15 20 26');
a.equal(token('--surface'), '#14181d');
a.equal(token('--surface-rgb'), '20 24 29');
a.equal(token('--raised'), '#181d23');
a.equal(token('--raised-rgb'), '24 29 35');
a.equal(token('--text'), '#f5f7fa');
a.equal(token('--text-rgb'), '245 247 250');
a.equal(token('--muted'), '#aeb8c5');
a.equal(token('--muted-rgb'), '174 184 197');
a.equal(token('--faint'), '#758192');
a.equal(token('--faint-rgb'), '117 129 146');
a.equal(token('--line'), '#272d35');
a.equal(token('--line-rgb'), '39 45 53');
a.equal(token('--line-soft'), '#29323c');
a.equal(token('--line-soft-rgb'), '41 50 60');
a.equal(token('--accent'), '#2b5f96');
a.equal(token('--accent-rgb'), '43 95 150');
a.equal(token('--accent-border'), '#4a6d98');
a.equal(token('--accent-hover'), '#3675b7');
a.equal(token('--accent-ink'), '#f7fbff');
// Four genuinely distinct status hues, not one hue split by chroma.
a.equal(token('--tone-live'), '#48a7ed');
a.equal(token('--tone-live-rgb'), '72 167 237');
a.equal(token('--tone-settled'), '#45c47b');
a.equal(token('--tone-settled-rgb'), '69 196 123');
a.equal(token('--tone-attention'), '#d46d77');
a.equal(token('--tone-attention-rgb'), '212 109 119');
a.equal(token('--tone-idle'), '#d2a05f');
a.equal(token('--tone-idle-rgb'), '210 160 95');
a.equal(token('--danger'), 'var(--tone-attention)', 'general-purpose danger must agree with the attention status hue');
a.equal(token('--danger-rgb'), 'var(--tone-attention-rgb)');
a.equal(token('--ok'), 'var(--tone-settled)', 'general-purpose ok must agree with the settled status hue');
a.equal(token('--ok-rgb'), 'var(--tone-settled-rgb)');
a.equal(token('--gold'), '#d9b25c');
a.equal(token('--gold-rgb'), '217 178 92');
// Shape: pills are back. Controls take 6px, cards/panels take 10px (one
// shared value), icon-only buttons stay tighter at 4px.
a.equal(token('--radius-ctl'), '6px');
a.equal(token('--radius-card'), '10px');
a.equal(token('--radius-icon'), '4px');
a.equal(token('--radius-pill'), '999px');
a.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => token(`--space-${n}`)), ['4px', '8px', '12px', '16px', '24px', '32px', '48px', '64px']);
a.equal(token('--tap-target-min'), '44px');
a.equal(token('--ease'), 'ease', 'the old custom easing curve is dropped for Hiveory\'s plain ease');
a.equal(token('--fast'), '150ms', 'hover/press transitions run at 0.15s per the source');
a.match(css, /--display:\s*-apple-system, "Segoe UI", Roboto, system-ui, sans-serif/, 'headings must use the local sans stack approximating Hiveory\'s IBM Plex Sans');
a.doesNotMatch(css, /--mono:\s*['"]?(IBM Plex Mono|JetBrains Mono)/, 'this app runs offline in Electron — no webfont stack for --mono, including Hiveory\'s real JetBrains Mono choice');
a.match(index, /<meta name="color-scheme" content="dark">/, 'the document chrome must advertise the single dark surface, not a toggle');
a.doesNotMatch(index, /theme-bootstrap/, 'the light/dark bootstrap script is gone along with the toggle');
a.doesNotMatch(index, /<script>(?!\s*<\/script>)/, 'the shell must obey the daemon script CSP');
a.doesNotMatch(css, /:root\[data-theme=|prefers-color-scheme: dark/, 'the light/dark toggle must not survive the Hiveory swap — dark is the only ground now');
a.doesNotMatch(css, /--dark-/, 'the --dark- prefix convention is gone now that dark is the only palette');
a.doesNotMatch(css, /linear-gradient|radial-gradient/, 'the optional Hiveory panel-wash gradient is deferred to a later pass, not adopted yet');
a.match(css, /\.mode-switcher\s*\{[^}]*border-radius:\s*var\(--radius-pill\)/, 'work modes must read as one segmented control');
a.match(css, /\.mode-option\.selected\s*\{[^}]*background:\s*var\(--accent\)/, 'the active work mode needs one clear accent state');
a.match(css, /\.view-heading::before\s*\{[^}]*content:\s*"AGENTIC OS \/ WORKSPACE"/, 'pages need one eyebrow from the shared heading primitive, naming the product correctly');
a.match(css, /\.thread-header\s*\{[^}]*background:\s*var\(--surface\)/, 'threads need the same paper panel primitive as dashboard pages');
a.doesNotMatch(css, /--mono:\s*['"]?(IBM Plex Mono|Playfair Display)/, 'this app runs offline in Electron — no webfont stack for --mono');

// PLAN.md section 1: mono is reserved for code/terminal/diff/log content,
// never ordinary UI metadata; uppercase-tracked treatment is reserved for
// small section/rail headings, not every label, badge, or chip. Swept for
// both across every selector that isn't a section/rail heading — issue #39.
for (const sel of ['\\.button\\.chip', '\\.field-value', '\\.metric-label', '\\.run-badge', '\\.usage-breakdown dd, \\.agent-usage-details dd']) {
  a.doesNotMatch(css, new RegExp(`${sel}\\s*\\{[^}]*font-family:\\s*var\\(--mono\\)`),
    `${sel.replace(/\\\\/g, '')} is ordinary UI metadata, not code — must not use --mono`);
}
for (const sel of ['\\.metric-label', '\\.run-badge', '\\.mode-kicker', '\\.task-row b']) {
  a.doesNotMatch(css, new RegExp(`${sel}\\s*\\{[^}]*text-transform:\\s*uppercase`),
    `${sel.replace(/\\\\/g, '')} is a label, not a section/rail heading — must not be uppercase-tracked by default`);
}
a.match(css, /\.run-badge\s*\{[^}]*border-radius:\s*var\(--radius-pill\)/, 'Hiveory pills every status chip, count badge, and tag — the run badge is one');
a.match(css, /grid-template:\s*"sidebar main" 1fr \/ 260px/);
a.match(css, /#bg\s*\{[\s\S]*?z-index:\s*0;/, 'wallpaper must sit between the body and shell');
a.match(css, /body\.has-bg\s*\{[\s\S]*?--shell-alpha:\s*\.82;/, 'wallpaper selection must open the shell surfaces');
a.match(css, /--surface-alpha\s*:\s*1;/, 'shell opacity must be tokenised with an opaque default');
a.equal(/backdrop-filter/i.test(css), false, 'flat surfaces must not reintroduce glass');
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
a.match(css, /\.thread-message\.theirs \.message-body\s*\{[^}]*background:\s*var\(--raised\)/, 'incoming thread messages need a stable raised surface');
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
a.match(css, /\.sidebar\.collapsed \.sidebar-collapse::before\s*\{[^}]*content:\s*"[^"}]+";/, 'the collapsed rail must retain a visible expand affordance');
a.match(css, /\.conversation-row:hover \.conversation-actions, \.conversation-row\.selected \.conversation-actions, \.conversation-row:focus-within \.conversation-actions/, 'conversation actions must be visible to keyboard users');
a.match(css, /\.conversation-actions\s*\{[^}]*flex:\s*none;/, 'conversation actions must keep their own width beside the title');
a.match(css, /\.conversation-action\s*\{[^}]*min-height:\s*var\(--tap-target-min\);[^}]*padding:[^;]+;[^}]*white-space:\s*nowrap;/, 'conversation actions need full touch-sized labels');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.conversation-actions\s*\{\s*display:\s*flex;/, 'conversation actions must remain reachable on touch-sized navigation drawers');
a.match(css, /\.wfn-x\s*\{[^}]*min-width:\s*var\(--tap-target-min\);[^}]*min-height:\s*var\(--tap-target-min\);[^}]*padding:\s*var\(--space-1\);/, 'workflow deletion needs a full touch-sized target');
a.match(css, /\.wfport::after\s*\{[^}]*inset:\s*-18px;/, 'workflow ports need a full touch target around the visible dot');
a.match(css, /\.attachment-chip button\s*\{[^}]*width:\s*var\(--tap-target-min\);[^}]*min-height:\s*var\(--tap-target-min\);/, 'attachment removal needs a full touch target');
a.match(css, /@media \(max-width: 720px\)[\s\S]*?\.wfn-x\s*\{\s*opacity:\s*1;/, 'workflow deletion must remain reachable on touch-sized editors');
a.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none\s*!important;/, 'reduced-motion users must not receive a running animation');
a.doesNotMatch(css, /\.section\s*\{|\.card\s*\{|\.row\s*\{|\.nav\s*\{|\.composer-form\s*\{|\.message\s*\{/, 'deleted window components must not leave a second styling vocabulary');
a.match(main, /class="mobile-menu"/, 'small screens need a menu control');
a.match(main, /sidebar-scrim/, 'small screens need a native close target outside the rail');
a.doesNotMatch(main, /const action = document\.createElement\('small'\)/, 'mode tabs must not repeat the header explainer copy');
a.doesNotMatch(css, /\.mode-option small/, 'mode tabs must not reserve space for duplicate explainer copy');
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

console.log('t-theme.js OK — the Hiveory palette is tokenised, dark-only, and has one fixed layout');
