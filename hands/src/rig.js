// The rig: skeleton plus every solver, stepped by the injected clock. Pose
// layers with per digit masks feed critically damped springs on every hand
// channel; arm targets (wrist position and orientation) are smoothed the same
// way and solved by the two bone IK each step; additive layers carry idle
// life, strain tremor and the fingers' lag behind the wrist. Nothing here
// reads wall time or Math.random: the seed is the only source of variation,
// so a seed and a sequence of calls give one exact pose. Tools and games
// hook in through controllers (update before the solve, post after it)
// rather than the rig knowing about them.
import { v3, quat, clamp, hashNumbers } from './math.js';
import { Skeleton, FINGERS, DIGITS } from './skeleton.js';
import { Spring } from './springs.js';
import { POSES, fingerSetPose } from './poses.js';
import { poseChannels, clonePose, DIGIT_OF_JOINT, fingerControlChannels, enslaveNeighbours } from './fingers.js';
import { solveArm, handRotation } from './ik.js';
import { solveGrasp, placeObject, attachToHand, attachedWorld, preShape, settleThumb, restThumbOn, openedGraspPose, capsuleObjectDistance, GRIPS } from './grasp.js';
import { deg } from './math.js';
import { guardThumb, guardFingers, guardEnvironment } from './selfcontact.js';

// Poses solved as grips on a virtual object rather than authored angles.
export const POSE_GRIPS = {
  ok: { grip: 'tipPinch', obj: { shape: 'sphere', r: 0.004 } },
};

// Poses where the thumb lies across curled fingers: the fist wraps it over
// the index and middle, a point or a count rests it on whichever fingers
// are folded.
export const POSE_THUMB_REST = {
  fist: ['index', 'middle'],
  point: ['middle', 'ring'],
  count1: ['middle', 'ring'],
  v: ['ring', 'little'],
  count2: ['ring', 'little'],
  count3: ['little'],
};

// Named poses resolved once per side and shared by every rig: the thumb of
// each authored pose is settled on a scratch skeleton so it rests on the
// fingers or palm instead of passing through them; finger sets ('set:...')
// are generated; poses where digits meet are closed by the grasp solver on a
// small virtual object.
const RESOLVED = { left: new Map(), right: new Map() };
let scratch = null;
export function resolveNamedPose(side, name) {
  const cache = RESOLVED[side];
  if (cache.has(name)) return cache.get(name);
  scratch = scratch || new Skeleton();
  let out;
  const solved = POSE_GRIPS[name];
  if (solved) {
    const pre = preShape(scratch, side, solved.obj, solved.grip);
    const placed = placeObject(scratch, side, solved.obj, solved.grip);
    // The digits the grip closes start from the pre-shape; the rest keep the
    // authored pose (an OK sign's other three fingers stand up).
    const start = POSES[name] ? { ...POSES[name] } : pre.pose;
    for (const d of GRIPS[solved.grip].digits) start[d] = pre.pose[d];
    out = solveGrasp(scratch, side, { ...solved.obj, ...placed }, solved.grip, clonePose(start)).pose;
  } else if (name.startsWith('set:')) {
    const set = name.slice(4) === 'none' ? [] : name.slice(4).split('+');
    const g = fingerSetPose(set);
    out = g.thumbRest.length ? restThumbOn(scratch, side, g.pose, g.thumbRest).pose : settleThumb(scratch, side, g.pose).pose;
  } else if (POSE_THUMB_REST[name]) {
    out = restThumbOn(scratch, side, POSES[name], POSE_THUMB_REST[name]).pose;
  } else if (POSES[name]) {
    out = settleThumb(scratch, side, POSES[name]).pose;
  } else {
    throw new Error(`unknown pose ${name}`);
  }
  cache.set(name, out);
  return out;
}

// Spring stiffness per channel family (rad/s). Fingers settle a little after
// the wrist and arm because they are softer.
const FINGER_MAX_RATE = 22; // rad/s
export const OMEGA = { finger: 24, thumb: 26, wristSwing: 30, armPos: 16, armRot: 18, layer: 12 };
// Weight reads in the arms: metres of wrist drop per newton carried, capped.
export const LOAD_SAG = 0.0022;
export const LOAD_SAG_MAX = 0.07;
export const SECONDARY_LAG = 0.022; // seconds of wrist angular velocity that leaks into finger flexion

