// Interaction: the hands acting on a physics world. Hands move objects and
// objects resist hands.
//
// - The phalanges and metacarpals of both hands are kinematic capsules in
//   the world every step, so a hand pushes whatever it touches through
//   contact impulses (a crate, a ball, a button cap, a switch toggle).
// - A grasped body becomes kinematic and rides the hand that grasped it
//   (the leader); a second hand on the same body follows the body exactly
//   (two-hand grip), and releasing the leader hands the body over.
// - A grasped prop part (lever, knob, drawer handle) is driven toward where
//   the hand intends it to go, with the hand's strength against the prop's
//   friction, springs and limits, and the hand follows where the part
//   actually is: a stiff lever lags and holds the hand back.
// - A grasped static (a rung) pins the wrist there; the body anchor can
//   then move under it (hanging, climbing).
// - A grasped rope pins the rope to the grip; the rest of the rope swings.
// - Weight reads in the arms: a held load lowers and draws in the wrist.
// - Grip strength and slip: a load heavier than the grip holds, or shaken
//   harder than it holds, slips out; the fingers stay where they were for a
//   moment, then close on nothing.
import { v3, quat, clamp, segmentDistance, pointSegmentDistance } from './math.js';
import { Spring } from './springs.js';
import { RotSpring } from './rig.js';
import { GRIPS, attachToHand, placeObject, preShape, solveGrasp, capsuleObjectDistance } from './grasp.js';
import { Skeleton } from './skeleton.js';
import { solveArm } from './ik.js';
import { clonePose, poseChannels, applyChannels } from './fingers.js';
import { handCapsules } from './measure.js';
import { Body, Prop, Rope } from './physics.js';
import { FOREARM_TWIST, LIMITS_DEG } from './anatomy.js';
import * as dmath from './dmath.js';

const SIDES = ['left', 'right'];
const G = 9.81;
const SLIP_FRAMES = 2;
const LOOSEN_AFTER = 0.15; // s the fingers stay put after a slip before closing on nothing

// Resolve a grasp target to a world grasp shape (what the solver closes on).
// The inputs of a plan, as a string: which hand and grip, the object's shape
// and where it lies, the hint, the grip point and whether to avoid the
// surroundings. A recorded plan is only used where its fingerprint matches.
export function planFingerprint(side, grip, obj, hint, at, avoid) {
  const nums = [obj.pos, obj.rot, hint || [], at].flat();
  const dims = ['r', 'h', 'hx', 'hy', 'hz', 'round'].map((k) => (typeof obj[k] === 'number' ? obj[k] : ''));
  return `${side}|${grip}|${obj.shape}|${dims.join(',')}|${avoid ? 1 : 0}|${nums.join(',')}`;
}

const FOREARM_ROOM_WEIGHT = 1 / 3;
// Seconds the thumb leads the fingers in letting go of a body set down.
const THUMB_LEAD = 0.2;
// Height (metres over its surface) by which a set-down's turn is complete.
const TURN_ABOVE = 0.02;
// Seconds a hand backing out from under a body it set down is left to it.
const LEAVE_TIME = 0.35;

// A pose with another pose's thumb.
function withThumb(pose, thumb) {
  const out = clonePose(pose);
  out.thumb = { cmc: thumb.cmc.slice(), mcp: thumb.mcp.slice(), ip: thumb.ip };
  return out;
}

export function targetShape(target) {
  if (target instanceof Body) return target.graspShape();
  if (target && target.body instanceof Body) return partShape(target.body.partWorld(target.part));
  if (target && target.prop instanceof Prop) {
    const w = target.prop.partWorld(target.part);
    return partShape(w);
  }
  if (target && target.rope instanceof Rope) return target.rope.graspShape(target.index ?? target.rope.nearestIndex(target.at));
  if (target && target.fixed) return target.fixed.shape === 'capsule' ? capsuleShape(target.fixed) : target.fixed;
  if (target && target.shape && target.pos) return { rot: [0, 0, 0, 1], ...target };
  return null;
}
function partShape(w) {
  if (w.shape === 'capsule') return { shape: 'cylinder', r: w.r, h: w.h, pos: w.pos, rot: w.rot };
  if (w.shape === 'sphere') return { shape: 'sphere', r: w.r, pos: w.pos, rot: w.rot };
  return { shape: 'box', hx: w.hx, hy: w.hy, hz: w.hz, pos: w.pos, rot: w.rot };
}
function capsuleShape(s) {
  const mid = v3.lerp([0, 0, 0], s.a, s.b, 0.5);
  const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], s.b, s.a));
  return { shape: 'cylinder', r: s.r, h: v3.dist(s.a, s.b) / 2, pos: mid, rot: quat.fromTo([0, 0, 0, 1], [0, 0, 1], dir) };
}

function closestPoint(box, p) {
  const inv = quat.conjugate([0, 0, 0, 1], box.rot || [0, 0, 0, 1]);
  const l = quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], p, box.pos));
  const c = [clamp(l[0], -box.hx, box.hx), clamp(l[1], -box.hy, box.hy), clamp(l[2], -box.hz, box.hz)];
  return v3.add([0, 0, 0], box.pos, quat.rotate([0, 0, 0], box.rot || [0, 0, 0, 1], c));
}

function compose(a, b) {
  return { pos: v3.add([0, 0, 0], a.pos, quat.rotate([0, 0, 0], a.rot, b.pos)), rot: quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], a.rot, b.rot)) };
}
function inverse(a) {
  const ir = quat.conjugate([0, 0, 0, 1], a.rot);
  return { pos: quat.rotate([0, 0, 0], ir, v3.negate([0, 0, 0], a.pos)), rot: ir };
}

export class Interaction {
  constructor(hands, world, { strength = 1 } = {}) {
    this.hands = hands;
    this.rig = hands.rig;
    this.world = world;
    this.strength = strength;
    this.hold = { left: null, right: null };
    this.intent = { left: null, right: null };
    this.scratch = new Skeleton();
    this.touching = new Set();
    this.touchNow = new Set();
    this.track = new Map(); // body id -> { pos, rot, vel, ang, acc }
    this.slipCount = { left: 0, right: 0 };
    this.loosen = { left: null, right: null };
    this.pendingOpen = { left: null, right: null };
    this.pendingRelease = { left: null, right: null };
    // A hand backing out from under a body it just set down, and the move it
    // was asked for meanwhile (made once it is out).
    this.leaving = { left: null, right: null };
    this.pendingMove = { left: null, right: null };
    this.unignore = [];
    this.wayIn = { left: null, right: null };
    this.plans = { left: null, right: null };
    this.via = { left: null, right: null };
    this.objectLed = new Map();
    this.wayInPose = { left: null, right: null };
    this.log = []; // per frame audit rows for checks
    // Static surfaces near each hand, for the rig's environment guard:
    // fingers rest on a table or a panel instead of passing into it.
    this.rig.environment = (side) => this.guardShapes(side);
    world.onContact((e) => {
      const target = e.body ? `b${e.body.id}` : `p${e.prop.id}`;
      const key = `${e.hand}:${e.digit}:${e.segment}:${target}`;
      this.touchNow.add(key);
      if (!this.touching.has(key)) this.hands.emit('contact', { hand: e.hand, digit: e.digit, segment: e.segment, object: e.body || e.prop, point: e.point });
    });
  }

  guardShapes(side) {
    const wr = this.rig.skel.joint(side, 'wrist').worldPos;
    const rec = this.hold[side];
    const out = [];
    // What the hand holds: while the fingers close on it, none of them may
    // pass into it (they stop at its surface, a pad squish allowed).
    const att = this.rig.hands[side].attached;
    if (att) {
      const held = this.rig.attachedObject(side);
      out.push({ distance: (a, b, r) => capsuleObjectDistance(held, a, b, r, 8) + 0.0005 });
    }
    // A body just let go of: the same.
    for (const b of this.world.bodies) {
      if (!b.letGo || b.letGo.hand !== side || this.world.time >= b.letGo.until) continue;
      for (const shape of [b.graspShape(), ...b.parts.map((pt) => partShape(b.partWorld(pt)))]) out.push({ distance: (a, c, r) => capsuleObjectDistance(shape, a, c, r, 8) + 0.0003 });
    }
    // A prop just let go of: the opening fingers come off it, not through it.
    for (const pr of this.world.props) {
      if (!pr.letGo || pr.letGo.hand !== side || this.world.time >= pr.letGo.until) continue;
      for (const part of pr.parts) {
        if (part.collide === false) continue;
        const shape = partShape(pr.partWorld(part));
        out.push({ distance: (a, b, r) => capsuleObjectDistance(shape, a, b, r, 8) + 0.0003 });
      }
    }
    for (const s of this.world.statics) {
      if (rec && rec.kind === 'fixed' && rec.fixed === s) continue;
      if (s.shape === 'box') {
        if (v3.dist(closestPoint(s, wr), wr) > 0.25) continue;
        const shape = { shape: 'box', hx: s.hx, hy: s.hy, hz: s.hz, pos: s.pos, rot: s.rot || [0, 0, 0, 1] };
        out.push({ distance: (a, b, r) => capsuleObjectDistance(shape, a, b, r, 8) });
      } else if (s.shape === 'capsule') {
        if (pointSegmentDistance(wr, s.a, s.b).d > 0.25) continue;
        out.push({ distance: (a, b, r) => segmentDistance(a, b, s.a, s.b).d - r - s.r });
      }
    }
    return out;
  }

  heldBody(side) { const h = this.hold[side]; return h && h.kind === 'body' ? h.body : null; }
  holding(side) { return this.hold[side]; }
  attachedCount() { return SIDES.filter((s) => this.hold[s]).length; }

  // Where the wrist must be for `grip` to land on `target` as it lies now.
  // hint: preferred hand rotation (fingers and palm); at: grip point in the
  // object's frame (a cylinder gripped off centre); approach: metres to stop
  // short along the palm normal.
  // A plan source (this.planSource, set by whoever runs a scripted
  // sequence) can hand back the result of a costly solve it recorded from an
  // identical earlier run of the same sequence: the solve is skipped and the
  // result is the same to the last bit. It answers in call order, and only
  // when the kind and the inputs' fingerprint match; with none set, or no
  // answer, the solve runs here (and a recording source keeps the result).
  cached(kind, fp, compute) {
    const src = this.planSource;
    if (!src) return compute();
    const hit = src.take(kind, fp);
    if (hit !== undefined) return hit;
    const v = compute();
    src.put(kind, fp, v);
    return v;
  }

  reachPose(side, target, grip, opts = {}) {
    if (!this.planSource) return this.solveReachPose(side, target, grip, opts);
    const { hint = null, at = [0, 0, 0], avoid = true } = opts;
    const obj = targetShape(target);
    // The object in the answer is the live one, as a fresh solve returns it.
    const got = this.cached('reachPose', planFingerprint(side, grip, obj, hint, at, avoid), () => {
      const pose = this.solveReachPose(side, target, grip, opts);
      return { pos: pose.pos.slice(), rot: pose.rot.slice(), pole: pose.pole ? pose.pole.slice() : null };
    });
    const pose = { pos: got.pos.slice(), rot: got.rot.slice(), obj };
    if (got.pole) pose.pole = got.pole.slice();
    return pose;
  }

  // The rig's pre-shape for a grip, through the plan source.
  preShape(side, obj, grip, env, open) {
    return this.cached('preShape', `${side}|${grip}|${open}|${[obj.pos, obj.rot].flat().join(',')}|${env.length}`, () => this.rig.preShapePose(side, obj, grip, env, open));
  }

