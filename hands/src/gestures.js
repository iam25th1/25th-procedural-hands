// Gesture registry. Every gesture is data: a pose name, and for the moving
// ones an optional arm placement, arm oscillation and channel oscillations.
// One interpreter turns an entry into the rig's gesture spec, so adding a
// gesture means adding an entry here (or calling registerGesture), not code.
//
// Entry fields (angles in degrees, positions in metres, body space with x
// toward the hand's own side, mirrored for the left hand):
//   pose      named pose or finger set the hand holds ('open', 'set:index')
//   arm       { pos, finger, palm, pole } where the hand goes while it plays
//   armOsc    { axis, amp, hz } wrist oscillation about a body space axis
//   osc       [{ digits, joints, amp, hz, phaseStep, wave, channel }] finger motion
//   object    { preset or shape } held with `grip` before the motion starts
//   force     true if the motion may move digits that hold something
import { deg, quat } from './math.js';
import { handRotation } from './ik.js';
import { XR_PREFIX } from './skeleton.js';
import { OBJECTS } from './defaults.js';
import * as dmath from './dmath.js';

const FINGER_JOINT = { mcp: 'phalanx-proximal', pip: 'phalanx-intermediate', dip: 'phalanx-distal' };
const THUMB_JOINT = { cmc: 'metacarpal', mcp: 'phalanx-proximal', ip: 'phalanx-distal' };

export const GESTURES = {
  relaxed: { pose: 'relaxed', label: 'Relaxed' },
  open: { pose: 'open', label: 'Open palm' },
  spread: { pose: 'spread', label: 'Spread' },
  fist: { pose: 'fist', label: 'Fist, thumb outside' },
  point: { pose: 'point', label: 'Point' },
  ok: { pose: 'ok', label: 'OK' },
  thumbsUp: { pose: 'thumbsUp', label: 'Thumbs up' },
  v: { pose: 'v', label: 'V' },
  // Palm up, the fingers curl in toward the palm and back, index leading.
  beckon: {
    label: 'Beckon',
    pose: 'ready',
    arm: { pos: [0.19, -0.17, -0.36], finger: [-0.2, 0.35, -0.9], palm: [0.2, 0.95, 0.25], pole: [0.6, -0.7, 0.05] },
    osc: [{ digits: ['index', 'middle', 'ring', 'little'], joints: { mcp: 45, pip: 70, dip: 40 }, hz: 1.3, phaseStep: -0.056, wave: 'cos01' }],
  },
  // Open palm facing forward, the wrist rolling side to side.
  wave: {
    label: 'Wave',
    pose: 'open',
    arm: { pos: [0.21, 0.0, -0.38], finger: [0.1, 0.98, -0.2], palm: [0, 0.2, -1], pole: [0.6, -0.4, 0.1] },
    armOsc: { axis: [0, 0, 1], amp: 22, hz: 2.4 },
  },
  // Palm down, fingertips resting on a surface, each finger lifting and
  // tapping in turn from the little finger to the index.
  drum: {
    label: 'Finger drum',
    pose: 'drum',
    arm: { pos: [0.16, -0.3, -0.36], finger: [-0.25, -0.2, -0.95], palm: [0, -1, 0.1], pole: [0.6, -0.7, 0.05] },
    osc: [{ digits: ['little', 'ring', 'middle', 'index'], joints: { mcp: -30, pip: -15, dip: -10 }, hz: 2.8, phaseStep: -0.25, wave: 'tap' }],
  },
  // A pebble rolled between the thumb pad and the index and middle pads:
  // small circling motions on the channels that move the pads across the
  // pebble rather than into it, index and middle in opposite phase.
  pebbleRoll: {
    label: 'Pebble roll',
    object: { ...OBJECTS.pebble, r: 0.012 },
    grip: 'tripod',
    force: true,
    arm: { pos: [0.17, -0.22, -0.36], finger: [-0.35, 0.1, -0.93], palm: [-0.2, -0.3, -0.9], pole: [0.6, -0.7, 0.05] },
    osc: [
      { digits: ['thumb'], joints: { cmc: 3 }, channel: 'twist', hz: 1.1, wave: 'sin' },
      { digits: ['thumb'], joints: { ip: 1 }, hz: 1.1, phase: 1.1, wave: 'sin' },
      { digits: ['index'], joints: { mcp: -0.5 }, hz: 1.1, wave: 'sin' },
      { digits: ['index'], joints: { mcp: 0.5 }, channel: 'abd', hz: 1.1, phase: Math.PI / 2, wave: 'sin' },
      { digits: ['index'], joints: { dip: 2 }, hz: 1.1, phase: 0.9, wave: 'sin' },
      { digits: ['middle'], joints: { mcp: 0.5 }, hz: 1.1, wave: 'sin' },
      { digits: ['middle'], joints: { mcp: -0.5 }, channel: 'abd', hz: 1.1, phase: Math.PI / 2, wave: 'sin' },
      { digits: ['middle'], joints: { dip: -2 }, hz: 1.1, phase: 0.9, wave: 'sin' },
    ],
  },
};