const HAND_CHANNEL_JOINTS = [
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal',
  ...FINGERS.flatMap((f) => {
    const p = { index: 'index-finger', middle: 'middle-finger', ring: 'ring-finger', little: 'pinky-finger' }[f];
    return [`${p}-metacarpal`, `${p}-phalanx-proximal`, `${p}-phalanx-intermediate`, `${p}-phalanx-distal`];
  }),
];

function fullMask(v = 1) {
  const m = {};
  for (const d of DIGITS) m[d] = v;
  return m;
}

// Default arm targets, body space (the eye at the origin, -Z ahead, +Y up):
// both hands relaxed in front of the chest, palms turned down and in, elbows
// low and out, so both read in a first person view on every screen.
export function defaultArmTargets() {
  const t = {};
  for (const side of ['left', 'right']) {
    const s = side === 'right' ? 1 : -1;
    t[side] = {
      pos: [0.14 * s, -0.25, -0.36],
      rot: handRotation([-0.3 * s, 0.12, -0.95], [-0.45 * s, -0.88, 0.1]),
      pole: [0.55 * s, -0.75, 0.05],
    };
  }
  return t;
}

// Critically damped spring on orientation: the error is the rotation vector
// from the current to the target orientation, integrated semi implicitly,
// with the angular speed capped so a large turn stays continuous.
export class RotSpring {
  constructor(omega, q) {
    this.w = omega;
    this.q = q.slice();
    this.omega = [0, 0, 0];
    this.target = q.slice();
    this.maxRate = 10;
  }
  snap(q) { this.q = q.slice(); this.target = q.slice(); this.omega = [0, 0, 0]; }
  step(dt) {
    if (dt <= 0) return this.q;
    // Error rotation r = target * conj(q) as a rotation vector.
    const t = this.target.slice();
    if (quat.dot(t, this.q) < 0) for (let i = 0; i < 4; i++) t[i] = -t[i];
    const e = quat.multiply([0, 0, 0, 1], t, quat.conjugate([0, 0, 0, 1], this.q));
    quat.normalize(e, e);
    const ang = 2 * Math.acos(clamp(e[3], -1, 1));
    const s = Math.sqrt(Math.max(0, 1 - e[3] * e[3]));
    const axis = s < 1e-9 ? [0, 0, 0] : [e[0] / s, e[1] / s, e[2] / s];
    const err = [axis[0] * ang, axis[1] * ang, axis[2] * ang];
    const w = this.w;
    for (let i = 0; i < 3; i++) this.omega[i] += (w * w * err[i] - 2 * w * this.omega[i]) * dt;
    const rate = Math.hypot(this.omega[0], this.omega[1], this.omega[2]);
    if (rate > this.maxRate) for (let i = 0; i < 3; i++) this.omega[i] *= this.maxRate / rate;
    const dq = quat.fromRotationVector([0, 0, 0, 1], [this.omega[0] * dt, this.omega[1] * dt, this.omega[2] * dt]);
    this.q = quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], dq, this.q));
    return this.q;
  }
}

