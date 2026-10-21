// The pure control flow behind the "End team and switch to this
// repository…" action, pulled out of main.js so it can run under a plain
// Node test with fake dependencies instead of a real Electron process, a
// real daemon, and a real confirmation dialog.
//
// Order matters and is exactly what makes this worth testing on its own:
// validate BEFORE confirming (a bad path must never reach the user's "are
// you sure"), confirm BEFORE anything destructive, end the old team BEFORE
// starting a new one, and only reload once the new team actually answered.
export async function switchRepo(rawPath, { resolve, assertRepo, confirm, shutdown, teamOnPort, startDaemon, reload, logPath, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!rawPath) return { ok: false, error: 'Choose a repository first.' };
  const repo = resolve(String(rawPath));

  try {
    await assertRepo(repo);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const proceed = await confirm(repo);
  if (!proceed) return { canceled: true };

  // A refused shutdown must stop here: waiting for the port to free would
  // only time out, and starting a second team beside the old one is wrong.
  const down = await shutdown();
  if (down?.ok === false) return { ok: false, error: down.error };

  const freeBy = now() + 15_000;
  while (await teamOnPort()) {
    if (now() > freeBy) return { ok: false, error: 'The previous workspace did not end in time. Try again in a moment.' };
    await wait(300);
  }

  try {
    await startDaemon(repo, logPath);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  reload();
  return { ok: true, repo };
}
