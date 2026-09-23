// Public API of the procedural hands module. DOM free: everything here runs
// in Node under node --test and in the browser. Rendering is separate
// (createThreeView in three-view.js) so a consumer owns its renderer.
//
//   const hands = create({ seed: 7 });
//   hands.setPose('right', 'point');
//   hands.setFinger('left', 'index', 0.6, 0.2);
//   hands.grasp('right', { shape: 'sphere', r: 0.03 }, 'spherical');
//   hands.on('grasped', (e) => ...);
//   hands.update(dt);           // fixed 60 Hz steps inside
//   hands.dispose();
import { Rig, defaultArmTargets } from './rig.js';
import { STEP } from './clock.js';
import { GRIPS, gripFor } from './grasp.js';
import { handRotation } from './ik.js';
import { v3, quat } from './math.js';
import { FINGERS, DIGITS } from './skeleton.js';
import { DEFAULTS, OBJECTS, SKIN_TONES, SLEEVE_COLOURS } from './defaults.js';
import { POSES } from './poses.js';

export const HANDS = ['left', 'right'];
export const EVENTS = ['contact', 'grasped', 'released', 'slipped'];
const MAX_STEPS_PER_UPDATE = 15;

function sidesOf(hand) {
  if (hand === 'both' || hand == null) return HANDS;
  if (!HANDS.includes(hand)) throw new Error(`hand must be 'left', 'right' or 'both', got ${hand}`);
  return [hand];
}

function digitOf(finger) {
  if (!DIGITS.includes(finger)) throw new Error(`finger must be one of ${DIGITS.join(', ')}, got ${finger}`);
  return finger;
}

export class Hands {
  constructor(options = {}) {
    const o = { ...DEFAULTS, ...options };
    this.options = o;
    this.rig = new Rig({ seed: o.seed, reduced: o.reducedMotion, targets: o.targets || null });
    this.listeners = new Map(EVENTS.map((e) => [e, new Set()]));
    this.acc = 0;
    this.disposed = false;
  }

  get time() { return this.rig.time; }
  get frame() { return this.rig.frame; }
  get skeleton() { return this.rig.skel; }