class ArmState {
  constructor(side, target) {
    this.side = side;
    // Wrist travel capped at 2.2 m/s: 3.7 cm per frame at 60 Hz.
    this.pos = target.pos.map((v) => new Spring(OMEGA.armPos, v, 2.0));
    this.rot = new RotSpring(OMEGA.armRot, target.rot);
    this.poleSprings = target.pole.map((v) => new Spring(OMEGA.armPos, v));
    this.target = { pos: target.pos.slice(), rot: target.rot.slice(), pole: target.pole.slice() };
    this.offset = [0, 0, 0]; // additive world offset (idle sway)
    this.reactSprings = [0, 0, 0].map(() => new Spring(OMEGA.armPos * 1.5, 0)); // reaction offset (jump, land, crouch, dash, flinch)
    this.last = null;
    this.follow = null; // () => { pos, rot, pole? }: the wrist tracks this exactly (a hand holding a shared object or a fixed rung)
    this.load = 0; // newtons carried: weight reads in the arm
    this.sag = new Spring(8, 0);
    // Busy hands hold still: idle sway and finger drift fade out while the
    // hand reaches for, holds or works something, and fade back after.
    this.calm = new Spring(6, 0);
    this.envPush = [0, 0, 0]; // held off a surface the hand would pass into (set by the world interaction)
  }
  set(target, snap = false) {
    if (target.pos) { this.target.pos = target.pos.slice(); this.pos.forEach((s, i) => { s.target = target.pos[i]; if (snap) s.snap(target.pos[i]); }); }
    if (target.rot) {
      this.target.rot = target.rot.slice();
      this.rot.target = target.rot.slice();
      if (snap) this.rot.snap(target.rot);
    }
    if (target.pole) { this.target.pole = target.pole.slice(); this.poleSprings.forEach((s, i) => { s.target = target.pole[i]; if (snap) s.snap(target.pole[i]); }); }
  }
  get pole() { return this.poleSprings.map((s) => s.x); }
  get react() { return this.reactSprings.map((s) => s.x); }
  set react(v) { this.reactSprings.forEach((s, i) => { s.target = v[i]; }); }
  step(dt) {
    if (this.follow) {
      const t = this.follow();
      if (t) this.set(t, true);
    }
    this.sag.target = Math.min(LOAD_SAG_MAX, LOAD_SAG * this.load);
    this.sag.step(dt);
    this.calm.step(dt);
    for (const s of this.pos) s.step(dt);
    for (const s of this.poleSprings) s.step(dt);
    for (const s of this.reactSprings) s.step(dt);
    this.rot.step(dt);
  }
  smoothedPos() {
    if (this.follow) return [this.pos[0].x, this.pos[1].x, this.pos[2].x];
    const r = this.react;
    // A carried load lowers the wrist and draws it in toward the body.
    const sag = this.sag.x;
    const e = this.envPush;
    return [this.pos[0].x + this.offset[0] + r[0] + e[0], this.pos[1].x + this.offset[1] + r[1] - sag + e[1], this.pos[2].x + this.offset[2] + r[2] + 0.4 * sag + e[2]];
  }
  smoothedRot() { return this.rot.q.slice(); }
}

class HandState {
  constructor(side) {
    this.side = side;
    this.layers = []; // { name, pose, mask, weight: Spring, additive: false }
    this.additive = []; // { name, fn(t, rig) -> { jointName: { flex, abd, twist } } }
    this.springs = {};
    for (const name of HAND_CHANNEL_JOINTS) {
      const w = name.startsWith('thumb') ? OMEGA.thumb : OMEGA.finger;
      // A finger never snaps faster than a real one closes (about 15 rad/s).
      this.springs[name] = { flex: new Spring(w, 0, FINGER_MAX_RATE), abd: new Spring(w, 0, FINGER_MAX_RATE), twist: new Spring(w, 0, FINGER_MAX_RATE) };
    }
    this.base = clonePose(POSES.relaxed);
    this.attached = null; // { obj, attachment, gripKey, contacts }
    this.lastWristRot = null;
    this.lag = 0;
    this.manual = {}; // jointName -> { flex?, abd?, twist? } slider overrides
    this.gesture = null; // { name, spec, k: Spring, t0 }
    this.control = {}; // digit -> { curl, spread, opposition, joints, weight: Spring } per-finger control over the active pose
  }
}

