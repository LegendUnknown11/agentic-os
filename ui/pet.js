// The court dog.
//
// HappyDog, lifted from the sovereign's own Codex pets
// (~/.codex/pets/happydog). Codex ships a plain sprite sheet and no manifest
// beyond a name, so the geometry below was measured off the image rather than
// read from anywhere: 1536x1872, an 8-column grid of 192x208 cells, nine rows,
// each row one animation with a different number of live frames. The trailing
// cells of a short row are transparent — playing them would show a blank patch
// for a third of a second, which is why FRAMES exists.
//
// He is not decoration. He reports the court: asleep when nobody is working,
// running while a member has a turn in flight, cheering on a merge. That makes
// him the one thing on screen you can read from across the room.
const SHEET = 'pet/happydog.webp';
const COLS = 8, ROWS = 9, CW = 192, CH = 208;

// row -> live frames, measured by alpha coverage per cell.
const FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];

/** name -> [row, ms per frame, loops?] */
const CLIP = {
  idle:  [0, 220, true],    // sitting, blinking
  run:   [1, 90,  true],    // legs out, going somewhere
  dash:  [2, 80,  true],
  wave:  [3, 180, false],   // paw up
  play:  [4, 140, false],   // bouncing about
  sleep: [5, 420, true],    // droops, curls up, lies down
  sit:   [6, 260, true],
  cheer: [7, 120, false],
  groom: [8, 200, false],   // washing a paw
};

/**
 * What the court is doing -> what the dog is doing. One indirection so callers
 * talk about the kingdom, not about sprite rows.
 */
const MOOD = { working: 'run', idle: 'idle', asleep: 'sleep', cheer: 'cheer', upset: 'groom' };

/**
 * The rule for turning a roster into a mood, in one place because two windows
 * ask it: the throne room's rail dog and the floating desktop dog.
 * @param {Iterable<{awake:boolean, busy:boolean}>} members
 */
export function moodOf(members) {
  let awake = 0, busy = 0;
  for (const m of members) {
    if (!m.awake) continue;
    awake++;
    if (m.busy) busy++;
  }
  if (busy) return 'working';
  return awake ? 'idle' : 'asleep';
}

// Fidgets: on a long idle he does something small, then settles. Without this
// he is a looping gif and you stop seeing him within a minute.
//
// Every one of these MUST be a non-looping clip. A fidget only ends when its
// clip wraps and clears `once`, so a looping one never returns — `sit` was in
// here and pinned him in it permanently.
const FIDGET = ['wave', 'groom', 'play'];

let el, timer, clip = 'idle', frame = 0, mood = 'idle', sinceFidget = 0;
let once = null;   // a non-looping clip to finish before returning to mood

export function initPet(host) {
  el = document.createElement('button');
  el.id = 'pet';
  el.title = 'HappyDog — asleep when the court is, running when it is working';
  el.setAttribute('aria-label', 'Court pet');
  el.style.backgroundImage = `url("${SHEET}")`;
  // One place decides the on-screen size; the sheet scales to match.
  el.style.backgroundSize = `${COLS * 100}% ${ROWS * 100}%`;
  el.onclick = () => play('play');
  host.append(el);
  apply();
  tick();
  applyHidden();
  return el;
}

/** Play a one-shot clip, then fall back to the standing mood. */
export function play(name) {
  if (!CLIP[name] || !el) return;
  if (CLIP[name][2]) return;   // a looping clip as a one-shot would never end
  once = name;
  clip = name;
  frame = 0;
  restart();
}

/** The standing state. Ignored while a one-shot is finishing. */
export function setMood(next) {
  if (!el) return;   // no dog in this window (Electron gives him his own)
  const want = MOOD[next] ?? 'idle';
  if (want === mood) return;
  mood = want;
  sinceFidget = 0;
  if (!once) { clip = mood; frame = 0; restart(); }
}

function restart() {
  clearTimeout(timer);
  apply();
  tick();
}

function tick() {
  const [, ms] = CLIP[clip];
  timer = setTimeout(() => {
    const [row, , loops] = CLIP[clip];
    frame++;
    if (frame >= FRAMES[row]) {
      frame = 0;
      if (!loops) {
        // A one-shot ends by going back to whatever the court is doing.
        once = null;
        clip = mood;
      } else if (clip === mood && mood === 'idle' && ++sinceFidget >= 3) {
        sinceFidget = 0;
        return play(FIDGET[Math.floor(Math.random() * FIDGET.length)]);
      }
    }
    apply();
    tick();
  }, ms);
}

function apply() {
  const [row] = CLIP[clip];
  // Percentage background-position on a scaled sheet: with N columns the step
  // between cells is 100/(N-1) percent, NOT 100/N. Getting this wrong shifts
  // every frame but the first and looks like a corrupt sheet.
  el.style.backgroundPosition =
    `${(frame * 100) / (COLS - 1)}% ${(row * 100) / (ROWS - 1)}%`;
  el.dataset.clip = clip;
}

/* ---------- showing and hiding ---------- */
const applyHidden = () =>
  document.body.classList.toggle('no-pet', localStorage.getItem('kd.pet') === '0');

export function toggle() {
  localStorage.setItem('kd.pet', localStorage.getItem('kd.pet') === '0' ? '1' : '0');
  applyHidden();
  return localStorage.getItem('kd.pet') !== '0';
}

export const aspect = () => ({ CW, CH });
