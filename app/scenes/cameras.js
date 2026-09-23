// Camera framing for shots and for the sandbox's own inspection camera.
// Pure functions of the scene state: the camera never moves by itself, only
// when a shot, a scene choice or the user's orbit sets it.

import { fovFor } from '../render/fov.js';

const NARROW = 1.3; // portrait phones see a narrower slice: stand further back

// Where to look from for each station and scenario: across the table from
// the front and a little to the side, above the work, so the palms, the
// fingers and the object read and the sleeves fall behind the hands. Fixed
// for a whole scenario, so a strip of frames never moves its camera.
// target is relative to the station's x.
const STATION_VIEWS = {
  ledge: { target: [0.1, -0.4, -0.38], yaw: 2.55, pitch: 0.5, dist: 0.75 },
  bench: { target: [0, -0.38, -0.36], yaw: 2.7, pitch: 0.45, dist: 0.8 },
  panel: { target: [0, -0.28, -0.42], yaw: 1.3, pitch: 0.3, dist: 0.8 },
  crate: { target: [0, -0.5, -0.4], yaw: 2.2, pitch: 0.4, dist: 0.9 },
  ladder: { target: [0, 0.3, -0.3], yaw: 1.2, pitch: 0.12, dist: 1.2, wide: 1.3 }, // a tall climb: wide screens stand back
  rope: { target: [0.03, -0.22, -0.42], yaw: 2.3, pitch: 0.35, dist: 0.75 },
};
const SCENARIO_VIEWS = {
  padPinch: { target: [0.18, -0.42, -0.3], yaw: 2.4, pitch: 0.45, dist: 0.55 },
  tripod: { target: [0.18, -0.42, -0.3], yaw: 2.4, pitch: 0.45, dist: 0.55 },
  inHandRoll: { target: [0.17, -0.36, -0.32], yaw: 2.4, pitch: 0.4, dist: 0.45 },
  inHandSpin: { target: [0.12, -0.38, -0.36], yaw: 2.4, pitch: 0.4, dist: 0.5 },
  lateralPinch: { target: [-0.1, -0.36, -0.4], yaw: -2.4, pitch: 0.45, dist: 0.55 },
  hook: { target: [-0.35, -0.38, -0.46], yaw: -2.5, pitch: 0.45, dist: 0.7 },
  slipHeavy: { target: [-0.25, -0.4, -0.33], yaw: -2.5, pitch: 0.45, dist: 0.6 },
  slipJerk: { target: [-0.17, -0.38, -0.3], yaw: -2.5, pitch: 0.45, dist: 0.6 },
  throwCatch: { target: [0.08, -0.3, -0.38], yaw: 3.3, pitch: 0.45, dist: 0.9 },
  grabCarryPlace: { target: [0.28, -0.38, -0.36], yaw: 2.5, pitch: 0.5, dist: 0.7 },
  sphericalGrip: { target: [0.18, -0.4, -0.42], yaw: 2.5, pitch: 0.45, dist: 0.6 },
  pressButton: { target: [-0.2, -0.24, -0.42], yaw: -1.3, pitch: 0.25, dist: 0.5 },
  flipSwitch: { target: [-0.1, -0.24, -0.42], yaw: -1.3, pitch: 0.25, dist: 0.5 },
  turnKnob: { target: [0.08, -0.22, -0.45], yaw: -0.6, pitch: 0.7, dist: 0.42, wide: 1.25 },
  pullLever: { target: [0.26, -0.26, -0.36], yaw: 1.45, pitch: 0.25, dist: 0.7 },
  drawer: { target: [0.02, -0.4, -0.38], yaw: 1.3, pitch: 0.35, dist: 0.7 },
  hang: { target: [0, -0.12, -0.3], yaw: 1.2, pitch: 0.12, dist: 1.0 },
};

export function scenarioView(id, station) {
  return SCENARIO_VIEWS[id] || STATION_VIEWS[station] || STATION_VIEWS.ledge;
}

export function stationView(sb, x, station = 'ledge') {
  const v = STATION_VIEWS[station] || STATION_VIEWS.ledge;
  return { ...v, target: [x + v.target[0], v.target[1], v.target[2]] };
}

