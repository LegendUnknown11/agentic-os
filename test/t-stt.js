// Dictation through SpeechBird's local Whisper.
//
// Skips itself when SpeechBird is not installed, so `npm test` stays green on
// a machine that has never heard of it. When it IS installed this is a real
// end-to-end run: real audio, real model, real transcript.
//
//   node test/t-stt.js
import { strict as a } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Speech } from '../src/stt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'kingdom.config.json'), 'utf8'));
const speech = new Speech(process.env.KINGDOM_SPEECHBIRD ?? config.speechbird);

/* ---------- absence is not failure ---------- */
if (!speech.available()) {
  const missing = new Speech(null);
  a.equal(missing.available(), false, 'a missing SpeechBird must report unavailable, not throw');
  await a.rejects(() => missing.transcribe(Buffer.from('x')), /SpeechBird not found/,
    'and must say what to fix');
  console.log('t-stt.js SKIPPED — SpeechBird not installed (absence handled cleanly)');
  process.exit(0);
}

/* ---------- a real clip through the real model ---------- */
const clip = join(HERE, 'fixtures', 'hello.wav');
a.ok(existsSync(clip), `missing fixture ${clip}`);

const t0 = Date.now();
const text = await speech.transcribe(readFileSync(clip), 'wav');
const cold = Date.now() - t0;

a.equal(typeof text, 'string');
a.ok(text.length > 0, 'a spoken clip must transcribe to something');
console.log(`  cold: "${text}" (${cold}ms, model load included)`);

/* ---------- the point of a warm worker: the model stays loaded ---------- */
// Asserted on process identity, not the clock. The worker loads the model once
// before its stdin loop (see stt_worker.py), so "the same process served both
// clips" IS the claim — and it is true or false regardless of machine load.
//
// This was a wall-clock comparison (`warm < cold`) and it flaked: run alone the
// split is 42.6s cold against 17.9s warm, but inside the full suite the OS page
// cache from an earlier run made "cold" 14.1s and contention made "warm" 15.0s,
// so the assertion failed while the feature worked perfectly. A timing test
// that fails on noise trains people to ignore red, which costs more than it
// ever catches.
const pidBefore = speech.proc?.pid;
a.ok(pidBefore, 'a warm worker must still be running after the first clip');

const t1 = Date.now();
const again = await speech.transcribe(readFileSync(clip), 'wav');
const warm = Date.now() - t1;
a.equal(again, text, 'the same audio must transcribe the same way');
a.equal(speech.proc?.pid, pidBefore,
  'the second clip must be served by the SAME worker — a new pid means the '
  + 'model was reloaded and the warm path is not working');
console.log(`  warm: ${warm}ms on pid ${pidBefore} — model stayed loaded`
  + `${warm < cold ? '' : ' (slower than cold: machine under load, not a failure)'}`);

/* ---------- a dead worker restarts rather than wedging ---------- */
speech.stop();
const revived = await speech.transcribe(readFileSync(clip), 'wav');
a.equal(revived, text, 'a killed worker must respawn on the next clip');
console.log('  respawn after kill: OK');

/* ---------- garbage in, an error out, not a hang ---------- */
await a.rejects(() => speech.transcribe(Buffer.from('this is not audio'), 'webm'),
  'undecodable audio must reject');
const after = await speech.transcribe(readFileSync(clip), 'wav');
a.equal(after, text, 'a bad clip must not poison the worker');
console.log('  bad audio rejected, worker still usable');

speech.stop();
console.log('t-stt.js OK — local dictation via SpeechBird');
