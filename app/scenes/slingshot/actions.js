// Actions: the first person choreography. Every action is built from the
// procedural systems (arm targets that the springs follow, named poses and
// grips, slingshot state) with anticipation and follow through authored into
// the keyframes rather than canned clips. Draw is continuous from input.
// The camera never moves: everything here is arm, hand and fork targets in
// camera space.
import { v3, quat, lerp, clamp, smoothstep } from '../../../hands/src/math.js';
import { handRotation } from '../../../hands/src/ik.js';
import { BAND, HANDLE_GRIP, Slingshot } from './slingshot.js';

// Cheek anchor for the drawn pouch, relative to the eye, x toward the pinch
// side. The fork gap sits on the aim ray from the anchor.
export const ANCHOR = [0.075, -0.085, -0.10]; // corner of the mouth
export const AIM_DISTANCE = 0.42;
export const RELEASE_HOLD = 0.6; // seconds the fork arm keeps its aim after a release
// Hand turn for seating a stone: fingers toward the fork, palm in and up.
const SEAT_ROT = (a) => handRotation(a.P(-0.5, 0.2, -0.85), a.P(-0.75, 0.6, 0.3));
// Rest elbow: down, out and a little forward of the camera plane.
const POLE_REST = [0.55, -0.7, -0.2];
export const FULL_DRAW_HOLD = 0.2; // seconds at full draw before the strain tremor grows

export const STONES = {
  pebble: { kind: 'pebble', r: 0.0125 },
  rock: { kind: 'rock', r: 0.03 },
};
export const SACHET = { shape: 'pillow', hx: 0.075, hy: 0.045, hz: 0.0175, round: 0.012 };
export const LEDGE_STONE = { kind: 'pebble', r: 0.0125, pos: [0.30, -0.58, -0.40] }; // on a ledge, inside reach

export const ACTION_NAMES = [
  'idle', 'loadPebble', 'loadRock', 'draw', 'fullDrawHold', 'release', 'cancelDraw', 'dryRelease',
  'switchAmmo', 'pickup', 'drink', 'jump', 'land', 'crouch', 'dash', 'hitFlinch', 'knockout',
];

const ease = (t) => smoothstep(t);

export class Actions {
  constructor(rig) {
    this.rig = rig;
    this.cat = rig.slingshot;
    this.state = 'idle';
    this.track = null;
    this.drawInput = 0;
    this.draw = 0;          // smoothed draw amount 0..1
    this.drawVel = 0;
    this.holdTime = 0;
    this.ammo = 'pebble';
    this.carry = null;      // stone held in the pinch hand, not yet seated
    this.grabDemo = null;   // grab demo object resting on the ledge { kind, obj, pos, rot }
    this.crouched = false;
    this.sachet = null;     // { attached: true } while drinking
    this.ledgeStone = { ...LEDGE_STONE, present: true };
    this.events = [];
    this.log = [];
    this.s = rig.handedness === 'right' ? 1 : -1;
    this.forkAttachment = null;
    this.forkHand = rig.forkSide;
    this.pinchHand = rig.pinchSide;
    this.setupHold();
  }

  // Mirror x for handedness.
  P(x, y, z) { return [x * this.s, y, z]; }

  // Fork hand grips the handle; the fork frame is derived from the grip so
  // the fork can be aimed by rotating the hand target.
  setupHold() {
    const rig = this.rig;
    const handle = HANDLE_GRIP;
    rig.setPose(this.forkHand, 'relaxed', { snap: true });
    rig.step(0);
    const att = rig.grasp(this.forkHand, handle, 'powerCylinder');
    this.forkAttachment = att.attachment;
    // Pouch pinched: pinch a sphere of the pouch's folded thickness.
    rig.setPose(this.pinchHand, 'relaxed', { snap: true });
    rig.step(0);
    rig.grasp(this.pinchHand, { shape: 'sphere', r: 0.006 }, 'padPinch');
    this.pinchAttachment = rig.hands[this.pinchHand].attached.attachment;
    this.applyIdleTargets(true);
    rig.snapAll();
    this.syncSlingshot();
    // The pouch is in the pinch from the start, so a draw before any load
    // pulls the empty pouch back with the hand.
    this.cat.pinch(rig.attachedObject(this.pinchHand).pos);
    this.syncSlingshot();
    this.cat.step(0); // pouch and bands sit at the pinch before the first frame
    rig.snapAll();
  }