  solveReachPose(side, target, grip, { hint = null, at = [0, 0, 0], avoid = true } = {}) {
    const obj = targetShape(target);
    if (!obj) throw new Error('reach: unknown target');
    const sk = this.scratch;
    sk.reset();
    preShape(sk, side, obj, grip);
    const placed = placeObject(sk, side, obj, grip);
    const L = attachToHand(sk, side, placed); // object in the wrist frame when gripped
    // The point taken, fixed on the object whichever of its symmetric turns
    // the hand takes it by (a rung held left of centre stays left of centre).
    const gripPoint = v3.add([0, 0, 0], obj.pos, quat.rotate([0, 0, 0], obj.rot, at));
    const centreInWrist = L.pos;
    const want = hint || this.rig.skel.joint(side, 'wrist').worldRot;
    const poseFor = (h) => {
      let W;
      if (obj.shape === 'sphere') {
        W = h.slice();
      } else if (grip === 'press' && obj.shape === 'box') {
        // A flat hand on a face may turn freely about the palm normal: swing
        // the hinted palm onto the nearest face and keep the hinted turn.
        const palm = quat.rotate([0, 0, 0], h, [0, -1, 0]);
        const inv = quat.conjugate([0, 0, 0, 1], obj.rot);
        const pl = quat.rotate([0, 0, 0], inv, palm);
        const ax = [Math.abs(pl[0]), Math.abs(pl[1]), Math.abs(pl[2])];
        const i = ax[0] > ax[1] && ax[0] > ax[2] ? 0 : ax[1] > ax[2] ? 1 : 2;
        const n = [0, 0, 0];
        n[i] = Math.sign(pl[i]) || 1;
        // The palm faces into the object: toward the face's inward normal.
        const faceIn = quat.rotate([0, 0, 0], obj.rot, n);
        W = quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], quat.fromTo([0, 0, 0, 1], palm, faceIn), h));
      } else {
        // The object's own symmetry leaves the hand free to roll about a
        // cylinder's axis (and flip end for end), or to take a box by any of
        // its faces' symmetric turns; take the one nearest the hint.
        let best = null;
        const flips = [[0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], [1, 0, 0], Math.PI)];
        // A box's quarter turn about Z is a symmetry only when it is square across.
        const rolls = obj.shape === 'cylinder' ? 72 : Math.abs((obj.hx || 0) - (obj.hy || 0)) < 1e-6 ? 4 : 2;
        for (const f of flips) {
          for (let i = 0; i < rolls; i++) {
            const roll = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], (i / rolls) * 2 * Math.PI);
            const objRot = quat.multiply([0, 0, 0, 1], obj.rot, quat.multiply([0, 0, 0, 1], f, roll));
            const cand = quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], objRot, quat.conjugate([0, 0, 0, 1], L.rot)));
            const d = quat.angleBetween(cand, h);
            if (!best || d < best.d) best = { d, W: cand };
          }
        }
        W = best.W;
      }
      // A box taken by another of its faces sits deeper or shallower in the
      // palm: correct the placement for the half extent along the palm normal.
      let centre = centreInWrist;
      if (obj.shape === 'box' && grip === 'press') {
        const n = quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], obj.rot), quat.rotate([0, 0, 0], W, [0, 1, 0]));
        const ax = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
        const i = ax[0] > ax[1] && ax[0] > ax[2] ? 0 : ax[1] > ax[2] ? 1 : 2;
        const half = [obj.hx, obj.hy, obj.hz][i];
        centre = [centreInWrist[0], centreInWrist[1] - (half - obj.hy), centreInWrist[2]];
      }
      return { pos: v3.sub([0, 0, 0], gripPoint, quat.rotate([0, 0, 0], W, centre)), rot: W, obj };
    };
    const first = poseFor(want);
    if (!avoid) return first;
    // The whole hand, closed on the object, must stay clear of the table and
    // the neighbours; if the hinted turn does not, try the nearby turns
    // (tilting the fingers down, rolling, swinging) and keep the one that
    // clears with the full grip and strays least from the hint.
    const env = this.environment(obj, target);
    if (!env.length) return first;
    const score = (pose) => this.gripScore(side, obj, grip, pose, env, want);
    let best = { pose: first, ...score(first) };
    if (best.clear) return best.pose;
    const axX = quat.rotate([0, 0, 0], want, [1, 0, 0]);
    const axZ = quat.rotate([0, 0, 0], want, [0, 0, 1]);
    const axY = quat.rotate([0, 0, 0], want, [0, 1, 0]);
    const turn = (q, axis, degs) => quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], axis, (degs * Math.PI) / 180), q));
    const hints = [];
    for (const pitch of [-20, 20, 40, -40, 60]) for (const roll of [0, -25, 25]) for (const yaw of [0, -25, 25]) hints.push(turn(turn(turn(want, axX, pitch), axZ, roll), axY, yaw));
    // A cylinder can be taken from any side round its axis.
    if (obj.shape === 'cylinder') {
      const axis = quat.rotate([0, 0, 0], obj.rot, [0, 0, 1]);
      for (const a of [-60, -40, -20, 20, 40, 60]) for (const pitch of [0, 20, -20]) hints.push(turn(turn(want, axis, a), axX, pitch));
    }
    for (const h of hints) {
      const pose = poseFor(h);
      const sc = score(pose);
      if (sc.total < best.total) best = { pose, ...sc };
      if (best.clear && best.total < 5) break;
    }
    return best.pose;
  }

  // Surroundings carried into the scratch hand's frame for a wrist pose.
  toScratch(side, pose, envW) {
    const sk = this.scratch;
    sk.reset();
    const restWrist = { pos: sk.joint(side, 'wrist').worldPos.slice(), rot: sk.joint(side, 'wrist').worldRot.slice() };
    const T = compose(restWrist, inverse({ pos: pose.pos, rot: pose.rot }));
    return envW.map((e) => ({ ...e, ...compose(T, { pos: e.pos, rot: e.rot || [0, 0, 0, 1] }) }));
  }

  // Deepest the hand, held in `handPose`, reaches into the surroundings or
  // the object anywhere on the straight line from pose + dir * dist in to pose.
  pathCost(side, pose, handPose, envW, dir, dist) {
    return this.cached('pathCost', `${side}|${[pose.pos, pose.rot, dir].flat().join(',')}|${dist}|${envW.length}`, () => this.solvePathCost(side, pose, handPose, envW, dir, dist));
  }

  solvePathCost(side, pose, handPose, envW, dir, dist) {
    const sk = this.scratch;
    let worst = 0;
    const obj = { ...pose.obj };
    for (let i = 0; i <= 4; i++) {
      const s = (dist * i) / 4;
      const p = { pos: v3.addScaled([0, 0, 0], pose.pos, dir, s), rot: pose.rot };
      const shapes = this.toScratch(side, p, [...envW, obj]);
      applyChannels(sk, side, poseChannels(this.rig.resolvePose(side, handPose)));
      sk.update();
      for (const c of handCapsules(sk, side)) for (const e of shapes) worst = Math.max(worst, -capsuleObjectDistance(e, c.a, c.b, c.r, 6));
    }
    return worst;
  }

  // Deepest the hand reaches into the surroundings moving in a straight line
  // (turning as it goes) from wrist pose a to b, its fingers changing from
  // shape sa to sb on the way.
  transitCost(side, a, b, sa, sb, envW) {
    return this.cached('transitCost', `${side}|${[a.pos, a.rot, b.pos, b.rot].flat().join(',')}|${envW.length}`, () => this.solveTransitCost(side, a, b, sa, sb, envW));
  }

  solveTransitCost(side, a, b, sa, sb, envW) {
    const sk = this.scratch;
    let worst = 0;
    // Position and turn travel on their own springs, so the turn may be
    // ahead of or behind the position anywhere along the way; and the
    // fingers change shape on theirs: either shape may be the one the hand
    // has at any point.
    const angle = quat.angleBetween(a.rot, b.rot);
    const lags = angle > 0.2 ? [-0.25, 0, 0.25] : [0];
    for (let i = 1; i <= 6; i++) {
      const u = i / 6;
      for (const lag of lags) {
        const v = clamp(u + lag, 0, 1);
        if (lag !== 0 && (v === 0 || v === 1) && (u === 1)) continue;
        const p = { pos: v3.lerp([0, 0, 0], a.pos, b.pos, u), rot: quat.slerp([0, 0, 0, 1], a.rot, b.rot, v) };
        const shapes = this.toScratch(side, p, envW);
        for (const shape of sa === sb ? [sa] : [sa, sb]) {
          applyChannels(sk, side, poseChannels(this.rig.resolvePose(side, shape)));
          sk.update();
          // A margin on the way; none at the end, which is meant to be close.
          const margin = i === 6 ? 0 : 0.004;
          for (const c of handCapsules(sk, side)) for (const e of shapes) worst = Math.max(worst, -capsuleObjectDistance(e, c.a, c.b, c.r + margin, 6));
        }
      }
    }
    return worst;
  }

  // Can the arm actually take this wrist pose? Solve it on a scratch arm
  // with the body where it is: the wrist's reach and its limits (flexion,
  // deviation, the forearm's turn) decide. The elbow can sit low and in, low
  // and out, or raised out to the side: raising it turns the forearm for the
  // wrist, the way a shoulder helps a forearm at the end of its pronation.
  // Returns the elbow (pole) that does best, its errors and the room left.
  armFit(side, pose) {
    const arm = this.armScratch || (this.armScratch = new Skeleton());
    // The arm solve starts from the arm's current angles, so each try starts
    // from rest: a previous candidate's twist must not steer this one.
    const fresh = () => {
      arm.reset();
      for (const s of ['left', 'right']) v3.copy(arm.joint(s, 'shoulder').localPos, this.rig.body);
      arm.update();
    };
    const sg = side === 'right' ? 1 : -1;
    const b0 = this.rig.body;
    const poles = [this.rig.arms[side].target.pole, [b0[0] + 0.55 * sg, b0[1] - 0.75, b0[2] + 0.05], [b0[0] + 0.8 * sg, b0[1] - 0.35, b0[2] + 0.1], [b0[0] + 0.7 * sg, b0[1] + 0.05, b0[2] + 0.2], [b0[0] + 0.2 * sg, b0[1] - 0.8, b0[2] + 0.2]];
    let bestArm = null;
    for (const pole of poles) {
      fresh();
      solveArm(arm, side, pose.pos, pose.rot, pole);
      const wr = arm.joint(side, 'wrist');
      const posErr = v3.dist(wr.worldPos, pose.pos);
      const rotErr = quat.angleBetween(wr.worldRot, pose.rot);
      // Comfort: a wrist or forearm near the end of its range has no room to
      // follow the object once it moves, so poses with room are preferred.
      let room = Infinity;
      for (const n of ['wrist', 'forearm']) {
        const j = arm.joint(side, n);
        const m = arm.measureChannels(j);
        for (const ax of ['flex', 'abd', 'twist']) {
          const L = j.limits[ax];
          if (L[0] === 0 && L[1] === 0) continue;
          room = Math.min(room, (Math.min(L[1] - m[ax], m[ax] - L[0]) * 180) / Math.PI);
        }
      }
      // Forearm rotation: the whole pronation against its range, however the
      // twist bones share it. It was read off forearm-twist-1 alone, a third
      // of the rotation, so its room counted a third; that weighting is kept
      // (FOREARM_ROOM_WEIGHT) now that no single bone carries a third.
      const pron = FOREARM_TWIST.reduce((acc, t) => acc + arm.measureChannels(arm.joint(side, t.name)).twist, 0);
      const PR = LIMITS_DEG.forearm.twist;
      room = Math.min(room, FOREARM_ROOM_WEIGHT * Math.min(PR[1] - (pron * 180) / Math.PI, (pron * 180) / Math.PI - PR[0]));
      const bad = (posErr > 0.002 ? 1 + posErr : 0) + (rotErr > 0.035 ? 1 + rotErr : 0);
      const key = bad * 1000 - Math.min(room, 20);
      if (!bestArm || key < bestArm.key) bestArm = { key, posErr, rotErr, room, pole };
    }
    return bestArm;
  }

  // How well a grip pose works: the closed hand's deepest reach into the
  // surroundings, digits of the grip that found no contact, the distance
  // from the shoulder and the turn away from the hint.
  gripScore(side, obj, grip, pose, env, want) {
    const sk = this.scratch;
    sk.reset();
    const restWrist = { pos: sk.joint(side, 'wrist').worldPos.slice(), rot: sk.joint(side, 'wrist').worldRot.slice() };
    const T = compose(restWrist, inverse({ pos: pose.pos, rot: pose.rot }));
    const envT = env.map((e) => ({ ...e, ...compose(T, { pos: e.pos, rot: e.rot || [0, 0, 0, 1] }) }));
    const objT = { ...obj, ...compose(T, { pos: obj.pos, rot: obj.rot }) };
    const pre = preShape(sk, side, objT, grip);
    const res = solveGrasp(sk, side, objT, grip, pre.pose, envT);
    let pen = 0;
    let where = '';
    for (const c of handCapsules(sk, side)) {
      for (const e of envT) { const d = -capsuleObjectDistance(e, c.a, c.b, c.r, 6); if (d > pen) { pen = d; where = `${c.name} into ${e.shape}`; } }
      // Nothing may pass into the object itself beyond a pad's squish, and a
      // digit that takes no part in the grip keeps 3 mm off it, or it would
      // nudge a light object off its perch on the way in.
      const spare = !GRIPS[grip].digits.includes(c.digit) && !(GRIPS[grip].support || []).includes(c.digit);
      const d = -capsuleObjectDistance(objT, c.a, c.b, c.r, 6) - (spare ? -0.0024 : 0.0006);
      if (d > pen) { pen = d; where = `${c.name} into the object`; }
    }
    // A grip that arrives in its own approach shape (a hook comes in with
    // its fingers flat) must be able to arrive: that shape, at this pose,
    // may not pass into the object or the surroundings either.
    const arrive = GRIPS[grip].approachPose;
    if (arrive) {
      sk.reset();
      applyChannels(sk, side, poseChannels(this.rig.resolvePose(side, arrive)));
      sk.update();
      for (const c of handCapsules(sk, side)) {
        for (const e of [...envT, objT]) {
          const d = -capsuleObjectDistance(e, c.a, c.b, c.r, 6);
          if (d > pen) { pen = d; where = `${c.name} into ${e === objT ? 'the object' : e.shape} on arrival`; }
        }
      }
    }
    const need = GRIPS[grip].digits;
    const got = new Set(res.contacts.map((c) => c.digit));
    const missing = need.filter((d) => !got.has(d)).length;
    const { posErr, rotErr, room, pole } = this.armFit(side, pose);
    pose.pole = pole;
    const far = (posErr > 0.002 ? 0.05 + posErr : 0) + (rotErr > 0.035 ? 0.05 + rotErr * 0.1 : 0);
    const turn = quat.angleBetween(pose.rot, want);
    const cramped = Math.max(0, 15 - room);
    const clear = pen <= 0.0006 && missing <= (need.length > 3 ? 1 : 0) && far === 0 && room >= 12;
    // A pose the arm cannot take is out, whatever else it has going for it.
    // Passing through something is worse than any shortfall in the grip.
    const total = (far > 0 ? 1e6 + far * 1e4 : 0) + 2e5 * Math.max(0, pen - 0.0006) + 1000 * missing + turn * 10 + cramped * 4;
    return { clear, total, pen, missing, where, contacts: res.contacts.length, posErr, rotErr, room };
  }

  // Move toward a grasp: pre-shape the hand for the object and aim the wrist
  // `approach` metres back along the palm normal from the grip pose.
  // approach: metres to stop short of the grip pose, backing off along
  // `from` (a world direction, default out of the palm). open: how far the
  // pre-shape opens past the contact pose (1 just clears it; the default 2.5
  // lets the hand arrive without its fingers sweeping through the object;
  // false keeps the fingers as they are).
  reach(side, target, grip, { hint = null, at = [0, 0, 0], approach = 0, from = null, pole = null, snap = false, open = 2.5 } = {}) {
    // A new aim replaces whatever the last letting go still had queued,
    // moves asked for while it backed out included.
    this.pendingMove[side] = null;
    this.pendingOpen[side] = null;
    this.leaving[side] = null;
    // Closing in on the target planned a moment ago keeps that plan (the
    // search could otherwise settle on another turn mid reach) unless the
    // target has moved since.
    const now = targetShape(target);
    const prev = this.plans[side];
    const moved = prev ? v3.sub([0, 0, 0], now.pos, prev.at) : null;
    const pose = open === false && prev && prev.target === target && prev.grip === grip && v3.len(moved) < 0.02
      ? { ...prev.pose, pos: v3.add([0, 0, 0], prev.pose.pos, moved), obj: { ...prev.pose.obj, pos: now.pos.slice(), rot: now.rot.slice() } }
      : this.reachPose(side, target, grip, { hint, at });
    this.plans[side] = { target, grip, at: now.pos.slice(), pose };
    const envW = this.environment(pose.obj, target);
    let handPose = open === false ? null : (GRIPS[grip].approachPose || this.preShape(side, { ...pose.obj }, grip, this.toScratch(side, pose, envW), open));
    // The opened hand must fit round the object where the grip will be: if
    // a digit would already be inside it, open wider.
    if (handPose && !GRIPS[grip].approachPose) {
      const withObj = [...envW, { ...pose.obj }];
      for (const wide of [open * 1.6, open * 2.4]) {
        if (this.pathCost(side, pose, handPose, withObj, [0, 1, 0], 0) <= 0.0006) break;
        handPose = this.preShape(side, { ...pose.obj }, grip, this.toScratch(side, pose, envW), wide);
      }
    }
    // The straight line in to the grip pose must not sweep the hand through
    // anything: back off along whichever direction keeps that path clearest
    // (out of the palm, straight up, toward the body, back along the fingers).
    let back = from ? v3.normalize([0, 0, 0], from) : null;
    if (!back && approach > 0 && handPose) {
      const palm = quat.rotate([0, 0, 0], pose.rot, [0, -1, 0]);
      const fingers = quat.rotate([0, 0, 0], pose.rot, [0, 0, -1]);
      const cands = [v3.negate([0, 0, 0], palm), [0, 1, 0], [0, 0, 1], v3.negate([0, 0, 0], fingers), v3.normalize([0, 0, 0], v3.sub([0, 0, 0], [0, 1, 0], palm)), v3.normalize([0, 0, 0], [0, 1, 1])];
      // The way to the start of that line counts too (a hand reaching
      // round a hanging rope should not have to pass through it first).
      const wr = this.rig.skel.joint(side, 'wrist');
      const here = { pos: wr.worldPos.slice(), rot: wr.worldRot.slice() };
      const envAll = [...envW, { ...pose.obj }];
      const shapeNow = this.rig.hands[side].base;
      let best = null;
      // No clear way in with the hand this open: open it wider (a fist round
      // a thin shaft comes in with the fingers well open).
      const shapes = GRIPS[grip].approachPose ? [handPose] : [handPose, ...[1.6, 2.4, 3.6].map((k) => () => this.preShape(side, { ...pose.obj }, grip, this.toScratch(side, pose, envW), open * k))];
      for (let si = 0; si < shapes.length && !(best && best.cost <= 0.0006); si++) {
        const hp = typeof shapes[si] === 'function' ? shapes[si]() : shapes[si];
        for (const d of cands) {
          const inCost = this.pathCost(side, pose, hp, envW, d, approach);
          const start = { pos: v3.addScaled([0, 0, 0], pose.pos, d, approach), rot: pose.rot };
          const cost = Math.max(inCost, snap ? 0 : this.transitCost(side, here, start, shapeNow, hp, envAll) * 0.5);
          if (!best || cost < best.cost - 1e-5) best = { cost, d, hp };
        }
      }
      back = best.d;
      handPose = best.hp;
    }
    if (!back) back = v3.negate([0, 0, 0], quat.rotate([0, 0, 0], pose.rot, [0, -1, 0]));
    // Remember the way in, in the hand's own frame: letting go later backs
    // the hand out along it.
    this.wayIn[side] = quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], pose.rot), back);
    if (handPose) this.wayInPose[side] = handPose;
    const pos = v3.addScaled([0, 0, 0], pose.pos, back, approach);
    // The pre-shape is solved on a scratch hand at rest, so the surroundings
    // are carried into that hand's frame: fingers open no further than the
    // table or a neighbour allows.
    const shapeBefore = this.rig.hands[side].base;
    if (handPose) this.rig.setPose(side, handPose);
    this.rig.setBusy(side, true);
    const t = { pos, rot: pose.rot };
    if (pole || pose.pole) t.pole = pole || pose.pole;
    // On the way there the hand must not sweep through the target or its
    // neighbours: if the straight line would, it goes round them. Closing in
    // while still on the way round finishes the way round first.
    if (open === false && this.via[side] && !snap) {
      const v = this.via[side];
      v.legs.push({ pos: v.final.pos.slice(), rot: v.final.rot });
      v.final = t;
      return { pos, rot: pose.rot, grip: pose };
    }
    this.via[side] = null;
    if (!snap && open !== false) {
      const wr = this.rig.skel.joint(side, 'wrist');
      const from = { pos: wr.worldPos.slice(), rot: wr.worldRot.slice() };
      if (this.route(side, from, t, shapeBefore, handPose || shapeBefore, [...envW, { ...pose.obj }])) return { pos, rot: pose.rot, grip: pose };
    }
    this.rig.setArmTarget(side, t, { snap });
    return { pos, rot: pose.rot, grip: pose };
  }

  // Plan a way from wrist pose `from` to `t` that keeps the hand (shape sa
  // changing to sb) out of `env`: straight when that is clear, else the
  // clearest of a few routes over, round the side of or back toward the
  // body past what is in the way. Sets the arm going and returns true when
  // it took a detour.
  route(side, from, t, sa, sb, env) {
    const direct = this.transitCost(side, from, t, sa, sb, env);
    if (direct <= 0.0005) return false;
    const sg = side === 'right' ? 1 : -1;
    const f = from.pos;
    const g = t.pos;
    const top = Math.max(f[1], g[1]) + 0.08;
    // Never so far back the wrist comes into the shoulder (the arm folds
    // up and its solve turns over).
    const nearest = this.rig.body[2] - 0.17;
    const back = Math.min(Math.max(f[2], g[2]) + 0.1, nearest);
    const farBack = Math.min(Math.max(f[2], g[2]) + 0.18, nearest);
    const routes = [
      [[g[0], top, g[2]]],
      [[f[0], top, f[2]], [g[0], top, g[2]]],
      [[f[0], f[1], back], [g[0], g[1], back]],
      [[f[0], top, back], [g[0], top, g[2]]],
      [[g[0] + 0.1 * sg, g[1], g[2]]],
      [[f[0] + 0.1 * sg, top, f[2]], [g[0] + 0.1 * sg, top, g[2]]],
      // Up close to the body, then out over the top (a bar overhead).
      [[f[0], top, farBack], [g[0], top, g[2]]],
      // Well back toward the body, past a bar in between (hand over hand).
      [[f[0], f[1], farBack], [g[0], g[1], farBack]],
      [[f[0], f[1] - 0.04, farBack], [g[0], g[1] + 0.04, farBack]],
      // Across at the depth the hand is at, then straight out or in to the
      // goal (or the other way round): the way past something standing just
      // beside the goal (a knob by the lever the hand let go of). Last, so a
      // clear way above is still taken first.
      [[g[0], g[1], f[2]]],
      [[f[0], f[1], g[2]]],
    ];
    let best = { cost: direct, pts: null };
    const plans = [
      ...routes.map((pts) => pts.map((p, k) => ({ pos: p, rot: quat.slerp([0, 0, 0, 1], from.rot, t.rot, (k + 1) / (pts.length + 1)) }))),
      // Turn the hand to its final orientation first, where it is (or a
      // little back toward the body), then go straight or over.
      [{ pos: f, rot: t.rot }],
      [{ pos: [f[0], f[1], back], rot: t.rot }],
      [{ pos: [f[0], f[1], back], rot: t.rot }, { pos: [g[0], g[1], back], rot: t.rot }],
      [{ pos: [f[0], top, f[2]], rot: t.rot }, { pos: [g[0], top, g[2]], rot: t.rot }],
    ];
    for (const legs of plans) {
      const poses = [from, ...legs, t];
      let cost = 0;
      for (let k = 0; k + 1 < poses.length && cost < best.cost; k++) cost = Math.max(cost, this.transitCost(side, poses[k], poses[k + 1], k === 0 ? sa : sb, sb, env));
      if (cost < best.cost - 1e-5) best = { cost, pts: poses.slice(1, -1) };
      if (best.cost <= 0.0005) break;
    }
    if (!best.pts) return false;
    this.via[side] = { final: t, legs: best.pts };
    this.rig.setArmTarget(side, { ...t, pos: best.pts[0].pos, rot: best.pts[0].rot });
    return true;
  }

  // Move a free hand to a wrist pose along a way that does not sweep it
  // through anything near the path: straight if clear, else by the clearest
  // of a few detours (over, back toward the body, out to the side).
  moveTo(side, target) {
    if (this.leaving[side]) { this.leaving[side].then.push(target); return this; }
    this.pendingMove[side] = null;
    const wr = this.rig.skel.joint(side, 'wrist');
    const from = { pos: wr.worldPos.slice(), rot: wr.worldRot.slice() };
    const aim = this.rig.arms[side].target;
    const t = { pos: target.pos || aim.pos, rot: target.rot || aim.rot, ...(target.pole ? { pole: target.pole } : {}) };
    this.via[side] = null;
    const mid = v3.lerp([0, 0, 0], from.pos, t.pos, 0.5);
    const shape = this.rig.hands[side].base;
    if (!this.hold[side] && this.route(side, from, t, shape, shape, this.environment({ pos: mid }, null))) return this;
    this.rig.setArmTarget(side, t);
    return this;
  }

  // opts.drag: the body stays on whatever it rests on and the hand pulls it
  // along by its grip (a crate dragged by its handle) instead of carrying it.
  grasp(side, target, grip, { drag = false } = {}) {
    if (this.hold[side]) this.release(side);
    this.via[side] = null;
    const obj = targetShape(target);
    const att = this.rig.graspWhere(side, { ...obj, pos: obj.pos.slice(), rot: obj.rot.slice() }, grip, { env: this.environment(obj, target), cache: (fp, compute) => this.cached('grasp', fp, compute) });
    // Nothing within the fingers' reach: the grasp closes on air and holds nothing.
    if (!att.contacts.some((c) => !c.via && c.depth > -0.002)) {
      this.rig.release(side);
      this.hands.emit('released', { hand: side, object: null, velocity: [0, 0, 0], missed: true });
      return null;
    }
    const wr = this.rig.skel.joint(side, 'wrist');
    const wrist = { pos: wr.worldPos.slice(), rot: wr.worldRot.slice() };
    const arm = this.rig.arms[side];
    let rec;
    if (target instanceof Body || (target && target.body instanceof Body)) {
      const b = target instanceof Body ? target : target.body;
      if (drag) {
        b.heldBy = [side];
        b.wake();
        // Two tether points along the grip's axis: the body can turn about
        // the handle but not away from the fingers.
        const axisLocal = obj.shape === 'cylinder' ? quat.rotate([0, 0, 0], quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], b.rot), obj.rot), [0, 0, 1]) : [1, 0, 0];
        const centreLocal = quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], b.rot), v3.sub([0, 0, 0], obj.pos, b.pos));
        const span = obj.shape === 'cylinder' ? Math.min(obj.h, 0.04) : 0.03;
        const tethers = [-1, 1].map((k) => {
          const local = v3.addScaled([0, 0, 0], centreLocal, axisLocal, k * span);
          const wp = v3.add([0, 0, 0], b.pos, quat.rotate([0, 0, 0], b.rot, local));
          const inWrist = quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], wrist.rot), v3.sub([0, 0, 0], wp, wrist.pos));
          return { body: b, local, inWrist, axes: [[1, 0, 0], [0, 0, 1]], strength: (GRIPS[grip].capacity || 100) * this.strength, acc: [0, 0, 0], target: { pos: wp, vel: [0, 0, 0] } };
        });
        this.world.tethers.push(...tethers);
        rec = { kind: 'body', body: b, grip, leader: true, part: (target && target.part) || null, tethers };
        // The hand intends; the body, held back by what it rests on, moves as
        // far as the pull gets it, and the hand stays on its handle.
        this.intent[side] = { pos: wrist.pos.map((v) => new Spring(14, v, 1.0)), rot: new RotSpring(14, wrist.rot), wristToGrip: null };
        rec.wristInBody = compose(inverse({ pos: b.pos, rot: b.rot }), wrist);
        arm.follow = () => compose({ pos: b.pos, rot: b.rot }, rec.wristInBody);
      } else if (!b.heldBy || b.heldBy.length === 0) {
        b.heldBy = [side];
        b.kinematic = true;
        b.wake();
        rec = { kind: 'body', body: b, grip, leader: true, part: (target && target.part) || null };
        // The rig carries what the fingers closed on; when that is a part of
        // the body, the body sits at a fixed offset from it.
        if (rec.part) rec.bodyInPart = inverse({ pos: rec.part.pos, rot: rec.part.rot });
        this.track.set(b.id, { pos: b.pos.slice(), rot: b.rot.slice(), vel: b.vel.slice(), ang: b.ang.slice(), acc: [0, 0, 0] });
      } else if (this.objectLed.has(b.id)) {
        b.heldBy.push(side);
        const wristInBody = compose(inverse({ pos: b.pos, rot: b.rot }), wrist);
        rec = { kind: 'body', body: b, grip, leader: false, wristInBody };
        arm.follow = () => compose({ pos: b.pos, rot: b.rot }, wristInBody);
      } else {
        // Second hand on a held body: it follows the body exactly.
        b.heldBy.push(side);
        const bodyPose = { pos: b.pos.slice(), rot: b.rot.slice() };
        const wristInBody = compose(inverse(bodyPose), wrist);
        rec = { kind: 'body', body: b, grip, leader: false, wristInBody };
        arm.follow = () => compose({ pos: b.pos, rot: b.rot }, wristInBody);
      }
    } else if (target && target.prop) {
      const { prop, part } = target;
      const pw = prop.partWorld(part);
      const wristInPart = compose(inverse({ pos: pw.pos, rot: pw.rot }), wrist);
      // Where the grip point is on the part, for projecting the intent onto the prop's one degree of freedom.
      const gripInPart = compose(inverse({ pos: pw.pos, rot: pw.rot }), { pos: obj.pos, rot: obj.rot });
      const partLocal = { pos: part.pos || [0, 0, 0], rot: part.rot || [0, 0, 0, 1] };
      const gripLocal = compose(partLocal, gripInPart); // in the prop frame
      this.intent[side] = { pos: wrist.pos.map((v) => new Spring(14, v, 1.2)), rot: new RotSpring(14, wrist.rot), wristToGrip: compose(inverse(wrist), { pos: obj.pos, rot: obj.rot }) };
      const I = this.intent[side];
      prop.driver = {
        hand: side,
        stiffness: part.stiffness ?? (prop.type === 'hinge' ? 40 : 600),
        damping: part.driveDamping ?? (prop.type === 'hinge' ? 3 : 60),
        strength: (part.strength ?? (prop.type === 'hinge' ? 12 : 90)) * this.strength,
        target: () => {
          const intentWrist = { pos: I.pos.map((s) => s.x), rot: I.rot.q };
          const g = compose(intentWrist, I.wristToGrip);
          const radial = v3.len(v3.reject([0, 0, 0], v3.sub([0, 0, 0], prop.worldPoint(gripLocal.pos, 0), prop.anchor), prop.axis));
          if (prop.type === 'hinge' && radial < 0.015) {
            // A grip on the axis (a knob): the wrist's turn about the axis turns it.
            const rel = quat.multiply([0, 0, 0, 1], g.rot, quat.conjugate([0, 0, 0, 1], prop.worldRot(gripLocal.rot, 0)));
            let q = quat.twistAngle(rel, prop.axis);
            while (q - prop.q > Math.PI) q -= 2 * Math.PI;
            while (q - prop.q < -Math.PI) q += 2 * Math.PI;
            return clamp(q, prop.min, prop.max);
          }
          return prop.project(gripLocal.pos, g.pos);
        },
      };
      rec = { kind: 'prop', prop, part, grip, wristInPart };
      arm.follow = () => compose(prop.partWorld(part), rec.wristInPart);
    } else if (target && target.rope) {
      const rope = target.rope;
      const index = target.index ?? rope.nearestIndex(target.at || obj.pos);
      const pins = [index - 1, index, index + 1].filter((i) => i > 0 && i < rope.n);
      const local = pins.map((i) => quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], wrist.rot), v3.sub([0, 0, 0], rope.points[i], wrist.pos)));
      rec = { kind: 'rope', rope, index, pins, local, grip };
    } else {
      rec = { kind: 'fixed', fixed: target.fixed, grip, wrist };
      arm.follow = () => ({ pos: rec.wrist.pos, rot: rec.wrist.rot });
    }
    this.hold[side] = rec;
    this.loosen[side] = null;
    this.pendingOpen[side] = null;
    this.rig.setBusy(side, true);
    this.hands.emit('grasped', { hand: side, object: target, grip, contacts: att.contacts });
    for (const c of att.contacts) this.hands.emit('contact', { hand: side, object: target, digit: c.digit, segment: c.segment, point: c.point });
    return att;
  }

  // Shapes near a grasp that the fingers must stop against: the surfaces
  // and objects within reach of the hand, as grasp solver shapes.
  environment(obj, target) {
    const out = [];
    const near = (p, r) => v3.dist(p, obj.pos) < 0.3 + r;
    const self = target instanceof Body ? target : (target && target.body) || null;
    for (const s of this.world.statics) {
      if (s.shape === 'box' && near(closestPoint(s, obj.pos), 0)) out.push({ shape: 'box', hx: s.hx, hy: s.hy, hz: s.hz, pos: s.pos, rot: s.rot || [0, 0, 0, 1] });
      else if (s.shape === 'capsule' && !(target && target.fixed === s)) { const c = capsuleShape(s); if (near(c.pos, c.h)) out.push(c); }
    }
    // Props: every part but the one the hand takes.
    for (const pr of this.world.props) {
      for (const part of pr.parts) {
        if (part.collide === false) continue;
        if (target && target.prop === pr && target.part === part) continue;
        const w = pr.partWorld(part);
        if (!near(w.pos, 0.1)) continue;
        out.push(partShape(w));
      }
    }
    // A rope is in the way along its length, except where the hand takes it.
    for (const rope of this.world.ropes) {
      const own = target && target.rope === rope;
      for (let i = 0; i + 1 < rope.points.length; i++) {
        const a = rope.points[i];
        const b = rope.points[i + 1];
        const mid = v3.lerp([0, 0, 0], a, b, 0.5);
        if (!near(mid, 0.05)) continue;
        if (own && v3.dist(mid, obj.pos) < 0.06) continue;
        out.push(capsuleShape({ a, b, r: rope.r }));
      }
    }
    for (const b of this.world.bodies) {
      if (!near(b.pos, 0.1)) continue;
      if (b !== self) { out.push(b.graspShape()); continue; }
      // Taking one part of a body (a strap, a handle): the body itself and
      // its other parts are in the way.
      if (target && target.part) {
        out.push(b.graspShape());
        for (const p of b.parts) if (p !== target.part) out.push(partShape(b.partWorld(p)));
      }
    }
    return out;
  }

  // Where the hand wants a held prop part to go (the wrist pose it intends).
  setIntent(side, target) {
    const I = this.intent[side];
    if (!I) return this.rig.setArmTarget(side, target);
    if (target.pos) I.pos.forEach((s, i) => { s.target = target.pos[i]; });
    if (target.rot) I.rot.target = target.rot.slice();
    return undefined;
  }

  // open: the pose the fingers open to, after `openAfter` seconds (the hand
  // first backs off `withdraw` metres, so the opening fingers never press
  // into what was just set down); a throw opens at once.
  release(side, { velocity = null, slipped = false, open = 'ready', withdraw = 0.02, openAfter = null, thumbFirst = true, keepThumb = null, thumbUnder = false } = {}) {
    const rec = this.hold[side];
    if (!rec) return null;
    // Setting a body down: the thumb comes off first while the fingers still
    // hold it, then the fingers open. A thumb curled under a handle would
    // otherwise lift the end it is under as the hand opens.
    if (thumbFirst && !velocity && !slipped) {
      const off = this.thumbOff(side);
      const thumb = off ? clonePose(this.rig.hands[side].attached.pose).thumb : null;
      if (off === true) {
        this.pendingRelease[side] = { at: this.rig.time + THUMB_LEAD, opts: { open, withdraw, openAfter, thumbFirst: false, keepThumb: thumb } };
        return rec.body || null;
      }
      if (off === 'under') { keepThumb = thumb; thumbUnder = true; }
    }
    const arm = this.rig.arms[side];
    const wr = this.rig.skel.joint(side, 'wrist');
    let vel = [0, 0, 0];
    let object = null;
    // Fingers hooked round a handle open off it without dragging it along.
    // (A dragged body stays on its surface, so letting go of it cannot drop
    // it onto the fingers; a carried one lands on them as they open.)
    if (rec.kind === 'body' && rec.tethers && ['hook', 'powerCylinder'].includes(rec.grip)) rec.body.letGo = { hand: side, until: this.world.time + 0.8 };
    if (rec.kind === 'body' && rec.tethers) {
      this.world.tethers = this.world.tethers.filter((t) => !rec.tethers.includes(t));
      rec.body.heldBy = null;
      rec.body.wake();
      this.intent[side] = null;
      object = rec.body;
    } else if (rec.kind === 'body' && this.objectLed.has(rec.body.id)) {
      const b = rec.body;
      object = b;
      const others = (b.heldBy || []).filter((s) => s !== side);
      b.heldBy = others.length ? others : null;
      if (!others.length) {
        this.objectLed.delete(b.id);
        b.kinematic = false;
        v3.set(b.vel, 0, 0, 0);
        b.wake();
        this.track.delete(b.id);
      }
    } else if (rec.kind === 'body') {
      const b = rec.body;
      object = b;
      const others = (b.heldBy || []).filter((s) => s !== side);
      const tr = this.track.get(b.id);
      if (rec.leader && others.length) {
        // Hand over: the follower becomes the leader where it is.
        const o = others[0];
        this.hold[o].leader = true;
        this.rig.arms[o].follow = null;
        this.rig.hands[o].attached.attachment = attachToHand(this.rig.skel, o, { pos: b.pos, rot: b.rot });
        this.hold[o].part = null;
        this.hold[o].bodyInPart = null;
        b.heldBy = others;
      } else if (!rec.leader) {
        b.heldBy = others;
      } else {
        b.heldBy = null;
        b.kinematic = false;
        // A slipping body does not keep up with the hand that lost it.
        vel = velocity ? velocity.slice() : (tr ? (slipped && tr.prevVel ? tr.prevVel : tr.vel).slice() : [0, 0, 0]);
        // Set down rather than thrown: it stays where it was put, with none
        // of the hand's last small motion (a pebble on a post would roll).
        const placed = !velocity && !slipped && v3.len(vel) < 0.15;
        if (placed) vel = [0, 0, 0];
        v3.copy(b.vel, vel);
        if (tr && !velocity && !placed) v3.copy(b.ang, tr.ang);
        else if (placed) v3.set(b.ang, 0, 0, 0);
        b.wake();
        this.track.delete(b.id);
      }
    } else if (rec.kind === 'prop') {
      rec.prop.driver = null;
      rec.prop.qd = 0;
      rec.prop.letGo = { hand: side, until: this.world.time + 1.4 };
      object = rec.prop;
      this.intent[side] = null;
    } else if (rec.kind === 'rope') {
      for (const i of rec.pins) rec.rope.unpin(i);
      object = rec.rope;
    } else {
      object = rec.fixed;
    }
    if (arm.follow) {
      arm.follow = null;
      arm.set({ pos: wr.worldPos.slice(), rot: wr.worldRot.slice() }, true);
    }

    arm.load = 0;
    this.hold[side] = null;
    if (this.down) this.down[side] = null;
    this.rig.setBusy(side, false);
    // Letting go first eases the grip, each digit opening only as far as it
    // takes to come off the object and never into the surface under it, so
    // the pads leave the object before the hand moves away.
    const att = this.rig.hands[side].attached;
    // Letting go reverses the way in: the fingers open back to the shape the
    // hand arrived with (which cleared the object on the way in), then the
    // hand backs out along the same line. Without a remembered way in, the
    // grip eases just clear of the object.
    let wayPose = !slipped && this.wayInPose[side] && rec.kind !== 'fixed' ? this.wayInPose[side] : null;
    // Where the object now rests (set down on a post, say) the shape the
    // hand arrived with may no longer fit: then the grip only eases.
    const held = object instanceof Body ? object : rec.kind === 'prop' ? { prop: rec.prop, part: rec.part } : null;
    const here = held ? { pos: wr.worldPos.slice(), rot: wr.worldRot.slice(), obj: targetShape(held) } : null;
    const hereEnv = here ? this.environment(here.obj, held) : null;
    // It must fit round the object too, or opening would push into it.
    if (wayPose && here && this.pathCost(side, here, wayPose, held instanceof Body ? [...hereEnv, here.obj] : hereEnv, [0, 1, 0], 0) > 0.0006) wayPose = null;
    // A slip eases the grip too: the pads visibly come off the object as it
    // goes, and a moment later the fingers close on nothing.
    let eased = wayPose || (att && att.pose && !(GRIPS[rec.grip] && GRIPS[rec.grip].approachPose) ? this.easeGrip(side, att) : null);
    if (eased && keepThumb) eased = withThumb(this.rig.resolvePose(side, eased), keepThumb);
    let openLater = null;
    this.rig.release(side);
    if (slipped) this.hands.emit('slipped', { hand: side, object, velocity: vel.slice() });
    this.hands.emit('released', { hand: side, object, velocity: vel.slice(), slipped });
    if (eased) this.rig.setPose(side, eased);
    // Letting go opens the fingers (after a slip they stay put a moment
    // first) and backs the hand off out of the palm's way, so opening never
    // pushes into what was just set down.
    const thrown = Boolean(velocity) || v3.len(vel) > 0.5;
    // A hook (fingers curled round a handle) uncurls before the hand moves.
    const uncurl = GRIPS[rec.grip] && GRIPS[rec.grip].approachPose;
    if (uncurl && !slipped) this.rig.setPose(side, uncurl);
    if (thrown || slipped) {
      if (open && !slipped) this.rig.setPose(side, open);
    } else {
      // Ease clear, back out along whichever way keeps the eased hand
      // clearest of the object and its surroundings, then open.
      let openFirst = false;
      let way = this.wayIn[side] ? quat.rotate([0, 0, 0], wr.worldRot, this.wayIn[side]) : v3.negate([0, 0, 0], quat.rotate([0, 0, 0], wr.worldRot, [0, -1, 0]));
      if (eased && here) {
        const pose = here;
        // A body just set down is in the way like anything else: backing out
        // must not lift it on the digits still under it.
        const envW = held instanceof Body ? [...hereEnv, here.obj] : hereEnv;
        // And the hand opens to a shape that fits where it is: a ready hand's
        // thumb dips below the palm, into a table the hand is resting near.
        if (open && held instanceof Body) {
          let bestOpen = null;
          for (const shape of [open, 'open', 'flat']) {
            const cost = this.pathCost(side, pose, shape, envW, [0, 1, 0], 0);
            if (!bestOpen || cost < bestOpen.cost - 1e-5) bestOpen = { cost, shape };
          }
          open = bestOpen.shape;
        }
        // A thumb that came off first stays where it went until the hand has
        // backed out: opening it under a handle would lift the handle.
        if (keepThumb && open) { openLater = open; open = withThumb(this.rig.resolvePose(side, open), keepThumb); }
        const palm = quat.rotate([0, 0, 0], wr.worldRot, [0, -1, 0]);
        const fingers = quat.rotate([0, 0, 0], wr.worldRot, [0, 0, -1]);
        // Never along a shaft the fingers are round: that does not free the
        // hand, it only slides the fist along the handle.
        let cands = [way, v3.negate([0, 0, 0], palm), [0, 1, 0], [0, 0, 1], v3.negate([0, 0, 0], fingers), v3.normalize([0, 0, 0], v3.sub([0, 0, 0], [0, 1, 0], palm))];
        if (pose.obj.shape === 'cylinder') {
          const ax = quat.rotate([0, 0, 0], pose.obj.rot, [0, 0, 1]);
          cands = cands.filter((d) => Math.abs(v3.dot(d, ax)) < 0.7);
          // Once the fingers are off a handle just set down, the hand slides
          // off along it, level: that neither lifts nor rolls it.
          const flatAx = v3.normalize([0, 0, 0], [ax[0], 0, ax[2]]);
          if (keepThumb) cands = [flatAx, v3.negate([0, 0, 0], flatAx), ...cands];
        }
        // A grip wrapped round the object opens before the hand moves off.
        // (A body set down, though, is only eased off first: opening a wrap
        // at once flicks it, and it is resting on its surface anyway.)
        const wraps = ['powerCylinder', 'hook', 'spherical'].includes(rec.grip) && !(held instanceof Body && keepThumb);
        let best = null;
        if (!wraps) {
          for (const d of cands) {
            const cost = this.pathCost(side, pose, eased, envW, d, 0.04);
            if (!best || cost < best.cost - 1e-5) best = { cost, d };
          }
        }
        // Eased fingers still round the object (a handle): open the hand
        // first, then back out, if that way is clearer.
        // (A body set down: the hand backs out eased and opens once away;
        // fingers uncurling beside it would sweep through the table.)
        if ((wraps || best.cost > 0.0006) && open && !keepThumb) {
          if (!best) best = { cost: Infinity, d: cands[0] };
          for (const d of cands) {
            const cost = this.pathCost(side, pose, open, envW, d, 0.04);
            if (cost < best.cost - 1e-5) best = { cost, d, openFirst: true };
          }
        }
        way = best.d;
        if (best.openFirst) { this.rig.setPose(side, open); openFirst = true; }
      }
      const t0 = this.rig.time + (openFirst ? 0.4 : uncurl || wayPose ? 0.24 : 0.1);
      if (withdraw) this.pendingMove[side] = { at: t0, pos: v3.addScaled([0, 0, 0], arm.target.pos, way, Math.max(withdraw, 0.035)) };
     // Nothing else moves the hand until it has backed out: a move asked for
      // meanwhile would drag the body it just let go of (a thumb under it
      // would carry it up). Moves asked for meanwhile follow, in order.
      if (keepThumb && withdraw) this.leaving[side] = { until: t0 + LEAVE_TIME, then: [], way, body: held instanceof Body ? held : null, more: 4 };
      if (open) this.pendingOpen[side] = { at: openAfter != null ? this.rig.time + openAfter : t0 + 0.3, pose: openLater || open };
    }
    return object;
  }

  // Catch: predict a free body's flight with this world's own integrator,
  // pick the moment it passes nearest `near` on its way down, and bring the
  // hand to exactly the grip pose for that point at that moment, so the
  // body arrives in the palm with nothing to correct.
  planCatch(side, body, grip, { hint = null, near, horizon = 0.9 } = {}) {
    const path = this.world.predict(body, horizon);
    let best = null;
    for (const p of path) {
      if (p.vel[1] > 0) continue;
      const d = v3.dist(p.pos, near);
      if (!best || d < best.d) best = { d, ...p };
    }
    if (!best) return null;
    const pose = this.reachPose(side, { shape: 'sphere', r: body.r, pos: best.pos }, grip, { hint });
    const wr = this.rig.skel.joint(side, 'wrist');
    const start = { pos: wr.worldPos.slice(), rot: wr.worldRot.slice() };
    const t0 = this.rig.time;
    const t1 = t0 + best.t;
    body.ignoreHands = [side];
    this.catchPlan = { side, body, grip, t0, t1, start, end: { pos: pose.pos, rot: pose.rot }, vel: best.vel };
    const arm = this.rig.arms[side];
    arm.follow = () => {
      const u = clamp((this.rig.time - t0) / (t1 - t0), 0, 1);
      const k = u * u * (3 - 2 * u);
      return { pos: v3.lerp([0, 0, 0], start.pos, pose.pos, k), rot: quat.slerp([0, 0, 0, 1], start.rot, pose.rot, k) };
    };
    return this.catchPlan;
  }

  // Object-led carry: the body moves to `target` ({ pos, rot }) on its own
  // smooth path and every hand holding it follows the body. This is how two
  // hands carry one thing: neither hand leads, so neither wrist's limits
  // turn the object away from the other.
  carry(body, target) {
    let led = this.objectLed.get(body.id);
    if (!led) {
      led = { body, pos: body.pos.map((v) => new Spring(9, v, 0.8)), rot: new RotSpring(9, body.rot) };
      this.objectLed.set(body.id, led);
      for (const side of body.heldBy || []) {
        const rec = this.hold[side];
        if (!rec) continue;
        const wr = this.rig.skel.joint(side, 'wrist');
        const wristInBody = compose(inverse({ pos: body.pos, rot: body.rot }), { pos: wr.worldPos.slice(), rot: wr.worldRot.slice() });
        rec.leader = false;
        rec.wristInBody = wristInBody;
        this.rig.arms[side].follow = () => compose({ pos: body.pos, rot: body.rot }, wristInBody);
      }
    }
    if (target.pos) led.pos.forEach((s, i) => { s.target = target.pos[i]; });
    if (target.rot) led.rot.target = target.rot.slice();
    return led;
  }

  // Set a held body down: lower the hand until the body, or the fingers
  // under it, meets the surface at `surface` (a height), closed loop on
  // where they really are, never faster than `speed`.
  setDown(side, { surface = null, speed = 0.18, margin = 0.0007 } = {}) {
    this.down = this.down || {};
    const rec = this.hold[side];
    if (surface == null && rec && rec.kind === 'body') surface = this.world.surfaceBelow(rec.body);
    this.down[side] = { surface, speed, margin, done: false };
    if (rec && rec.kind === 'body' && !this.objectLed.has(rec.body.id)) this.planSetDown(side, this.down[side]);
    return this.down[side];
  }

  // Is the hand clear of a body: 3 mm off it, and the thumb not under it?
  clearOf(side, body) {
    const shape = body.graspShape();
    for (const c of handCapsules(this.rig.skel, side)) {
      if (capsuleObjectDistance(shape, c.a, c.b, c.r, 6) < 0.003) return false;
      if (c.digit !== 'thumb') continue;
      for (let i = 0; i <= 4; i++) {
        const q = v3.lerp([0, 0, 0], c.a, c.b, i / 4);
        if (capsuleObjectDistance(shape, q, [q[0], q[1] + 0.2, q[2]], 0, 6) < 0) return false;
      }
    }
    return true;
  }

  // The thumb's part of letting go a body that rests on its surface, held by
  // this hand alone with at least two other digits: the thumb takes a shape
  // off the body and clear of the surface (the grip eased off the body, the
  // shape the hand arrived with, the open or ready hand) and leaves the
  // grip. Tried on the hand as it is, then put back. False when it cannot.
  thumbOff(side) {
    const rec = this.hold[side];
    const att = this.rig.hands[side].attached;
    if (!rec || rec.kind !== 'body' || !att || !att.pose || (rec.body.heldBy || []).length > 1) return false;
    const body = rec.body;
    if (!this.world.isSupported(body, 0.0015)) return false;
    const holding = new Set(att.contacts.filter((c) => !c.via).map((c) => c.digit));
    if (!holding.has('thumb') || holding.size < 3) return false;
    const sk = this.rig.skel;
    // A thumb under the body (a handle taken palm down) cannot come off it
    // first: the body would drop onto it. It stays as it is instead while
    // the fingers come off, and slides out as the hand backs away.
    const shape0 = body.graspShape();
    for (const c of handCapsules(sk, side)) {
      if (c.digit !== 'thumb') continue;
      for (let i = 0; i <= 4; i++) {
        const q = v3.lerp([0, 0, 0], c.a, c.b, i / 4);
        if (capsuleObjectDistance(shape0, q, [q[0], q[1] + 0.2, q[2]], 0, 6) < 0) return 'under';
      }
    }
    const joints = sk.sides[side].joints.filter((j) => j.digit === 'thumb');
    const saved = joints.map((j) => ({ ...j.channels }));
    const cands = [this.easeGrip(side, att), this.wayInPose[side], 'open', 'ready'].filter(Boolean);
    let found = null;
    for (const cand of cands) {
      const pose = clonePose(att.pose);
      pose.thumb = clonePose(this.rig.resolvePose(side, cand)).thumb;
      const ch = poseChannels(pose);
      for (const j of joints) if (ch[j.name]) sk.setChannels(j, ch[j.name].flex, ch[j.name].abd, ch[j.name].twist);
      sk.updateSide(side);
      const shape = body.graspShape();
      let clear = true;
      for (const c of handCapsules(sk, side)) {
        if (c.digit !== 'thumb') continue;
        if (capsuleObjectDistance(shape, c.a, c.b, c.r, 6) < 0.0015) { clear = false; break; }
        for (let i = 0; i <= 4 && clear; i++) {
          const q = v3.lerp([0, 0, 0], c.a, c.b, i / 4);
          if (q[1] - c.r - this.world.surfaceUnder(q, c.r) < 0) clear = false;
        }
        if (!clear) break;
      }
      if (clear) { found = pose.thumb; break; }
    }
    joints.forEach((j, i) => sk.setChannels(j, saved[i].flex, saved[i].abd, saved[i].twist));
    sk.updateSide(side);
    if (!found) return false;
    att.pose.thumb = found;
    att.contacts = att.contacts.filter((c) => c.digit !== 'thumb');
    this.rig.setPose(side, att.pose);
    return true;
  }

  // Before lowering: the object must meet its surface before any digit does
  // (a handle taken palm down has fingers and thumb curled below it, which
  // would reach the table first and leave it standing on them when the hand
  // lets go), and the arm must be able to take the hand all the way down.
  // Where either fails, the hand turns the object about its centre: tipping
  // it (a long handle's far end goes down first and rests on the surface
  // while the hand opens round the other) or turning it about the vertical
  // (it lands the same way up). The smallest turn that does both is taken;
  // none is needed for most.
  planSetDown(side, plan) {
    const body = this.hold[side].body;
    const wr = this.rig.skel.joint(side, 'wrist');
    const fp = `${side}|${body.shape}|${[body.r, body.h, body.hx, body.hy, body.hz].join(',')}|${[body.pos, body.rot, wr.worldPos, wr.worldRot].flat().join(',')}|${plan.surface}|${plan.margin}`;
    const got = this.cached('setDown', fp, () => this.solveSetDown(side, plan));
    if (!got) return;
    // The turn is spread over the way down (the arm may take it only near
    // the bottom): stepDown turns the hand by the share of the drop made.
    plan.turn = { q: got.q, shift: got.shift, C: body.pos.slice(), pos: wr.worldPos.slice(), rot: wr.worldRot.slice(), endY: got.endY };
    this.rig.arms[side].set({ pole: got.pole });
  }

  solveSetDown(side, plan) {
    const body = this.hold[side].body;
    const sk = this.rig.skel;
    const wr = sk.joint(side, 'wrist');
    const C = body.pos.slice();
    const caps = handCapsules(sk, side).map((c) => ({ a: c.a.slice(), b: c.b.slice(), r: c.r, digit: c.digit }));
    const check = (q, shift, thumbClear = true) => {
      const move = (p) => v3.add([0, 0, 0], v3.add([0, 0, 0], C, quat.rotate([0, 0, 0], q, v3.sub([0, 0, 0], p, C))), shift);
      const at = v3.add([0, 0, 0], C, shift);
      // Only onto the same surface (a shift may not step off the table).
      if (Math.abs(this.world.surfaceUnder(at, 0) - plan.surface) > 1e-6) return null;
      const rot0 = quat.multiply([0, 0, 0, 1], q, body.rot);
      const objGap = Body.prototype.lowest.call({ ...body, pos: at, rot: rot0 }) - plan.margin - plan.surface;
      let digitGap = Infinity;
      const pts = [];
      for (const c of caps) {
        const a = move(c.a);
        const b = move(c.b);
        for (let i = 0; i <= 4; i++) {
          const p = v3.lerp([0, 0, 0], a, b, i / 4);
          digitGap = Math.min(digitGap, p[1] - c.r - plan.margin - 0.0005 - this.world.surfaceUnder(p, c.r));
          if (c.digit === 'thumb') pts.push([p, c.r]);
        }
      }
      if (digitGap < objGap + 0.001) return null;
      // Nor may the thumb end up under it: letting go, the thumb comes off
      // first, and a thumb under the body cannot come out without lifting it.
      const shape = { ...body.graspShape(), pos: at, rot: rot0 };
      if (thumbClear) for (const [p, r] of pts) if (capsuleObjectDistance(shape, p, [p[0], p[1] + 0.2, p[2]], 0, 6) < 0) return null;
      const pos = move(wr.worldPos);
      const rot = quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], q, wr.worldRot));
      const fitDown = this.armFit(side, { pos: [pos[0], pos[1] - objGap, pos[2]], rot });
      if (fitDown.posErr > 0.002 || fitDown.rotErr > 0.035) return null;
      // Turned by the time it is TURN_ABOVE over its surface, before any
      // digit nears it: the arm must take the turn from there on.
      const fitMid = this.armFit(side, { pos: [pos[0], pos[1] - Math.max(0, objGap - TURN_ABOVE), pos[2]], rot });
      if (fitMid.posErr > 0.002 || fitMid.rotErr > 0.035) return null;
      return { q: q.slice(), shift: shift.slice(), pole: fitDown.pole, endY: pos[1] - objGap };
    };
    if (check([0, 0, 0, 1], [0, 0, 0])) return null;
    // Long axis in the horizontal: tipping is about the axis across it,
    // rolling (a handle turning in the hand) about the axis along it.
    const along = body.shape === 'capsule' ? quat.rotate([0, 0, 0], body.rot, [0, 0, 1]) : quat.rotate([0, 0, 0], body.rot, [1, 0, 0]);
    const flat = v3.normalize([0, 0, 0], [along[0], 0, along[2]]);
    const across = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], [0, 1, 0], flat));
    const rad = (d) => (d * Math.PI) / 180;
    const about = (axis, d) => quat.fromAxisAngle([0, 0, 0, 1], axis, rad(d));
    const turns = [{ cost: 0, q: [0, 0, 0, 1] }];
    for (const d of [15, 30, 45, 60, 90]) for (const sg of [1, -1]) turns.push({ cost: d, q: about([0, 1, 0], sg * d) });
    for (const axis of [across, flat]) for (const d of [5, 10, 15, 20, 30]) for (const sg of [1, -1]) turns.push({ cost: d * 1.5, q: about(axis, sg * d) });
    for (const r of [45, 60, 75, 90, 105, 120, 135, 150, 165, 180]) for (const rs of [1, -1]) for (const d of [0, 5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 30]) for (const sg of [1, -1]) turns.push({ cost: r * 0.5 + d * 1.5, q: quat.multiply([0, 0, 0, 1], about(across, sg * d), about(flat, rs * r)) });
    for (const y of [15, 30, 45]) for (const ys of [1, -1]) for (const d of [5, 10, 15, 20]) for (const sg of [1, -1]) turns.push({ cost: y + d * 1.5, q: quat.multiply([0, 0, 0, 1], about([0, 1, 0], ys * y), about(across, sg * d)) });
    // The spot may shift a little over the same surface, a few centimetres
    // either way, where the arm takes the turn more easily.
    const shifts = [[0, 0, 0]];
    for (const d of [0.03, 0.05]) for (const dir of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) shifts.push(dir.map((v) => v * d));
    const cands = [];
    for (const t of turns) for (const sh of shifts) cands.push({ cost: t.cost + v3.len(sh) * 400, q: t.q, shift: sh });
    cands.sort((a, b) => a.cost - b.cost);
    for (const c of cands) { if (c.cost === 0) continue; const got = check(c.q, c.shift); if (got) return got; }
    // A thumb wrapped round a handle is under some of it however the hand
    // turns: then the body landing first is enough (letting go, the thumb
    // stays put and the hand slides off level along the handle).
    if (check([0, 0, 0, 1], [0, 0, 0], false)) return null;
    for (const c of cands) { if (c.cost === 0) continue; const got = check(c.q, c.shift, false); if (got) return got; }
    return null;
  }

  downGap(side, plan) {
    const rec = this.hold[side];
    // The held body comes down onto its surface; each finger onto whatever
    // is under that finger (beside a post, the table; not the post's top).
    let gap = Infinity;
    if (rec && rec.kind === 'body') gap = rec.body.lowest() - plan.margin - plan.surface;
    for (const c of handCapsules(this.rig.skel, side)) {
      for (let i = 0; i <= 4; i++) {
        const p = v3.lerp([0, 0, 0], c.a, c.b, i / 4);
        gap = Math.min(gap, p[1] - c.r - plan.margin - 0.0005 - this.world.surfaceUnder(p, c.r));
      }
    }
    return gap;
  }
  stepDown(dt) {
    if (!this.down) return;
    for (const side of SIDES) {
      const plan = this.down[side];
      if (!plan || plan.done) continue;
      const arm = this.rig.arms[side];
      const wr = this.rig.skel.joint(side, 'wrist').worldPos;
      const gap = this.downGap(side, plan);
      const rec0 = this.hold[side];
      const led = rec0 && rec0.kind === 'body' ? this.objectLed.get(rec0.body.id) : null;
      if (led) {
        // An object-led body is lowered itself; the hands follow it.
        const left0 = gap - (rec0.body.pos[1] - led.pos[1].target);
        led.pos[1].target -= Math.min(plan.speed * dt, left0);
        if (Math.abs(gap) < 0.0005 && Math.abs(left0) < 0.0005) plan.done = true;
        continue;
      }
      // Where the wrist will come to rest for the current target (the arm
      // springs are critically damped and the load sag is held while
      // setting down), and so how much gap that leaves.
      const rest = arm.target.pos[1] - arm.sag.x;
      const left = gap - (wr[1] - rest);
      const next = arm.target.pos[1] - Math.min(plan.speed * dt, left);
      const T = plan.turn;
      if (T) {
        // Turned by the share of the drop made so far, about the body's centre.
        const f = clamp((T.pos[1] - arm.target.pos[1]) / Math.max(1e-6, T.pos[1] - T.endY - TURN_ABOVE), 0, 1);
        const q = quat.slerp([0, 0, 0, 1], [0, 0, 0, 1], T.q, f);
        const p = v3.addScaled([0, 0, 0], v3.add([0, 0, 0], T.C, quat.rotate([0, 0, 0], q, v3.sub([0, 0, 0], T.pos, T.C))), T.shift, f);
        arm.set({ pos: [p[0], next, p[2]], rot: quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], q, T.rot)) });
      } else arm.set({ pos: [arm.target.pos[0], next, arm.target.pos[2]] });
      if (Math.abs(gap) < 0.0005 && Math.abs(left) < 0.0005) plan.done = true;
    }
  }

  // The eased grip, through the plan source (see cached).
  easeGrip(side, att) {
    const wr = this.rig.skel.joint(side, 'wrist');
    const objW = this.rig.attachedObject(side);
    return this.cached('easeGrip', `${side}|${JSON.stringify(att.pose)}|${[wr.worldPos, wr.worldRot, objW.pos, objW.rot].flat().join(',')}`, () => this.solveEaseGrip(side, att));
  }

  solveEaseGrip(side, att) {
    const sk = this.scratch;
    sk.reset();
    const wr = this.rig.skel.joint(side, 'wrist');
    const restWrist = { pos: sk.joint(side, 'wrist').worldPos.slice(), rot: sk.joint(side, 'wrist').worldRot.slice() };
    const T = compose(restWrist, inverse({ pos: wr.worldPos, rot: wr.worldRot }));
    const objW = this.rig.attachedObject(side);
    const obj = { ...objW, ...compose(T, { pos: objW.pos, rot: objW.rot }) };
    const env = this.environment(objW, null).map((e) => ({ ...e, ...compose(T, { pos: e.pos, rot: e.rot || [0, 0, 0, 1] }) }));
    const pose = clonePose(att.pose);
    const apply = () => { applyChannels(sk, side, poseChannels(pose)); sk.update(); };
    apply();
    const caps = (d) => handCapsules(sk, side).filter((c) => c.digit === d);
    const objGap = (d) => { let g = Infinity; for (const c of caps(d)) g = Math.min(g, capsuleObjectDistance(obj, c.a, c.b, c.r, 6)); return g; };
    const envGap = (d) => { let g = Infinity; for (const c of caps(d)) for (const e of env) g = Math.min(g, capsuleObjectDistance(e, c.a, c.b, c.r, 6)); return g; };
    const STEP = Math.PI / 180;
    for (const d of ['thumb', 'index', 'middle', 'ring', 'little']) {
      const dofs = d === 'thumb'
        ? [(v) => { pose.thumb.cmc[0] += v; }, (v) => { pose.thumb.mcp[0] += v; }, (v) => { pose.thumb.ip += v; }]
        : [(v) => { pose[d].mcp[0] += v; }, (v) => { pose[d].pip += v; }, (v) => { if (pose[d].dip == null) pose[d].dip = (2 / 3) * pose[d].pip; pose[d].dip += v; }];
      for (let it = 0; it < 30 && objGap(d) < 0.004; it++) {
        let best = null;
        for (const f of dofs) {
          for (const dv of [-STEP, STEP]) {
            f(dv); apply();
            const score = Math.min(objGap(d), 0.004) * 10 - Math.max(0, -envGap(d)) * 100;
            if (!best || score > best.score) best = { score, f, dv };
            f(-dv);
          }
        }
        if (!best) break;
        best.f(best.dv);
        apply();
      }
    }
    return pose;
  }

  // Before the rig steps: held props move toward the hand's intent, so the
  // hand that follows them lands on where they are this step.
  // Hands (and what they carry) rest on fixed surfaces instead of passing
  // into them: if the palm, the base of the thumb or a carried body reaches
  // into a table, a panel or a rung, the arm is held off it along the
  // surface's normal; the hold eases away once the hand is clear.
  pushOffSurfaces(dt) {
    for (const side of SIDES) {
      const arm = this.rig.arms[side];
      if (arm.follow) { v3.set(arm.envPush, 0, 0, 0); continue; }
      const shapes = [];
      for (const c of handCapsules(this.rig.skel, side)) if (c.segment === 'metacarpal' || c.segment === 'phalanx-proximal') shapes.push({ kind: 'cap', a: c.a, b: c.b, r: c.r });
      const rec = this.hold[side];
      if (rec && rec.kind === 'body' && rec.leader && !rec.tethers) shapes.push({ kind: 'body', body: rec.body });
      let push = [0, 0, 0];
      const wr = this.rig.skel.joint(side, 'wrist').worldPos;
      for (const st of this.world.statics) {
        if (rec && rec.kind === 'fixed' && rec.fixed === st) continue;
        // Only surfaces within a hand's length of the wrist can be touched.
        if (st.shape === 'box' ? v3.dist(closestPoint(st, wr), wr) > 0.3 : st.shape === 'capsule' && pointSegmentDistance(wr, st.a, st.b).d > 0.3 + st.r) continue;
        for (const sh of shapes) {
          let k = null;
          if (sh.kind === 'cap') k = this.world.capsuleVsShape(sh.a, sh.b, sh.r, st);
          else if (sh.body.shape === 'sphere') { const q = this.world.sphereVsShape(sh.body.pos, sh.body.r, st); if (q) k = { n: v3.negate([0, 0, 0], q.n), depth: q.depth }; }
          if (!k || k.depth <= 0.0003) continue;
          // n points from the hand into the surface: push the other way.
          const want = v3.scale([0, 0, 0], k.n, -(k.depth - 0.0003));
          for (let i = 0; i < 3; i++) if (Math.abs(want[i]) > Math.abs(push[i])) push[i] = want[i];
        }
      }
      const any = push.some((v) => v !== 0);
      if (any) v3.add(arm.envPush, arm.envPush, push);
      else v3.scale(arm.envPush, arm.envPush, Math.max(0, 1 - 6 * dt));
    }
  }

  pre(dt) {
    // A hand going over something on its way: once above it, on to the goal.
    for (const side of SIDES) {
      const v = this.via[side];
      // On to the next leg once near this one's end, or once the hand has
      // stopped short of it (an end out of reach).
      const arm = this.rig.arms[side];
      const still = v && dmath.hypot(...arm.pos.map((sp) => sp.v)) < 0.02 && this.rig.time - (v.since ?? (v.since = this.rig.time)) > 0.3;
      if (v && (still || v3.dist(this.rig.skel.joint(side, 'wrist').worldPos, v.legs[0].pos) < 0.025)) {
        v.since = this.rig.time;
        v.legs.shift();
        if (v.legs.length) this.rig.setArmTarget(side, { ...v.final, pos: v.legs[0].pos, rot: v.legs[0].rot });
        else { this.via[side] = null; this.rig.setArmTarget(side, v.final); }
      }
    }
    this.stepDown(dt);
    this.pushOffSurfaces(dt);
    for (const led of this.objectLed.values()) {
      for (const sp of led.pos) sp.step(dt);
      led.rot.step(dt);
      v3.copy(led.body.pos, led.pos.map((sp) => sp.x));
      led.body.rot = led.rot.q.slice();
    }
    const cp = this.catchPlan;
    if (cp && this.rig.time >= cp.t1 - 1e-9) {
      this.catchPlan = null;
      cp.body.ignoreHands = null;
      this.rig.arms[cp.side].follow = null;
      this.grasp(cp.side, cp.body, cp.grip);
      // Give with the catch: the hand travels on a little along the flight.
      const wr = this.rig.skel.joint(cp.side, 'wrist');
      this.rig.arms[cp.side].set({ pos: wr.worldPos.slice(), rot: wr.worldRot.slice() }, true);
      this.rig.setArmTarget(cp.side, { pos: v3.addScaled([0, 0, 0], wr.worldPos, cp.vel, 0.035) });
    }
    for (const side of SIDES) {
      const I = this.intent[side];
      if (!I) continue;
      for (const s of I.pos) s.step(dt);
      I.rot.step(dt);
    }
    this.world.stepDriven(dt);
    // Loads read in the arms.
    for (const side of SIDES) {
      const rec = this.hold[side];
      let load = 0;
      if (rec && rec.kind === 'body' && rec.tethers) load = 0;
      else if (rec && rec.kind === 'body' && !this.world.isSupported(rec.body)) load = (rec.body.mass * G) / rec.body.heldBy.length;
      // Setting down, the arm keeps the load it had until it lets go, so
      // the wrist does not rise off the surface as the weight comes off.
      if (this.down && this.down[side]) continue;
      this.rig.arms[side].load = load;
    }
    this.unignore = this.unignore.filter((u) => {
      if (this.rig.time < u.at) return true;
      if (u.body.ignoreHands) u.body.ignoreHands = u.body.ignoreHands.filter((s) => s !== u.side);
      return false;
    });
    for (const side of SIDES) {
      const lv = this.leaving[side];
      // Not out yet (a thumb under a long handle): on the same way a little
      // further, a few times at most, before anything else.
      if (lv && this.rig.time >= lv.until && lv.body && lv.more > 0 && !this.clearOf(side, lv.body)) {
        lv.more--;
        lv.until = this.rig.time + LEAVE_TIME;
        const arm = this.rig.arms[side];
        arm.set({ pos: v3.addScaled([0, 0, 0], arm.target.pos, lv.way, 0.035) });
      }
      if (lv && this.rig.time >= lv.until) {
        this.leaving[side] = null;
        const next = lv.then.shift();
        if (next) { this.moveTo(side, next); if (lv.then.length) this.leaving[side] = { until: this.rig.time + LEAVE_TIME, then: lv.then }; }
      }
      const pr = this.pendingRelease[side];
      if (pr && this.rig.time >= pr.at) { this.pendingRelease[side] = null; this.release(side, pr.opts); }
      const m = this.pendingMove[side];
      if (m && this.rig.time >= m.at) { if (!this.hold[side]) this.rig.arms[side].set({ pos: m.pos }); this.pendingMove[side] = null; }
      const o = this.pendingOpen[side];
      if (o && this.rig.time >= o.at) { if (!this.hold[side]) this.rig.setPose(side, o.pose); this.pendingOpen[side] = null; }
    }
    // Fingers close on nothing a moment after a slip.
    for (const side of SIDES) {
      const l = this.loosen[side];
      if (l && this.rig.time >= l) { this.rig.setPose(side, 'relaxed'); this.loosen[side] = null; }
    }
  }

  // After the rig steps: held bodies ride their leading hand, ropes follow
  // their grips, the hand capsules enter the world, and the world steps.
  post(dt) {
    for (const side of SIDES) {
      const rec = this.hold[side];
      if (!rec) continue;
      if (rec.kind === 'body' && rec.tethers) {
        const I = this.intent[side];
        const real = this.rig.skel.joint(side, 'wrist');
        // A hand round a bar handle rolls on it where the wrist cannot keep
        // its turn (the crate comes in close and the wrist is at its limit).
        if (rec.part && rec.part.shape === 'capsule') {
          const b = rec.body;
          const axis = quat.rotate([0, 0, 0], rec.part.rot, [0, 0, 1]);
          const actual = compose(inverse({ pos: b.pos, rot: b.rot }), { pos: real.worldPos, rot: real.worldRot });
          const d = quat.multiply([0, 0, 0, 1], actual.rot, quat.conjugate([0, 0, 0, 1], rec.wristInBody.rot));
          const roll = quat.twistAngle(d, axis);
          if (Math.abs(roll) > 0.001) {
            const R = quat.fromAxisAngle([0, 0, 0, 1], axis, roll);
            const c = rec.part.pos;
            rec.wristInBody = { pos: v3.add([0, 0, 0], c, quat.rotate([0, 0, 0], R, v3.sub([0, 0, 0], rec.wristInBody.pos, c))), rot: quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], R, rec.wristInBody.rot)) };
            const w = compose({ pos: b.pos, rot: b.rot }, rec.wristInBody);
            for (const t of rec.tethers) {
              const wp = v3.add([0, 0, 0], b.pos, quat.rotate([0, 0, 0], b.rot, t.local));
              t.inWrist = quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], w.rot), v3.sub([0, 0, 0], wp, w.pos));
            }
          }
        }
        // Pulled toward where the hand means to go, turned the way the wrist
        // really is (a wrist at its limit turns the crate with it rather
        // than twisting in the grip).
        const wr = I ? { worldPos: I.pos.map((sp) => sp.x), worldRot: real.worldRot } : real;
        for (const t of rec.tethers) {
          const pos = v3.add([0, 0, 0], wr.worldPos, quat.rotate([0, 0, 0], wr.worldRot, t.inWrist));
          t.target.vel = dt > 0 ? v3.scale([0, 0, 0], v3.sub([0, 0, 0], pos, t.target.pos), 1 / dt) : [0, 0, 0];
          t.target.pos = pos;
        }
      } else if (rec.kind === 'body' && rec.leader && !this.objectLed.has(rec.body.id)) {
        let w = this.rig.attachedObject(side);
        if (w && rec.bodyInPart) w = compose(w, rec.bodyInPart);
        if (w) { v3.copy(rec.body.pos, w.pos); rec.body.rot = w.rot.slice(); }
      } else if (rec.kind === 'prop') {
        // The arm has a reach and the wrist and forearm have limits: where
        // the hand cannot follow the part any further, it stops meaning to,
        // and the prop is driven back to where the hand really is.
        const I = this.intent[side];
        const arm = this.rig.arms[side];
        if (I && arm.follow && rec.part.shape === 'capsule') {
          // A hand round a bar may roll on it: where the wrist cannot keep
          // its turn, the grip rolls about the bar to the turn it has.
          const real = this.rig.skel.joint(side, 'wrist');
          const pw = rec.prop.partWorld(rec.part);
          const actual = compose(inverse({ pos: pw.pos, rot: pw.rot }), { pos: real.worldPos, rot: real.worldRot });
          const d = quat.multiply([0, 0, 0, 1], actual.rot, quat.conjugate([0, 0, 0, 1], rec.wristInPart.rot));
          const roll = quat.twistAngle(d, [0, 0, 1]);
          if (Math.abs(roll) > 0.001) {
            const R = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], roll);
            rec.wristInPart = { pos: quat.rotate([0, 0, 0], R, rec.wristInPart.pos), rot: quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], R, rec.wristInPart.rot)) };
            const w = compose(pw, rec.wristInPart);
            I.wristToGrip = compose(inverse(w), { pos: pw.pos, rot: pw.rot });
          }
        }
        if (I && arm.follow) {
          const want = arm.follow();
          const real = this.rig.skel.joint(side, 'wrist');
          if (v3.dist(want.pos, real.worldPos) > 0.0005 || quat.angleBetween(want.rot, real.worldRot) > 0.008) {
            I.pos.forEach((sp, i) => { sp.snap(real.worldPos[i]); });
            I.rot.snap(real.worldRot);
            // And the part goes back to the hand this very step, so the
            // grip never opens up on it.
            const p = rec.prop;
            if (p.driver) { p.q = clamp(p.driver.target(), p.min, p.max); p.qd = 0; }
          }
        }
      } else if (rec.kind === 'fixed' && rec.fixed.shape === 'capsule') {
        // Round a rung the hand rolls on it as the body moves under it.
        const real = this.rig.skel.joint(side, 'wrist');
        const f = rec.fixed;
        const axis = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], f.b, f.a));
        const d = quat.multiply([0, 0, 0, 1], real.worldRot, quat.conjugate([0, 0, 0, 1], rec.wrist.rot));
        const roll = quat.twistAngle(d, axis);
        if (Math.abs(roll) > 0.001) {
          const R = quat.fromAxisAngle([0, 0, 0, 1], axis, roll);
          rec.wrist = { pos: v3.add([0, 0, 0], f.a, quat.rotate([0, 0, 0], R, v3.sub([0, 0, 0], rec.wrist.pos, f.a))), rot: quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], R, rec.wrist.rot)) };
        }
      } else if (rec.kind === 'rope') {
        const wr = this.rig.skel.joint(side, 'wrist');
        rec.pins.forEach((i, k) => rec.rope.pin(i, v3.add([0, 0, 0], wr.worldPos, quat.rotate([0, 0, 0], wr.worldRot, rec.local[k]))));
      }
    }
    // Held body velocity and acceleration, for throws and for slip.
    for (const [id, tr] of this.track) {
      const b = this.world.bodies.find((x) => x.id === id);
      if (!b || dt <= 0) continue;
      const vel = v3.scale([0, 0, 0], v3.sub([0, 0, 0], b.pos, tr.pos), 1 / dt);
      tr.acc = v3.scale([0, 0, 0], v3.sub([0, 0, 0], vel, tr.vel), 1 / dt);
      tr.prevVel = tr.vel.slice();
      const dq = quat.multiply([0, 0, 0, 1], b.rot, quat.conjugate([0, 0, 0, 1], tr.rot));
      const ang = 2 * dmath.acos(clamp(Math.abs(dq[3]), 0, 1));
      const sn = Math.sqrt(Math.max(0, 1 - dq[3] * dq[3]));
      const sign = dq[3] < 0 ? -1 : 1;
      tr.ang = sn < 1e-9 ? [0, 0, 0] : [dq[0] / sn * ang / dt * sign, dq[1] / sn * ang / dt * sign, dq[2] / sn * ang / dt * sign];
      tr.vel = vel;
      tr.pos = b.pos.slice();
      tr.rot = b.rot.slice();
      v3.copy(b.vel, vel);
    }
    this.checkSlip(dt);
    const caps = [];
    for (const side of SIDES) for (const c of handCapsules(this.rig.skel, side)) caps.push({ a: c.a, b: c.b, r: c.r, side, name: c.name, digit: c.digit, segment: c.segment });
    this.world.setHandCapsules(caps, dt);
    this.touchNow = new Set();
    this.world.step(dt);
    this.touching = this.touchNow;
  }

  // Load the grip must carry: weight plus the force to accelerate the body.
  requiredForce(body) {
    if (this.world.isSupported(body)) return 0;
    const tr = this.track.get(body.id);
    const acc = tr ? tr.acc : [0, 0, 0];
    return body.mass * dmath.hypot(acc[0], acc[1] + G, acc[2]);
  }
  capacity(body) {
    let c = 0;
    for (const s of body.heldBy || []) { const rec = this.hold[s]; if (rec) c += (GRIPS[rec.grip]?.capacity ?? 0) * this.strength; }
    return c;
  }

  checkSlip() {
    for (const side of SIDES) {
      const rec = this.hold[side];
      if (rec && rec.tethers) {
        const sat = rec.tethers.some((t) => t.saturated);
        this.slipCount[side] = sat ? this.slipCount[side] + 1 : 0;
        if (this.slipCount[side] >= 6) { this.lastSlip = { side, time: this.rig.time, body: rec.body }; this.release(side, { slipped: true }); this.loosen[side] = this.rig.time + LOOSEN_AFTER; }
        continue;
      }
      if (!rec || rec.kind !== 'body' || !rec.leader) { this.slipCount[side] = 0; continue; }
      const b = rec.body;
      const need = this.requiredForce(b);
      const have = this.capacity(b);
      this.slipCount[side] = need > have ? this.slipCount[side] + 1 : 0;
      if (this.slipCount[side] >= SLIP_FRAMES) {
        const holders = b.heldBy.slice();
        const payload = { body: b, required: need, capacity: have };
        for (const s of holders.filter((x) => x !== side)) this.release(s, { slipped: true });
        this.release(side, { slipped: true });
        this.lastSlip = { side, time: this.rig.time, ...payload };
        // The fingers stay where they were while the body slides out, then close on nothing.
        for (const s of holders) this.loosen[s] = this.rig.time + LOOSEN_AFTER;
      }
    }
  }
}
