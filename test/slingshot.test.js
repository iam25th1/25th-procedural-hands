// The Slingshot scene plays every action to completion under Node, the pouch
// rides the pinch through a draw, and a release sends the stone along the
// aim. Thresholds match the slingshot checks in npm run hands:check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlingshotScene, ACTION_NAMES, ACTION_DURATIONS } from '../app/scenes/slingshot-scene.js';
import { v3, toDeg, STEP } from '../hands/src/index.js';
import { capsuleEnd } from '../hands/src/skeleton.js';
import { capsuleObjectDistance } from '../hands/src/grasp.js';

const MM = 0.001;

// Worst of: pouch centre against the pinched object's centre, and the thumb
// and index distal capsules off (or into) the pinched object's surface.
function pinchError(rig) {
  const side = rig.pinchSide;
  const obj = rig.attachedObject(side);
  if (!obj) return Infinity;
  let worst = v3.dist(rig.slingshot.pouchCentre, obj.pos);
  for (const name of ['thumb-phalanx-distal', 'index-finger-phalanx-distal']) {
    const j = rig.skel.joint(side, name);
    worst = Math.max(worst, Math.abs(capsuleObjectDistance(obj, j.worldPos, capsuleEnd(j), j.radius)));
  }
  return worst;
}

test('slingshot scene: every action plays to completion with a finite pose', () => {
  const scene = createSlingshotScene({ seed: 3 });
  assert.deepEqual(scene.names, ACTION_NAMES);
  assert.equal(ACTION_NAMES.length, 17);
  for (const name of ACTION_NAMES) {
    scene.play(name);
    const t = scene.stepTo(ACTION_DURATIONS[name]);
    assert.ok(Math.abs(t - ACTION_DURATIONS[name]) < STEP / 2, `${name} reached ${t}`);
    const values = scene.rig.skel.transformValues();
    assert.ok(values.every(Number.isFinite), `${name}: non finite joint transform`);
    assert.ok(scene.slingshot.pouchCentre.every(Number.isFinite), `${name}: non finite pouch`);
  }
  scene.dispose();
});

test('slingshot scene: the pouch stays within 2 mm of the pinch point while drawing', () => {
  const scene = createSlingshotScene({ seed: 21 });
  scene.play('draw');
  let worst = 0;
  let frames = 0;
  for (let i = 1; i <= Math.round(ACTION_DURATIONS.draw / STEP); i++) {
    scene.stepTo(i * STEP);
    if (!scene.slingshot.pinched) continue;
    frames++;
    worst = Math.max(worst, pinchError(scene.rig));
  }
  assert.ok(frames > 60, `pinched on ${frames} frames`);
  assert.ok(scene.actions.draw > 0.97, `draw reached ${scene.actions.draw}`);
  assert.ok(worst <= 2 * MM, `worst pinch error ${(worst / MM).toFixed(3)} mm`);
});

test('slingshot scene: a release launches the stone within 1 degree of the aim', () => {
  const scene = createSlingshotScene({ seed: 25 });
  scene.play('release');
  const launch = scene.actions.lastLaunch;
  assert.ok(launch && launch.launched, 'a stone was launched');
  // The reticle: straight ahead from the cheek anchor.
  const angle = toDeg(Math.acos(Math.min(1, v3.dot(launch.launchDir, [0, 0, -1]))));
  assert.ok(angle <= 1, `launch ${angle.toFixed(3)} degrees off the aim`);
  scene.stepTo(ACTION_DURATIONS.release);
  assert.equal(scene.actions.state, 'idle');
});
