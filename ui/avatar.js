// The state light beside a member's name — and, since the left-rule-to-dot
// sweep (issue #39/#48), beside a task, a Doctor check, or a run deliverable
// too. One shape, reused wherever a row needs to say how it's going.
//
// This file used to draw a face: a hue-derived monogram disc, one per member,
// on the argument that people recognise a colour faster than they read a word.
// The discs were removed on the sovereign's instruction. What was INSIDE one is
// not decoration and stays: a single dot carrying four states —
//
//   awake    a live process
//   resting  in the crew, idle-slept, revives on its next message (hollow ring)
//   busy     mid-turn
//   failed   the process died
//
// live pulses (ui/app.css .status-dot.live) rather than a separate `.busy`
// class — busy is just the live tone's original case, and every other
// "actively in progress" row now reads the same way.
// The states are painted in ui/app.css off the row's classes, not from here, so
// this stays a shape and the rail stays the thing that knows what is happening.
// `name` and `role` are still taken and still ignored: five call sites pass
// them, and a signature that changes for no behaviour is a diff nobody can
// review. They come back the moment the light needs to say WHO as well as what.

/**
 * @param {string} _name  unused — see above
 * @param {string} _role  unused — see above
 */
export function statusDot(_name, _role) {
  const el = document.createElement('span');
  el.className = 'status-dot';
  el.setAttribute('aria-hidden', 'true');
  el.append(document.createElement('i'));
  return el;
}
