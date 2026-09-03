// Sound is the one retained feedback cue. The old arrival/departure animation
// belonged to the floating rail and has no place in the fixed layout.
import { setPrefs, state } from './store.js';

let ctx = null;
const audio = () => (ctx ??= new (window.AudioContext ?? window.webkitAudioContext)());

export const soundOn = () => state.prefs.sound !== false;
export const setSound = (on) => setPrefs({ sound: Boolean(on) });

function note(freq, { at = 0, len = 0.16, gain = 0.055, type = 'sine' } = {}) {
  const a = audio();
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const amp = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(amp).connect(a.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
}

const CUES = {
  summon: () => { note(392, { type: 'triangle' }); note(587.33, { at: 0.09, len: 0.24, type: 'triangle' }); },
  dismiss: () => { note(392, { type: 'triangle', gain: 0.04 }); note(261.63, { at: 0.08, len: 0.2, type: 'triangle', gain: 0.04 }); },
  approve: () => { note(523.25, { len: 0.12 }); note(783.99, { at: 0.07, len: 0.3 }); },
  reject: () => note(174.61, { len: 0.22, gain: 0.05, type: 'triangle' }),
};

export function cue(name) {
  if (!soundOn() || !CUES[name]) return;
  try { CUES[name](); } catch { /* sound must never block an action */ }
}