export function registerGesture(name, entry) {
  if (!entry || (!entry.pose && !entry.object)) throw new Error('a gesture needs a pose or an object to hold');
  GESTURES[name] = entry;
  return GESTURES[name];
}

export const GESTURE_NAMES = () => Object.keys(GESTURES);
export const isDynamic = (g) => Boolean(g.osc || g.armOsc || g.arm || g.object);

function waveform(kind, x) {
  switch (kind) {
    case 'cos01': return 0.5 - 0.5 * dmath.cos(x);
    // A short lift then rest: the first third of each cycle is a half sine.
    case 'tap': { const p = ((x / (2 * Math.PI)) % 1 + 1) % 1; return p < 0.32 ? dmath.sin((p / 0.32) * Math.PI) : 0; }
    default: return dmath.sin(x);
  }
}

function jointName(digit, j) {
  return digit === 'thumb' ? `thumb-${THUMB_JOINT[j]}` : `${XR_PREFIX[digit]}-${FINGER_JOINT[j]}`;
}

// Channel offsets for a gesture at time t (seconds since it started), weight k.
export function gestureChannels(entry, t, k) {
  const out = {};
  for (const o of entry.osc || []) {
    const ch = o.channel || 'flex';
    (o.digits || []).forEach((digit, i) => {
      const x = 2 * Math.PI * o.hz * t + (o.phase || 0) + (o.phaseStep || 0) * i * 2 * Math.PI;
      const w = waveform(o.wave, x);
      for (const [j, amp] of Object.entries(o.joints)) {
        const name = jointName(digit, j);
        const slot = out[name] || (out[name] = {});
        slot[ch] = (slot[ch] || 0) + deg(amp) * w * k;
      }
    });
  }
  return out;
}

// Arm target for a gesture on a side at time t with weight k.
export function gestureArm(entry, side, t, k) {
  if (!entry.arm) return null;
  const s = side === 'right' ? 1 : -1;
  const m = (v) => [v[0] * s, v[1], v[2]];
  let rot = handRotation(m(entry.arm.finger), m(entry.arm.palm));
  if (entry.armOsc) {
    const a = deg(entry.armOsc.amp) * k * dmath.sin(2 * Math.PI * entry.armOsc.hz * t);
    // About a body space axis (the wave swings about the forward axis).
    rot = quat.multiply([0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], entry.armOsc.axis, a * s), rot);
  }
  return { pos: m(entry.arm.pos), rot, pole: m(entry.arm.pole) };
}

// The rig's gesture spec for an entry.
export function compileGesture(entry) {
  return {
    base: entry.pose || null,
    force: Boolean(entry.force),
    channels: entry.osc ? (t, k) => gestureChannels(entry, t, k) : null,
    arm: entry.arm ? (t, rig, side, k) => gestureArm(entry, side, t, k) : null,
  };
}
