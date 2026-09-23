// The sandbox playground as physics: stations laid out along X, each within
// arm's reach of a player standing at its body anchor. DOM free: the checks,
// the capability matrix and the browser all build the same world from here.
//
// Body space: the eye at the body anchor, -Z ahead, +Y up, ground 1.55 m
// below the eye. A station's props sit in front of a player standing at
// { x: station.x }.
import { World, Prop, Rope, quat, v3 } from '../../hands/src/index.js';

export const GROUND_Y = -1.55;
export const TABLE_TOP = -0.5;
export const BENCH_TOP = -0.64; // the crate bench is lower, so the crate's top sits at a comfortable reach

export const STATIONS = {
  ledge: { x: 0, label: 'Ledge of objects' },
  bench: { x: -2.6, label: 'Bench for two hands' },
  panel: { x: 1.3, label: 'Button panel, switch, knob, lever, drawer' },
  crate: { x: -1.3, label: 'Crate bench' },
  ladder: { x: 2.6, label: 'Rungs' },
  rope: { x: 3.9, label: 'Rope' },
};

const Z_TO_Y = quat.fromTo([0, 0, 0, 1], [0, 0, 1], [0, 1, 0]);
const Z_TO_X = quat.fromTo([0, 0, 0, 1], [0, 0, 1], [1, 0, 0]);
// The card points away and a little to the right: the left hand takes its
// near end with the fingers turned in, the way a forearm rests.
const CARD_YAW = quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], -0.44);

// Objects on the ledge: many sizes and shapes. Positions are x and z on the
// table top; y is set so each rests on it.
export const LEDGE = [
  { name: 'pebbleS', shape: 'sphere', r: 0.015, mass: 0.03, at: [0.02, -0.3], on: 'pebbleStand', kind: 'pebble', friction: 0.8 },
  { name: 'pebbleM', shape: 'sphere', r: 0.019, mass: 0.06, at: [0.18, -0.3], on: 'pebbleStandM', kind: 'pebble', friction: 0.8 },
  { name: 'pebbleL', shape: 'sphere', r: 0.024, mass: 0.12, at: [0.34, -0.3], on: 'pebbleStandL', kind: 'pebble', friction: 0.8 },
  { name: 'rock', shape: 'sphere', r: 0.03, mass: 0.3, at: [0.42, -0.48], kind: 'rock', friction: 0.8 },
  { name: 'ball', shape: 'sphere', r: 0.035, mass: 0.06, at: [0.26, -0.58], kind: 'ball', restitution: 0.55, friction: 0.7 },
  { name: 'dowel', shape: 'capsule', r: 0.007, h: 0.04, mass: 0.012, at: [0.06, -0.42], rot: Z_TO_X, on: 'dowelRack', kind: 'dowel', friction: 0.8 },
  { name: 'card', shape: 'box', hx: 0.027, hy: 0.0015, hz: 0.043, mass: 0.006, at: [-0.08, -0.44], rot: CARD_YAW, on: 'cardStand', kind: 'card', friction: 0.8 },
  { name: 'shot', shape: 'sphere', r: 0.02, mass: 0.9, at: [-0.17, -0.28], kind: 'iron', friction: 0.6 },
  { name: 'weight', shape: 'box', hx: 0.03, hy: 0.03, hz: 0.03, mass: 2.4, at: [-0.28, -0.31], kind: 'iron', friction: 0.5 },
  {
    name: 'bag', shape: 'box', hx: 0.07, hy: 0.06, hz: 0.045, mass: 1.2, at: [-0.4, -0.52], kind: 'bag', friction: 0.7,
    parts: [{ name: 'strap', shape: 'capsule', r: 0.008, h: 0.045, pos: [0, 0.105, 0], rot: Z_TO_X }, { name: 'loopL', shape: 'capsule', r: 0.006, h: 0.02, pos: [-0.052, 0.082, 0], rot: Z_TO_Y }, { name: 'loopR', shape: 'capsule', r: 0.006, h: 0.02, pos: [0.052, 0.082, 0], rot: Z_TO_Y }],
  },
];

