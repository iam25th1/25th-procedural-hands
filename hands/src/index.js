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
import { v3, quat, hashNumbers } from './math.js';
import { FINGERS, DIGITS, Skeleton as SkeletonClass, XR_PREFIX } from './skeleton.js';
import { poseChannels, applyChannels } from './fingers.js';
import { handCapsules as handCapsulesOf } from './measure.js';
import { DEFAULTS, OBJECTS, SKIN_TONES, SLEEVE_COLOURS } from './defaults.js';
import { skinTone } from './skin.js';
import { World, Body, Prop, Rope } from './physics.js';
import { Interaction, targetShape } from './interact.js';
import { POSES, COUNTING, countPoseName, setPoseName, fingerSetPose } from './poses.js';
import { GESTURES, registerGesture, compileGesture, isDynamic, gestureChannels, gestureArm } from './gestures.js';

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
    // A bad skin tone fails here, where it was given, not at first draw.
    skinTone(o.skinTone);
    this.options = o;
    this.rig = new Rig({ seed: o.seed, reduced: o.reducedMotion, targets: o.targets || null });
    this.listeners = new Map(EVENTS.map((e) => [e, new Set()]));
    // A physics world to act on: pass one, or true for a fresh one.
    this.world = o.world === true ? new World({ seed: o.seed }) : (o.world || null);
    this.interaction = this.world ? new Interaction(this, this.world, { strength: o.strength ?? 1 }) : null;
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
    if (this.bodyMove) {
      const m = this.bodyMove;
      const u = Math.min(1, (this.rig.time + STEP - m.t0) / m.dur);
      const k = u * u * (3 - 2 * u);
      this.rig.setBody(v3.lerp([0, 0, 0], m.from, m.to, k));
      if (u >= 1) this.bodyMove = null;
    }
    if (this.interaction) this.interaction.pre(STEP);
    this.rig.step(STEP);
    if (this.interaction) this.interaction.post(STEP);
    return this;
  }

  // A snapped change lands on the skeleton at once, not on the next step.
  applyNow(snap) { if (snap) this.rig.step(0); return this; }

  // Poses and blends --------------------------------------------------------
  setPose(hand, pose, { snap = false } = {}) {
    for (const side of sidesOf(hand)) this.rig.setPose(side, pose, { snap });
    return this.applyNow(snap);
  }
  blendPose(hand, pose, weight = 1, { mask = null, layer = 'blend', snap = false } = {}) {
    const m = mask || Object.fromEntries(DIGITS.map((d) => [d, 1]));
    for (const side of sidesOf(hand)) {
      if (weight <= 0) this.rig.clearLayer(side, layer);
      else this.rig.setLayer(side, layer, pose, { mask: m, weight, snap });
    }
    return this.applyNow(snap);
  }
  clearBlend(hand, layer = 'blend') {
    for (const side of sidesOf(hand)) this.rig.clearLayer(side, layer);
    return this;
  }

  // Per-finger control ------------------------------------------------------
  setFinger(hand, finger, curl, spread = undefined, { snap = false, force = false } = {}) {
    const d = digitOf(finger);
    for (const side of sidesOf(hand)) this.rig.setFingerControl(side, d, { curl, spread, force }, { snap });
    return this.applyNow(snap);
  }
  setFingerJoint(hand, finger, joint, curl, { snap = false, force = false } = {}) {
    const d = digitOf(finger);
    const allowed = d === 'thumb' ? ['cmc', 'mcp', 'ip'] : ['mcp', 'pip', 'dip'];
    if (!allowed.includes(joint)) throw new Error(`${finger} joints are ${allowed.join(', ')}, got ${joint}`);
    for (const side of sidesOf(hand)) {
      const ctl = this.rig.hands[side].control[d];
      this.rig.setFingerControl(side, d, { joint, value: curl, force, curl: ctl ? undefined : this.currentCurl(side, d) }, { snap });
    }
    return this.applyNow(snap);
  }
  setThumbOpposition(hand, amount, { snap = false } = {}) {
    for (const side of sidesOf(hand)) {
      const ctl = this.rig.hands[side].control.thumb;
      this.rig.setFingerControl(side, 'thumb', { opposition: amount, curl: ctl ? undefined : this.currentCurl(side, 'thumb') }, { snap });
    }
    return this.applyNow(snap);
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
  // Any name in the gesture registry. Static ones hold a pose as a layer over
  // the base; moving ones place the arm and run their oscillations; ones
  // with an object (the pebble roll) grasp it first.
  gesture(name, { hand = 'both', snap = false } = {}) {
    const entry = GESTURES[name];
    if (!entry) throw new Error(`unknown gesture ${name}; gestures are ${Object.keys(GESTURES).join(', ')}`);
    for (const side of sidesOf(hand)) {
      this.rig.stopGesture(side);
      if (!isDynamic(entry)) {
        this.rig.setLayer(side, 'gesture', entry.pose, { weight: 1, snap });
        continue;
      }
      this.rig.clearLayer(side, 'gesture');
      if (entry.object && !this.rig.hands[side].attached) {
        this.release(side);
        this.rig.setPose(side, this.rig.preShapePose(side, entry.object, entry.grip), { snap: true });
        this.rig.step(0);
        this.grasp(side, entry.object, entry.grip);
      }
      this.rig.startGesture(side, name, compileGesture(entry), { snap });
    }
    return this.applyNow(snap);
  }
  stopGesture(hand = 'both') {
    for (const side of sidesOf(hand)) { this.rig.stopGesture(side); this.rig.clearLayer(side, 'gesture'); }
    return this;
  }
  // Counting 1 to 5 (0 is a closed hand): style 'index' counts from the index
  // finger, 'thumb' from the thumb.
  count(hand, n, style = 'index', { snap = false } = {}) {
    const name = countPoseName(n, style);
    for (const side of sidesOf(hand)) { this.rig.stopGesture(side); this.rig.setLayer(side, 'gesture', name, { weight: 1, snap }); }
    return this.applyNow(snap);
  }
  // Any combination of extended digits: showFingers('right', ['middle']),
  // showFingers('left', ['index', 'little']).
  showFingers(hand, set, { snap = false } = {}) {
    const name = setPoseName(set);
    for (const side of sidesOf(hand)) { this.rig.stopGesture(side); this.rig.setLayer(side, 'gesture', name, { weight: 1, snap }); }
    return this.applyNow(snap);
  }
  static registerGesture(name, entry) { return registerGesture(name, entry); }

  // Arms: IK targets --------------------------------------------------------
  // target: { pos: [x,y,z] wrist in world, rot: quaternion of the hand frame
  // (WebXR: -Z along the fingers, -Y out of the palm), pole: elbow hint }.
  setTarget(hand, target, { snap = false } = {}) {
    for (const side of sidesOf(hand)) {
      if (this.interaction) this.interaction.via[side] = null;
      this.rig.setArmTarget(side, target, { snap });
    }
    return this;
  }
  // Has the hand got where it was sent (no detour left, wrist within tol
  // metres of its target and nearly still)?
  arrived(hand, tol = 0.004) {
    const side = sidesOf(hand)[0];
    if (this.interaction && this.interaction.via[side]) return false;
    const a = this.rig.arms[side];
    const w = this.rig.skel.joint(side, 'wrist').worldPos;
    const speed = Math.hypot(...a.pos.map((s) => s.v));
    // Near the target and nearly still; or stopped as close as the arm can get.
    return (v3.dist(w, a.target.pos) <= tol && speed < 0.05) || (speed < 0.005 && v3.dist(w, a.target.pos) <= 0.03);
  }
  // Move a free hand to a wrist pose along a way clear of what is around it
  // (in a world); without a world this is setTarget.
  moveTo(hand, target) {
    for (const side of sidesOf(hand)) {
      if (this.interaction) this.interaction.moveTo(side, target);
      else this.rig.setArmTarget(side, target);
    }
    return this;
  }
  // Point the hand: fingers along fingerDir, palm facing palmDir.
  static handRotation(fingerDir, palmDir) { return handRotation(fingerDir, palmDir); }
  target(hand) {
    const a = this.rig.arms[hand];
    return { pos: a.target.pos.slice(), rot: a.target.rot.slice(), pole: a.target.pole.slice() };
  }
  setBody(pos) { this.bodyMove = null; this.rig.setBody(pos); return this; }
  // Move the body anchor (both shoulders) to pos over `seconds`, eased:
  // hanging, pulling up a rung. The camera never follows it on its own.
  moveBody(pos, seconds = 1) {
    this.bodyMove = { from: this.rig.body.slice(), to: pos.slice(), t0: this.rig.time, dur: Math.max(STEP, seconds) };
    return this;
  }
  // A busy hand holds still: idle sway and finger drift fade out.
  setBusy(hand, busy) { for (const side of sidesOf(hand)) this.rig.setBusy(side, busy); return this; }

  // Grasp and attachment ----------------------------------------------------
  // Pre-shape to the object, place it in the grip relative to the hand as it
  // is now, close every digit to contact, and attach it.
  grasp(hand, object, gripType = null, opts = {}) {
    if (this.interaction && isWorldTarget(object)) {
      const key = gripType || gripFor(targetShape(object));
      if (!GRIPS[key]) throw new Error(`unknown grip ${key}; grips are ${Object.keys(GRIPS).join(', ')}`);
      return this.interaction.grasp(sidesOf(hand)[0], object, key, opts);
    }
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
  // openAfter: seconds before the fingers open (a world's hand backs off first).
  release(hand, { velocity = null, openAfter = null } = {}) {
    const out = [];
    for (const side of sidesOf(hand)) {
      if (this.interaction && this.interaction.hold[side]) { out.push(this.interaction.release(side, { velocity, openAfter })); continue; }
      const obj = this.rig.attachedObject(side);
      if (!obj) continue;
      this.rig.release(side);
      this.emit('released', { hand: side, object: obj, velocity: velocity ? velocity.slice() : [0, 0, 0] });
      out.push(obj);
    }
    return out.length <= 1 ? out[0] || null : out;
  }
  held(hand) {
    // A dragged body is where the physics has it, not where the hand is.
    const rec = this.interaction && this.interaction.hold[hand];
    if (rec && rec.tethers) return targetShape(rec.part ? { body: rec.body, part: rec.part } : rec.body);
    return this.rig.attachedObject(hand);
  }
  // What a hand holds in the world: { kind: 'body' | 'prop' | 'rope' | 'fixed', ... } or null.
  holding(hand) { return this.interaction ? this.interaction.hold[hand] : null; }

  // World interaction -------------------------------------------------------
  // Reach toward a world target (a Body, { prop, part }, { rope, at } or
  // { fixed }) so that `grip` will land on it where it lies; pre-shapes the
  // hand. Returns the wrist pose it aims for.
  reach(hand, target, grip, opts = {}) {
    if (!this.interaction) throw new Error('reach needs a world: create({ world })');
    return this.interaction.reach(sidesOf(hand)[0], target, grip || gripFor(targetShape(target)), opts);
  }
  // Carry a held body with every hand on it following the body (two hands on
  // one object): target { pos, rot } for the body itself.
  carry(body, target) {
    if (!this.interaction) throw new Error('carry needs a world: create({ world })');
    return this.interaction.carry(body, target);
  }
  // Hold a hand open and ready where a ball of `radius` will be caught.
  readyCatch(hand, point, grip = 'spherical', { hint = null, radius = 0.035 } = {}) {
    return this.reach(hand, { shape: 'sphere', r: radius, pos: point }, grip, { hint });
  }
  // Plan and carry out a catch of a free body (see Interaction.planCatch).
  planCatch(hand, body, grip = 'spherical', opts = {}) {
    if (!this.interaction) throw new Error('planCatch needs a world: create({ world })');
    return this.interaction.planCatch(sidesOf(hand)[0], body, grip, opts);
  }
  // Where the wrist wants to go while it holds a prop part (the prop is
  // driven toward it and the hand follows the part); otherwise an IK target.
  intent(hand, target) {
    for (const side of sidesOf(hand)) { if (this.interaction) this.interaction.setIntent(side, target); else this.rig.setArmTarget(side, target); }
    return this;
  }
  contacts(hand) { const a = this.rig.hands[hand].attached; return a ? a.contacts.slice() : []; }

  // Where a digit's tip is in the wrist frame when the hand holds `pose`
  // (for aiming a fingertip at a button or a switch), and its pad radius.
  // A wrist pose that puts a digit's tip (as it is in `pose`) on `point`,
  // turned as near `rot` as the arm can actually take: the turn is tried as
  // given, then tilted and rolled a little each way, and the first the arm
  // reaches without strain wins. Returns { pos, rot, pole }.
  fingertipPose(hand, pose, point, rot, digit = 'index') {
    const side = sidesOf(hand)[0];
    const tl = this.tipLocal(side, pose, digit).tip;
    const at = (q) => ({ pos: v3.sub([0, 0, 0], point, quat.rotate([0, 0, 0], q, tl)), rot: q });
    if (!this.interaction) return at(rot);
    const turn = (q, axis, degs) => quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], quat.rotate([0, 0, 0], rot, axis), (degs * Math.PI) / 180), q));
    const tries = [rot];
    for (const a of [15, 30, 45]) for (const axis of [[1, 0, 0], [0, 0, 1], [0, 1, 0]]) for (const sgn of [1, -1]) tries.push(turn(rot, axis, sgn * a));
    let best = null;
    for (const q of tries) {
      const p = at(q);
      const fit = this.interaction.armFit(side, p);
      const cost = (fit.posErr > 0.002 ? 1 + fit.posErr : 0) * 1000 + (fit.rotErr > 0.02 ? 1 + fit.rotErr : 0) * 1000 + quat.angleBetween(q, rot) * 10 + Math.max(0, 12 - fit.room);
      if (!best || cost < best.cost) best = { cost, ...p, pole: fit.pole };
      if (cost < 1) break;
    }
    return { pos: best.pos, rot: best.rot, pole: best.pole };
  }

  tipLocal(hand, pose, digit = 'index') {
    const side = sidesOf(hand)[0];
    const sk = this.scratchSkeleton || (this.scratchSkeleton = new SkeletonClass());
    sk.reset();
    applyChannels(sk, side, poseChannels(this.rig.resolvePose(side, pose)));
    sk.update();
    const pre = digit === 'thumb' ? 'thumb' : XR_PREFIX[digit];
    const tip = sk.joint(side, `${pre}-tip`);
    const dist = sk.joint(side, `${pre}-phalanx-distal`);
    const wr = sk.joint(side, 'wrist');
    const inv = quat.conjugate([0, 0, 0, 1], wr.worldRot);
    return {
      tip: quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], tip.worldPos, wr.worldPos)),
      dir: quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], tip.worldPos, dist.worldPos)),
      radius: dist.radius,
    };
  }
  // Turn a held object in the grip about an axis in its own frame at `rate`
  // rad/s (in-hand roll and spin); 0 stops it.
  spin(hand, axis, rate) {
    for (const side of sidesOf(hand)) {
      const a = this.rig.hands[side].attached;
      if (!a) continue;
      a.spin = rate ? { axis: v3.normalize([0, 0, 0], axis), rate } : null;
    }
    return this;
  }

  // Set down what the hand holds on a surface at height `surface`: the hand
  // lowers until the object (or a finger under it) meets it, then stops.
  // surface: a height, or null to set it on whatever is under it.
  setDown(hand, surface = null, opts = {}) {
    if (!this.interaction) throw new Error('setDown needs a world: create({ world })');
    return this.interaction.setDown(sidesOf(hand)[0], { surface, ...opts });
  }
  // Lowest point of a hand's digits and palm (for setting things down so the
  // fingers under an object stop at the surface).
  lowestPoint(hand) {
    let lo = Infinity;
    for (const c of handCapsulesOf(this.rig.skel, hand)) lo = Math.min(lo, c.a[1] - c.r, c.b[1] - c.r);
    return lo;
  }

  // Read back ---------------------------------------------------------------
  joint(hand, name) {
    const j = this.rig.skel.joint(hand, name);
    return { pos: j.worldPos.slice(), rot: j.worldRot.slice(), channels: { ...j.channels } };
  }
  // One number for the whole state: every joint, and the world when there is one.
  hash() { return this.world ? hashNumbers([...this.rig.skel.transformValues(), ...this.world.stateValues()]) : this.rig.hash(); }

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

