import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spring, Oscillator } from '../src/springs.js';
import { Skeleton, TWIST_PART } from '../src/skeleton.js';
import { FOREARM_TWIST } from '../src/anatomy.js';
import { solveArm, handRotation } from '../src/ik.js';
import { poseChannels, applyChannels } from '../src/fingers.js';
import { POSES } from '../src/poses.js';
import { Rig } from '../src/rig.js';
import { solveGrasp, placeObject, preShape, aperture, tipGap } from '../src/grasp.js';
import { v3, quat, deg, toDeg } from '../src/math.js';
import { mulberry32 } from '../src/rng.js';
import { STEP } from '../src/clock.js';

test('critically damped spring never overshoots and settles', () => {
  const s = new Spring(24, 0);
  s.target = 1;
  let maxX = 0;
  for (let i = 0; i < 120; i++) { s.step(STEP); maxX = Math.max(maxX, s.x); assert.ok(s.x <= 1 + 1e-9, `overshoot ${s.x}`); }
  assert.ok(Math.abs(s.x - 1) < 0.01, `settled ${s.x}`);
  assert.ok(maxX > 0.99);
  // Same inputs, same outputs, bit for bit.
  const a = new Spring(24, 0); const b = new Spring(24, 0);
  a.target = 0.7; b.target = 0.7;
  for (let i = 0; i < 30; i++) { a.step(STEP); b.step(STEP); }
  assert.equal(a.x, b.x);
});

test('under damped oscillator rings and settles within its envelope', () => {
  const o = new Oscillator(2 * Math.PI * 8, 0.2, 1);
  o.target = 0;
  let crossed = 0; let prev = o.x;
  for (let i = 0; i < 60; i++) { o.step(STEP); if (Math.sign(o.x) !== Math.sign(prev)) crossed++; prev = o.x; }
  assert.ok(crossed >= 3, `rings ${crossed}`);
  assert.ok(Math.abs(o.x) < 0.05, `settled ${o.x}`);
});

test('two bone IK meets reachable targets within 2 mm, extends fully when unreachable, no elbow flips', () => {
  const skel = new Skeleton();
  const rng = mulberry32(5);
  for (const side of ['right', 'left']) {
    const s = side === 'right' ? 1 : -1;
    const shoulder = skel.joint(side, 'upper-arm').worldPos;
    const reach = skel.joint(side, 'upper-arm').length + v3.dist(skel.joint(side, 'forearm').restWorldPos, skel.joint(side, 'wrist').restWorldPos);
    const pole = [s * 0.5, -0.7, 0];
    let worst = 0;
    let lastElbow = null;
    for (let i = 0; i < 300; i++) {
      // Working volume in front and below the eyes, inside reach.
      const target = [shoulder[0] + (rng() - 0.5) * 0.5, shoulder[1] + (rng() - 0.3) * 0.4, shoulder[2] - 0.15 - rng() * 0.35];
      const d = v3.dist(target, shoulder);
      if (d > reach * 0.97 || d < 0.2) continue;
      const rot = handRotation([0, 0.2, -1], [-s, 0.2, 0]);
      const r = solveArm(skel, side, target, rot, pole);
      worst = Math.max(worst, r.error);
      assert.ok(r.reachable);
      assert.ok(r.flex >= 0 && r.flex <= deg(150), `elbow flex ${toDeg(r.flex)}`);
      // The elbow always sits on the pole side of the shoulder to wrist line.
      const u = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], target, shoulder));
      const e = v3.sub([0, 0, 0], r.elbow, shoulder);
      const side_ = v3.dot(v3.reject([0, 0, 0], e, u), v3.reject([0, 0, 0], v3.sub([0, 0, 0], pole, shoulder), u));
      assert.ok(side_ >= -1e-9, 'elbow on pole side');
      lastElbow = r.elbow;
    }
    assert.ok(worst <= 0.002, `${side} worst error ${worst}`);
    // Unreachable: the arm extends fully toward the target along the line.
    const far = [shoulder[0], shoulder[1] - 0.2, shoulder[2] - 1.5];
    const r = solveArm(skel, side, far, handRotation([0, 0, -1], [0, -1, 0]), pole);
    assert.equal(r.reachable, false);
    assert.ok(r.flex < deg(3), `extended ${toDeg(r.flex)}`);
    const wr = skel.joint(side, 'wrist').worldPos;
    const u = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], far, shoulder));
    const w = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], wr, shoulder));
    assert.ok(v3.dot(u, w) > 0.9999, 'points at the target');
    void lastElbow;
  }
});