  // Desired fork pose for a draw amount: from the lowered idle hold to the
  // aimed, braced pose with the gap on the aim ray.
  forkPose(u) {
    const s = this.s;
    const k = ease(clamp(u / 0.35, 0, 1));
    const aimIdle = v3.normalize([0, 0, 0], [0.16 * s, 0.18, -1]);
    const aimDraw = [0, 0, -1];
    const aim = v3.normalize([0, 0, 0], v3.lerp([0, 0, 0], aimIdle, aimDraw, k));
    // Low and a little left of centre, close enough to read, far enough
    // that a portrait phone (80 degree cone, 0.46 aspect) keeps both prongs
    // and the pinch hand inside the frame.
    const gapIdle = this.P(-0.07, -0.06, -0.42);
    const gapDraw = v3.addScaled([0, 0, 0], this.P(ANCHOR[0], ANCHOR[1], ANCHOR[2]), aimDraw, AIM_DISTANCE);
    const gap = v3.lerp([0, 0, 0], gapIdle, gapDraw, k);
    // Fork +Y up, -Z along the aim, with a little idle roll toward the centre.
    const up = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], [0.12 * s * (1 - k), 1, 0], aim));
    const z = v3.negate([0, 0, 0], aim);
    const x = v3.cross([0, 0, 0], up, z);
    const rot = quat.fromBasis([0, 0, 0, 1], x, up, z);
    return { gap, rot, aim };
  }

  // Hand target that puts the attached fork at the desired fork pose.
  forkHandTarget(u) {
    const { gap, rot } = this.forkPose(u);
    const fork = this.cat.fork;
    const gripWorld = v3.sub([0, 0, 0], gap, quat.rotate([0, 0, 0], rot, fork.gapCentre));
    // fork world = hand world * A  =>  hand rot = forkRot * conj(A.rot); hand pos = grip - handRot * A.pos
    const A = this.forkAttachment;
    const handRot = quat.multiply([0, 0, 0, 1], rot, quat.conjugate([0, 0, 0, 1], this.forkRoll(A)));
    const handPos = v3.sub([0, 0, 0], gripWorld, quat.rotate([0, 0, 0], handRot, A.pos));
    return { pos: handPos, rot: handRot, pole: this.P(-0.5, -0.8, 0.05) };
  }

  // The grasp attaches a symmetric cylinder, so its roll about the handle is
  // free. The fork's frame in the hand is fixed by the comfortable full draw
  // hold: with the fork aimed straight ahead the fork hand sits with its
  // knuckles up and forward and the palm toward the midline, so that hold
  // needs no wrist deviation.
  forkRoll(A) {
    if (this._forkRoll) return this._forkRoll;
    const s = this.s;
    const handDraw = handRotation([0.05 * s, 0.6, -0.8], [0.8 * s, -0.15, 0.58]);
    const forkDraw = this.forkPose(1).rot;
    this._forkRoll = quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], handDraw), forkDraw);
    void A;
    return this._forkRoll;
  }

  // Where the pouch hangs for a fork pose: just below and behind the gap,
  // bands slack, in frame; it is not left hanging. The pinch hand keeps it
  // there at rest and the pouch springs back to it after a release.
  restFor(gap, rot) {
    return v3.add([0, 0, 0], gap, quat.rotate([0, 0, 0], rot, [0.015 * this.s, -0.055, 0.085]));
  }

  // Where the pouch should be held for a draw amount, and the pinch hand target.
  pouchTarget(u) {
    const { gap, rot } = this.forkPose(u);
    const anchor = this.P(ANCHOR[0], ANCHOR[1], ANCHOR[2]);
    // Rest: where the pouch hangs from the tips for that fork pose.
    const grip = v3.sub([0, 0, 0], gap, quat.rotate([0, 0, 0], rot, this.cat.fork.gapCentre));
    const rest = this.restFor(gap, rot);
    // Draw path measured from the tips so the bands only ever lengthen: the
    // distance from the tips' midpoint grows from the hanging length to the
    // anchor's, while the direction swings from down to back toward the face.
    const tips = this.cat.fork.tips.map((t) => v3.add([0, 0, 0], grip, quat.rotate([0, 0, 0], rot, t)));
    const mid = v3.lerp([0, 0, 0], tips[0], tips[1], 0.5);
    const full = this.forkPose(1);
    const gripFull = v3.sub([0, 0, 0], full.gap, quat.rotate([0, 0, 0], full.rot, this.cat.fork.gapCentre));
    const tipsFull = this.cat.fork.tips.map((t) => v3.add([0, 0, 0], gripFull, quat.rotate([0, 0, 0], full.rot, t)));
    const midFull = v3.lerp([0, 0, 0], tipsFull[0], tipsFull[1], 0.5);
    const restDir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], rest, mid));
    const restLen = v3.dist(rest, mid);
    const anchorDir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], anchor, midFull));
    const anchorLen = v3.dist(anchor, midFull);
    const k = ease(u);
    const dir = v3.normalize([0, 0, 0], v3.lerp([0, 0, 0], restDir, anchorDir, k));
    const len = lerp(restLen, anchorLen, k);
    // Blend the reference midpoint too, so u = 1 lands exactly on the anchor.
    const base = v3.lerp([0, 0, 0], mid, midFull, k);
    return v3.addScaled([0, 0, 0], base, dir, len);
  }
  // Wrist target that brings the stone held in the pinch hand to a point,
  // with the hand turned as given: the stone's offset in the wrist frame is
  // taken from its grasp attachment.
  carryTarget(point, rot) {
    const h = this.rig.hands[this.pinchHand];
    const A = h.attached ? h.attached.attachment : this.pinchAttachment;
    return { pos: v3.sub([0, 0, 0], point, quat.rotate([0, 0, 0], rot, A.pos)), rot };
  }

  pinchHandTarget(u, point = null) {
    const s = this.s;
    const target = point || this.pouchTarget(u);
    const k = ease(u);
    // Rest: palm inward and up, fingers forward. Full draw: the classic
    // slingshot anchor, fingers pointing at the face, back of the hand
    // forward, elbow high and out.
    const fingerDir = v3.normalize([0, 0, 0], v3.lerp([0, 0, 0], [-0.55 * s, 0.35, -0.75], [-0.95 * s, 0.1, -0.3], k));
    const palmDir = v3.normalize([0, 0, 0], v3.lerp([0, 0, 0], [-0.7 * s, 0.55, 0.45], [0, -0.95, 0.3], k));
    const rot = handRotation(fingerDir, palmDir);
    const A = this.pinchAttachment;
    const pos = v3.sub([0, 0, 0], target, quat.rotate([0, 0, 0], rot, A.pos));
    // Elbow low and out at rest, out and only slightly raised at full draw so the arm stays clear of the view.
    const pole = v3.lerp([0, 0, 0], this.P(...POLE_REST), this.P(0.7, -0.45, 0.05), k);
    return { pos, rot, pole };
  }

  applyIdleTargets(snap = false) {
    this.rig.setArmTarget(this.forkHand, this.forkHandTarget(0), { snap });
    this.rig.setArmTarget(this.pinchHand, this.pinchHandTarget(0), { snap });
  }

  // Keep the slingshot in step with the hands: fork from the fork hand, pouch
  // from the pinch hand when pinched.
  syncSlingshot() {
    const rig = this.rig;
    const forkObj = rig.attachedObject(this.forkHand);
    if (forkObj) {
      const rot = quat.multiply([0, 0, 0, 1], rig.skel.joint(this.forkHand, 'wrist').worldRot, this.forkRoll(this.forkAttachment));
      this.cat.setFork(forkObj.pos, rot);
    }
    // The pouch rests relative to the fork as it actually is, so after a
    // release it hangs from the aimed fork instead of being dragged toward
    // where the fork will be once the arm has lowered.
    this.cat.holdPoint = this.restFor(this.cat.gapWorld(), this.cat.forkRot);
    const pinchObj = rig.attachedObject(this.pinchHand);
    if (this.cat.pinched && pinchObj) this.cat.pinch(pinchObj.pos);
  }

  // Timeline helper: keys fire once when their time passes.
  play(name, keys, onDone = null) {
    this.state = name;
    this.track = { name, t0: this.rig.time, keys: keys.slice().sort((a, b) => a.t - b.t), next: 0, onDone };
    this.log.push({ t: this.rig.time, name });
  }

  busy() { return this.track !== null && this.state !== 'draw' && this.state !== 'fullDrawHold'; }

  // Public actions ---------------------------------------------------------

  setDraw(u) {
    if (this.busy()) return;
    this.drawInput = clamp(u, 0, 1);
    if (this.drawInput > 0.02 && this.state === 'idle') { this.state = 'draw'; this.log.push({ t: this.rig.time, name: 'draw' }); }
  }

  releaseDraw() {
    if (this.state !== 'draw' && this.state !== 'fullDrawHold') return;
    if (this.draw < 0.08) return this.cancelDraw();
    return this.cat.loaded ? this.release() : this.dryRelease();
  }

  cancelDraw() {
    if (this.state !== 'draw' && this.state !== 'fullDrawHold') return;
    this.drawInput = 0;
    this.rig.tremor = 0;
    this.state = 'cancelDraw';
    this.play('cancelDraw', [{ t: 0.9, fn: () => { this.state = 'idle'; this.track = null; } }]);
  }

  release() {
    const rig = this.rig;
    const u = this.draw;
    const result = this.cat.release(true);
    this.lastLaunch = result;
    rig.tremor = 0;
    rig.release(this.pinchHand);
    rig.setStiffness(this.pinchHand, 60);
    rig.setPose(this.pinchHand, 'released');
    const aim = result.aim;
    const from = this.pinchHandTarget(u);
    // Follow through: a short push along the aim, then the hand drops away
    // from the face toward the rest hold.
    const follow = v3.add([0, 0, 0], v3.addScaled([0, 0, 0], from.pos, aim, 0.035), this.P(0.03, -0.03, 0));
    // The fork arm holds its aim while the bands ring down (RELEASE_HOLD),
    // then the draw input drops and the fork lowers to the idle hold, where
    // the pinch hand re-grips the pouch.
    this.play('release', [
      { t: 0, fn: () => rig.setArmTarget(this.pinchHand, { pos: follow, rot: from.rot }) },
      { t: 0.1, fn: () => { rig.setStiffness(this.pinchHand, null); rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], this.pinchHandTarget(0).pos, this.P(0.06, -0.12, 0.02)), rot: this.pinchHandTarget(0.25).rot, pole: this.P(...POLE_REST) }); } },
      { t: 0.3, fn: () => { rig.setPose(this.pinchHand, 'relaxed'); rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], this.pinchHandTarget(0).pos, this.P(0.02, -0.05, 0.02)), rot: this.pinchHandTarget(0).rot }); } },
      { t: RELEASE_HOLD, fn: () => { this.drawInput = 0; } },
      { t: 1.0, fn: () => this.regrabPouch() },
      { t: 1.3, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  dryRelease() {
    const rig = this.rig;
    const u = this.draw;
    const result = this.cat.release(false);
    this.lastLaunch = result;
    rig.tremor = 0;
    rig.release(this.pinchHand);
    rig.setStiffness(this.pinchHand, 60);
    rig.setPose(this.pinchHand, 'released');
    const from = this.pinchHandTarget(u);
    this.play('dryRelease', [
      { t: 0, fn: () => rig.setArmTarget(this.pinchHand, { pos: v3.addScaled([0, 0, 0], from.pos, result.aim, 0.04), rot: from.rot }) },
      { t: 0.12, fn: () => { rig.setStiffness(this.pinchHand, null); rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], this.pinchHandTarget(0).pos, this.P(0.06, -0.12, 0.02)), rot: this.pinchHandTarget(0.25).rot, pole: this.P(...POLE_REST) }); } },
      { t: 0.3, fn: () => { rig.setPose(this.pinchHand, 'relaxed'); rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], this.pinchHandTarget(0).pos, this.P(0.02, -0.05, 0.02)), rot: this.pinchHandTarget(0).rot }); } },
      { t: RELEASE_HOLD, fn: () => { this.drawInput = 0; } },
      { t: 1.0, fn: () => this.regrabPouch() },
      { t: 1.3, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  // Pinch the pouch (with or without a stone) at its current position.
  regrabPouch() {
    const rig = this.rig;
    // The leather wraps the stone; the fingers close on the stone's own radius,
    // which is also exactly what they were already holding when it was seated.
    const r = this.cat.loaded ? this.cat.loaded.r : 0.006;
    rig.setPose(this.pinchHand, 'ready');
    rig.step(0);
    // A rock in the pouch fills the hand: fingers around it; pebbles and the empty pouch are pinched.
    rig.grasp(this.pinchHand, { shape: 'sphere', r }, r > 0.02 ? 'spherical' : 'padPinch');
    this.pinchAttachment = rig.hands[this.pinchHand].attached.attachment;
    this.cat.pinch(rig.attachedObject(this.pinchHand).pos);
    rig.setArmTarget(this.pinchHand, this.pinchHandTarget(0));
  }

  fullDrawHold() {
    this.state = 'fullDrawHold';
  }

  // Load: reach to the hip pocket, pinch the stone, lift it, seat it in the
  // pouch and pinch the pouch around it.
  load(kind) {
    if (this.busy() || this.state !== 'idle') return;
    const rig = this.rig;
    const stone = STONES[kind];
    const pocket = this.P(0.25, -0.44, -0.25);
    const grip = kind === 'rock' ? 'spherical' : 'padPinch';
    this.ammo = kind;
    rig.release(this.pinchHand);
    this.cat.pinched = false;
    this.play(kind === 'rock' ? 'loadRock' : 'loadPebble', [
      // Anticipation: open the hand and lift slightly before the reach.
      { t: 0, fn: () => { rig.setPose(this.pinchHand, 'ready'); rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], this.pinchHandTarget(0).pos, [0, 0.03, 0]), rot: handRotation(this.P(-0.3, -0.3, -0.9), this.P(-0.2, -0.9, -0.3)) }); } },
      { t: 0.18, fn: () => rig.setArmTarget(this.pinchHand, { pos: pocket, rot: handRotation(this.P(-0.3, -0.55, -0.78), this.P(-0.9, 0.25, 0.3)) }) },
      { t: 0.3, fn: () => rig.setPose(this.pinchHand, rig.preShapePose(this.pinchHand, { shape: 'sphere', r: stone.r }, grip)) },
      { t: 0.6, fn: () => { rig.grasp(this.pinchHand, { shape: 'sphere', r: stone.r }, grip); this.carry = { ...stone }; } },
      // The stone (not the wrist) goes above the pouch, then down into it.
      { t: 0.75, fn: () => rig.setArmTarget(this.pinchHand, this.carryTarget(v3.add([0, 0, 0], this.pouchTarget(0), [0, 0.05, 0]), SEAT_ROT(this))) },
      { t: 1.15, fn: () => rig.setArmTarget(this.pinchHand, this.carryTarget(v3.add([0, 0, 0], this.pouchTarget(0), [0, 0.004, 0]), SEAT_ROT(this))) },
      { t: 1.45, fn: () => { this.cat.loaded = { kind: stone.kind, r: stone.r }; this.carry = null; rig.release(this.pinchHand); this.regrabPouch(); } },
      { t: 1.9, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  // Take the current stone out and bring the other kind.
  switchAmmo() {
    if (this.busy() || this.state !== 'idle') return;
    const rig = this.rig;
    const next = this.ammo === 'pebble' ? 'rock' : 'pebble';
    const pocket = this.P(0.25, -0.44, -0.25);
    const had = this.cat.loaded;
    this.play('switchAmmo', [
      { t: 0, fn: () => { if (had) { rig.release(this.pinchHand); this.cat.pinched = false; rig.grasp(this.pinchHand, { shape: 'sphere', r: had.r }, had.kind === 'rock' ? 'spherical' : 'padPinch'); this.carry = { ...had }; this.cat.loaded = null; } } },
      { t: 0.15, fn: () => rig.setArmTarget(this.pinchHand, { pos: pocket, rot: handRotation(this.P(-0.3, -0.55, -0.78), this.P(-0.9, 0.25, 0.3)) }) },
      { t: 0.6, fn: () => { rig.release(this.pinchHand); this.carry = null; const st = STONES[next]; rig.setPose(this.pinchHand, rig.preShapePose(this.pinchHand, { shape: 'sphere', r: st.r }, next === 'rock' ? 'spherical' : 'padPinch')); } },
      { t: 0.9, fn: () => { const st = STONES[next]; rig.grasp(this.pinchHand, { shape: 'sphere', r: st.r }, next === 'rock' ? 'spherical' : 'padPinch'); this.carry = { ...st }; this.ammo = next; } },
      { t: 1.05, fn: () => rig.setArmTarget(this.pinchHand, this.carryTarget(v3.add([0, 0, 0], this.pouchTarget(0), [0, 0.05, 0]), SEAT_ROT(this))) },
      { t: 1.45, fn: () => rig.setArmTarget(this.pinchHand, this.carryTarget(v3.add([0, 0, 0], this.pouchTarget(0), [0, 0.004, 0]), SEAT_ROT(this))) },
      { t: 1.75, fn: () => { const st = STONES[next]; this.cat.loaded = { kind: st.kind, r: st.r }; this.carry = null; rig.release(this.pinchHand); this.regrabPouch(); } },
      { t: 2.2, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  // Pick a stone off the ledge with world space IK when it is within reach.
  pickup() {
    if (this.busy() || this.state !== 'idle' || !this.ledgeStone.present) return;
    const rig = this.rig;
    const stone = this.ledgeStone;
    const shoulder = rig.skel.joint(this.pinchHand, 'upper-arm').worldPos;
    const reach = rig.skel.joint(this.pinchHand, 'upper-arm').length + v3.dist(rig.skel.joint(this.pinchHand, 'forearm').restWorldPos, rig.skel.joint(this.pinchHand, 'wrist').restWorldPos);
    if (v3.dist(stone.pos, shoulder) > reach * 0.95) { this.log.push({ t: rig.time, name: 'pickup out of reach' }); return; }
    const above = v3.add([0, 0, 0], stone.pos, [0, 0.07, 0]);
    const grasp = handRotation(this.P(-0.2, -0.95, -0.25), this.P(-0.9, -0.3, 0.3));
    rig.release(this.pinchHand);
    this.cat.pinched = false;
    this.play('pickup', [
      { t: 0, fn: () => { rig.setPose(this.pinchHand, 'ready'); rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], above, [0, 0.05, 0.03]), rot: grasp }); } },
      { t: 0.4, fn: () => rig.setArmTarget(this.pinchHand, { pos: above, rot: grasp }) },
      { t: 0.55, fn: () => { rig.setPose(this.pinchHand, rig.preShapePose(this.pinchHand, { shape: 'sphere', r: stone.r }, 'padPinch')); } },
      { t: 0.85, fn: () => { rig.grasp(this.pinchHand, { shape: 'sphere', r: stone.r }, 'padPinch'); this.carry = { kind: stone.kind, r: stone.r }; stone.present = false; } },
      { t: 1.0, fn: () => rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], above, [0, 0.08, 0]) }) },
      { t: 1.25, fn: () => rig.setArmTarget(this.pinchHand, this.carryTarget(v3.add([0, 0, 0], this.pouchTarget(0), [0, 0.05, 0]), SEAT_ROT(this))) },
      { t: 1.65, fn: () => rig.setArmTarget(this.pinchHand, this.carryTarget(v3.add([0, 0, 0], this.pouchTarget(0), [0, 0.004, 0]), SEAT_ROT(this))) },
      { t: 1.95, fn: () => { this.cat.loaded = { kind: stone.kind, r: stone.r }; this.carry = null; rig.release(this.pinchHand); this.regrabPouch(); } },
      { t: 2.4, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  // Drink a pure water sachet (the heal pickup) and toss it.
  drink() {
    if (this.busy() || this.state !== 'idle') return;
    const rig = this.rig;
    const pocket = this.P(0.26, -0.44, -0.22);
    // Low and far enough that the sachet sits in the bottom third of the
    // view with the reticle clear.
    const mouth = this.P(0.03, -0.145, -0.20);
    rig.release(this.pinchHand);
    this.cat.pinched = false;
    this.play('drink', [
      // Reach into the pocket with the hand already shaped for the sachet, so it comes out under the thumb.
      { t: 0, fn: () => { rig.setPose(this.pinchHand, rig.preShapePose(this.pinchHand, SACHET, 'spherical')); rig.setArmTarget(this.pinchHand, { pos: pocket, rot: handRotation(this.P(-0.3, -0.55, -0.78), this.P(-0.9, 0.25, 0.3)) }); } },
      { t: 0.45, fn: () => { rig.grasp(this.pinchHand, SACHET, 'spherical'); this.sachet = { held: true }; } },
      // Bring the corner to the mouth, sachet tilted up.
      { t: 0.65, fn: () => rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], mouth, [0.06 * this.s, -0.1, -0.03]), rot: handRotation(this.P(-0.6, 0.6, -0.5), this.P(-0.7, 0.2, 0.7)) }) },
      { t: 1.05, fn: () => rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], mouth, [0.04 * this.s, -0.06, 0.0]), rot: handRotation(this.P(-0.5, 0.85, -0.2), this.P(-0.75, 0.1, 0.65)) }) },
      // Drink: tilt further, hold.
      { t: 1.5, fn: () => rig.setArmTarget(this.pinchHand, { pos: v3.add([0, 0, 0], mouth, [0.03 * this.s, -0.04, 0.01]), rot: handRotation(this.P(-0.3, 0.95, -0.1), this.P(-0.8, 0.0, 0.6)) }) },
      // Toss: swing out to the side and let go.
      { t: 2.4, fn: () => rig.setArmTarget(this.pinchHand, { pos: this.P(0.42, -0.12, -0.42), rot: handRotation(this.P(0.9, 0.2, -0.35), this.P(0.2, -0.8, -0.5)) }) },
      { t: 2.62, fn: () => { const obj = rig.attachedObject(this.pinchHand); rig.release(this.pinchHand); rig.setPose(this.pinchHand, 'open'); this.sachet = null; if (obj) this.cat.projectiles.push({ kind: 'sachet', r: 0.04, pos: obj.pos.slice(), rot: obj.rot.slice(), vel: this.P(2.2, 1.6, -1.5), age: 0 }); } },
      { t: 2.95, fn: () => { rig.setPose(this.pinchHand, 'relaxed'); rig.setArmTarget(this.pinchHand, this.pinchHandTarget(0)); } },
      { t: 3.3, fn: () => this.regrabPouch() },
      { t: 3.7, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  // Reactions: short arm offsets and a brace on the hands. Reduced motion halves them.
  reaction(name) {
    if (this.busy() && !['jump', 'land', 'dash', 'hitFlinch', 'crouch'].includes(name)) return;
    const rig = this.rig;
    const k = rig.reduced ? 0.5 : 1;
    const both = (fn) => { fn(this.forkHand); fn(this.pinchHand); };
    if (name === 'jump') {
      this.reactTrack = [{ t: 0, v: [0, 0.035 * k, 0.01 * k] }, { t: 0.18, v: [0, -0.015 * k, 0] }, { t: 0.5, v: [0, 0, 0] }];
    } else if (name === 'land') {
      this.reactTrack = [{ t: 0, v: [0, -0.05 * k, 0] }, { t: 0.14, v: [0, 0.012 * k, 0] }, { t: 0.45, v: [0, 0, 0] }];
      both((side) => rig.setLayer(side, 'brace', 'fist', { mask: { index: 0.5, middle: 0.5, ring: 0.6, little: 0.6, thumb: 0 }, weight: 0.5 }));
      this.braceUntil = rig.time + 0.3;
    } else if (name === 'crouch') {
      this.crouched = !this.crouched;
      // The camera drops with the body, so the hands barely move against it:
      // a small settle with a forward lean keeps both in frame on a wide screen.
      this.reactTrack = [{ t: 0, v: [0, this.crouched ? -0.015 * k : 0, this.crouched ? 0.02 * k : 0] }];
    } else if (name === 'dash') {
      this.reactTrack = [{ t: 0, v: [0, -0.01 * k, 0.06 * k] }, { t: 0.15, v: [0, 0.005 * k, -0.015 * k] }, { t: 0.5, v: [0, 0, 0] }];
      both((side) => rig.setLayer(side, 'brace', 'fist', { mask: { index: 0.4, middle: 0.6, ring: 0.7, little: 0.7, thumb: 0 }, weight: 0.6 }));
      this.braceUntil = rig.time + 0.25;
    } else if (name === 'hitFlinch') {
      this.reactTrack = [{ t: 0, v: this.P(-0.02 * k, 0.015 * k, 0.03 * k) }, { t: 0.1, v: this.P(0.01 * k, -0.01 * k, -0.01 * k) }, { t: 0.4, v: [0, 0, 0] }];
      both((side) => rig.setLayer(side, 'brace', 'fist', { mask: { index: 0.6, middle: 0.7, ring: 0.8, little: 0.8, thumb: 0.3 }, weight: 0.7 }));
      this.braceUntil = rig.time + 0.2;
    }
    this.reactStart = rig.time;
    this.reactBase = this.crouched && name !== 'crouch' ? [0, -0.015 * k, 0.02 * k] : [0, 0, 0];
    this.log.push({ t: rig.time, name });
  }

  knockout() {
    const rig = this.rig;
    rig.tremor = 0;
    this.drawInput = 0;
    this.cat.pinched = false;
    rig.release(this.pinchHand);
    // The fork hand keeps its grip as the arm goes limp: a pose change on a
    // hand holding something would open the fingers through it.
    this.play('knockout', [
      { t: 0, fn: () => { rig.setPose(this.pinchHand, 'open'); } },
      { t: 0.05, fn: () => { rig.setArmTarget(this.pinchHand, { pos: this.P(0.3, -0.62, -0.3), rot: handRotation(this.P(0.2, -0.9, -0.4), this.P(-0.8, -0.3, 0.5)) }); rig.setArmTarget(this.forkHand, { pos: this.P(-0.28, -0.68, -0.28), rot: handRotation(this.P(-0.2, -0.9, -0.4), this.P(0.7, -0.3, 0.6)) }); } },
      { t: 0.6, fn: () => { rig.setPose(this.pinchHand, 'relaxed'); } },
      { t: 1.6, fn: () => { this.state = 'down'; this.track = null; } },
    ]);
  }

  // Get up after a knockout: back to the idle hold.
  recover() {
    if (this.state !== 'down') return;
    this.play('recover', [
      { t: 0, fn: () => { this.applyIdleTargets(false); } },
      { t: 0.7, fn: () => this.regrabPouch() },
      { t: 1.1, fn: () => { this.state = 'idle'; this.track = null; } },
    ]);
  }

  // Per step -----------------------------------------------------------------
  update(dt) {
    const rig = this.rig;
    // Draw amount follows the input through a critically damped response.
    const w = 14;
    const A = this.draw - this.drawInput;
    const B = this.drawVel + w * A;
    const e = Math.exp(-w * dt);
    this.draw = this.drawInput + (A + B * dt) * e;
    this.drawVel = (B - w * (A + B * dt)) * e;

    if (this.state === 'draw' || this.state === 'fullDrawHold') {
      rig.setArmTarget(this.forkHand, this.forkHandTarget(this.draw));
      rig.setArmTarget(this.pinchHand, this.pinchHandTarget(this.draw));
      if (this.draw > 0.97) {
        this.holdTime += dt;
        if (this.holdTime > FULL_DRAW_HOLD) { this.state = 'fullDrawHold'; rig.tremor = clamp((this.holdTime - FULL_DRAW_HOLD) / 0.5, 0, 1); }
      } else {
        this.holdTime = 0;
        rig.tremor = 0;
        if (this.state === 'fullDrawHold') this.state = 'draw';
      }
      // Fork hand braces: fingers tighten with draw.
      rig.setLayer(this.forkHand, 'brace', 'fist', { mask: { index: 0.25, middle: 0.35, ring: 0.4, little: 0.45, thumb: 0 }, weight: 0.35 * this.draw });
    } else if (this.state === 'cancelDraw') {
      rig.setArmTarget(this.forkHand, this.forkHandTarget(this.draw));
      rig.setArmTarget(this.pinchHand, this.pinchHandTarget(this.draw));
      rig.setLayer(this.forkHand, 'brace', 'fist', { mask: { index: 0.25, middle: 0.35, ring: 0.4, little: 0.45, thumb: 0 }, weight: 0.35 * this.draw });
    } else if (this.state === 'release' || this.state === 'dryRelease') {
      // The fork arm keeps its aim, then follows the draw amount back down;
      // the pinch hand is on the release timeline.
      rig.setArmTarget(this.forkHand, this.forkHandTarget(this.draw));
      rig.setLayer(this.forkHand, 'brace', 'fist', { mask: { index: 0.25, middle: 0.35, ring: 0.4, little: 0.45, thumb: 0 }, weight: 0.35 * this.draw });
    } else if (this.state === 'idle') {
      rig.clearLayer(this.forkHand, 'brace');
      this.holdTime = 0;
    }

    // Timeline keys.
    if (this.track) {
      const el = rig.time - this.track.t0;
      while (this.track && this.track.next < this.track.keys.length && this.track.keys[this.track.next].t <= el + 1e-9) {
        const key = this.track.keys[this.track.next++];
        key.fn();
      }
    }
    // Reactions: piecewise linear offsets applied to both arms.
    if (this.reactTrack) {
      const el = rig.time - this.reactStart;
      const T = this.reactTrack;
      let v = T[T.length - 1].v;
      for (let i = 0; i + 1 < T.length; i++) {
        if (el >= T[i].t && el < T[i + 1].t) { const t = (el - T[i].t) / (T[i + 1].t - T[i].t); v = v3.lerp([0, 0, 0], T[i].v, T[i + 1].v, ease(t)); break; }
      }
      if (el < T[0].t) v = T[0].v;
      for (const side of ['left', 'right']) rig.arms[side].react = v3.add([0, 0, 0], v, this.reactBase || [0, 0, 0]);
      if (el > T[T.length - 1].t + 0.05 && !this.crouched) { this.reactTrack = null; for (const side of ['left', 'right']) rig.arms[side].react = [0, 0, 0]; }
    }
    if (this.braceUntil && rig.time > this.braceUntil) { this.braceUntil = null; if (this.state !== 'draw' && this.state !== 'fullDrawHold') for (const side of ['left', 'right']) rig.clearLayer(side, 'brace'); }
  }
}