  // Events ------------------------------------------------------------------
  on(event, fn) {
    if (!this.listeners.has(event)) throw new Error(`unknown event ${event}; events are ${EVENTS.join(', ')}`);
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this.listeners.get(event)?.delete(fn); }
  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) fn({ type: event, time: this.rig.time, ...payload });
  }

  // Time --------------------------------------------------------------------
  // Advance by dt seconds in fixed 60 Hz steps (the remainder carries over).
  update(dt) {
    this.assertLive();
    if (!(dt > 0)) return 0;
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP - 1e-9 && n < MAX_STEPS_PER_UPDATE) { this.acc -= STEP; this.step(); n++; }
    if (n === MAX_STEPS_PER_UPDATE) this.acc = 0;
    return n;
  }
  step() {
    this.assertLive();
    this.rig.step(STEP);
    return this;
  }

  // Poses and blends --------------------------------------------------------
  setPose(hand, pose, { snap = false } = {}) {
    for (const side of sidesOf(hand)) this.rig.setPose(side, pose, { snap });
    return this;
  }
  blendPose(hand, pose, weight = 1, { mask = null, layer = 'blend', snap = false } = {}) {
    const m = mask || Object.fromEntries(DIGITS.map((d) => [d, 1]));
    for (const side of sidesOf(hand)) {
      if (weight <= 0) this.rig.clearLayer(side, layer);
      else this.rig.setLayer(side, layer, pose, { mask: m, weight, snap });
    }
    return this;
  }
  clearBlend(hand, layer = 'blend') {
    for (const side of sidesOf(hand)) this.rig.clearLayer(side, layer);
    return this;
  }

  // Per-finger control ------------------------------------------------------
  setFinger(hand, finger, curl, spread = undefined, { snap = false, force = false } = {}) {
    const d = digitOf(finger);
    for (const side of sidesOf(hand)) this.rig.setFingerControl(side, d, { curl, spread, force }, { snap });
    return this;
  }
  setFingerJoint(hand, finger, joint, curl, { snap = false, force = false } = {}) {
    const d = digitOf(finger);
    const allowed = d === 'thumb' ? ['cmc', 'mcp', 'ip'] : ['mcp', 'pip', 'dip'];
    if (!allowed.includes(joint)) throw new Error(`${finger} joints are ${allowed.join(', ')}, got ${joint}`);
    for (const side of sidesOf(hand)) {
      const ctl = this.rig.hands[side].control[d];
      this.rig.setFingerControl(side, d, { joint, value: curl, force, curl: ctl ? undefined : this.currentCurl(side, d) }, { snap });
    }
    return this;
  }
  setThumbOpposition(hand, amount, { snap = false } = {}) {
    for (const side of sidesOf(hand)) {
      const ctl = this.rig.hands[side].control.thumb;
      this.rig.setFingerControl(side, 'thumb', { opposition: amount, curl: ctl ? undefined : this.currentCurl(side, 'thumb') }, { snap });
    }
    return this;
  }
  releaseFingers(hand, finger = null) {
    for (const side of sidesOf(hand)) this.rig.releaseFingerControl(side, finger);
    return this;
  }
  // Approximate curl 0..1 a digit shows right now (for taking over smoothly).
  currentCurl(side, digit) {
    const sk = this.rig.skel;
    if (digit === 'thumb') return Math.min(1, Math.max(0, sk.joint(side, 'thumb-phalanx-distal').channels.flex / (88 * Math.PI / 180)));
    const p = { index: 'index-finger', middle: 'middle-finger', ring: 'ring-finger', little: 'pinky-finger' }[digit];
    return Math.min(1, Math.max(0, sk.joint(side, `${p}-phalanx-intermediate`).channels.flex / (100 * Math.PI / 180)));
  }

  // Gestures ----------------------------------------------------------------
  gesture(name, { hand = 'both', snap = false } = {}) {
    if (!POSES[name]) throw new Error(`unknown gesture ${name}`);
    for (const side of sidesOf(hand)) this.rig.setLayer(side, 'gesture', name, { weight: 1, snap });
    return this;
  }
  stopGesture(hand = 'both') {
    for (const side of sidesOf(hand)) { this.rig.stopGesture(side); this.rig.clearLayer(side, 'gesture'); }
    return this;
  }

  // Arms: IK targets --------------------------------------------------------
  // target: { pos: [x,y,z] wrist in world, rot: quaternion of the hand frame
  // (WebXR: -Z along the fingers, -Y out of the palm), pole: elbow hint }.
  setTarget(hand, target, { snap = false } = {}) {
    for (const side of sidesOf(hand)) this.rig.setArmTarget(side, target, { snap });
    return this;
  }
  // Point the hand: fingers along fingerDir, palm facing palmDir.
  static handRotation(fingerDir, palmDir) { return handRotation(fingerDir, palmDir); }
  target(hand) {
    const a = this.rig.arms[hand];
    return { pos: a.target.pos.slice(), rot: a.target.rot.slice(), pole: a.target.pole.slice() };
  }
  setBody(pos) { this.rig.setBody(pos); return this; }

  // Grasp and attachment ----------------------------------------------------
  // Pre-shape to the object, place it in the grip relative to the hand as it
  // is now, close every digit to contact, and attach it.
  grasp(hand, object, gripType = null) {
    const key = gripType || gripFor(object);
    if (!GRIPS[key]) throw new Error(`unknown grip ${key}; grips are ${Object.keys(GRIPS).join(', ')}`);
    const out = [];
    for (const side of sidesOf(hand)) {
      const att = this.rig.grasp(side, object, key);
      for (const c of att.contacts) this.emit('contact', { hand: side, object, digit: c.digit, segment: c.segment, point: c.point });
      this.emit('grasped', { hand: side, object, grip: key, contacts: att.contacts });
      out.push(att);
    }
    return out.length === 1 ? out[0] : out;
  }
  // Attach an object at its current world pose to the wrist without solving a
  // closure (the fingers keep whatever pose they have).
  attach(hand, object) {
    const side = sidesOf(hand)[0];
    const h = this.rig.hands[side];
    const wr = this.rig.skel.joint(side, 'wrist');
    const inv = quat.conjugate([0, 0, 0, 1], wr.worldRot);
    const pos = object.pos || v3.copy([0, 0, 0], wr.worldPos);
    const rot = object.rot || [0, 0, 0, 1];
    h.attached = {
      obj: { ...object, pos: pos.slice(), rot: rot.slice() },
      attachment: { pos: quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], pos, wr.worldPos)), rot: quat.multiply([0, 0, 0, 1], inv, rot) },
      gripKey: null,
      contacts: [],
      pose: null,
    };
    return h.attached;
  }
  detach(hand) {
    const side = sidesOf(hand)[0];
    const obj = this.rig.attachedObject(side);
    this.rig.release(side);
    return obj;
  }
  release(hand, { velocity = null } = {}) {
    const out = [];
    for (const side of sidesOf(hand)) {
      const obj = this.rig.attachedObject(side);
      if (!obj) continue;
      this.rig.release(side);
      this.emit('released', { hand: side, object: obj, velocity: velocity ? velocity.slice() : [0, 0, 0] });
      out.push(obj);
    }
    return out.length <= 1 ? out[0] || null : out;
  }
  held(hand) { return this.rig.attachedObject(hand); }
  contacts(hand) { const a = this.rig.hands[hand].attached; return a ? a.contacts.slice() : []; }

  // Read back ---------------------------------------------------------------
  joint(hand, name) {
    const j = this.rig.skel.joint(hand, name);
    return { pos: j.worldPos.slice(), rot: j.worldRot.slice(), channels: { ...j.channels } };
  }
  hash() { return this.rig.hash(); }

  // Teardown ----------------------------------------------------------------
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const set of this.listeners.values()) set.clear();
    this.rig.controllers = [];
    this.rig = null;
  }
  assertLive() { if (this.disposed) throw new Error('hands instance was disposed'); }
}

export function create(options = {}) { return new Hands(options); }

export { Rig, defaultArmTargets, GRIPS, gripFor, handRotation, FINGERS, DIGITS, OBJECTS, SKIN_TONES, SLEEVE_COLOURS, DEFAULTS, POSES, STEP };
export { Skeleton, XR_JOINT_NAMES, ARM_JOINT_NAMES, SIDES } from './skeleton.js';
export { Clock, RATES } from './clock.js';
export { buildArmMesh, colorize } from './mesh.js';
export { buildStone, buildSachet } from './stones.js';
export { v3, quat, m4, deg, toDeg, hashNumbers } from './math.js';
export { mulberry32 } from './rng.js';
export { createThreeView, makeSkinMaterial } from './three-view.js';
