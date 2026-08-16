// Weight. What a summon feels like, not just what it looks like afterwards.
//
// Everything the court does used to happen instantly and silently: a member
// appeared in the rail fully formed, a dismissed one vanished between frames,
// and a turn starting looked the same as a turn that had been running for a
// minute. The state was all correct and none of it was FELT — you had to reread
// the screen to notice anything had changed, which is the difference between an
// interface you operate and one you inhabit.
//
// Two rules this file obeys:
//
//   1. Nothing here carries information that is not also carried elsewhere. The
//      motion says "this just changed" and the sound says "the thing you
//      clicked landed" — the words and the status light say what actually
//      happened. Turn it all off and the app still works, which is why
//      prefers-reduced-motion can turn it all off.
//
//   2. Sound only ever follows a click of yours. Background events — a turn
//      ending, a message arriving, a peasant waking on its own — stay silent.
//      An orchestrator that chimes at you while you are in another window is one
//      you mute permanently, and then the cues you DID want are gone too.

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(.22,1,.36,1)';

/* ---------------- motion ---------------- */

/**
 * A member takes their place in the court.
 *
 * WAAPI rather than a CSS animation on the row, because rail.js rebuilds the
 * list on every summon to re-sort it — the same element is re-appended, which
 * replays a CSS entrance animation for every existing row as well. An explicit
 * call fires once, on the row that is actually new.
 */
export function arrive(el) {
  if (REDUCED.matches || !el) return;
  el.animate(
    [
      { opacity: 0, transform: 'translateX(-10px)', filter: 'brightness(2.2)' },
      { opacity: 1, transform: 'translateX(0)', filter: 'brightness(1)' },
    ],
    { duration: 420, easing: EASE },
  );
}

/**
 * A member leaves.
 *
 * The row has to still be in the DOM while this runs, so the caller passes what
 * to do when it finishes rather than removing the element itself. `finished`
 * can reject if the element is torn down mid-flight (a roster refresh landing
 * on top of a dismiss), so the removal is in a `finally` — a member who fails
 * to animate out must still leave.
 */
export function depart(el, done) {
  if (REDUCED.matches || !el) return done();
  const h = el.offsetHeight;
  el.style.overflow = 'hidden';
  // Padding collapses with the height. Without it a row animating to height 0
  // still leaves its 8px top and bottom padding behind, so the list twitches
  // shut by 16px at the end instead of closing smoothly.
  el.animate(
    [
      { opacity: 1, height: `${h}px`, paddingTop: '8px', paddingBottom: '8px',
        transform: 'translateX(0)' },
      { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px',
        transform: 'translateX(-14px)' },
    ],
    { duration: 260, easing: EASE },
  ).finished.catch(() => {}).finally(done);
}

/** Something about this element just became true. One ring, outward. */
export function pulse(el, colour = 'rgba(69,236,198,.55)') {
  if (REDUCED.matches || !el) return;
  el.animate(
    [
      { boxShadow: `0 0 0 0 ${colour}` },
      { boxShadow: `0 0 0 9px transparent` },
    ],
    { duration: 620, easing: EASE },
  );
}

/* ---------------- sound ---------------- */

// Synthesised, not sampled. Four short cues is a few hundred bytes of maths
// against about 80KB of audio files that would have to be fetched, decoded,
// cached and shipped — and the daemon serves ui/ straight off disk with no
// build step, so every asset is a real file somebody has to keep.
let ctx = null;
const audio = () => {
  // Created on the first cue, never at load. A page that opens an AudioContext
  // before the user has touched it gets one in `suspended` state in Chrome, and
  // the first sound that matters is then the one that gets dropped. Every call
  // site here is already inside a click handler, so this is always allowed.
  ctx ??= new (window.AudioContext ?? window.webkitAudioContext)();
  return ctx;
};

export const soundOn = () => localStorage.getItem('kd.sound') !== '0';
export const setSound = (on) => localStorage.setItem('kd.sound', on ? '1' : '0');

/**
 * One note. `type` shapes it, the gain envelope is what stops it sounding like
 * a test tone: a 12ms attack and an exponential tail is the difference between
 * a chime and a beep.
 */
function note(freq, { at = 0, len = 0.16, gain = 0.055, type = 'sine' } = {}) {
  const a = audio();
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const amp = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  // exponentialRamp can never reach zero, so it lands just above silence and
  // the oscillator stop does the rest.
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(amp).connect(a.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
}

const CUES = {
  // A horn call, rising: someone has been called to the court.
  summon: () => { note(392, { type: 'triangle' }); note(587.33, { at: 0.09, len: 0.24, type: 'triangle' }); },
  // The same interval, falling.
  dismiss: () => { note(392, { type: 'triangle', gain: 0.04 }); note(261.63, { at: 0.08, len: 0.2, type: 'triangle', gain: 0.04 }); },
  // A seal pressed: the sovereign has ruled on something.
  approve: () => { note(523.25, { len: 0.12 }); note(783.99, { at: 0.07, len: 0.3 }); },
  // Flat and low. Not alarming — this fires on a refusal, which is a normal
  // outcome, not a fault.
  reject: () => note(174.61, { len: 0.22, gain: 0.05, type: 'triangle' }),
};

/**
 * Play a cue, if the sovereign has not muted them.
 *
 * Never throws. Audio is decoration: a browser that refuses to start a context
 * (no output device, an autoplay policy this call did not satisfy) must cost
 * nothing more than silence, and certainly must not take the summon that was
 * being confirmed down with it.
 */
export function cue(name) {
  if (!soundOn() || !CUES[name]) return;
  try { CUES[name](); } catch { /* silence is the correct failure */ }
}