// The snapshot rig built the slingshot in and took a handedness; the module's
// rig is game free and hooks tools in through controllers. These two pieces
// restore that wiring from outside the module.

// First person arm targets, camera space, for the pinch hand and the fork
// hand, mirrored in x for a left handed player: the snapshot rig's defaults,
// keyed by side so they can be passed to the module as `targets`.
export function slingshotArmTargets(handedness = 'right') {
  const s = handedness === 'right' ? 1 : -1;
  const pinch = {
    pos: [0.19 * s, -0.21, -0.36],
    rot: handRotation([-0.35 * s, 0.35, -0.87], [-0.85 * s, 0.4, 0.2]),
    pole: [0.5 * s, -0.7, 0.0],
  };
  const fork = {
    pos: [-0.11 * s, -0.13, -0.42],
    rot: handRotation([0.1 * s, 0.9, -0.42], [0.95 * s, 0.05, 0.3]),
    pole: [-0.55 * s, -0.7, 0.0],
  };
  return handedness === 'right' ? { right: pinch, left: fork } : { left: pinch, right: fork };
}

// Put a slingshot in a rig's hands. The rig gets the fields the snapshot rig
// carried (handedness, pinchSide, forkSide, slingshot, actions) so actions,
// scenarios, checks and the view read it the same way. The controller is
// added only after the hold is set up: the snapshot rig created its actions
// last, so the setup steps ran without the per step slingshot sync.
export function attachSlingshot(rig, { handedness = 'right' } = {}) {
  rig.handedness = handedness;
  rig.pinchSide = handedness;
  rig.forkSide = handedness === 'right' ? 'left' : 'right';
  rig.slingshot = new Slingshot();
  const actions = new Actions(rig);
  rig.actions = actions;
  const remove = rig.addController({
    update(dt) { actions.update(dt); },
    post(dt) {
      actions.syncSlingshot();
      rig.slingshot.step(dt);
    },
    // Letting go with the pinch hand lets go of the pouch too, so a stone
    // or other object taken next does not drag the bands along with it.
    released(side) { if (side === rig.pinchSide) rig.slingshot.pinched = false; },
  });
  actions.detach = remove;
  return actions;
}