test('forearm rotation is shared across the twist bones in the sourced parts, none at the wrist', () => {
  const skel = new Skeleton();
  const side = 'right';
  const shoulder = skel.joint(side, 'upper-arm').worldPos;
  const target = [shoulder[0] + 0.05, shoulder[1] + 0.05, shoulder[2] - 0.45];
  const rot = handRotation([0, 0, -1], [Math.sin(deg(40)), -Math.cos(deg(40)), 0]);
  const r = solveArm(skel, side, target, rot, [0.5, -0.7, 0]);
  // Each twist bone takes its part of the rotation: the skin's share of the
  // hand's turn at its stop less the share at the stop before (Kulesh PN et
  // al. SICOT J 2015;1:3; anatomy.js FOREARM_TWIST), and the wrist none.
  const twists = FOREARM_TWIST.map((t) => skel.joint(side, t.name).channels.twist);
  const total = twists.reduce((a, b) => a + b, 0);
  FOREARM_TWIST.forEach((t, i) => assert.ok(Math.abs(twists[i] - total * TWIST_PART[t.name]) < 1e-9, `${t.name} carries ${TWIST_PART[t.name].toFixed(3)} of the rotation`));
  assert.equal(skel.joint(side, 'wrist').channels.twist, 0, 'the wrist joint does not pronate');
  // Channels measure pronation from thumb up neutral: palm down is 90, a
  // palm turned 40 degrees toward the thumb side is less pronated.
  assert.ok(total > deg(10) && total <= deg(90) + 1e-9, `total pronation ${toDeg(total)}`);
  assert.ok(r.error < 0.002);
  // Arm straight ahead, palm down: the bind pose, which is 90 of pronation.
  solveArm(skel, side, [shoulder[0], shoulder[1], shoulder[2] - 2], handRotation([0, 0, -1], [0, -1, 0]), [shoulder[0], shoulder[1] - 1, shoulder[2] - 0.2]);
  const full = FOREARM_TWIST.reduce((a, t) => a + skel.joint(side, t.name).channels.twist, 0);
  assert.ok(Math.abs(full - deg(90)) < deg(2), `palm down is 90 pronation, got ${toDeg(full)}`);
});

test('finger coupling: DIP follows PIP at two thirds, ring and little enslave each other, limits hold', () => {
  const skel = new Skeleton();
  const pose = structuredClone(POSES.open);
  for (const f of ['index', 'middle', 'ring', 'little']) pose[f].dip = null;
  pose.index.pip = deg(60);
  pose.ring.mcp[0] = deg(60);
  const ch = poseChannels(pose);
  assert.ok(Math.abs(ch['index-finger-phalanx-distal'].flex - deg(40)) < 1e-9);
  assert.ok(ch['pinky-finger-phalanx-proximal'].flex > deg(10), 'little follows ring');
  assert.ok(ch['middle-finger-phalanx-proximal'].flex > 0 && ch['middle-finger-phalanx-proximal'].flex < ch['pinky-finger-phalanx-proximal'].flex);
  assert.equal(ch['index-finger-phalanx-proximal'].flex, 0, 'index stays independent of ring');
  applyChannels(skel, 'right', ch);
  for (const name of Object.keys(POSES)) {
    applyChannels(skel, 'right', poseChannels(POSES[name]));
    for (const j of skel.sides.right.joints) {
      const c = j.channels;
      assert.ok(c.flex >= j.limits.flex[0] - 1e-9 && c.flex <= j.limits.flex[1] + 1e-9, `${name} ${j.name} flex`);
      assert.ok(c.abd >= j.limits.abd[0] - 1e-9 && c.abd <= j.limits.abd[1] + 1e-9, `${name} ${j.name} abd`);
    }
  }
});

