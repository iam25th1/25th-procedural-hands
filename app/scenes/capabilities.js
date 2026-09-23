// Capability scenarios: each one is a short script of public API calls on
// the hands and the sandbox world, keyed by time. The checks sample every
// frame of each; the gallery renders chosen frames; the sandbox's capability
// matrix panel plays them. Station coordinates: x is relative to the
// scenario's station (ctx.P adds it).
import { v3, quat } from '../../hands/src/index.js';
import { TABLE_TOP } from './sandbox-world.js';

// A key that answers WAIT runs again next step, holding the script back.
export const WAIT = Symbol('wait');

// Hand orientations as [finger direction, palm direction] for the right
// hand; ctx.rot mirrors them for the left.
const DOWN = [[-0.22, -0.34, -0.91], [-0.05, -1, 0.12]];
const PINCH = [[-0.35, -0.5, -0.8], [-0.35, -0.85, 0.25]];
const TRIPOD = [[-0.3, -0.62, -0.73], [-0.25, -0.75, 0.55]];
const SIDEWAYS = [[-0.25, -0.05, -0.97], [-1, 0.05, 0.25]]; // thumb up, palm to the midline, fingers level
const OVERHAND = [[0, 0.35, -0.94], [0, -0.94, -0.35]]; // fingers forward over a bar
const PALM_UP = [[-0.3, 0.15, -0.94], [0.1, 1, 0.1]];

// Keys that take a world target where it lies: approach from `approach`
// metres back along the palm normal, close on it, lift.
function pick(t0, side, target, grip, hint, { approach = 0.07, lift = 0.08, at = [0, 0, 0], pole = null, from = null } = {}) {
  return [
    [t0, (c) => c.hands.reach(side, target(c), grip, { hint: c.rot(side, ...hint), approach, at, pole, from })],
    [t0 + 0.6, (c) => (c.hands.arrived(side) ? c.hands.reach(side, target(c), grip, { hint: c.rot(side, ...hint), at, pole, open: false }) : WAIT)],
    [t0 + 1.05, (c) => (c.hands.arrived(side) ? c.hands.grasp(side, target(c), grip) : WAIT)],
    [t0 + 1.35, (c) => { if (lift) c.nudge(side, [0, lift, 0]); }],
  ];
}

// Keys that lower a held body onto the surface under it and let go.
function place(t0, side, name, { surface = null, clear = 0.07, back = 0.02, openAfter = null } = {}) {
  return [
    // Down until the object meets the surface, or the fingers under it do.
    [t0, (c) => c.hands.setDown(side, surface)],
    [t0 + 0.55, (c) => (settled(c, side) ? c.hands.release(side, openAfter == null ? {} : { openAfter }) : WAIT)],
    [t0 + 1.05, (c) => c.nudge(side, [0, clear, back])],
  ];
}

const home = (side) => (c) => c.hands.moveTo(side, c.ready(side));
// Has a set-down finished (the object resting on its surface)?
const settled = (c, side) => { const d = c.hands.interaction.down && c.hands.interaction.down[side]; return !d || d.done; };
// The hand not taking part draws back out of the way of a long object.
const aside = (side) => (c) => { const r = c.ready(side); c.hands.setTarget(side, { ...r, pos: v3.add([0, 0, 0], r.pos, [side === 'left' ? -0.1 : 0.1, -0.1, 0.1]) }); };

// A smooth path for a hand's target between two times (eased in and out),
// for pushing and dragging, where a sudden target jump would yank.
function glide(side, t0, t1, delta) {
  return (c, t) => {
    if (t < t0 || t > t1 + 0.02) return;
    if (!c.state[`glide${t0}`]) c.state[`glide${t0}`] = c.hands.joint(side, 'wrist').pos.slice();
    const u = Math.min(1, (t - t0) / (t1 - t0));
    const k = u * u * (3 - 2 * u);
    // intent: a hand dragging or working something aims here and gets as
    // far as the thing lets it; a free hand simply goes there.
    c.hands.intent(side, { pos: v3.addScaled([0, 0, 0], c.state[`glide${t0}`], delta, k) });
  };
}

