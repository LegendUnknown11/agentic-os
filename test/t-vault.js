// Vault access: the court can search and read the sovereign's notes, and its
// writes are confined to one folder so a personal knowledge base cannot be
// scattered with agent files.
//   node test/t-vault.js
import { strict as a } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const vault = realpathSync.native(mkdtempSync(join(tmpdir(), 'kingdom-vault-')));
mkdirSync(join(vault, 'References'), { recursive: true });
mkdirSync(join(vault, '.obsidian'), { recursive: true });
mkdirSync(join(vault, '.trash'), { recursive: true });
writeFileSync(join(vault, 'References', 'Model Guidance.md'), 'Use Haiku for cheap bulk work.\nPricing matters.\n');
writeFileSync(join(vault, '.obsidian', 'workspace.json'), '{"secret":"config"}');
writeFileSync(join(vault, '.trash', 'Deleted.md'), 'deleted pricing note');

// Drive the MCP server the way a CLI does: JSON-RPC over stdio.
function callTool(name, args, extraEnv = {}) {
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.js')], {
    input: rpc,
    encoding: 'utf8',
    env: {
      ...process.env,
      KINGDOM_AGENT: 'coder', KINGDOM_ROLE: 'peasant',
      KINGDOM_DB: join(vault, 'test.db'),
      KINGDOM_VAULT: vault, KINGDOM_VAULT_DIR: 'Kingdom',
      ...extraEnv,
    },
  });
  const reply = r.stdout.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((m) => m && m.id === 2);
  a.ok(reply, `no tools/call reply. stderr: ${r.stderr.slice(0, 400)}`);
  return reply.result?.content?.[0]?.text ?? JSON.stringify(reply.result);
}

// --- search finds real notes -----------------------------------------
const found = callTool('vault_search', { query: 'pricing' });
a.match(found, /Model Guidance\.md/, 'search must find the note');
a.match(found, /Pricing matters/, 'search must show the matching line');

// --- hidden Obsidian internals are never exposed ---------------------
a.ok(!/workspace\.json/.test(found), '.obsidian must not be searched');
a.ok(!/Deleted\.md/.test(callTool('vault_search', { query: 'pricing' })), '.trash must not be searched');

// --- read ------------------------------------------------------------
a.match(callTool('vault_read', { path: 'References/Model Guidance.md' }), /cheap bulk work/);

// --- path traversal is refused ---------------------------------------
const escape = callTool('vault_read', { path: '../../../Windows/System32/drivers/etc/hosts' });
a.match(escape, /No such note/, 'must refuse to read outside the vault');

// --- writes land in the confined folder, with attribution ------------
const saved = callTool('vault_write', {
  title: 'Reframe route needs SSRF guard',
  body: 'Discovered while wiring the python service.',
  links: ['Model Guidance'],
});
a.match(saved, /Kingdom[\/\\]/, 'writes must go under the write dir');
const note = join(vault, 'Kingdom', 'Reframe route needs SSRF guard.md');
a.ok(existsSync(note), 'the note must exist on disk');
const text = readFileSync(note, 'utf8');
a.match(text, /Recorded by coder/, 'notes must say which member wrote them');
a.match(text, /\[\[Model Guidance\]\]/, 'links must be rendered as wikilinks');

// --- append ----------------------------------------------------------
callTool('vault_write', { title: 'Reframe route needs SSRF guard', body: 'Second finding.', append: true });
const after = readFileSync(note, 'utf8');
a.match(after, /Discovered while wiring/, 'append must keep the original');
a.match(after, /Second finding/, 'append must add the new text');

// --- a filename cannot escape the write folder -----------------------
callTool('vault_write', { title: '../../escaped', body: 'nope' });
a.equal(existsSync(join(vault, '..', 'escaped.md')), false, 'title must not traverse out');

