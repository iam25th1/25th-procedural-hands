// The interaction physics on its own: bodies fall, rest, bounce, slide and
// stop; hinges and sliders keep their limits, springs and detents; a rope
// keeps its length; hand capsules push through contact only; a replay is
// bit for bit the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, Body, Prop, Rope } from '../src/physics.js';
import { quat, v3 } from '../src/math.js';

const DT = 1 / 60;
const run = (w, seconds, each = null) => { for (let i = 0; i < Math.round(seconds / DT); i++) { if (each) each(i); w.step(DT); } };
const Z_TO_X = quat.fromTo([0, 0, 0, 1], [0, 0, 1], [1, 0, 0]);

test('physics: a sphere, a box and a capsule dropped on the ground come to rest on it and sleep', () => {
  const w = new World({ seed: 1, groundY: 0 });
  const s = w.add({ name: 's', shape: 'sphere', r: 0.03, mass: 0.2, pos: [0, 0.3, 0], restitution: 0 });
  const b = w.add({ name: 'b', shape: 'box', hx: 0.05, hy: 0.03, hz: 0.04, mass: 0.5, pos: [0.3, 0.3, 0], restitution: 0 });
  const c = w.add({ name: 'c', shape: 'capsule', r: 0.015, h: 0.05, mass: 0.2, pos: [-0.3, 0.3, 0], rot: Z_TO_X, restitution: 0 });
  run(w, 3);
  assert.ok(Math.abs(s.pos[1] - 0.03) < 0.001, `sphere rests at its radius: ${s.pos[1]}`);
  assert.ok(Math.abs(b.lowest()) < 0.001, `box rests on its face: ${b.lowest()}`);
  assert.ok(Math.abs(c.lowest()) < 0.001, `capsule rests on its side: ${c.lowest()}`);
  for (const x of [s, b, c]) assert.ok(x.asleep, `${x.name} sleeps`);
});

test('physics: restitution bounces a ball, a dead body does not bounce', () => {
  const w = new World({ seed: 1, groundY: 0 });
  const live = w.add({ name: 'live', shape: 'sphere', r: 0.03, mass: 0.06, pos: [0, 0.5, 0], restitution: 0.6 });
  const dead = w.add({ name: 'dead', shape: 'sphere', r: 0.03, mass: 0.06, pos: [0.5, 0.5, 0], restitution: 0 });
  // Heights reached after the first landing (the first time each ball is
  // going up again or has stopped falling).
  let landedLive = false;
  let landedDead = false;
  let peakLive = 0;
  let peakDead = 0;
  run(w, 2, () => {
    if (live.pos[1] < 0.1 && live.vel[1] >= 0) landedLive = true;
    if (dead.pos[1] < 0.1 && dead.vel[1] >= 0) landedDead = true;
    if (landedLive) peakLive = Math.max(peakLive, live.pos[1]);
    if (landedDead) peakDead = Math.max(peakDead, dead.pos[1]);
  });
  assert.ok(peakLive > 0.1, `the ball bounces back up: ${peakLive}`);
  assert.ok(peakDead < 0.04, `the dead body stays down: ${peakDead}`);
});

test('physics: friction slows a sliding box to a stop on a table, and a resting box does not creep', () => {
  const w = new World({ seed: 1, groundY: -1 });
  w.addStatic({ name: 'table', shape: 'box', pos: [0, -0.03, 0], hx: 1, hy: 0.03, hz: 1, friction: 0.6 });
  const slide = w.add({ name: 'slide', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [0, 0.05, 0], vel: [0.8, 0, 0], friction: 0.5 });
  const rest = w.add({ name: 'rest', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [0, 0.05, 0.4], friction: 0.5 });
  run(w, 2);
  assert.ok(v3.len(slide.vel) < 0.01, `the slide stops: ${v3.len(slide.vel)}`);
  assert.ok(slide.pos[0] > 0.05 && slide.pos[0] < 0.3, `it slid a short way: ${slide.pos[0]}`);
  assert.ok(v3.dist(rest.pos, [0, 0.05, 0.4]) < 0.001, `the resting box stays put: ${rest.pos}`);
});

test('physics: a hinge keeps its limits and a bistable switch settles in a well', () => {
  const w = new World({ seed: 1 });
  const lever = w.add(new Prop({ name: 'lever', type: 'hinge', anchor: [0, 0, 0], axis: [1, 0, 0], min: 0, max: 1, inertia: 0.05, damping: 0.5, parts: [{ name: 'arm', shape: 'capsule', r: 0.01, h: 0.1, pos: [0, 0.1, 0] }] }));
  const sw = w.add(new Prop({ name: 'switch', type: 'hinge', anchor: [0, 0, 1], axis: [1, 0, 0], min: -0.42, max: 0.42, q: 0.05, inertia: 2e-5, damping: 6e-4, detents: { wells: [-0.38, 0.38], k: 0.012 }, parts: [{ name: 't', shape: 'capsule', r: 0.005, h: 0.009, pos: [0, 0, 0.016] }] }));
  lever.qd = 50;
  run(w, 1);
  assert.ok(lever.q <= 1 + 1e-9 && lever.q >= 0, `lever inside its limits: ${lever.q}`);
  assert.ok(Math.abs(sw.q - 0.38) < 0.02, `switch snaps to its nearer well: ${sw.q}`);
});