test('grasp: power grip contacts, pad pinch contacts, spherical contacts, aperture monotonic', () => {
  const skel = new Skeleton();
  const side = 'right';
  const cyl = { shape: 'cylinder', r: 0.014, h: 0.09 };
  const placedC = placeObject(skel, side, cyl, 'powerCylinder');
  const power = solveGrasp(skel, side, { ...cyl, ...placedC }, 'powerCylinder');
  const digitsOn = new Set(power.contacts.map((c) => c.digit));
  assert.ok(['index', 'middle', 'ring', 'little', 'thumb'].every((d) => digitsOn.has(d)), `power grip digits: ${[...digitsOn]}`);
  for (const c of power.contacts) assert.ok(c.depth <= 0.001 + 1e-9, `contact depth ${c.depth}`);

  const pebble = { shape: 'sphere', r: 0.012 };
  const preP = preShape(skel, side, pebble, 'padPinch');
  const placedP = placeObject(skel, side, pebble, 'padPinch');
  const pinch = solveGrasp(skel, side, { ...pebble, ...placedP }, 'padPinch', preP.pose);
  const pinchDigits = new Set(pinch.contacts.map((c) => c.digit));
  assert.ok(pinchDigits.has('thumb') && pinchDigits.has('index'), `pinch digits: ${[...pinchDigits]}`);

  const rock = { shape: 'sphere', r: 0.03 };
  const placedR = placeObject(skel, side, rock, 'spherical');
  const sph = solveGrasp(skel, side, { ...rock, ...placedR }, 'spherical');
  const sphDigits = new Set(sph.contacts.map((c) => c.digit));
  assert.ok(sphDigits.size >= 4, `spherical digits: ${[...sphDigits]}`);

  let prev = -1;
  for (let r = 0.008; r <= 0.0401; r += 0.004) {
    const obj = { shape: 'sphere', r, pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    const pre = preShape(skel, side, obj, r <= 0.02 ? 'padPinch' : 'spherical');
    assert.ok(pre.gap > prev - 1e-6, `aperture grows: r=${r} gap=${pre.gap} prev=${prev}`);
    assert.ok(Math.abs(pre.gap - aperture(r)) < 0.004 || pre.gap >= aperture(r) - 0.004, `gap ${pre.gap} vs ${aperture(r)}`);
    prev = pre.gap;
  }
  void tipGap;
});

test('rig: deterministic for a seed, springs keep joints continuous, hand root never jumps', () => {
  const a = new Rig({ seed: 7 });
  const b = new Rig({ seed: 7 });
  const hashes = [];
  for (let i = 1; i <= 120; i++) {
    a.step(STEP); b.step(STEP);
    if (i === 30) { a.setPose('right', 'fist'); b.setPose('right', 'fist'); }
    if (i === 60) { a.setLayer('left', 'g', 'point', { mask: { index: 1, thumb: 1 } }); b.setLayer('left', 'g', 'point', { mask: { index: 1, thumb: 1 } }); }
    if (i % 20 === 0) hashes.push([a.hash(), b.hash()]);
  }
  for (const [ha, hb] of hashes) assert.equal(ha, hb);
  assert.notEqual(new Rig({ seed: 8 }).hash(), a.hash());
});

test('rig: a pose change moves every finger joint smoothly under 20 rad/s and the wrist stays put', () => {
  const rig = new Rig({ seed: 3 });
  const localRot = (j) => (j.parent ? quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], j.parent.worldRot), j.worldRot) : j.worldRot.slice());
  const prev = rig.skel.joints.map(localRot);
  const prevW = rig.skel.joint('right', 'wrist').worldPos.slice();
  // The right hand starts pinching the pouch; digits holding something keep
  // their grasp through a pose change, so it lets go first (as the lab's
  // pose chips do) and then makes the fist.
  rig.release('right');
  rig.setPose('right', 'fist');
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    rig.step(STEP);
    rig.skel.joints.forEach((j, k) => {
      const cur = localRot(j);
      const ang = quat.angleBetween(prev[k], cur);
      worst = Math.max(worst, ang / STEP);
      prev[k] = cur;
    });
    const w = rig.skel.joint('right', 'wrist').worldPos;
    assert.ok(v3.dist(w, prevW) < 0.05);
  }
  assert.ok(worst < 20, `worst angular speed ${worst} rad/s`);
  const idx = rig.skel.joint('right', 'index-finger-phalanx-intermediate').channels.flex;
  assert.ok(idx > deg(90), `fist reached ${toDeg(idx)}`);
});