// Keys that carry a held body back to where it started (hovering `above`
// first), set it down there and let go.
function putBack(t0, side, name, { above = 0.04, clear = 0.06, surface } = {}) {
  const wristFor = (c, lift) => {
    const b = c.body(name);
    const wr = c.hands.joint(side, 'wrist');
    // A ball has no way up: move the hand by the offset and keep its turn.
    if (b.shape === 'sphere') return { pos: v3.add([0, 0, 0], v3.add([0, 0, 0], wr.pos, v3.sub([0, 0, 0], b.home.pos, b.pos)), [0, lift + 0.0006, 0]), rot: wr.rot };
    const inv = quat.conjugate([0, 0, 0, 1], b.rot);
    const wristInBody = { pos: quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], wr.pos, b.pos)), rot: quat.multiply([0, 0, 0, 1], inv, wr.rot) };
    const home = b.home;
    return { pos: v3.add([0, 0, 0], v3.add([0, 0, 0], home.pos, quat.rotate([0, 0, 0], home.rot, wristInBody.pos)), [0, lift + 0.0006, 0]), rot: quat.multiply([0, 0, 0, 1], home.rot, wristInBody.rot) };
  };
  return [
    [t0, (c) => c.hands.setTarget(side, wristFor(c, above))],
    [t0 + 0.7, (c) => c.hands.setDown(side, surface)],
    [t0 + 1.3, (c) => (settled(c, side) ? c.hands.release(side) : WAIT)],
    [t0 + 1.8, (c) => c.nudge(side, [0, clear, 0.02])],
  ];
}
const aim = (side, pos, hint, extra = {}) => (c) => c.hands.setTarget(side, { pos: c.P(...pos), rot: c.rot(side, ...hint), ...extra });
// Move the hand to a point keeping the turn it has (carrying something).
const carryTo = (side, pos) => (c) => c.hands.setTarget(side, { pos: c.P(...pos) });

// Pick, lift, hold, place back and let go: one object with one grip.
function pickAndReturn(t0, side, name, grip, hint, opts = {}) {
  return [
    ...pick(t0, side, (c) => c.body(name), grip, hint, opts),
    ...putBack(t0 + 1.8, side, name, { above: 0.02 }),
  ];
}

// A point along a long body's axis, d from its middle, on the end nearer
// the left hand, in the body's own frame.
function leftEnd(c, name, d) {
  const b = c.body(name);
  const ax = quat.rotate([0, 0, 0], b.rot, [0, 0, 1]);
  const w = c.hands.joint('left', 'wrist').pos;
  return [0, 0, v3.dot(v3.sub([0, 0, 0], w, b.pos), ax) > 0 ? d : -d];
}

// The pointing fingertip `off` metres out from the button's face.
const PRESS_HINT = [[-0.05, -0.1, -1], [-1, 0, 0.05]];
function pressAt(c, side, off) {
  // The turn is chosen once, on the way in, and kept for the press.
  if (!c.state.pressRot) c.state.pressRot = c.hands.fingertipPose(side, 'point', v3.add([0, 0, 0], c.state.face, [0, 0, off]), c.rot(side, ...PRESS_HINT));
  const f = c.state.pressRot;
  c.hands.setTarget(side, { ...tipAt(c, side, 'point', v3.add([0, 0, 0], c.state.face, [0, 0, off]), null, f.rot), pole: f.pole });
}

// The index finger's side just under the toggle, offset by d.
function switchAt(c, d) {
  const point = v3.add([0, 0, 0], c.state.below, d);
  if (!c.state.switchRot) c.state.switchRot = c.hands.fingertipPose('left', 'point', point, c.rot('left', ...PRESS_HINT));
  const f = c.state.switchRot;
  c.hands.setTarget('left', { ...tipAt(c, 'left', 'point', point, null, f.rot), pole: f.pole });
}