test('physics: a sprung slider (a button) returns to rest, and a drawer stays where it is left', () => {
  const w = new World({ seed: 1 });
  const btn = w.add(new Prop({ name: 'button', type: 'slider', anchor: [0, 0, 0], axis: [0, 0, -1], min: 0, max: 0.008, inertia: 0.02, damping: 1.2, spring: { k: 90, rest: 0 }, parts: [{ name: 'cap', shape: 'box', hx: 0.01, hy: 0.01, hz: 0.005 }] }));
  const drawer = w.add(new Prop({ name: 'drawer', type: 'slider', anchor: [0, 0, 1], axis: [0, 0, 1], min: 0, max: 0.2, inertia: 1.5, damping: 6, friction: 3, parts: [{ name: 'front', shape: 'box', hx: 0.1, hy: 0.05, hz: 0.01 }] }));
  btn.q = 0.008;
  drawer.q = 0.1;
  run(w, 1.5);
  assert.ok(btn.q < 0.0005, `button back up: ${btn.q}`);
  assert.ok(Math.abs(drawer.q - 0.1) < 1e-9, `drawer stays: ${drawer.q}`);
});

test('physics: a rope hangs from its top at its length', () => {
  const w = new World({ seed: 1 });
  const rope = w.add(new Rope({ name: 'rope', top: [0, 1, 0], length: 1, segments: 20, r: 0.012 }));
  run(w, 4);
  assert.ok(v3.dist(rope.points[0], [0, 1, 0]) < 1e-9, 'top stays pinned');
  assert.ok(rope.maxStretch() < 0.02, `stretch under 2 percent: ${rope.maxStretch()}`);
  assert.ok(rope.points[rope.n - 1][1] < 0.02, `hangs down: ${rope.points[rope.n - 1][1]}`);
});

test('physics: a hand capsule pushes a box only while it touches it, and a rung stops a falling ball', () => {
  const w = new World({ seed: 1, groundY: 0 });
  const box = w.add({ name: 'box', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [0, 0.05, 0], friction: 0.3 });
  w.addStatic({ name: 'rung', shape: 'capsule', a: [-0.3, 0.5, 1], b: [0.3, 0.5, 1], r: 0.016 });
  const ball = w.add({ name: 'ball', shape: 'sphere', r: 0.03, mass: 0.1, pos: [0, 0.8, 1], restitution: 0 });
  // A capsule 5 cm from the box's face, moving in at 0.2 m/s for 0.5 s, then still.
  let x = -0.1;
  let movedBeforeTouch = false;
  run(w, 1.5, (i) => {
    const t = i * DT;
    if (t < 0.5) x += 0.2 * DT;
    w.setHandCapsules([{ side: 'right', name: 'finger', digit: 'index', segment: 'phalanx-distal', a: [x, 0.05, -0.02], b: [x, 0.05, 0.02], r: 0.008 }], DT);
    if (x + 0.008 < -0.05 - 0.002 && Math.abs(box.pos[0]) > 1e-4) movedBeforeTouch = true;
  });
  assert.ok(!movedBeforeTouch, 'the box does not move before the finger reaches it');
  assert.ok(box.pos[0] > 0.02, `the finger pushed it: ${box.pos[0]}`);
  assert.ok(box.pos[0] - 0.05 >= x + 0.008 - 0.0015, 'the finger is not inside the box');
  assert.ok(ball.pos[1] > 0.5, `the ball rests on the rung: ${ball.pos[1]}`);
});

test('physics: the same calls give the same state bit for bit; another seed-free change differs', () => {
  const make = (vx) => {
    const w = new World({ seed: 3, groundY: 0 });
    w.add({ name: 'a', shape: 'sphere', r: 0.03, mass: 0.2, pos: [0, 0.4, 0], vel: [vx, 0, 0.1], restitution: 0.4 });
    w.add({ name: 'b', shape: 'box', hx: 0.05, hy: 0.03, hz: 0.04, mass: 0.5, pos: [0.05, 0.6, 0.02], rot: quat.fromAxisAngle([0, 0, 0, 1], [1, 1, 0], 0.4) });
    w.add(new Rope({ name: 'r', top: [1, 1, 0], length: 0.6, segments: 12 }));
    run(w, 3);
    return w.stateValues();
  };
  const a = make(0.3);
  const b = make(0.3);
  assert.deepEqual(a, b);
  const c = make(0.31);
  assert.notDeepEqual(a, c);
  assert.ok(new Body({ shape: 'sphere', r: 1 }).mass === 1);
});