// The bench: a second table for the objects both hands work together.
export const BENCH = [
  { name: 'handle', shape: 'capsule', r: 0.014, h: 0.085, mass: 0.2, at: [0, -0.3], rot: Z_TO_X, on: 'handleRack', kind: 'handle', friction: 0.8 },
  { name: 'box', shape: 'box', hx: 0.1, hy: 0.065, hz: 0.065, mass: 0.9, at: [0, -0.49], kind: 'box', friction: 0.6 },
];

export function buildSandbox({ seed = 1 } = {}) {
  const world = new World({ seed, groundY: GROUND_Y });
  const S = STATIONS;
  const statics = {};
  const add = (name, s) => { statics[name] = world.addStatic({ name, ...s }); return statics[name]; };

  // Ledge: a table in front of the ledge station.
  add('ledgeTable', { shape: 'box', pos: [S.ledge.x, TABLE_TOP - 0.03, -0.43], hx: 0.52, hy: 0.03, hz: 0.21, friction: 0.8, render: 'wood' });
  // Racks: two short posts that hold the handle and the dowel off the
  // table, so fingers can close right round them.
  const rack = (name, x0, x, z, half, h) => {
    add(`${name}A`, { shape: 'box', pos: [x0 + x - half, TABLE_TOP + h / 2, z], hx: 0.006, hy: h / 2, hz: 0.012, render: 'wood' });
    add(`${name}B`, { shape: 'box', pos: [x0 + x + half, TABLE_TOP + h / 2, z], hx: 0.006, hy: h / 2, hz: 0.012, render: 'wood' });
    statics[name] = { pos: [x0 + x, TABLE_TOP + h / 2, z], hy: h / 2 };
  };
  rack('dowelRack', S.ledge.x, 0.06, -0.42, 0.03, 0.045);
  // A slim post under the smallest stone: fingertips can reach below its
  // middle without meeting the table.
  add('pebbleStand', { shape: 'box', pos: [S.ledge.x + 0.02, TABLE_TOP + 0.02, -0.3], hx: 0.008, hy: 0.02, hz: 0.008, render: 'wood' });
  add('pebbleStandM', { shape: 'box', pos: [S.ledge.x + 0.18, TABLE_TOP + 0.025, -0.3], hx: 0.008, hy: 0.025, hz: 0.008, render: 'wood' });
  add('pebbleStandL', { shape: 'box', pos: [S.ledge.x + 0.34, TABLE_TOP + 0.03, -0.3], hx: 0.009, hy: 0.03, hz: 0.009, render: 'wood' });
  // A slim stand that lifts the card clear of the table, under its middle,
  // so it overhangs toward the player far enough for curled fingers to
  // close under it in a lateral pinch.
  add('cardStand', { shape: 'box', pos: v3.add([0, 0, 0], [S.ledge.x - 0.08, TABLE_TOP + 0.05, -0.44], quat.rotate([0, 0, 0], CARD_YAW, [0, 0, -0.002])), rot: CARD_YAW, hx: 0.02, hy: 0.05, hz: 0.004, render: 'wood' });
  const place = (list, x0) => {
    for (const o of list) {
      const rot = o.rot || [0, 0, 0, 1];
      const b = world.add({ ...o, pos: [x0 + o.at[0], 0, o.at[1]], rot });
      const base = o.on ? statics[o.on].pos[1] + statics[o.on].hy : TABLE_TOP;
      b.pos[1] = base + (b.pos[1] - b.lowest());
      b.home = { pos: b.pos.slice(), rot: b.rot.slice() };
    }
  };
  place(LEDGE, S.ledge.x);

  // Bench station: a table, the handle on a rack and the box.
  add('benchTable', { shape: 'box', pos: [S.bench.x, TABLE_TOP - 0.03, -0.43], hx: 0.36, hy: 0.03, hz: 0.21, friction: 0.8, render: 'wood' });
  rack('handleRack', S.bench.x, 0, -0.3, 0.075, 0.075);
  place(BENCH, S.bench.x);

  // Panel station: a console face with a button, a switch and a knob, a
  // lever to the right and a drawer below.
  const P = S.panel.x;
  const FACE = -0.5;
  add('console', { shape: 'box', pos: [P, -0.27, FACE - 0.03], hx: 0.34, hy: 0.3, hz: 0.03, render: 'console' });
  add('cabinet', { shape: 'box', pos: [P, -0.66, FACE - 0.03], hx: 0.34, hy: 0.09, hz: 0.03, render: 'console' });
  world.add(new Prop({
    name: 'button', type: 'slider', anchor: [P - 0.21, -0.22, FACE + 0.011], axis: [0, 0, -1], min: 0, max: 0.008,
    inertia: 0.02, damping: 1.2, spring: { k: 90, rest: 0 },
    parts: [{ name: 'cap', shape: 'box', hx: 0.016, hy: 0.016, hz: 0.006, pos: [0, 0, 0] }],
  }));
  // Switch toggle: out from the face, hinged about X; q < 0 tips it up.
  world.add(new Prop({
    name: 'switch', type: 'hinge', anchor: [P - 0.1, -0.22, FACE + 0.004], axis: [1, 0, 0], min: -0.42, max: 0.42, q: 0.38,
    inertia: 2e-5, damping: 6e-4, detents: { wells: [-0.38, 0.38], k: 0.012 },
    parts: [{ name: 'toggle', shape: 'capsule', r: 0.0055, h: 0.009, pos: [0, 0, 0.016] }],
  }));
  world.add(new Prop({
    name: 'knob', type: 'hinge', anchor: [P + 0.08, -0.22, FACE + 0.035], axis: [0, 0, 1], min: -1.7, max: 1.7,
    inertia: 4e-4, damping: 0.02, friction: 0.03,
    parts: [
      { name: 'grip', shape: 'sphere', r: 0.021, pos: [0, 0, 0], strength: 0.6, stiffness: 2.5, driveDamping: 0.08 },
      // The stem it stands on, clear of the face, so fingers close round it.
      { name: 'stem', shape: 'capsule', r: 0.006, h: 0.02, pos: [0, 0, -0.022], collide: false },
      // A pointer fin on its front: a sphere alone shows no turn.
      { name: 'pointer', shape: 'box', hx: 0.004, hy: 0.014, hz: 0.004, pos: [0, 0.012, 0.018], collide: false },
    ],
  }));
  // Lever: pivot low on the right, the arm up, a ball grip on top; pulling
  // it back toward the player is positive q.
  world.add(new Prop({
    name: 'lever', type: 'hinge', anchor: [P + 0.25, -0.38, FACE + 0.075], axis: [1, 0, 0], min: 0, max: 1.05,
    inertia: 0.05, damping: 0.8, friction: 1.4,
    parts: [
      { name: 'arm', shape: 'capsule', r: 0.009, h: 0.11, pos: [0, 0.12, 0], rot: Z_TO_Y },
      // A crossbar handle on top, taken overhand.
      { name: 'grip', shape: 'capsule', r: 0.012, h: 0.045, pos: [0, 0.245, 0], rot: Z_TO_X, strength: 12, stiffness: 40, driveDamping: 3 },
    ],
  }));
  // Drawer: slides out toward the player (+Z); a bar handle on its front.
  world.add(new Prop({
    name: 'drawer', type: 'slider', anchor: [P, -0.44, FACE + 0.012], axis: [0, 0, 1], min: 0, max: 0.2,
    inertia: 1.5, damping: 6, friction: 3,
    parts: [
      { name: 'front', shape: 'box', hx: 0.16, hy: 0.065, hz: 0.012, pos: [0, 0, 0] },
      { name: 'tray', shape: 'box', hx: 0.15, hy: 0.05, hz: 0.12, pos: [0, -0.005, -0.13], collide: false },
      // A round pull on a short stem, taken between thumb and fingertips.
      { name: 'stem', shape: 'capsule', r: 0.005, h: 0.009, pos: [0, 0.005, 0.021] },
      { name: 'handle', shape: 'sphere', r: 0.017, pos: [0, 0.005, 0.042], strength: 90, stiffness: 600, driveDamping: 60 },
    ],
  }));

  // Crate station: a bench and a wooden crate with a bar handle on its near face.
  const C = S.crate.x;
  add('crateBench', { shape: 'box', pos: [C, BENCH_TOP - 0.03, -0.5], hx: 0.34, hy: 0.03, hz: 0.28, friction: 0.5, render: 'wood' });
  const crate = world.add({
    name: 'crate', shape: 'box', hx: 0.12, hy: 0.085, hz: 0.1, mass: 2.2, friction: 0.22, restitution: 0.05, angDamp: 4, kind: 'crate',
    pos: [C + 0.06, BENCH_TOP + 0.085, -0.47],
    // A bar handle across the top on two short uprights.
    parts: [
      { name: 'handle', shape: 'capsule', r: 0.01, h: 0.05, pos: [0, 0.135, 0.02], rot: Z_TO_X },
      { name: 'postL', shape: 'capsule', r: 0.006, h: 0.022, pos: [-0.06, 0.107, 0.02], rot: Z_TO_Y },
      { name: 'postR', shape: 'capsule', r: 0.006, h: 0.022, pos: [0.06, 0.107, 0.02], rot: Z_TO_Y },
    ],
  });
  crate.home = { pos: crate.pos.slice(), rot: crate.rot.slice() };

  // Ladder station: fixed rungs up in front, rails either side.
  const L = S.ladder.x;
  const rungs = [];
  for (let i = 0; i < 6; i++) {
    const y = 0.05 + i * 0.26;
    rungs.push(add(`rung${i}`, { shape: 'capsule', a: [L - 0.28, y, -0.33], b: [L + 0.28, y, -0.33], r: 0.016, friction: 0.9, render: 'rung' }));
  }
  add('railL', { shape: 'box', pos: [L - 0.31, 0.2, -0.33], hx: 0.02, hy: 1.75, hz: 0.025, render: 'wood' });
  add('railR', { shape: 'box', pos: [L + 0.31, 0.2, -0.33], hx: 0.02, hy: 1.75, hz: 0.025, render: 'wood' });

  // Rope station: a rope from an overhead beam.
  const R = S.rope.x;
  add('beam', { shape: 'box', pos: [R, 0.74, -0.53], hx: 0.3, hy: 0.03, hz: 0.04, render: 'wood' });
  // Hanging a little to the right of the player, where the right hand takes it.
  const rope = world.add(new Rope({ name: 'rope', top: [R + 0.02, 0.71, -0.53], length: 1.25, segments: 25, r: 0.012, damping: 0.06 }));
  // Hang it still before anyone arrives: a freshly strung rope would bounce.
  for (let i = 0; i < 240; i++) rope.step(1 / 60, world.gravity);
  for (let i = 0; i < rope.points.length; i++) rope.prev[i] = rope.points[i].slice();

  return { world, statics, rungs, stations: S };
}

// Put every ledge object and the crate back where it started.
export function resetProps(world) {
  for (const b of world.bodies) {
    if (!b.home) continue;
    v3.copy(b.pos, b.home.pos);
    b.rot = b.home.rot.slice();
    v3.set(b.vel, 0, 0, 0);
    v3.set(b.ang, 0, 0, 0);
    b.kinematic = false;
    b.heldBy = null;
    b.asleep = true;
  }
}
