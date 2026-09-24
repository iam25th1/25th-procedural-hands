import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton, XR_JOINT_NAMES, ARM_JOINT_NAMES, FINGERS, XR_PREFIX, channelsToQuat, quatToChannels } from '../src/skeleton.js';
import { BONES_MM, ARM_MM, CARPUS_MM, MM } from '../src/anatomy.js';
import { v3, deg, quat } from '../src/math.js';
import { mulberry32 } from '../src/rng.js';

const skel = new Skeleton();

test('25 WebXR joints per hand, in module order, with the module parent chain', () => {
  assert.equal(XR_JOINT_NAMES.length, 25);
  assert.equal(XR_JOINT_NAMES[0], 'wrist');
  assert.equal(XR_JOINT_NAMES[1], 'thumb-metacarpal');
  assert.equal(XR_JOINT_NAMES[4], 'thumb-tip');
  assert.equal(XR_JOINT_NAMES[5], 'index-finger-metacarpal');
  assert.equal(XR_JOINT_NAMES[24], 'pinky-finger-tip');
  for (const side of ['left', 'right']) {
    const hand = skel.sides[side].joints.filter((j) => j.kind === 'hand');
    assert.equal(hand.length, 25);
    assert.deepEqual(hand.map((j) => j.name), XR_JOINT_NAMES);
    assert.equal(skel.joint(side, 'wrist').parent.name, 'forearm-twist-3');
    assert.equal(skel.joint(side, 'thumb-metacarpal').parent.name, 'wrist');
    assert.equal(skel.joint(side, 'index-finger-tip').parent.name, 'index-finger-phalanx-distal');
    assert.equal(skel.joint(side, 'pinky-finger-phalanx-intermediate').parent.name, 'pinky-finger-phalanx-proximal');
    const arm = skel.sides[side].joints.filter((j) => j.kind === 'arm');
    assert.deepEqual(arm.map((j) => j.name), ARM_JOINT_NAMES);
  }
  assert.equal(skel.joints.length, 62);
});

test('bone lengths equal the sourced data', () => {
  for (const side of ['left', 'right']) {
    for (const f of FINGERS) {
      const b = BONES_MM[f];
      const p = XR_PREFIX[f];
      const L = (a, c) => v3.dist(skel.joint(side, a).worldPos, skel.joint(side, c).worldPos) / MM;
      assert.ok(Math.abs(L(`${p}-metacarpal`, `${p}-phalanx-proximal`) - b.metacarpal) < 1e-9, `${f} metacarpal`);
      assert.ok(Math.abs(L(`${p}-phalanx-proximal`, `${p}-phalanx-intermediate`) - b.proximal) < 1e-9, `${f} proximal`);
      assert.ok(Math.abs(L(`${p}-phalanx-intermediate`, `${p}-phalanx-distal`) - b.middle) < 1e-9, `${f} middle`);
      assert.ok(Math.abs(L(`${p}-phalanx-distal`, `${p}-tip`) - (b.distal + b.tip)) < 1e-9, `${f} distal plus tip`);
    }
    const t = BONES_MM.thumb;
    const L = (a, c) => v3.dist(skel.joint(side, a).worldPos, skel.joint(side, c).worldPos) / MM;
    assert.ok(Math.abs(L('thumb-metacarpal', 'thumb-phalanx-proximal') - t.metacarpal) < 1e-9);
    assert.ok(Math.abs(L('thumb-phalanx-proximal', 'thumb-phalanx-distal') - t.proximal) < 1e-9);
    assert.ok(Math.abs(L('thumb-phalanx-distal', 'thumb-tip') - (t.distal + t.tip)) < 1e-9);
    assert.ok(Math.abs(L('upper-arm', 'forearm') - ARM_MM.upperArm) < 1e-9);
    assert.ok(Math.abs(L('forearm', 'wrist') - ARM_MM.forearm) < 1e-9);
    // Middle metacarpal base sits one carpus length from the wrist centre along the palm.
    const base = skel.joint(side, 'middle-finger-metacarpal').worldPos;
    const wrist = skel.joint(side, 'wrist').worldPos;
    assert.ok(Math.abs(-(base[2] - wrist[2]) / MM - CARPUS_MM) < 0.5);
  }
});

test('left and right mirror within 0.1 mm at rest and under identical channels', () => {
  const rng = mulberry32(3);
  for (let trial = 0; trial < 20; trial++) {
    skel.reset();
    if (trial > 0) {
      for (const j of skel.sides.right.joints) {
        const L = skel.joint('left', j.name);
        const flex = j.limits.flex[0] + rng() * (j.limits.flex[1] - j.limits.flex[0]);
        const abd = j.limits.abd[0] + rng() * (j.limits.abd[1] - j.limits.abd[0]);
        const twist = j.limits.twist[0] + rng() * (j.limits.twist[1] - j.limits.twist[0]);
        skel.setChannels(j, flex, abd, twist);
        skel.setChannels(L, flex, abd, twist);
      }
      skel.update();
    }
    let worst = 0;
    for (const j of skel.sides.right.joints) {
      const L = skel.joint('left', j.name);
      const m = v3.mirrorX([0, 0, 0], j.worldPos);
      worst = Math.max(worst, v3.dist(m, L.worldPos));
    }
    assert.ok(worst < 0.1 * MM, `trial ${trial}: worst mirror error ${worst / MM} mm`);
  }
  skel.reset();
});