function scaleForAspect(dist, aspect, wide = 1) {
  return aspect < 0.8 ? dist * NARROW : aspect < 1.3 ? dist * 1.12 : dist * wide;
}

function rot(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

// Orbit angles that look from `dir` (a unit vector from the target toward the eye).
function anglesFrom(dir) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return { yaw: Math.atan2(dir[0], dir[2]), pitch: Math.asin(Math.max(-1, Math.min(1, dir[1] / len))) };
}

export function handCentre(hands, side) {
  const names = ['wrist', 'middle-finger-phalanx-proximal', 'middle-finger-tip'];
  const c = [0, 0, 0];
  for (const n of names) { const p = hands.joint(side, n).pos; for (let i = 0; i < 3; i++) c[i] += p[i] / names.length; }
  return c;
}

export function cameraFor({ scene, scenario, sb, shot, hands, aspect }) {
  if (scene === 'sandbox') {
    const x = sb.x;
    if (shot.cam === 'fp') {
      const b = sb.hands.rig.body;
      return { eye: [x, b[1] * 0, 0], dir: [0, -0.62, -1] };
    }
    const base = scenario ? scenarioView(scenario.id, scenario.station) : scenarioView(null, 'ledge');
    const v = { ...base, target: [x + base.target[0], base.target[1], base.target[2]] };
    const out = { ...v };
    // Framed on one hand (inspection of a grip in place).
    if (shot.focus === 'left' || shot.focus === 'right') out.target = handCentre(sb.hands, shot.focus);
    if (shot.yaw != null) out.yaw = shot.yaw;
    if (shot.pitch != null) out.pitch = shot.pitch;
    out.dist = scaleForAspect((shot.dist ?? v.dist) / shot.zoom, aspect, v.wide);
    return out;
  }
  // Hands scene: framed on one hand or both.
  const focus = shot.focus || (shot.hand !== 'both' ? shot.hand : 'both');
  const target = focus === 'both'
    ? handCentre(hands, 'left').map((v, i) => (v + handCentre(hands, 'right')[i]) / 2)
    : handCentre(hands, focus);
  const cam = shot.cam || 'fp';
  if (cam === 'fp') return { eye: [0, 0, 0], dir: [target[0] * 0.5, target[1], target[2]] };
  let dir;
  const side = focus === 'both' ? 'right' : focus;
  const wr = hands.joint(side, 'wrist').rot;
  const s = side === 'right' ? 1 : -1;
  if (cam === 'front') dir = [0, 0.05, 1];
  else if (cam === 'palm') dir = rot(wr, [0, -1, 0]);
  else if (cam === 'back') dir = rot(wr, [0, 1, 0]);
  else if (cam === 'side') dir = rot(wr, [-s, 0, 0]);
  else dir = rot(wr, [-0.6 * s, 0.55, 0.3]); // three-quarter, from the thumb side above
  // Tilt a little toward the fingertips so the digits read along their length.
  const f = rot(wr, [0, 0, -1]);
  if (cam !== 'front') dir = [dir[0] + 0.25 * f[0], dir[1] + 0.25 * f[1], dir[2] + 0.25 * f[2]];
  const a = anglesFrom(dir);
  const base = focus === 'both' ? 0.52 : 0.3;
  let dist = scaleForAspect((shot.dist ?? base) / shot.zoom, aspect);
  if (focus === 'both' && shot.dist == null) {
    // Far enough that both hands, however far apart a gesture puts them,
    // fit across the frame with a margin: nothing cropped on a phone.
    const l = handCentre(hands, 'left');
    const r = handCentre(hands, 'right');
    const half = Math.hypot(l[0] - r[0], l[2] - r[2]) / 2 + 0.17;
    const vfov = (fovFor(aspect) * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    dist = Math.max(dist, half / Math.tan(hfov / 2) / shot.zoom);
  }
  return { target, yaw: shot.yaw ?? a.yaw, pitch: shot.pitch ?? Math.max(-1.45, Math.min(1.45, a.pitch)), dist };
}