// Fingertip on a point: the wrist target that puts a digit's tip (as it is
// in `pose`) at `point`, the hand turned as `hint`.
function tipAt(c, side, pose, point, hint, turn = null, digit = 'index') {
  const rot = turn || c.rot(side, ...hint);
  const tl = c.hands.tipLocal(side, pose, digit);
  return { pos: v3.sub([0, 0, 0], point, quat.rotate([0, 0, 0], rot, tl.tip)), rot };
}

export const SCENARIOS = {
  // Grab, lift, carry, place: a rock from the back right of the ledge to the
  // front, carried along a curving path (hold under motion).
  grabCarryPlace: {
    label: 'Grab, lift, carry, place', group: 'manipulation', station: 'ledge', duration: 5.2,
    keys: [
      [0, aside('left')],
      ...pick(0, 'right', (c) => c.body('rock'), 'spherical', DOWN, { lift: 0.1 }),
      // Up, round toward the body and out to the right, clear of the posts.
      [1.8, carryTo('right', [0.46, -0.3, -0.42])],
      [2.3, carryTo('right', [0.5, -0.27, -0.34])],
      [2.8, carryTo('right', [0.5, -0.33, -0.29])],
      ...place(3.4, 'right', 'rock'),
      [4.5, home('right')],
    ],
  },
  padPinch: {
    label: 'Pad pinch on three sizes', group: 'grips', station: 'ledge', duration: 12.4,
    keys: [
      [0, aside('left')],
      ...pickAndReturn(0, 'right', 'pebbleS', 'padPinch', PINCH, { lift: 0.06 }),
      ...pickAndReturn(3.9, 'right', 'pebbleM', 'padPinch', PINCH, { lift: 0.06 }),
      ...pickAndReturn(7.8, 'right', 'pebbleL', 'padPinch', PINCH, { lift: 0.06 }),
      [11.6, home('right')],
    ],
  },
  tripod: {
    label: 'Tripod on three sizes', group: 'grips', station: 'ledge', duration: 12.4,
    keys: [
      [0, aside('left')],
      ...pickAndReturn(0, 'right', 'pebbleS', 'tripod', TRIPOD, { lift: 0.06 }),
      ...pickAndReturn(3.9, 'right', 'pebbleM', 'tripod', TRIPOD, { lift: 0.06 }),
      ...pickAndReturn(7.8, 'right', 'pebbleL', 'tripod', TRIPOD, { lift: 0.06 }),
      [11.6, home('right')],
    ],
  },
  lateralPinch: {
    label: 'Lateral pinch', group: 'grips', station: 'ledge', duration: 5.0,
    keys: [
      ...pick(0, 'left', (c) => c.body('card'), 'lateral', SIDEWAYS, { lift: 0.05, approach: 0.05 }),
      [1.8, (c) => c.nudge('left', [-0.03, 0.01, 0.03])],
      ...putBack(2.3, 'left', 'card'),
      [4.5, home('left')],
    ],
  },
  hook: {
    label: 'Hook: a bag by its strap', group: 'grips', station: 'ledge', duration: 4.4,
    keys: [
      ...pick(0, 'left', (c) => c.bodyPart('bag', 'strap'), 'hook', OVERHAND, { lift: 0.12, approach: 0.06 }),
      [1.9, carryTo('left', [-0.33, -0.27, -0.4])],
      ...place(2.8, 'left', 'bag'),
      [4.0, home('left')],
    ],
  },
  powerGrip: {
    label: 'Power grip on a handle', group: 'grips', station: 'bench', duration: 5.8,
    keys: [
      [0, aside('left')],
      ...pick(0, 'right', (c) => c.body('handle'), 'powerCylinder', DOWN, { lift: 0.1, at: [0, 0, 0.03] }),
      // Turn the handle up to show the grip, out to the right, clear of the other hand.
      [1.8, (c) => c.hands.setTarget('right', { pos: v3.add([0, 0, 0], c.hands.target('right').pos, [0.07, 0.02, 0]), rot: c.rot('right', [-0.1, 0.25, -0.96], [-0.2, -0.95, -0.2]) })],
      [2.4, (c) => c.hands.setTarget('right', { rot: c.rot('right', ...DOWN) })],
      ...putBack(3.0, 'right', 'handle'),
      [5.3, (c) => { home('right')(c); home('left')(c); }],
    ],
  },
  sphericalGrip: {
    label: 'Spherical grip on a ball', group: 'grips', station: 'ledge', duration: 4.0,
    keys: [
      [0, aside('left')],
      ...pickAndReturn(0, 'right', 'ball', 'spherical', DOWN, { lift: 0.1 }),
      [3.4, home('right')],
    ],
  },
  twoHand: {
    label: 'Two-hand grip on one box', group: 'manipulation', station: 'bench', duration: 6.0,
    keys: [
      [0, (c) => { for (const s of ['left', 'right']) c.hands.reach(s, c.body('box'), 'press', { hint: c.rot(s, [0.1, 0.3, -0.95], [-1, 0, 0]), approach: 0.06 }); }],
      [0.7, (c) => { for (const s of ['left', 'right']) c.hands.reach(s, c.body('box'), 'press', { hint: c.rot(s, [0.1, 0.3, -0.95], [-1, 0, 0]), open: false }); }],
      [1.2, (c) => { c.hands.grasp('left', c.body('box'), 'press'); c.hands.grasp('right', c.body('box'), 'press'); }],
      // The box itself is carried: up, toward the chest, a little to each side.
      [1.5, (c) => { const b = c.body('box'); c.state.home = b.pos.slice(); c.hands.carry(b, { pos: v3.add([0, 0, 0], b.pos, [0, 0.07, 0.02]) }); }],
      [2.4, (c) => c.hands.carry(c.body('box'), { pos: v3.add([0, 0, 0], c.state.home, [0.025, 0.08, 0.03]) })],
      [3.0, (c) => c.hands.carry(c.body('box'), { pos: v3.add([0, 0, 0], c.state.home, [-0.02, 0.07, 0.02]) })],
      [3.6, (c) => { c.hands.carry(c.body('box'), { pos: v3.add([0, 0, 0], c.state.home, [0, 0.02, 0]) }); }],
      [4.1, (c) => c.hands.setDown('left')],
      [4.6, (c) => { c.hands.release('right'); c.hands.release('left'); }],
      [5.05, (c) => { c.nudge('left', [-0.05, 0.02, 0.01]); c.nudge('right', [0.05, 0.02, 0.01]); }],
      [5.5, (c) => { home('left')(c); home('right')(c); }],
    ],
  },
  handover: {
    label: 'Handover between hands', group: 'manipulation', station: 'bench', duration: 7.2,
    keys: [
      [0, aside('left')],
      ...pick(0, 'right', (c) => c.body('handle'), 'powerCylinder', DOWN, { lift: 0.08, at: [0, 0, 0.045] }),
      // Held out in front, the handle across the body, its free end to the left.
      [1.6, aim('right', [0.08, -0.22, -0.33], [[-0.2, -0.2, -0.96], [0, -1, 0.2]])],
      // The left hand takes the end of the handle nearer to it.
      [2.3, (c) => c.hands.reach('left', c.body('handle'), 'powerCylinder', { hint: c.rot('left', ...DOWN), at: leftEnd(c, 'handle', 0.045), approach: 0.06 })],
      [2.8, (c) => (c.hands.arrived('left') ? c.hands.reach('left', c.body('handle'), 'powerCylinder', { hint: c.rot('left', ...DOWN), at: leftEnd(c, 'handle', 0.045), open: false }) : WAIT)],
      [3.3, (c) => (c.hands.arrived('left') ? c.hands.grasp('left', c.body('handle'), 'powerCylinder') : WAIT)],
      [3.6, (c) => c.hands.release('right')],
      [4.2, (c) => { c.nudge('right', [0.05, 0.02, 0.05]); }],
      [4.7, home('right')],
      // The left hand takes it away to the left and lays it on the bench.
      [4.3, carryTo('left', [-0.24, -0.33, -0.3])],
      ...place(5.0, 'left', 'handle'),
      [6.6, home('left')],
    ],
  },
  inHandRoll: {
    label: 'In-hand roll', group: 'manipulation', station: 'ledge', duration: 5.9,
    keys: [
      [0, aside('left')],
      ...pick(0, 'right', (c) => c.body('pebbleM'), 'tripod', TRIPOD, { lift: 0.08 }),
      [1.5, (c) => { c.hands.gesture('pebbleRoll', { hand: 'right' }); c.hands.spin('right', [0, 0, 1], 2.4); }],
      [3.4, (c) => { c.hands.spin('right', [0, 0, 1], 0); c.hands.stopGesture('right'); }],
      // The dowel rack is close: the fingers open once the hand is up clear of it.
      ...place(3.7, 'right', 'pebbleM', { openAfter: 0.7 }),
      [5.4, home('right')],
    ],
  },
  inHandSpin: {
    label: 'In-hand spin', group: 'manipulation', station: 'ledge', duration: 5.9,
    keys: [
      [0, aside('left')],
      ...pick(0, 'right', (c) => c.body('dowel'), 'tripod', TRIPOD, { lift: 0.08 }),
      [1.5, (c) => c.hands.spin('right', [0, 0, 1], 6)],
      [3.4, (c) => c.hands.spin('right', [0, 0, 1], 0)],
      ...place(3.7, 'right', 'dowel'),
      [5.4, home('right')],
    ],
  },
  throwCatch: {
    label: 'Throw and catch', group: 'manipulation', station: 'ledge', duration: 4.8,
    setup: (c) => { c.state.catchPoint = c.P(-0.09, -0.3, -0.31); },
    keys: [
      ...pick(0, 'right', (c) => c.body('ball'), 'spherical', DOWN, { lift: 0.08 }),
      // Turn palm up, ball cupped, and ready the catching hand.
      [1.4, aim('right', [0.14, -0.33, -0.33], PALM_UP)],
      [1.4, (c) => c.hands.readyCatch('left', c.state.catchPoint, 'spherical', { hint: c.rot('left', ...PALM_UP), radius: c.body('ball').r })],
      // The toss: up and across, letting go on the way up.
      [2.2, aim('right', [-0.02, -0.16, -0.34], PALM_UP)],
      [2.32, (c) => { c.hands.release('right'); c.hands.planCatch('left', c.body('ball'), 'spherical', { hint: c.rot('left', ...PALM_UP), near: c.state.catchPoint }); }],
      [2.4, home('right')],
      // Caught: the left hand brings the ball up and holds it, clear of the iron on the table.
      [3.2, carryTo('left', [-0.1, -0.24, -0.3])],
    ],
  },
  slipHeavy: {
    label: 'Slip: too heavy for the grip', group: 'strength', station: 'ledge', duration: 3.6,
    keys: [
      ...pick(0, 'left', (c) => c.body('weight'), 'padPinch', PINCH, { lift: 0.06 }),
      [3.0, home('left')],
    ],
  },
  slipJerk: {
    label: 'Slip: accelerated too hard', group: 'strength', station: 'ledge', duration: 4.4,
    keys: [
      ...pick(0, 'left', (c) => c.body('shot'), 'padPinch', PINCH, { lift: 0.03 }),
      [1.8, (c) => c.nudge('left', [0, 0.012, 0])],
      [2.4, (c) => c.nudge('left', [0, 0.16, 0])],
      [3.8, home('left')],
    ],
  },
  // Panel station.
  pressButton: {
    label: 'Press a button', group: 'props', station: 'panel', duration: 3.2,
    // The button is left of centre: the left hand presses it, the elbow out
    // and low so the wrist is not bent back to reach up to it.
    keys: [
      [0, (c) => { c.hands.setPose('left', 'point'); c.hands.setBusy('left', true); const b = c.prop('button'); c.state.face = v3.add([0, 0, 0], b.anchor, [0, 0, 0.006]); pressAt(c, 'left', 0.03); }],
      // Onto the cap, then 7 mm of its 8 mm travel.
      [0.8, (c) => pressAt(c, 'left', 0.002)],
      [1.2, (c) => pressAt(c, 'left', -0.007)],
      [1.9, (c) => pressAt(c, 'left', 0.03)],
      [2.5, (c) => { c.hands.setPose('left', 'relaxed'); c.hands.setBusy('left', false); home('left')(c); }],
    ],
  },
  flipSwitch: {
    label: 'Flip a switch', group: 'props', station: 'panel', duration: 3.6,
    // The left hand, thumb up, pushes the toggle up with the side of its
    // index finger.
    keys: [
      [0, (c) => { c.hands.setPose('left', 'point'); c.hands.setBusy('left', true); const sw = c.prop('switch'); c.state.below = v3.add([0, 0, 0], sw.worldPoint([0, 0, 0.024]), [0, -0.02, 0.002]); switchAt(c, [0, -0.02, 0.02]); }],
      [0.8, (c) => switchAt(c, [0, 0, 0])],
      [1.3, (c) => switchAt(c, [0, 0.028, -0.004])],
      [2.1, (c) => switchAt(c, [0, 0.028, 0.045])],
      [2.8, (c) => { c.hands.setPose('left', 'relaxed'); c.hands.setBusy('left', false); home('left')(c); }],
    ],
  },
  turnKnob: {
    label: 'Turn a knob', group: 'props', station: 'panel', duration: 5.2,
    keys: [
      [0, aside('left')],
      ...pick(0, 'right', (c) => c.part('knob', 'grip'), 'tripod', [[-0.1, -0.2, -0.97], [0.1, -0.2, -0.97]], { lift: 0, approach: 0.05 }),
      [1.4, (c) => { const cur = c.hands.target('right'); c.hands.intent('right', { pos: cur.pos, rot: quat.multiply([0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], -1.2), cur.rot) }); }],
      [3.2, (c) => c.hands.release('right')],
      [3.8, (c) => c.nudge('right', [0.02, 0, 0.06])],
      [4.4, home('right')],
    ],
  },
  pullLever: {
    label: 'Pull a lever', group: 'props', station: 'panel', duration: 5.6,
    keys: [
      // Overhand round the crossbar.
      ...pick(0, 'right', (c) => c.part('lever', 'grip'), 'powerCylinder', OVERHAND, { lift: 0, approach: 0.06 }),
      [1.4, (c) => { const lv = c.prop('lever'); const grip = lv.worldPoint([0, 0.245, 0], 1.0); const cur = c.hands.target('right'); const now = lv.worldPoint([0, 0.245, 0]); c.hands.intent('right', { pos: v3.add([0, 0, 0], cur.pos, v3.sub([0, 0, 0], grip, now)), rot: cur.rot }); }],
      [3.5, (c) => c.hands.release('right')],
      [4.2, (c) => c.nudge('right', [0.02, 0.05, 0.05])],
      [4.8, home('right')],
    ],
  },
  drawer: {
    label: 'Open and close a drawer', group: 'props', station: 'panel', duration: 6.6,
    keys: [
      ...pick(0, 'right', (c) => c.part('drawer', 'handle'), 'tripod', [[-0.1, -0.2, -0.97], [0.1, -0.2, -0.97]], { lift: 0, approach: 0.05 }),
      [1.4, (c) => { const cur = c.hands.target('right'); c.hands.intent('right', { pos: v3.add([0, 0, 0], cur.pos, [0, 0, 0.18]), rot: cur.rot }); }],
      [3.0, (c) => { const cur = c.hands.rig.skel.joint('right', 'wrist'); c.hands.intent('right', { pos: v3.add([0, 0, 0], cur.worldPos, [0, 0, -0.18]), rot: cur.worldRot }); }],
      [4.6, (c) => c.hands.release('right')],
      [5.2, (c) => c.nudge('right', [0, 0.08, 0.01])],
      [5.8, home('right')],
    ],
  },
  // Crate station.
  pushCrate: {
    label: 'Push a crate', group: 'props', station: 'crate', duration: 5.0, moves: ['crate'],
    // A steady push, the speed a crate is walked across a bench.
    tick: glide('right', 1.4, 3.2, [0, 0, -0.12]),
    keys: [
      [0, (c) => { c.hands.setPose('right', 'press'); c.hands.setBusy('right', true); c.state.push = pushPose(c); c.hands.setTarget('right', { ...c.state.push, pos: v3.add([0, 0, 0], c.state.push.pos, [0, 0, 0.05]) }); }],
      [0.9, (c) => c.hands.setTarget('right', { ...c.state.push, pos: v3.add([0, 0, 0], c.state.push.pos, [0, 0, 0.003]) })],
      [3.4, (c) => c.nudge('right', [0, 0.02, 0.08])],
      [4.2, (c) => { c.hands.setPose('right', 'relaxed'); c.hands.setBusy('right', false); home('right')(c); }],
    ],
  },
  dragCrate: {
    label: 'Drag a crate', group: 'props', station: 'crate', duration: 5.4,
    tick: glide('right', 1.4, 3.2, [0, 0, 0.11]),
    keys: [
      [0, (c) => c.hands.reach('right', c.bodyPart('crate', 'handle'), 'hook', { hint: c.rot('right', ...OVERHAND), approach: 0.05 })],
      [0.6, (c) => c.hands.reach('right', c.bodyPart('crate', 'handle'), 'hook', { hint: c.rot('right', ...OVERHAND), open: false })],
      [1.05, (c) => c.hands.grasp('right', c.bodyPart('crate', 'handle'), 'hook', { drag: true })],
      [3.5, (c) => c.hands.release('right')],
      [4.05, (c) => c.nudge('right', [0, 0.05, 0.02])],
      [4.7, home('right')],
    ],
  },
  // Ladder station.
  hang: {
    label: 'Hang from a rung', group: 'climbing', station: 'ladder', duration: 7.0,
    keys: [
      [0, (c) => { for (const s of ['left', 'right']) c.hands.reach(s, { fixed: c.sb.statics.rung0 }, 'powerCylinder', { hint: c.rot(s, ...OVERHAND), at: [0, 0, s === 'left' ? -0.17 : 0.17], approach: 0.06, from: [0, 1, 0.35] }); }],
      [0.8, (c) => { if (!c.hands.arrived('left') || !c.hands.arrived('right')) return WAIT; for (const s of ['left', 'right']) c.hands.reach(s, { fixed: c.sb.statics.rung0 }, 'powerCylinder', { hint: c.rot(s, ...OVERHAND), at: [0, 0, s === 'left' ? -0.17 : 0.17], open: false }); return undefined; }],
      [1.3, (c) => { if (!c.hands.arrived('left') || !c.hands.arrived('right')) return WAIT; c.hands.grasp('left', { fixed: c.sb.statics.rung0 }, 'powerCylinder'); c.hands.grasp('right', { fixed: c.sb.statics.rung0 }, 'powerCylinder'); return undefined; }],
      // Knees give: the body hangs from the hands, then stands back up.
      [1.6, (c) => c.hands.moveBody([c.X, -0.1, 0], 0.9)],
      [3.6, (c) => c.hands.moveBody([c.X, 0, 0], 0.9)],
      [4.8, (c) => { c.hands.release('left'); c.hands.release('right'); }],
      // Up off the rung and back over it, then down.
      [5.4, (c) => { c.nudge('left', [0, 0.05, 0.07]); c.nudge('right', [0, 0.05, 0.07]); }],
      [6.0, (c) => { home('left')(c); home('right')(c); }],
    ],
  },
  climb: {
    label: 'Climb hand over hand', group: 'climbing', station: 'ladder', duration: 11.6,
    keys: climbKeys(),
  },
  // Rope station.
  rope: {
    label: 'Hold a rope', group: 'climbing', station: 'rope', duration: 6.9,
    keys: [
      [0, aside('left')],
      [0, (c) => c.hands.reach('right', { rope: c.rope('rope'), at: c.P(0.02, -0.2, -0.53) }, 'powerCylinder', { hint: c.rot('right', ...SIDEWAYS), approach: 0.06 })],
      [0.8, (c) => c.hands.reach('right', { rope: c.rope('rope'), at: c.P(0.02, -0.2, -0.53) }, 'powerCylinder', { hint: c.rot('right', ...SIDEWAYS), open: false })],
      [1.3, (c) => c.hands.grasp('right', { rope: c.rope('rope'), at: c.P(0.02, -0.2, -0.53) }, 'powerCylinder')],
      [1.6, (c) => c.nudge('right', [0.02, -0.05, 0.1])],
      [2.6, (c) => c.nudge('right', [-0.04, 0.02, -0.04])],
      [3.6, (c) => c.nudge('right', [0.02, 0.03, -0.06])],
      [4.6, (c) => c.hands.release('right')],
      [5.4, (c) => c.nudge('right', [0.1, -0.02, 0.16])],
      [6.1, (c) => { home('right')(c); home('left')(c); }],
    ],
  },
};

