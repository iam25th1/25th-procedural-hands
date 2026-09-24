import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, EVENTS, GRIPS, OBJECTS, STEP, handRotation, createThreeView, v3 } from '../src/index.js';

const run = (h, seconds) => { for (let i = 0; i < Math.round(seconds / STEP); i++) h.step(); };
const deg = (r) => (r * 180) / Math.PI;

test('create and update: fixed 60 Hz steps, the remainder carries over, deterministic per seed', () => {
  const a = create({ seed: 3 });
  const b = create({ seed: 3 });
  assert.equal(a.update(0.1), 6);
  assert.equal(a.frame, 6);
  a.update(STEP / 2);
  assert.equal(a.frame, 6);
  a.update(STEP / 2);
  assert.equal(a.frame, 7);
  run(b, 7 * STEP);
  assert.equal(a.hash(), b.hash());
  assert.equal(a.update(0), 0);
  assert.equal(a.update(-1), 0);
});

test('setPose and blendPose move the fingers through springs, per hand, with masks', () => {
  const h = create();
  h.setPose('right', 'fist');
  run(h, 0.8);
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex) > 90);
  assert.ok(deg(h.joint('left', 'index-finger-phalanx-intermediate').channels.flex) < 40, 'the other hand is untouched');
  h.blendPose('right', 'open', 1, { mask: { index: 1 } });
  run(h, 0.8);
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex) < 5, 'masked digit opens');
  assert.ok(deg(h.joint('right', 'middle-finger-phalanx-intermediate').channels.flex) > 90, 'unmasked digit stays in the fist');
  h.clearBlend('right');
  run(h, 0.8);
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex) > 90);
});

test('setFinger and setFingerJoint: curl 0 to 1 per finger and per joint, spread, on either hand', () => {
  const h = create();
  h.setPose('both', 'open', { snap: true });
  h.setFinger('left', 'ring', 1, 0);
  h.setFingerJoint('right', 'index', 'dip', 1);
  run(h, 1);
  assert.ok(deg(h.joint('left', 'ring-finger-phalanx-intermediate').channels.flex) > 95);
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-distal').channels.flex) > 85);
  h.setFinger('right', 'index', 0, 1);
  run(h, 1);
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-proximal').channels.abd) > 20, 'spread');
  assert.throws(() => h.setFinger('right', 'toe', 1), /finger must be/);
  assert.throws(() => h.setFingerJoint('right', 'thumb', 'pip', 1), /thumb joints are cmc, mcp, ip/);
  h.releaseFingers('both');
  run(h, 1.5);
  assert.ok(deg(h.joint('left', 'ring-finger-phalanx-intermediate').channels.flex) < 5, 'released back to the pose');
});

test('gesture(name) on one or both hands, and stopGesture', () => {
  const h = create();
  h.gesture('point');
  run(h, 1);
  for (const side of ['left', 'right']) {
    assert.ok(deg(h.joint(side, 'index-finger-phalanx-intermediate').channels.flex) < 10, `${side} index extended (natural coupling to the folded middle finger allows a few degrees)`);
    assert.ok(deg(h.joint(side, 'middle-finger-phalanx-intermediate').channels.flex) > 80, `${side} middle folded`);
  }
  h.stopGesture();
  run(h, 1);
  assert.ok(deg(h.joint('left', 'middle-finger-phalanx-intermediate').channels.flex) < 45);
  assert.throws(() => h.gesture('juggle'), /unknown gesture/);
});

test('IK targets: the wrist reaches a target and the elbow follows the pole', () => {
  const h = create();
  const pos = [0.18, -0.2, -0.4];
  h.setTarget('right', { pos, rot: handRotation([0, 0, -1], [0, -1, 0]), pole: [0.6, -0.7, 0] });
  run(h, 1.5);
  assert.ok(v3.dist(h.joint('right', 'wrist').pos, pos) < 0.004);
});

test('grasp, release, attach, detach and the events they emit', () => {
  const h = create();
  const seen = Object.fromEntries(EVENTS.map((e) => [e, []]));
  for (const e of EVENTS) h.on(e, (ev) => seen[e].push(ev));
  const att = h.grasp('right', OBJECTS.rock, 'spherical');
  assert.ok(att.contacts.length >= 4);
  assert.equal(seen.grasped.length, 1);
  assert.equal(seen.grasped[0].hand, 'right');
  assert.equal(seen.grasped[0].grip, 'spherical');
  assert.ok(seen.contact.length >= 4);
  const before = h.held('right').pos;
  h.setTarget('right', { pos: [0.2, -0.15, -0.35] });
  run(h, 0.5);
  assert.ok(v3.dist(h.held('right').pos, before) > 0.02, 'the held object moves with the hand');
  h.release('right', { velocity: [0, 1, 0] });
  assert.equal(seen.released.length, 1);
  assert.deepEqual(seen.released[0].velocity, [0, 1, 0]);
  assert.equal(h.held('right'), null);
  const obj = { shape: 'sphere', r: 0.02, pos: h.joint('left', 'wrist').pos, rot: [0, 0, 0, 1] };
  h.attach('left', obj);
  assert.ok(h.held('left'));
  const d = h.detach('left');
  assert.ok(d && h.held('left') === null);
  assert.ok(Object.keys(GRIPS).length >= 7);
  assert.throws(() => h.grasp('left', OBJECTS.rock, 'telekinesis'), /unknown grip/);
  assert.throws(() => h.on('exploded', () => {}), /unknown event/);
});

test('dispose tears everything down and later calls fail loudly', () => {
  const h = create();
  let called = 0;
  h.on('grasped', () => called++);
  h.dispose();
  h.dispose();
  assert.throws(() => h.update(0.1), /disposed/);
  assert.equal(called, 0);
});

test('createThreeView builds one skinned mesh per arm with every bone, DOM free', () => {
  const h = create();
  const view = createThreeView(h, { lod: 'low' });
  view.update();
  assert.equal(view.group.children.length, 2);
  assert.ok(view.triangles > 2000);
  const sm = view.arms.right.mesh;
  assert.equal(sm.isSkinnedMesh, true);
  assert.equal(sm.skeleton.bones.length, 31);
  view.recolor({ skinTone: '#4E3220', sleeveColour: '#2D6CDF' });
  view.setLod('high');
  assert.ok(view.triangles > 10000);
  view.dispose();
});
