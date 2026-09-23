// How a drag in Move camera mode turns into camera motion. Direct mapping by
// default: drag right and the camera moves right, drag up and it moves up
// (in first person: drag right and the view turns right, drag up and it
// looks up). Invert X and Invert Y flip an axis; sensitivity scales both.
// Pure functions of their inputs, so the mapping is tested under Node.

export const CAMERA_DEFAULTS = Object.freeze({ invertX: false, invertY: false, sensitivity: 1 });
export const SENSITIVITY = Object.freeze({ min: 0.25, max: 3, step: 0.05 });

// Radians per pixel at sensitivity 1.
const ORBIT_YAW = 0.008;
const ORBIT_PITCH = 0.006;
const LOOK = 0.005;
const PITCH_LIMIT = 1.4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A settings object with every field valid, whatever was stored.
export function cameraSettings(raw = {}) {
  const s = Number(raw && raw.sensitivity);
  return {
    invertX: Boolean(raw && raw.invertX),
    invertY: Boolean(raw && raw.invertY),
    sensitivity: Number.isFinite(s) ? clamp(s, SENSITIVITY.min, SENSITIVITY.max) : CAMERA_DEFAULTS.sensitivity,
  };
}

function signs(settings) {
  const s = cameraSettings(settings);
  return { x: (s.invertX ? -1 : 1) * s.sensitivity, y: (s.invertY ? -1 : 1) * s.sensitivity };
}

// Screen deltas are in pixels, +x right and +y down (pointer coordinates).
// Orbit: yaw up moves the camera toward its own right (see orbitPosition),
// pitch up raises it.
export function dragOrbit(orbit, dx, dy, settings) {
  const k = signs(settings);
  return { ...orbit, yaw: orbit.yaw + dx * ORBIT_YAW * k.x, pitch: clamp(orbit.pitch - dy * ORBIT_PITCH * k.y, -PITCH_LIMIT, PITCH_LIMIT) };
}

// First person: yaw up turns the view right, pitch up looks up.
export function dragLook(look, dx, dy, settings) {
  const k = signs(settings);
  return { yaw: look.yaw + dx * LOOK * k.x, pitch: clamp(look.pitch - dy * LOOK * k.y, -PITCH_LIMIT, PITCH_LIMIT) };
}

// Where an orbit puts the camera; the view uses this, and so does the test.
export function orbitPosition({ target, yaw, pitch, dist }) {
  const cp = Math.cos(pitch);
  return [target[0] + dist * cp * Math.sin(yaw), target[1] + dist * Math.sin(pitch), target[2] + dist * cp * Math.cos(yaw)];
}

// The direction a first person view looks along for a base direction plus a
// look offset (yaw right positive, pitch up positive).
export function lookDirection(dir, look) {
  const [dx, dy, dz] = dir;
  const yaw = Math.atan2(dx, -dz) + look.yaw;
  const pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)) + look.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}