test('joint frames follow the WebXR convention: -Z distal, +Y dorsal', () => {
  for (const side of ['left', 'right']) {
    const j = skel.joint(side, 'index-finger-phalanx-proximal');
    const child = skel.joint(side, 'index-finger-phalanx-intermediate');
    const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], child.worldPos, j.worldPos));
    const minusZ = quat.rotate([0, 0, 0], j.worldRot, [0, 0, -1]);
    assert.ok(v3.dot(dir, minusZ) > 0.999999, side);
    const y = quat.rotate([0, 0, 0], j.worldRot, [0, 1, 0]);
    assert.ok(y[1] > 0.99, `${side} dorsal up`);
    // Flexion curls the finger toward the palm (world -Y in the bind pose).
    skel.setChannels(j, deg(60), 0, 0);
    skel.update();
    const dir2 = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], child.worldPos, j.worldPos));
    assert.ok(dir2[1] < -0.5, `${side} flex goes palmar`);
    // Positive abduction spreads the index away from the middle finger (radially).
    skel.setChannels(j, 0, deg(20), 0);
    skel.update();
    const dir3 = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], child.worldPos, j.worldPos));
    const radial = side === 'right' ? -1 : 1;
    assert.ok(dir3[0] * radial > 0.2, `${side} abd goes radial`);
    skel.reset();
  }
});

test('channel round trip through quaternion', () => {
  const rng = mulberry32(9);
  for (let i = 0; i < 200; i++) {
    const flex = (rng() - 0.5) * 3;
    const abd = (rng() - 0.5) * 1.2;
    const twist = (rng() - 0.5) * 2.5;
    for (const s of [1, -1]) {
      const q = channelsToQuat([0, 0, 0, 1], flex, abd, twist, s);
      const c = quatToChannels(q, s);
      assert.ok(Math.abs(c.flex - flex) < 1e-9 && Math.abs(c.abd - abd) < 1e-9 && Math.abs(c.twist - twist) < 1e-9, `${flex} ${abd} ${twist} -> ${JSON.stringify(c)}`);
    }
  }
});

test('setChannels clamps to the limit table', () => {
  const j = skel.joint('right', 'index-finger-phalanx-intermediate');
  skel.setChannels(j, deg(140), deg(30), 0);
  assert.ok(Math.abs(j.channels.flex - deg(100)) < 1e-12);
  assert.equal(j.channels.abd, 0);
  skel.reset();
});

test('thumb CMC saddle: flex sweeps across the palm, abd lifts palmar, channels round trip', () => {
  for (const side of ['right', 'left']) {
    const cmc = skel.joint(side, 'thumb-metacarpal');
    const mcp = skel.joint(side, 'thumb-phalanx-proximal');
    const wrist = skel.joint(side, 'wrist');
    const dirOf = () => { skel.update(); const d = v3.sub([0, 0, 0], mcp.worldPos, cmc.worldPos); return v3.normalize([0, 0, 0], quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], wrist.worldRot), d)); };
    skel.reset();
    const d0 = dirOf();
    skel.setChannels(cmc, deg(40), 0, 0);
    const dFlex = dirOf();
    const ulnar = side === 'right' ? 1 : -1;
    assert.ok((dFlex[0] - d0[0]) * ulnar > 0.2, `${side} flex sweeps ulnar`);
    assert.ok(Math.abs(dFlex[1] - d0[1]) < 0.08, `${side} flex stays near the palm plane`);
    skel.setChannels(cmc, 0, deg(30), 0);
    const dAbd = dirOf();
    assert.ok(dAbd[1] < d0[1] - 0.2, `${side} abd lifts palmar`);
    const rng = mulberry32(21);
    for (let i = 0; i < 100; i++) {
      const f = deg(-29 + rng() * 91);
      const a = deg(-45 + rng() * 82);
      const t = deg(-35 + rng() * 70);
      skel.setChannels(cmc, f, a, t);
      const m = skel.measureChannels(cmc);
      assert.ok(Math.abs(m.flex - f) < 1e-6 && Math.abs(m.abd - a) < 1e-6 && Math.abs(m.twist - t) < 1e-6, `${side} round trip ${[f, a, t]} -> ${JSON.stringify(m)}`);
    }
    skel.reset();
  }
});

test('wrist swing twist joint: channels round trip and stay continuous through big swings', () => {
  for (const side of ['right', 'left']) {
    const wr = skel.joint(side, 'wrist');
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      const f = deg(-71 + rng() * 144);
      const a = deg(-19 + rng() * 52);
      const t = deg(-30 + rng() * 60);
      skel.setChannels(wr, f, a, t);
      const m = skel.measureChannels(wr);
      // The radiocarpal joint flexes and deviates but does not pronate: the
      // hand turns with the radius, and the forearm's twist bones carry the
      // rotation (anatomy.js, Kulesh 2015). A twist asked of the wrist is
      // clamped to zero; flexion and deviation round trip through any swing.
      assert.ok(Math.abs(m.flex - f) < 1e-6 && Math.abs(m.abd - a) < 1e-6 && Math.abs(m.twist) < 1e-9, `${side} wrist round trip ${[f, a, t]} -> ${JSON.stringify(m)}`);
    }
    skel.reset();
  }
});