// The open palm flat against the crate's near face, fingers up.
function pushPose(c) {
  const crate = c.body('crate');
  const rot = c.rot('right', [0, 1, -0.05], [0, 0.05, -1]);
  const face = crate.pos[2] + crate.hz;
  // The palm surface is about 19 mm in front of the wrist frame along -Y.
  const palm = [crate.pos[0] + 0.03, crate.pos[1] + 0.02, face + 0.0205];
  const wristToPalm = quat.rotate([0, 0, 0], rot, [0.005, -0.0195, -0.055]);
  return { pos: v3.sub([0, 0, 0], palm, wristToPalm), rot };
}

// Hand over hand up the rungs: before each move the body rises so the free
// hand can reach the next rung, and one hand always holds.
function climbKeys() {
  const keys = [];
  const rung = (c, i) => ({ fixed: c.sb.statics[`rung${i}`] });
  const offset = (s) => [0, 0, s === 'left' ? -0.11 : 0.11];
  // Onto a rung from above and a little behind it, fingers over the bar.
  const reachRung = (s, i, approach = 0) => (c) => c.hands.reach(s, rung(c, i), 'powerCylinder', { hint: c.rot(s, ...OVERHAND), at: offset(s), approach, from: approach ? [0, 1, 0.35] : null });
  const closeRung = (s, i) => (c) => c.hands.reach(s, rung(c, i), 'powerCylinder', { hint: c.rot(s, ...OVERHAND), at: offset(s), open: false });
  keys.push([0, (c) => { reachRung('left', 0, 0.06)(c); reachRung('right', 0, 0.06)(c); }]);
  const both = (c) => c.hands.arrived('left') && c.hands.arrived('right');
  keys.push([0.8, (c) => { if (!both(c)) return WAIT; closeRung('left', 0)(c); closeRung('right', 0)(c); return undefined; }]);
  keys.push([1.3, (c) => { if (!both(c)) return WAIT; c.hands.grasp('left', rung(c, 0), 'powerCylinder'); c.hands.grasp('right', rung(c, 0), 'powerCylinder'); return undefined; }]);
  let t = 1.6;
  let y = 0;
  const moves = [['right', 1], ['left', 2], ['right', 3]];
  for (const [s, i] of moves) {
    // Rise until the next rung is a comfortable reach above the shoulder,
    // the other hand's rung then level with it.
    const from = y;
    y = 0.01 + 0.26 * i;
    const to = y;
    // The lower hand lets go (the other holds the rung above), the body
    // pulls up on that hand, and the free hand rises with it (left where it
    // was, its elbow would fold back under it), then goes up past it.
    keys.push([t, (c) => c.hands.release(s)]);
    keys.push([t + 0.6, (c) => { c.hands.moveBody([c.X, to, 0], 0.8); c.nudge(s, [0, to - from, 0]); }]);
    keys.push([t + 1.5, reachRung(s, i, 0.05)]);
    keys.push([t + 2.1, (c) => (c.hands.arrived(s) ? closeRung(s, i)(c) : WAIT)]);
    keys.push([t + 2.6, (c) => (c.hands.arrived(s) ? c.hands.grasp(s, rung(c, i), 'powerCylinder') : WAIT)]);
    t += 2.9;
  }
  keys.push([t, (c) => c.hands.moveBody([c.X, y + 0.03, 0], 0.8)]);
  return keys;
}

export const SCENARIO_IDS = () => Object.keys(SCENARIOS);