// --- the search corpus is cached, and the cache must never serve stale ---
// searchVault re-read 9.4MB per call on the real vault: 800-2,600ms, and every
// member is told to search before deciding. It is cached now, which is only
// safe if a write is visible at once and a delete disappears.
{
  const { searchVault, invalidateVault, readNote } = await import('../src/vault.js');
  const probe = join(vault, 'cache-probe.md');

  // Freeze the revalidation window WIDE open for these checks, and turn the
  // watcher OFF. Otherwise either mechanism quietly refreshes the corpus and
  // every assertion passes whether or not the one under test works — the
  // watcher in particular fires on the test's own writes within 2ms.
  process.env.KINGDOM_VAULT_REVALIDATE_MS = '600000';
  process.env.KINGDOM_VAULT_WATCH = '0';

  a.equal(searchVault(vault, 'zork-token-4417').length, 0, 'sanity: nothing matches yet');

  writeFileSync(probe, 'zork-token-4417 lives here\n');
  invalidateVault(vault);
  a.equal(searchVault(vault, 'zork-token-4417').length, 1,
    'a note written into the vault must be findable immediately');
  a.match(readNote(vault, 'cache-probe.md'), /zork-token-4417/,
    'and readable — a cached read must not miss a file the cache has just seen');

  // An EDIT to an existing note must win too, not be served from the old text.
  writeFileSync(probe, 'zork-token-4417 was replaced by grue-token-9902\n');
  invalidateVault(vault);
  a.equal(searchVault(vault, 'grue-token-9902').length, 1, 'an edited note must re-read');
  a.match(readNote(vault, 'cache-probe.md'), /grue-token-9902/, 'and read back the new text');

  rmSync(probe, { force: true });
  invalidateVault(vault);
  a.equal(searchVault(vault, 'grue-token-9902').length, 0, 'a deleted note must drop out');
  a.equal(readNote(vault, 'cache-probe.md'), null, 'and stop being readable');

  // A note written by ANOTHER process — every member runs its own mcp.js — is
  // picked up on revalidation, not instantly. That bound is deliberate:
  // stat-ing 1,409 files is itself ~120ms, so checking on every call would put
  // the floor straight back. Each writer invalidates its OWN cache, which is
  // the case that matters (write then search inside one member's session).
  callTool('vault_write', { title: 'Cache Coherence Probe', body: 'nib-token-7731' });
  invalidateVault(vault);
  a.equal(searchVault(vault, 'nib-token-7731').length, 1,
    'a note written by another process must appear once the corpus revalidates');

  // And it must revalidate ON ITS OWN, with nobody calling invalidate — or a
  // member would never see another member's notes for the life of its process.
  // A search result is replayed in the member's context on every later turn,
  // so the payload is a token budget. Prove a vault full of fat matches cannot
  // return an unbounded wall of text.
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(vault, 'References', `bulky-${i}.md`),
      Array.from({ length: 30 }, (_, n) => `line ${n} mentions bulktoken and rambles on `
        + 'x'.repeat(300)).join('\n'));
  }
  invalidateVault(vault);
  const fat = callTool('vault_search', { query: 'bulktoken' });
  a.ok(fat.length < 6000, `a search must stay within its budget, got ${fat.length} chars`);
  a.match(fat, /more match/, 'and must say what it withheld rather than silently truncating');
  a.match(fat, /bulky-/, 'while still returning real hits');

  // --- reading a big note must not dump it into the member's context -------
  // 97% of this vault is sectioned, and everything read stays in context for
  // the rest of the session. The real Kingdom Index is 121k chars: read whole
  // it cost ~5,000 tokens (the old 20k truncation), as an outline ~225.
  {
    const big = join(vault, 'References', 'Big Note.md');
    writeFileSync(big, [
      '# Big Note', 'intro line',
      '## Alpha', 'a'.repeat(3000),
      '## Beta', 'unique-beta-token here', 'more beta',
      '### Beta child', 'nested-under-beta',
      '## Gamma', 'g'.repeat(3000),
    ].join('\n'));
    invalidateVault(vault);

    const outline = callTool('vault_read', { path: 'References/Big Note.md' });
    a.ok(outline.length < 1000, `a big note must answer with its shape, got ${outline.length} chars`);
    a.match(outline, /Alpha[\s\S]*Beta[\s\S]*Gamma/, 'and list its sections');
    a.ok(!outline.includes('aaaaaaaaaa'), 'without any of the body');
    a.match(outline, /section:/, 'and say how to ask for a part');

    const beta = callTool('vault_read', { path: 'References/Big Note.md', section: 'beta' });
    a.match(beta, /unique-beta-token/, 'a section read must return that section');
    a.ok(!beta.includes('aaaaaaaaaa') && !beta.includes('gggggggggg'),
      'and nothing from the other sections');
    a.match(beta, /nested-under-beta/,
      'a parent heading must bring its subsections, not stop at the first deeper heading');

    const whole = callTool('vault_read', { path: 'References/Big Note.md', section: '*' });
    a.ok(whole.includes('aaaaaaaaaa') && whole.includes('gggggggggg'),
      '"*" must remain an escape hatch to the whole note');

    const miss = callTool('vault_read', { path: 'References/Big Note.md', section: 'nope' });
    a.match(miss, /Alpha/, 'an unknown section must list what IS there');
    a.ok(!miss.includes('aaaaaaaaaa'), 'and still not dump the body');

    // A search hit must name the section it sits in, so the reader can jump
    // straight to vault_read(path, section) without fetching the outline first.
    const found = callTool('vault_search', { query: 'unique-beta-token' });
    a.match(found, /§\s*Beta/, `a hit must name its section, got: ${found.slice(0, 200)}`);

    // A small note is unchanged — no outline ceremony for something cheap.
    const small = callTool('vault_read', { path: 'References/Model Guidance.md' });
    a.match(small, /newprice-token-3312|Haiku/, 'a small note must still come back whole');
    console.log('  large notes answer with an outline; sections cost a fraction of the whole');
  }

  // --- density ranking: the budget must be spent on the best notes ---------
  // With 1,400 notes and a payload budget, ordering decides what the member
  // actually sees. A note that discusses the term throughout beats one that
  // mentions it once, whatever their timestamps say.
  {
    writeFileSync(join(vault, 'References', 'passing-mention.md'), 'rank-token once.\n');
    writeFileSync(join(vault, 'References', 'all-about-it.md'),
      Array.from({ length: 12 }, (_, i) => `line ${i}: rank-token again`).join('\n'));
    // Touch the thin one LAST so recency would put it first if density did not.
    writeFileSync(join(vault, 'References', 'passing-mention.md'), 'rank-token once.\n');
    invalidateVault(vault);

    const ranked = searchVault(vault, 'rank-token');
    a.equal(ranked[0].path, 'References/all-about-it.md',
      `the densest match must come first, got ${ranked.map((r) => r.path).join(', ')}`);
    a.ok(ranked[0].hits > ranked[1].hits, 'and the count must reflect every occurrence, not just shown lines');
  }

  // --- the on-disk index is a CACHE, never a source of truth ---------------
  // It seeds a cold process (938ms of per-file reads -> 43ms) but every entry
  // is checked against the real mtime, so it must be impossible for a stale or
  // corrupt index to produce a wrong answer.
  {
    const { vaultIndexPath } = await import('../src/vault.js');
    const idx = vaultIndexPath(vault);

    // Build the index, then EDIT a note behind its back.
    invalidateVault(vault);
    searchVault(vault, 'anything');
    a.ok(existsSync(idx), 'a search must leave an index behind for the next process');

    const drift = join(vault, 'References', 'Model Guidance.md');
    writeFileSync(drift, 'Pricing changed: newprice-token-3312\n');
    invalidateVault(vault);                       // simulate a cold process
    a.equal(searchVault(vault, 'newprice-token-3312').length, 1,
      'a note edited after the index was written must still be found');
    a.equal(searchVault(vault, 'Use Haiku for cheap bulk work').length, 0,
      'and the superseded text must NOT come back from the index');

    // A corrupt index must degrade to a rebuild, not an exception.
    writeFileSync(idx, '{ this is not json');
    invalidateVault(vault);
    a.equal(searchVault(vault, 'newprice-token-3312').length, 1,
      'a corrupt index must be ignored and rebuilt, not thrown');

    // ...and an index describing files that no longer exist must not resurrect
    // them. This is the failure that would quietly haunt a court for weeks.
    const ghost = join(vault, 'References', 'ghost-note.md');
    writeFileSync(ghost, 'ghost-token-8891\n');
    invalidateVault(vault);
    a.equal(searchVault(vault, 'ghost-token-8891').length, 1, 'sanity: the ghost exists');
    rmSync(ghost, { force: true });
    invalidateVault(vault);
    a.equal(searchVault(vault, 'ghost-token-8891').length, 0,
      'a deleted note must not be resurrected from the index');
    console.log('  on-disk index seeds cold starts without ever serving stale text');
  }

  // --- a writer names the file it wrote, instead of nuking the corpus ------
  // invalidateVault() drops everything, so the next search re-walks and
  // re-stats all 1,409 notes: 177ms per write-then-search cycle. The writer
  // already knows its one path — updating just that entry is 22ms.
  {
    const { noteWritten } = await import('../src/vault.js');
    process.env.KINGDOM_VAULT_WATCH = '0';        // isolate: no watcher to rescue this
    process.env.KINGDOM_VAULT_REVALIDATE_MS = '600000';
    invalidateVault(vault);
    searchVault(vault, 'seed');                   // establish a corpus

    const note = join(vault, 'References', 'targeted.md');
    writeFileSync(note, 'targeted-token-4820\n');
    noteWritten(vault, note);
    a.equal(searchVault(vault, 'targeted-token-4820').length, 1,
      'a named write must be visible with no sweep and no invalidate');

    // The replacement must NOT mention the old token, or "the old text is
    // gone" would be checking nothing.
    writeFileSync(note, 'now says edited-token-9134 only\n');
    noteWritten(vault, note);
    a.equal(searchVault(vault, 'edited-token-9134').length, 1, 'an edit likewise');
    a.equal(searchVault(vault, 'targeted-token-4820').length, 0, 'and the old text must go');

    rmSync(note, { force: true });
    noteWritten(vault, note);
    a.equal(searchVault(vault, 'edited-token-9134').length, 0,
      'and a delete must remove it, not leave a ghost');

    // The rest of the corpus must be untouched by a targeted update.
    a.ok(searchVault(vault, 'bulktoken').length > 0, 'other notes must survive a targeted write');
    console.log('  writers name the note they changed; no full rescan per write');
  }

  // --- the watcher, which is what makes repeat searches free ---------------
  // Re-stat-ing 1,409 files cost 134ms and ran every 4s. A recursive watcher
  // answers the same question in 1-2ms. It must be a pure optimisation: never
  // a reason for the court to read something stale.
  {
    const { closeVaultWatchers } = await import('../src/vault.js');
    closeVaultWatchers();
    delete process.env.KINGDOM_VAULT_WATCH;                 // watcher ON
    process.env.KINGDOM_VAULT_REVALIDATE_MS = '600000';     // polling CANNOT rescue this
    process.env.KINGDOM_VAULT_BACKSTOP_MS = '600000';       // nor can the backstop
    invalidateVault(vault);
    searchVault(vault, 'seed');                             // establish the cache + watcher

    const watched = join(vault, 'References', 'watched-note.md');
    writeFileSync(watched, 'watcher-token-6620\n');
    // No invalidate, no poll, no backstop — only the watcher can find this.
    for (let i = 0; i < 100 && !searchVault(vault, 'watcher-token-6620').length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    a.equal(searchVault(vault, 'watcher-token-6620').length, 1,
      'the watcher must notice a new note with no poll and no invalidate');

    writeFileSync(watched, 'watcher-token-6620 became replaced-token-7731\n');
    for (let i = 0; i < 100 && !searchVault(vault, 'replaced-token-7731').length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    a.equal(searchVault(vault, 'replaced-token-7731').length, 1, 'and an edit to an existing note');

    rmSync(watched, { force: true });
    for (let i = 0; i < 100 && searchVault(vault, 'replaced-token-7731').length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    a.equal(searchVault(vault, 'replaced-token-7731').length, 0, 'and a deletion');

    closeVaultWatchers();
    delete process.env.KINGDOM_VAULT_BACKSTOP_MS;
    console.log('  watcher keeps the corpus fresh without the 134ms stat sweep');
  }

  process.env.KINGDOM_VAULT_WATCH = '0';   // isolate the polling path again
  process.env.KINGDOM_VAULT_REVALIDATE_MS = '1';
  callTool('vault_write', { title: 'Second Process Probe', body: 'wisp-token-5540' });
  await new Promise((r) => setTimeout(r, 20));
  a.equal(searchVault(vault, 'wisp-token-5540').length, 1,
    'the corpus must revalidate on its own, not only when a writer asks it to');
  delete process.env.KINGDOM_VAULT_REVALIDATE_MS;
  delete process.env.KINGDOM_VAULT_WATCH;
  console.log('  search corpus cached; writes, edits and deletes stay coherent');
}

// --- the on-disk index is throttled ACROSS PROCESSES, not per process ------
//
// Every member runs its own mcp.js. A per-process timer lets a court of
// sixteen each rewrite the same 9.7MB index once a minute — the same file,
// sixteen times, for a cache that only has to be roughly right. The index's
// own mtime is the shared clock.
//
// This must be two real processes: the in-memory throttle would pass a
// single-process version of this test while the bug was fully present.
{
  const { execFileSync } = await import('node:child_process');
  const { vaultIndexPath } = await import('../src/vault.js');
  const { pathToFileURL } = await import('node:url');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const idx = vaultIndexPath(vault);
  rmSync(idx, { force: true });

  const run = (script) => execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_VAULT_WATCH: '0' },
  }).trim();

  const load = `const {searchVault}=await import(${JSON.stringify(pathToFileURL(join(HERE, '..', 'src', 'vault.js')).href)});`
    + `searchVault(${JSON.stringify(vault)},'anything');`
    + `console.log(require('node:fs').statSync(${JSON.stringify(idx)}).mtimeMs);`;

  const built = Number(run(`(async()=>{${load}})()`));
  a.ok(built > 0, 'a cold process must build the index — that is what it is for');

  // A second process, with an empty in-memory throttle, finding a fresh index
  // and a changed vault. It must leave the file alone.
  writeFileSync(join(vault, 'Kingdom', 'Churn Probe.md'), 'index-churn-token-8814\n');
  const after = Number(run(`(async()=>{${load}})()`));
  a.equal(after, built,
    'a second process must not rewrite an index another process just wrote — '
    + 'the throttle is the file\'s mtime, not a timer inside one process');

  // And the throttle must expire, or the index would freeze at its first
  // version forever and stop being a useful seed.
  const stale = execFileSync(process.execPath, ['-e', `(async()=>{${load}})()`], {
    encoding: 'utf8',
    env: { ...process.env, KINGDOM_VAULT_WATCH: '0', KINGDOM_VAULT_INDEX_MS: '0' },
  }).trim();
  a.ok(Number(stale) > built, 'with the window closed, a changed vault must rewrite the index');

  rmSync(join(vault, 'Kingdom', 'Churn Probe.md'), { force: true });
  console.log('  the index is written at most once a minute by the whole court, not once per member');
}