export class Rig {
  constructor({ seed = 1, reduced = false, targets = null } = {}) {
    this.skel = new Skeleton();
    this.seed = seed >>> 0;
    this.reduced = reduced;
    this.time = 0;
    this.frame = 0;
    this.solverMs = 0;
    this.controllers = [];
    // Body anchor: a translation of both shoulders in world space. It is
    // zero for a standing player; climbing and hanging move it.
    this.body = [0, 0, 0];
    const t = targets || defaultArmTargets();
    this.arms = {
      left: new ArmState('left', t.left),
      right: new ArmState('right', t.right),
    };
    this.hands = { left: new HandState('left'), right: new HandState('right') };
    this.idle = { amount: 1 };
    // Seeded phases for the idle motion so two rigs with one seed match.
    let x = this.seed || 1;
    const rnd = () => { x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0) || 1; x = (Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0) || 1; return (x >>> 0) / 4294967296; };
    this.phases = Array.from({ length: 16 }, () => rnd() * Math.PI * 2);
    this.tremor = 0; // 0..1 strain tremor amount (full draw hold)
    this.step(0); // settle into the initial pose
    this.snapAll();
  }

  // Controllers: { update?(dt, rig), post?(dt, rig) } called every step,
  // before the arms are solved and after forward kinematics respectively.
  addController(c) { this.controllers.push(c); return () => this.removeController(c); }
  removeController(c) { this.controllers = this.controllers.filter((x) => x !== c); }

  setBody(pos) {
    v3.copy(this.body, pos);
    for (const side of ['left', 'right']) v3.copy(this.skel.joint(side, 'shoulder').localPos, pos);
    // The arm solve reads the shoulders where they are now, not a step ago.
    this.skel.update();
  }

  // Temporarily stiffen a hand's finger springs (release window) or restore.
  setStiffness(side, omega) {
    const h = this.hands[side];
    for (const name of HAND_CHANNEL_JOINTS) {
      const w = omega ?? (name.startsWith('thumb') ? OMEGA.thumb : OMEGA.finger);
      h.springs[name].flex.w = w; h.springs[name].abd.w = w; h.springs[name].twist.w = w;
    }
  }

  hand(side) { return this.hands[side]; }
  arm(side) { return this.arms[side]; }

  // Named poses are authored per joint; the thumb of each is settled once
  // against the fingers and palm on a scratch skeleton so it rests on them
  // rather than passing through. Cached per side and name.
  resolvePose(side, pose) {
    if (typeof pose !== 'string') return clonePose(pose);
    return clonePose(resolveNamedPose(side, pose));
  }

  // Base pose for a hand (name or pose object). snap skips the springs.
  setPose(side, pose, { snap = false } = {}) {
    const h = this.hands[side];
    const next = this.resolvePose(side, pose);
    // Digits holding an object keep their grasp: a base pose set while the
    // hand holds something only moves the free digits.
    if (h.attached && h.attached.pose) {
      const locked = this.lockedDigits(side);
      for (const d of Object.keys(locked)) next[d] = clonePose(h.attached.pose)[d];
    }
    h.base = next;
    if (snap) this.snapHand(side);
  }

  // Gesture layer over the base with a per digit mask and a spring weight.
  setLayer(side, name, pose, { mask = fullMask(1), weight = 1, snap = false, force = false } = {}) {
    const h = this.hands[side];
    let layer = h.layers.find((l) => l.name === name);
    if (!layer) {
      layer = { name, pose: null, mask, weight: new Spring(OMEGA.layer, 0) };
      h.layers.push(layer);
    }
    layer.pose = this.resolvePose(side, pose);
    layer.mask = mask;
    layer.force = force;
    layer.weight.target = weight;
    if (snap) { layer.weight.snap(weight); this.snapHand(side); }
    return layer;
  }

  clearLayer(side, name) {
    const h = this.hands[side];
    const layer = h.layers.find((l) => l.name === name);
    if (layer) layer.weight.target = 0;
  }

  addAdditive(side, name, fn) {
    const h = this.hands[side];
    h.additive = h.additive.filter((a) => a.name !== name);
    h.additive.push({ name, fn });
  }

  removeAdditive(side, name) {
    const h = this.hands[side];
    h.additive = h.additive.filter((a) => a.name !== name);
  }

  setArmTarget(side, target, { snap = false } = {}) {
    this.arms[side].set(target, snap);
    if (snap) this.step(0);
  }

  // Grasp: place the object for the grip relative to the hand as it is now,
  // solve the closure, set the result as the base pose and attach the object.
  grasp(side, obj, gripKey = null) {
    const key = gripKey || Object.keys(GRIPS)[0];
    // Pre-shape first (aperture from the object radius), then place the
    // object relative to the pre-shaped hand, then close onto it.
    const pre = preShape(this.skel, side, obj, key);
    const placed = placeObject(this.skel, side, obj, key);
    const world = { ...obj, pos: placed.pos, rot: placed.rot };
    const result = solveGrasp(this.skel, side, world, key, pre.pose);
    const h = this.hands[side];
    h.base = result.pose;
    h.attached = { obj: world, attachment: attachToHand(this.skel, side, world), gripKey: key, contacts: result.contacts, preShape: pre, pose: clonePose(result.pose) };
    this.step(0);
    return h.attached;
  }

  // Grasp an object where it is: no re-placement. The closure starts from
  // the pose the hand already holds (a pre-shape set while reaching) and the
  // object is attached with its actual transform in the wrist frame, so the
  // moment of contact never moves it.
  // cache(fp, compute), when given, may answer the closing solve from a
  // recorded or precomputed run instead (see Interaction.cached); the
  // answer only sets the fingers' targets, as a fresh solve's does.
  graspWhere(side, obj, key, { startPose = null, env = [], cache = null } = {}) {
    const h = this.hands[side];
    const start = startPose || clonePose(h.base);
    const solve = () => { const r = solveGrasp(this.skel, side, obj, key, start, env); return { pose: r.pose, contacts: r.contacts, gripKey: r.gripKey }; };
    const result = cache ? cache(`${side}|${key}|${[obj.pos, obj.rot].flat().join(',')}|${JSON.stringify(start)}|${env.length}`, solve) : solve();
    h.base = result.pose;
    h.attached = { obj: { ...obj }, attachment: attachToHand(this.skel, side, obj), gripKey: key, contacts: result.contacts, preShape: null, pose: clonePose(result.pose) };
    this.step(0);
    return h.attached;
  }

  // The scaled pre-shape a grasp will start from, so an action can move the
  // hand there first and the grasp then closes from exactly that pose.
  preShapePose(side, obj, gripKey, env = [], wide = 1) {
    this.scratch = this.scratch || new Skeleton();
    this.scratch.reset();
    return openedGraspPose(this.scratch, side, obj, gripKey, env, wide);
  }

  // Where a grasp of this object would place it, in the wrist frame, from
  // the pre-shaped hand on the scratch skeleton.
  graspPlacement(side, obj, gripKey) {
    this.scratch = this.scratch || new Skeleton();
    preShape(this.scratch, side, obj, gripKey);
    const placed = placeObject(this.scratch, side, obj, gripKey);
    return attachToHand(this.scratch, side, placed);
  }

  release(side) {
    const h = this.hands[side];
    const was = h.attached;
    h.attached = null;
    for (const c of this.controllers) if (c.released) c.released(side, was, this);
    return was;
  }

  // World transform of the object attached to a hand, if any.
  attachedObject(side) {
    const h = this.hands[side];
    if (!h.attached) return null;
    const w = attachedWorld(this.skel, side, h.attached.attachment);
    return { ...h.attached.obj, pos: w.pos, rot: w.rot };
  }

  // Digits holding an object (recorded contacts) are locked: layers, idle
  // drift and wrist lag leave them alone so the grip never opens by itself.
  lockedDigits(side) {
    const h = this.hands[side];
    const locked = {};
    if (h.attached) for (const c of h.attached.contacts) locked[c.digit] = 1;
    return locked;
  }

  // Resolve layered pose targets for one hand into channel targets.
  targetChannels(side) {
    const h = this.hands[side];
    const baseCh = poseChannels(h.base);
    const locked = this.lockedDigits(side);
    const out = {};
    for (const name of HAND_CHANNEL_JOINTS) out[name] = { ...(baseCh[name] || { flex: 0, abd: 0, twist: 0 }) };
    for (const layer of h.layers) {
      const w = layer.weight.x;
      if (w <= 1e-4 || !layer.pose) continue;
      const ch = poseChannels(layer.pose);
      for (const name of HAND_CHANNEL_JOINTS) {
        const d = DIGIT_OF_JOINT[name];
        const m = clamp(w * (layer.mask[d] ?? 0) * (layer.force ? 1 : 1 - (locked[d] || 0)), 0, 1);
        if (m <= 0) continue;
        const a = out[name];
        const b = ch[name] || { flex: 0, abd: 0, twist: 0 };
        a.flex = a.flex + ((b.flex || 0) - a.flex) * m;
        a.abd = (a.abd || 0) + ((b.abd || 0) - (a.abd || 0)) * m;
        a.twist = (a.twist || 0) + ((b.twist || 0) - (a.twist || 0)) * m;
      }
    }
    for (const add of h.additive) {
      const offs = add.fn(this.time, this, side) || {};
      for (const [name, o] of Object.entries(offs)) {
        if (!out[name]) continue;
        out[name].flex += o.flex || 0;
        out[name].abd = (out[name].abd || 0) + (o.abd || 0);
        out[name].twist = (out[name].twist || 0) + (o.twist || 0);
      }
    }
    // Dynamic gesture channels on top, weighted by its own spring.
    if (h.gesture && h.gesture.spec.channels) {
      const k = h.gesture.k.x * (this.reduced ? 0.5 : 1);
      const offs = h.gesture.spec.channels(this.time - h.gesture.t0, k) || {};
      for (const [name, o] of Object.entries(offs)) {
        if (!out[name]) continue;
        const free = h.gesture.spec.force ? 1 : 1 - (locked[DIGIT_OF_JOINT[name]] || 0);
        out[name].flex += (o.flex || 0) * free;
        out[name].abd = (out[name].abd || 0) + (o.abd || 0) * free;
        out[name].twist = (out[name].twist || 0) + (o.twist || 0) * free;
      }
    }
    // Per-finger control, blended over whatever the layers produced. A digit
    // holding an object keeps its grip unless the control was forced.
    const weights = {};
    for (const [digit, ctl] of Object.entries(h.control)) {
      const w = ctl.weight.x * (ctl.force ? 1 : 1 - (locked[digit] || 0));
      if (w <= 1e-4) continue;
      weights[digit] = w;
      const ch = fingerControlChannels(digit, ctl);
      for (const [name, c] of Object.entries(ch)) {
        const a = out[name];
        a.flex += ((c.flex || 0) - a.flex) * w;
        a.abd = (a.abd || 0) + ((c.abd || 0) - (a.abd || 0)) * w;
        a.twist = (a.twist || 0) + ((c.twist || 0) - (a.twist || 0)) * w;
      }
    }
    if (Object.keys(weights).length) enslaveNeighbours(out, weights);
    // Manual slider overrides replace the target for that channel.
    for (const [name, m] of Object.entries(h.manual)) {
      if (!out[name]) continue;
      if (m.flex !== undefined) out[name].flex = m.flex;
      if (m.abd !== undefined) out[name].abd = m.abd;
      if (m.twist !== undefined) out[name].twist = m.twist;
    }
    return out;
  }

  // Per-finger control. patch: { curl?, spread?, opposition?, joint?, value?, force? }.
  setFingerControl(side, digit, patch, { snap = false } = {}) {
    const h = this.hands[side];
    let ctl = h.control[digit];
    if (!ctl) {
      ctl = { curl: 0, spread: 0, opposition: 0, joints: {}, force: false, weight: new Spring(OMEGA.layer, 0) };
      // Start from the pose the digit is in, so taking control never jumps.
      ctl.curl = patch.curl ?? 0;
      h.control[digit] = ctl;
    }
    if (ctl.weight.target === 0) {
      // Taking a released digit back starts from a clean slate.
      ctl.spread = 0; ctl.opposition = 0; ctl.joints = {}; ctl.force = false;
    }
    if (patch.curl !== undefined) ctl.curl = patch.curl;
    if (patch.spread !== undefined) ctl.spread = patch.spread;
    if (patch.opposition !== undefined) ctl.opposition = patch.opposition;
    if (patch.joint) ctl.joints[patch.joint] = patch.value;
    if (patch.force !== undefined) ctl.force = patch.force;
    ctl.weight.target = 1;
    if (snap) { ctl.weight.snap(1); this.snapHand(side); }
    return ctl;
  }

  releaseFingerControl(side, digit = null) {
    const h = this.hands[side];
    for (const [d, ctl] of Object.entries(h.control)) if (!digit || d === digit) ctl.weight.target = 0;
  }

  setManual(side, joint, channel, value) {
    const h = this.hands[side];
    h.manual[joint] = h.manual[joint] || {};
    h.manual[joint][channel] = value;
  }
  clearManual(side) { this.hands[side].manual = {}; }

  // Dynamic gesture: base pose (if any), channel function of time, optional
  // arm target function. Weight rises through a spring so it blends in.
  startGesture(side, name, spec, { snap = false } = {}) {
    const h = this.hands[side];
    h.gesture = { name, spec, k: new Spring(OMEGA.layer, snap ? 1 : 0), t0: this.time };
    h.gesture.k.target = 1;
    if (spec.base) this.setPose(side, spec.base, { snap });
    if (spec.arm) this.setArmTarget(side, spec.arm(0, this, side, 1), { snap });
  }
  stopGesture(side) {
    const h = this.hands[side];
    if (h.gesture) h.gesture.k.target = 0;
    h.gestureStopping = true;
  }

  // Idle life: slow breathing sway on the arms and tiny finger drift, damped
  // under reduced motion. Strain tremor at full draw adds a fast small jitter.
  setBusy(side, busy) { this.arms[side].calm.target = busy ? 1 : 0; }

  idleOffsets(side) {
    const k = (this.reduced ? 0.25 : 1) * this.idle.amount * (1 - this.arms[side].calm.x);
    const t = this.time;
    const ph = this.phases;
    const arm = this.arms[side];
    const i = side === 'left' ? 0 : 4;
    arm.offset[0] = k * 0.003 * Math.sin(t * 2 * Math.PI * 0.21 + ph[i]);
    arm.offset[1] = k * 0.004 * Math.sin(t * 2 * Math.PI * 0.26 + ph[i + 1]);
    arm.offset[2] = k * 0.002 * Math.sin(t * 2 * Math.PI * 0.17 + ph[i + 2]);
    const offs = {};
    const drift = k * deg(2.5);
    let n = 0;
    for (const f of FINGERS) {
      const p = { index: 'index-finger', middle: 'middle-finger', ring: 'ring-finger', little: 'pinky-finger' }[f];
      const a = drift * Math.sin(t * 2 * Math.PI * 0.31 + ph[(i + n) % 16]) * Math.sin(t * 2 * Math.PI * 0.07 + ph[(i + n + 3) % 16]);
      offs[`${p}-phalanx-proximal`] = { flex: a };
      offs[`${p}-phalanx-intermediate`] = { flex: a * 0.7 };
      n++;
    }
    if (this.tremor > 0) {
      const amp = this.tremor * (this.reduced ? 0.3 : 1) * deg(1.4);
      let m = 0;
      for (const name of HAND_CHANNEL_JOINTS) {
        const j = amp * Math.sin(t * 2 * Math.PI * 7.5 + ph[m % 16] + m);
        offs[name] = { flex: (offs[name]?.flex || 0) + j };
        m++;
      }
    }
    return offs;
  }

  snapHand(side) {
    const h = this.hands[side];
    const ch = this.targetChannels(side);
    for (const name of HAND_CHANNEL_JOINTS) {
      const s = h.springs[name];
      s.flex.snap(ch[name].flex || 0);
      s.abd.snap(ch[name].abd || 0);
      s.twist.snap(ch[name].twist || 0);
    }
  }

  snapAll() {
    for (const side of ['left', 'right']) {
      const a = this.arms[side];
      a.pos.forEach((s) => s.snap(s.target));
      a.poleSprings.forEach((s) => s.snap(s.target));
      a.rot.snap(a.rot.target);
      this.snapHand(side);
    }
    this.step(0);
  }

  // One fixed step. dt = 0 re-applies targets without advancing time.
  step(dt, time = this.time + dt) {
    const t0 = globalThis.performance ? performance.now() : 0;
    this.time = time;
    if (dt > 0) this.frame++;
    const skel = this.skel;
    if (dt > 0) for (const c of this.controllers) if (c.update) c.update(dt, this);
    for (const side of ['left', 'right']) {
      const arm = this.arms[side];
      const hand = this.hands[side];
      // Layer weights and arm targets.
      for (const layer of hand.layers) layer.weight.step(dt);
      for (const [d, ctl] of Object.entries(hand.control)) {
        ctl.weight.step(dt);
        if (ctl.weight.target === 0 && ctl.weight.x < 1e-4) delete hand.control[d];
      }
      if (hand.gesture) {
        hand.gesture.k.step(dt);
        if (hand.gesture.spec.arm && hand.gesture.k.target > 0) arm.set(hand.gesture.spec.arm(this.time - hand.gesture.t0, this, side, hand.gesture.k.x * (this.reduced ? 0.5 : 1)));
        if (hand.gesture.k.target === 0 && hand.gesture.k.x < 1e-3) hand.gesture = null;
      }
      arm.step(dt);
      // Idle life on top.
      const idle = this.idleOffsets(side);
      // Arm IK from the smoothed targets.
      solveArm(skel, side, arm.smoothedPos(), arm.smoothedRot(), arm.pole);
      // Fingers lag behind the wrist: wrist angular velocity about its flex axis.
      const wr = skel.joint(side, 'wrist');
      let lag = 0;
      if (hand.lastWristRot && dt > 0) {
        const dq = quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], hand.lastWristRot), wr.worldRot);
        const ang = quat.twistAngle(dq, [1, 0, 0]);
        lag = clamp((-ang / dt) * SECONDARY_LAG, -deg(10), deg(10)) * (this.reduced ? 0.4 : 1) * (1 - arm.calm.x);
      }
      hand.lastWristRot = wr.worldRot.slice();
      hand.lag = lag;
      // Hand channel targets through the springs.
      const ch = this.targetChannels(side);
      const locked = this.lockedDigits(side);
      for (const name of HAND_CHANNEL_JOINTS) {
        const s = hand.springs[name];
        const c = ch[name];
        const free = 1 - (locked[DIGIT_OF_JOINT[name]] || 0);
        const o = idle[name] || {};
        const isFinger = !name.startsWith('thumb') && !name.endsWith('metacarpal');
        // Held digits keep their contact: no drift, no lag, half the tremor.
        const oflex = (o.flex || 0) * (free ? 1 : (this.tremor > 0 ? 0.25 : 0));
        s.flex.target = (c.flex || 0) + oflex + (isFinger && name.endsWith('proximal') ? lag * free : 0);
        s.abd.target = (c.abd || 0) + (o.abd || 0);
        s.twist.target = (c.twist || 0) + (o.twist || 0);
        s.flex.step(dt); s.abd.step(dt); s.twist.step(dt);
        skel.setChannels(skel.joint(side, name), s.flex.x, s.abd.x, s.twist.x);
      }
      skel.update();
      hand.guarded = guardFingers(skel, side, hand.springs) | guardThumb(skel, side, hand.springs);
      // Surfaces around the hand (set by whoever owns a world).
      if (this.environment) hand.guarded |= guardEnvironment(skel, side, hand.springs, this.environment(side));
      else if (hand.attached) {
        // No world around the hand: still, the fingers closing on what it
        // holds stop at its surface.
        const held = this.attachedObject(side);
        hand.guarded |= guardEnvironment(skel, side, hand.springs, [{ distance: (a, b, r) => capsuleObjectDistance(held, a, b, r, 8) + 0.0005 }]);
      }
    }
    skel.update();
    // A held object turning in the grip (in-hand roll and spin).
    for (const side of ['left', 'right']) {
      const a = this.hands[side].attached;
      if (a && a.spin && dt > 0) a.attachment.rot = quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], a.attachment.rot, quat.fromAxisAngle([0, 0, 0, 1], a.spin.axis, a.spin.rate * dt)));
    }
    for (const c of this.controllers) if (c.post) c.post(dt, this);
    this.solverMs = globalThis.performance ? performance.now() - t0 : 0;
    return this;
  }

  hash() {
    return hashNumbers(this.skel.transformValues());
  }
}

export { fullMask, handRotation, GRIPS };
