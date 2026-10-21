// Parsing the output of third-party CLIs.
//
// Separate from doctor.js because doctor.js runs its whole check suite on
// import — it is a script, not a library — so nothing can unit-test a function
// living inside it. The output format of somebody else's CLI is exactly the
// thing that changes without warning, so it is exactly the thing worth pinning.

/**
 * Model ids out of `agy models` output.
 *
 * Takes the FIRST field of each line, not the whole line. agy prints
 * `gemini-3.6-flash-high<TAB>Gemini 3.6 Flash (High)`, and a matcher anchored
 * to the whole line rejects every one of them. That is not hypothetical: it
 * reported a signed-in CLI with 11 models as "probably not signed in" and told
 * the user the team would not work until they fixed it.
 *
 * A health check that fails when everything is fine is worse than no health
 * check — it sends people to fix nothing, and it teaches them to ignore the
 * next failure, which will be real.
 *
 * Accepts a bare id too, so a format change back does not break it again.
 */
export const parseModels = (out) => String(out).split('\n')
  .map((s) => s.trim().split(/\t|\s{2,}/)[0].trim())
  .filter((s) => /^[a-z0-9][\w.\-]+$/i.test(s));
