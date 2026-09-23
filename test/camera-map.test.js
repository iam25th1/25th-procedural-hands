// The Move camera mapping: direct by default (drag right moves the camera
// right, drag up moves it up; in first person the view turns right and looks
// up), each axis invertible, sensitivity scaling both. Pointer deltas are
// +x right and +y down, as the browser reports them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_DEFAULTS, cameraSettings, dragOrbit, dragLook, orbitPosition, lookDirection } from '../app/ui/camera-map.js';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

// The camera's own right and up vectors for an orbit, as three's lookAt builds them.
function basis(o) {
  const pos = orbitPosition(o);
  const fwd = norm(sub(o.target, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  return { pos, right, up: cross(right, fwd) };
}
const ORBIT = { target: [0.2, -0.3, -0.4], yaw: 2.5, pitch: 0.4, dist: 0.8 };

test('camera drag: defaults are the direct mapping', () => {
  assert.deepEqual(cameraSettings({}), { ...CAMERA_DEFAULTS });
  assert.deepEqual(cameraSettings({ sensitivity: 99 }).sensitivity, 3);
  assert.deepEqual(cameraSettings({ sensitivity: 'x' }).sensitivity, 1);
});

test('camera drag: in inspection, drag right moves the camera right and drag up moves it up', () => {
  const b = basis(ORBIT);
  const right = sub(orbitPosition(dragOrbit(ORBIT, 20, 0, {})), b.pos);
  const left = sub(orbitPosition(dragOrbit(ORBIT, -20, 0, {})), b.pos);
  const up = sub(orbitPosition(dragOrbit(ORBIT, 0, -20, {})), b.pos);
  const down = sub(orbitPosition(dragOrbit(ORBIT, 0, 20, {})), b.pos);
  assert.ok(dot(right, b.right) > 0, 'drag right moves right');
  assert.ok(dot(left, b.right) < 0, 'drag left moves left');
  assert.ok(dot(up, b.up) > 0, 'drag up moves up');
  assert.ok(dot(down, b.up) < 0, 'drag down moves down');
});

test('camera drag: in first person, drag right turns the view right and drag up looks up', () => {
  const dir = [0, -0.62, -1];
  const base = lookDirection(dir, { yaw: 0, pitch: 0 });
  const right = norm(cross(base, [0, 1, 0]));
  const turned = lookDirection(dir, dragLook({ yaw: 0, pitch: 0 }, 20, 0, {}));
  const raised = lookDirection(dir, dragLook({ yaw: 0, pitch: 0 }, 0, -20, {}));
  assert.ok(dot(sub(turned, base), right) > 0, 'drag right turns right');
  assert.ok(raised[1] > base[1], 'drag up looks up');
});

test('camera drag: Invert X and Invert Y flip one axis each, sensitivity scales', () => {
  const b = basis(ORBIT);
  const flippedX = sub(orbitPosition(dragOrbit(ORBIT, 20, 0, { invertX: true })), b.pos);
  const flippedY = sub(orbitPosition(dragOrbit(ORBIT, 0, -20, { invertY: true })), b.pos);
  assert.ok(dot(flippedX, b.right) < 0, 'inverted X: drag right moves left');
  assert.ok(dot(flippedY, b.up) < 0, 'inverted Y: drag up moves down');
  const slow = dragOrbit(ORBIT, 20, 0, { sensitivity: 0.5 }).yaw - ORBIT.yaw;
  const fast = dragOrbit(ORBIT, 20, 0, { sensitivity: 2 }).yaw - ORBIT.yaw;
  assert.ok(Math.abs(fast / slow - 4) < 1e-9, 'sensitivity scales linearly');
});
