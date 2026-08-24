// kingdom.config.json at the repo root is TWO things wearing one hat: the
// template defaultConfigPath() copies into every new workspace on first run
// (src/kingdom.js), and — because it is not gitignored — whatever a live
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

const cfg = JSON.parse(readFileSync(join(ROOT, 'kingdom.config.json'), 'utf8'));

/* ---------- the template carries no personal path or live session state */
{
  a.equal(cfg.vault, '', 'a shipped template must not point at anyone\'s Obsidian vault');
  a.equal(cfg.speechbird, '', 'a shipped template must not point at anyone\'s local SpeechBird checkout');
  a.equal(cfg.goal.text, '', 'a shipped template must not carry a live standing goal');
  a.equal(cfg.goal.setAt, null, 'and no timestamp from the session that set it');
  a.deepEqual(cfg.advisor.allow, [], 'an unpinned advisor allowlist — allow:[] means "every configured model", '
    + 'not "none" (src/kingdom.js: a.allow?.length ? filter : allowAll)');

  const asText = JSON.stringify(cfg);
  a.doesNotMatch(asText, /[A-Za-z]:\\\\/, 'no Windows absolute path anywhere in the shipped template');
  console.log('  template carries no personal path, no pinned allowlist, no live goal');
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

console.log('t-config-template.js OK — the shipped template is clean, and the packaged app carries its own skills');
