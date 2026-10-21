// The floating desktop dog.
//
// Same sprite engine as the rail dog (pet.js); what this file adds is the two
// things a desktop pet needs and a page cannot do on its own: knowing what the
// team is doing without the dashboard being open, and being moved and
// resized on the desktop.
//
// It talks to the team over the same HTTP origin it was served from, so no
// IPC is needed for state — only for the window itself.
import { initPet, setMood, play, moodOf } from './pet.js';

const bridge = window.agenticosPet;   // from electron/pet-preload.cjs
const el = initPet(document.body);
// initPet's tooltip explains him in the rail, where it sits harmlessly beside
// a list. Here the window IS the dog, so the tooltip lands squarely on top of
// him every time the cursor rests — which is most of the time.
el.removeAttribute('title');
document.getElementById('shoo').onclick = () => bridge?.hide();

/* ---------- what the team is doing ---------- */
// name -> {awake, busy}. Rebuilt from the same events the dashboard reads,
// so the dog is correct whether or not that window is open.
const team = new Map();
const sync = () => setMood(moodOf(team.values()));

function connect() {
  const es = new EventSource('/stream');
  es.onopen = () => document.body.classList.remove('offline');
  es.onerror = () => {
    document.body.classList.add('offline');
    // EventSource reconnects on its own; until it does, an unknown team is
    // reported as a sleeping one rather than as a working one.
    team.clear();
    sync();
  };
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    switch (d.type) {
      case 'snapshot':
      case 'roster':
        team.clear();
        for (const r of d.roster ?? []) team.set(r.name, { awake: r.awake, busy: false });
        break;
      case 'agent':
        if (d.state === 'awake') team.set(d.name, { awake: true, busy: false });
        else if (d.state === 'exited') team.set(d.name, { awake: false, busy: false });
        break;
      case 'event': {
        const m = team.get(d.name) ?? { awake: true, busy: false };
        // A turn ending is the only event that means "no longer working"; text
        // and tool events all mean the opposite.
        m.awake = true;
        m.busy = d.kind !== 'turn_end';
        team.set(d.name, m);
        break;
      }
      case 'merged':
      case 'milestone':
        play('cheer');
        break;
      default:
        return;   // nothing else changes what he should be doing
    }
    sync();
  };
}
connect();

// Opened in an ordinary browser tab rather than the Electron pet window: he
// has no window to move or resize, so the controls that pretend otherwise go
// away and he just sits there reporting the team. This page gets opened that
// way by accident often enough — a preview pane, a stray tab — that failing
// loudly would only look like a bug.
document.body.classList.toggle('no-bridge', !bridge);

/* ---------- size ---------- */
const size = document.getElementById('size');
const setScale = (s) => document.body.style.setProperty('--s', String(s));

if (bridge) {
  bridge.state().then(({ scale }) => { size.value = String(scale); setScale(scale); });
  size.oninput = () => { setScale(size.value); bridge.scale(Number(size.value)); };
  // The slider is inside the drag handle's window; without this a drag of the
  // thumb would also be read as a grab of the dog.
  size.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/* ---------- dragging ----------
 * All the arithmetic lives in the main process, driven by the OS cursor. The
 * renderer's own screenX/screenY cannot be used: Chromium caches the window's
 * screen origin and updates it a beat after the window moves, so every frame
 * measured against a stale origin and fed the error back into the next move —
 * hold the dog still and he sails off across the desktop.
 */
let dragging = false;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !bridge) return;
  dragging = true;
  document.body.classList.add('dragging');
  try { el.setPointerCapture(e.pointerId); } catch { /* nice to have */ }
  bridge.dragStart();
});

async function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  // Click and drag share a button, so the click only counts if he did not
  // travel — otherwise every drop would also make him bounce. The main process
  // is the one that knows, because it is the one that moved him.
  if (!await bridge.dragEnd()) play('play');
}

// Listened for on the WINDOW, not just the dog. setPointerCapture can fail —
// it is in a try/catch precisely because it does — and the window is moving
// out from under the cursor while the button is held, so a pointerup aimed at
// the dog can easily land somewhere else. Every one of these routes a release
// back to endDrag; missing it leaves him glued to the cursor.
for (const ev of ['pointerup', 'pointercancel', 'mouseup']) {
  window.addEventListener(ev, endDrag, true);
}
window.addEventListener('blur', endDrag);
// The last resort: any movement with no button held means the release already
// happened and nobody told us.
window.addEventListener('pointermove', (e) => { if (dragging && !e.buttons) endDrag(); }, true);

// initPet wires click-to-play for the in-app dog; where a bridge exists the
// pointer handlers above own that, and leaving both on made one click play
// twice. With no bridge there is no drag, so its click is all he has.
if (bridge) el.onclick = null;
