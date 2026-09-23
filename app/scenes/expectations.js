// What each capability scenario must actually achieve, measured frame by
// frame while it plays: the drawer opens and closes, the crate moves, the
// ball is caught in the air. The checks run these alongside the clean-play
// rules (no penetration, grips hold, continuity), so a scenario that plays
// cleanly but does nothing still fails.
//
// measure(c) returns numbers for this frame; verify(m, r) gets, per name,
// { first, last, min, max } plus the audit record r, and returns [ok, note].
import { v3, quat } from '../../hands/src/index.js';

const lift = (c, name) => c.body(name).pos[1] - c.body(name).home.pos[1];
const fromHome = (c, name) => v3.dist(c.body(name).pos, c.body(name).home.pos);
const held = (c, side, name) => { const h = c.hands.interaction.hold[side]; return h && h.body === c.body(name) ? 1 : 0; };
const f = (x, d = 3) => x.toFixed(d);

function liftAndReturn(names) {
  return {
    measure: (c) => Object.fromEntries(names.flatMap((n) => [[`${n}Lift`, lift(c, n)], [`${n}Home`, fromHome(c, n)]])),
    verify: (m) => {
      const bad = names.filter((n) => !(m[`${n}Lift`].max >= 0.03 && m[`${n}Home`].last <= 0.015));
      return [bad.length === 0, names.map((n) => `${n} up ${f(m[`${n}Lift`].max * 100, 1)} cm, back within ${f(m[`${n}Home`].last * 1000, 1)} mm`).join('; ')];
    },
  };
}

