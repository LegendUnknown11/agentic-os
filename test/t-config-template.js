// agenticos.config.json at the repo root is TWO things wearing one hat: the
// template defaultConfigPath() copies into every new workspace on first run
// (src/agenticos.js), and — because it is not gitignored — whatever a live
// session happens to write back to it if ever pointed at directly. The two
// must never mix: a fresh install inheriting a real vault path, a real
// dictation-model path, or a live goal with somebody else's timestamp is not
// a template, it's a leak. This pins the template clean and pins the fix
// (package.json's build.files) that made the installed app's skill menu stop
// being empty — skills/ was never in the packaged files list.
//
//   node test/t-config-template.js
import { strict as a } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const cfg = JSON.parse(readFileSync(join(ROOT, 'agenticos.config.json'), 'utf8'));
a.deepEqual(cfg.models.cursor, [], 'Cursor model ids are account-specific; populate from cursor-agent models');
a.deepEqual(cfg.efforts.agy, ['low', 'medium', 'high'], 'agy keeps its measured ladder; it rejects xhigh/max');

/* ---------- the template carries no personal path or live session state */
{
  a.equal(cfg.vault, '', 'a shipped template must not point at anyone\'s Obsidian vault');
  a.equal(cfg.speechbird, '', 'a shipped template must not point at anyone\'s local SpeechBird checkout');
  a.equal(cfg.goal.text, '', 'a shipped template must not carry a live standing goal');
  a.equal(cfg.goal.setAt, null, 'and no timestamp from the session that set it');
  a.deepEqual(cfg.advisor.allow, [], 'an unpinned advisor allowlist — allow:[] means "every configured model", '
    + 'not "none" (src/agenticos.js: a.allow?.length ? filter : allowAll)');

  const asText = JSON.stringify(cfg);
  a.doesNotMatch(asText, /[A-Za-z]:\\\\/, 'no Windows absolute path anywhere in the shipped template');
  console.log('  template carries no personal path, no pinned allowlist, no live goal');
}

/* ---------- the claude model list names real, current model ids --------- */
// The model selector rendered whatever this array held verbatim
// (`${cli} · ${model}` in ui/views/agents.js), so a bare alias like "opus"
// showed as "opus" with no version at all — issue #45: "it just says Opus
// Sonnet, not the model number at all". Every entry must be a real,
// versioned id, not a short alias the UI cannot distinguish from a stale one.
{
  a.ok(cfg.models?.claude?.length > 0, 'the template must offer at least one claude model');
  for (const model of cfg.models.claude) {
    a.match(model, /^claude-/, `"${model}" must be a full model id (e.g. claude-opus-5), not a bare alias — `
      + 'the model selector shows this value verbatim with no separate version label');
  }
  // The catalogue itself must be current, not just versioned-looking: Opus
  // 5.5 shipped and the template still offered only its predecessor.
  a.ok(cfg.models.claude.includes('claude-opus-5-5'),
    'the template must offer the current Opus (claude-opus-5-5), not just claude-opus-5 — the catalogue must stay up to date');
  console.log('  the claude model list names full, versioned model ids and is current');
}

/* ---------- package.json ships what src/skills.js and #seedRoles() read -- */
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  a.ok(files.some((f) => f.startsWith('skills/')),
    'skills/ must be in build.files — src/skills.js\'s BUILTIN resolves to <app>/skills, '
    + 'and an installed app that never packaged it ships an empty "/" skill menu');
  a.ok(files.includes('roles.json'),
    'roles.json must be in build.files — #seedRoles() reads it on a config with rolesSeeded:false');

  // Prove the claim, not just the manifest line: the directory the running
  // app actually resolves to (repo root's skills/, same as src/skills.js's
  // BUILTIN one level up from src/) is real and non-empty.
  const skillFiles = readdirSync(join(ROOT, 'skills')).filter((f) => f.endsWith('.md'));
  a.ok(skillFiles.length > 0, 'skills/ must exist and hold at least one skill for build.files to package');
  console.log(`  build.files packages skills/ (${skillFiles.length} files) and roles.json`);
}

/* ---------- agenticos.js's own fallback default matches the template ------- */
// Kingdom#models() falls back to a hardcoded default only when a config
// carries no `models` key at all (e.g. one built by hand in a test, or an
// older workspace's config predating this key). That default must not
// regress to the same bare-alias bug the template was just fixed for.
{
  const kingdomSource = readFileSync(join(ROOT, 'src', 'agenticos.js'), 'utf8');
  a.match(kingdomSource,
    /claude: \['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1'\]/,
    'Kingdom#models()\'s hardcoded fallback must also name full, versioned, CURRENT model ids');
  console.log('  Kingdom#models()\'s fallback default matches the template\'s versioned, current ids');
}

console.log('t-config-template.js OK — the shipped template is clean, and the packaged app carries its own skills');