function isWorldTarget(o) {
  return o instanceof Body || Boolean(o && (o.body instanceof Body || o.prop instanceof Prop || o.rope instanceof Rope || o.fixed));
}

export function create(options = {}) { return new Hands(options); }

export { Rig, defaultArmTargets, GRIPS, gripFor, handRotation, FINGERS, DIGITS, OBJECTS, SKIN_TONES, SLEEVE_COLOURS, DEFAULTS, POSES, STEP };
export { MONK_TONES, DEFAULT_SKIN_TONE, skinTone, skinPalette } from './skin.js';
export { GESTURES, registerGesture, compileGesture, gestureChannels, gestureArm, COUNTING, countPoseName, setPoseName, fingerSetPose };
export { Skeleton, XR_JOINT_NAMES, ARM_JOINT_NAMES, SIDES } from './skeleton.js';
export { Clock, RATES } from './clock.js';
export { buildArmMesh, colorize } from './mesh.js';
export { buildStone, buildSachet } from './stones.js';
export { v3, quat, m4, deg, toDeg, hashNumbers } from './math.js';
export { mulberry32 } from './rng.js';
export { createThreeView, makeSkinMaterial } from './three-view.js';
export { World, Body, Prop, Rope, Interaction, targetShape };
export { limitMargin, penetration, objectPenetration, handCapsules } from './measure.js';
