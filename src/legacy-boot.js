// Imported FIRST by every entry point (daemon, CLI tools, the MCP server,
// Electron's main process), for its side effects, before any other module
// reads process.env at load time:
//
//  1. the pre-rename environment variables are read as a fallback for the
//     current names, with one warning naming each (src/legacy.js);
//  2. the home folder's pre-rename state (the team registry, the global
//     token store, the repo-less workspace) moves to its current name, once.
//
// A repository's own state moves lazily, the first time src/worktree.js is
// asked where it lives, so a repo attached later is covered too.
import { homedir } from 'node:os';
import { applyLegacyEnv, migrateHome, SKIP_ENV } from './legacy.js';

applyLegacyEnv(process.env);
if (process.env[SKIP_ENV] !== '1') {
  try { migrateHome(homedir()); } catch (e) { console.warn(`[agenticos] home migration skipped: ${e.message}`); }
}