export const EXPECT = {
  grabCarryPlace: {
    measure: (c) => ({ lift: lift(c, 'rock'), moved: fromHome(c, 'rock'), held: held(c, 'right', 'rock') }),
    verify: (m) => [m.held.max === 1 && m.lift.max >= 0.05 && m.moved.last >= 0.08, `lifted ${f(m.lift.max * 100, 1)} cm, set down ${f(m.moved.last * 100, 1)} cm from where it was`],
  },
  padPinch: liftAndReturn(['pebbleS', 'pebbleM', 'pebbleL']),
  tripod: liftAndReturn(['pebbleS', 'pebbleM', 'pebbleL']),
  lateralPinch: liftAndReturn(['card']),
  hook: {
    measure: (c) => ({ lift: lift(c, 'bag'), held: held(c, 'left', 'bag') }),
    verify: (m) => [m.held.max === 1 && m.lift.max >= 0.05 && Math.abs(m.lift.last) <= 0.01, `bag carried ${f(m.lift.max * 100, 1)} cm up by its strap, set down level`],
  },
  powerGrip: liftAndReturn(['handle']),
  sphericalGrip: liftAndReturn(['ball']),
  twoHand: {
    measure: (c) => ({ both: held(c, 'left', 'box') * held(c, 'right', 'box'), lift: lift(c, 'box') }),
    verify: (m, r) => [m.both.max === 1 && m.lift.max >= 0.05 && r.grasped >= 2, `both hands on the box, lifted ${f(m.lift.max * 100, 1)} cm, set back ${f(m.lift.last * 1000, 1)} mm off its rest`],
  },
  handover: {
    measure: (c) => ({ right: held(c, 'right', 'handle'), left: held(c, 'left', 'handle'), both: held(c, 'left', 'handle') * held(c, 'right', 'handle'), x: c.body('handle').pos[0] - c.body('handle').home.pos[0], rest: c.world.isSupported(c.body('handle')) && !c.body('handle').heldBy ? 1 : 0 }),
    verify: (m) => [m.right.max === 1 && m.both.max === 1 && m.left.max === 1 && m.x.last < -0.08 && m.rest.last === 1, `right hand holds, both hold at the pass, the left hand lays it on the bench ${f(-m.x.last * 100, 1)} cm to the left, at rest`],
  },
  inHandRoll: spinIn('pebbleM'),
  inHandSpin: spinIn('dowel'),
  throwCatch: {
    measure: (c) => ({ right: held(c, 'right', 'ball'), left: held(c, 'left', 'ball') }),
    // Frames the ball flew touching nothing, counted up to the moment the
    // left hand took it: a catch in the air, not off the table.
    run: (c, st) => {
      const b = c.body('ball');
      const free = !b.heldBy && !b.contactThisStep.stat && !b.contactThisStep.hand && !b.contactThisStep.body;
      const L = held(c, 'left', 'ball');
      if (L && !st.prevL) st.flight = st.run || 0;
      st.run = free ? (st.run || 0) + 1 : 0;
      st.prevL = L;
    },
    verify: (m, r, st) => [m.right.max === 1 && m.left.max === 1 && (st.flight || 0) >= 6, `thrown by the right hand, ${st.flight || 0} frames in the air touching nothing, caught by the left`],
  },
  slipHeavy: { measure: () => ({}), verify: (m, r) => [r.slipped >= 1, `${r.slipped} slip`] },
  slipJerk: { measure: () => ({}), verify: (m, r) => [r.slipped >= 1, `${r.slipped} slip`] },
  pressButton: {
    measure: (c) => ({ q: c.prop('button').q }),
    verify: (m) => [m.q.max >= 0.006 && m.q.last <= 0.001, `pressed ${f(m.q.max * 1000, 1)} mm of 8, sprang back to ${f(m.q.last * 1000, 1)} mm`],
  },
  flipSwitch: {
    measure: (c) => ({ q: c.prop('switch').q }),
    verify: (m) => [m.q.first > 0.3 && m.q.last < -0.3, `toggle from ${f(m.q.first, 2)} to ${f(m.q.last, 2)} rad, over its centre`],
  },
  turnKnob: {
    measure: (c) => ({ q: c.prop('knob').q }),
    verify: (m) => [Math.max(Math.abs(m.q.min), Math.abs(m.q.max)) >= 0.6, `turned ${f(Math.max(Math.abs(m.q.min), Math.abs(m.q.max)), 2)} rad`],
  },
  pullLever: {
    measure: (c) => ({ q: c.prop('lever').q }),
    verify: (m) => [m.q.max >= 0.5, `pulled through ${f(m.q.max, 2)} rad`],
  },
  drawer: {
    measure: (c) => ({ q: c.prop('drawer').q }),
    verify: (m) => [m.q.max >= 0.12 && m.q.last <= 0.02, `opened ${f(m.q.max * 100, 1)} cm, closed to ${f(m.q.last * 1000, 1)} mm`],
  },
  pushCrate: {
    measure: (c) => ({ z: c.body('crate').pos[2], y: c.body('crate').pos[1] }),
    verify: (m) => [m.z.first - m.z.last >= 0.08 && Math.abs(m.y.last - m.y.first) <= 0.01, `pushed ${f((m.z.first - m.z.last) * 100, 1)} cm, still on the bench`],
  },
  dragCrate: {
    measure: (c) => ({ z: c.body('crate').pos[2], y: c.body('crate').pos[1] }),
    verify: (m) => [m.z.last - m.z.first >= 0.08 && Math.abs(m.y.last - m.y.first) <= 0.01, `dragged ${f((m.z.last - m.z.first) * 100, 1)} cm, still on the bench`],
  },
  hang: {
    measure: (c) => ({ bothLow: c.hands.interaction.hold.left && c.hands.interaction.hold.right ? c.hands.rig.body[1] : 0 }),
    verify: (m) => [m.bothLow.min <= -0.05, `body hangs ${f(-m.bothLow.min * 100, 1)} cm below standing from both hands`],
  },
  climb: {
    measure: (c) => ({ y: c.hands.rig.body[1] }),
    verify: (m, r) => [m.y.max >= 0.7 && r.grasped >= 5, `body up ${f(m.y.max, 2)} m over ${r.grasped} grips`],
  },
  rope: {
    measure: (c) => { const rope = c.rope('rope'); const i = 18; const moved = rope.home ? v3.dist(rope.points[i], rope.home[i]) : 0; return { moved: c.hands.interaction.hold.right ? moved : 0 }; },
    verify: (m) => [m.moved.max >= 0.05, `the rope moves with the hand, ${f(m.moved.max * 100, 1)} cm`],
    setup: (c) => { const rope = c.rope('rope'); rope.home = rope.points.map((p) => p.slice()); },
  },
};

// Turned in the grip: the object's turn in the wrist frame away from how it
// was taken.
function spinIn(name) {
  return {
    measure: (c) => {
      const a = c.hands.rig.hands.right.attached;
      if (!a || !held(c, 'right', name)) return { turn: 0 };
      c.state.spin0 = c.state.spin0 || a.attachment.rot.slice();
      return { turn: quat.angleBetween(c.state.spin0, a.attachment.rot) };
    },
    verify: (m) => [m.turn.max >= 1.2, `turned ${f(m.turn.max, 2)} rad in the fingers`],
  };
}