// --- a project with an attached repo gets its own mirror of what the court
// wrote about it, so that project's .kingdom folder is never missing what
// the shared vault knows, even though the vault itself stays put -----------
{
  const { kingdomDir } = await import('../src/worktree.js');
  const repo = mkdtempSync(join(tmpdir(), 'kingdom-mirror-repo-'));

  const saved = callTool('vault_write',
    { title: 'Mirror Probe', body: 'mirror-token-2291' },
    { KINGDOM_REPO: repo });
  a.match(saved, /Kingdom[\/\\]/);
  const mirrored = join(kingdomDir(repo), 'vault', 'Kingdom', 'Mirror Probe.md');
  a.ok(existsSync(mirrored), 'a vault write for an attached repo must be mirrored into its .kingdom folder');
  a.match(readFileSync(mirrored, 'utf8'), /mirror-token-2291/, 'the mirror must carry the real content');

  const remembered = callTool('remember',
    { campaign: 1, title: 'Mirror remember probe', body: 'discovered the hard way' },
    { KINGDOM_REPO: repo });
  a.match(remembered, /No campaign #1/,
    'remember must not write directly when there is no closed campaign to ground a proposal');
  const mirroredMemory = join(kingdomDir(repo), 'vault', 'Kingdom', 'Memories', 'Mirror remember probe.md');
  a.ok(!existsSync(mirroredMemory), 'a memory must not exist until the sovereign approves its proposal');

  // No repo attached: a write must NOT touch the shared homedir workspace —
  // that would be silent pollution of the machine's real state on every test run.
  const { homedir } = await import('node:os');
  const workspaceVault = join(homedir(), '.kingdom', 'workspace', 'vault', 'Kingdom', 'Reframe route needs SSRF guard.md');
  a.ok(!existsSync(workspaceVault), 'a repo-less write must not fall back to mirroring the real homedir workspace');

  try { rmSync(kingdomDir(repo), { recursive: true, force: true }); } catch {}
  try { rmSync(repo, { recursive: true, force: true }); } catch {}
  console.log('  a repo\'s own .kingdom folder mirrors what the shared vault just learned about it');
}

try { rmSync(vault, { recursive: true, force: true }); } catch {}
console.log('t-vault.js OK — search, read, confined writes, no traversal, .obsidian/.trash skipped');
