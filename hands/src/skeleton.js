// Skeleton: per side a shoulder anchor, upper arm, forearm with two twist
// bones, then the 25 joint hand layout of the WebXR Hand Input module
// (wrist, four thumb joints, five per finger including the tip), named
// exactly as the module names them. Joint frames follow the same module:
// -Z runs along the bone away from the wrist, -Y points out of the palm,
// +X completes a right handed frame. Rest lengths come from anatomy.js.
import { v3, quat, deg } from './math.js';
import { BONES_MM, LAYOUT_MM, CARPUS_MM, ARM_MM, SHOULDER_M, SECTIONS_MM, MM, LIMITS_DEG } from './anatomy.js';

export const SIDES = ['left', 'right'];
export const FINGERS = ['index', 'middle', 'ring', 'little'];
export const DIGITS = ['thumb', ...FINGERS];
export const XR_PREFIX = { thumb: 'thumb', index: 'index-finger', middle: 'middle-finger', ring: 'ring-finger', little: 'pinky-finger' };
export const FINGER_SEGMENTS = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
export const THUMB_SEGMENTS = ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'];

// The 25 names in the order the WebXR module lists them.
export const XR_JOINT_NAMES = [
  'wrist',
  ...THUMB_SEGMENTS.map((s) => `thumb-${s}`),
  ...FINGERS.flatMap((f) => FINGER_SEGMENTS.map((s) => `${XR_PREFIX[f]}-${s}`)),
];
export const ARM_JOINT_NAMES = ['shoulder', 'upper-arm', 'forearm', 'forearm-twist-1', 'forearm-twist-2'];
export const JOINTS_PER_SIDE = ARM_JOINT_NAMES.length + XR_JOINT_NAMES.length;

const NO_LIMIT = { flex: [0, 0], abd: [0, 0], twist: [0, 0] };
const D = (pair) => (pair ? [deg(pair[0]), deg(pair[1])] : [0, 0]);
function limitsFor(spec) {
  return { flex: D(spec.flex), abd: D(spec.abd), twist: D(spec.twist) };
}

// Limit table per joint name, radians.
const THIRD = 1 / 3;
function jointLimits(name, digit, segment) {
  if (name === 'upper-arm') return limitsFor({ flex: [0, LIMITS_DEG.shoulder.cone], twist: LIMITS_DEG.shoulder.twist });
  if (name === 'forearm') return limitsFor({ flex: LIMITS_DEG.elbow.flex });
  if (name === 'forearm-twist-1' || name === 'forearm-twist-2') {
    return limitsFor({ twist: [LIMITS_DEG.forearm.twist[0] * THIRD, LIMITS_DEG.forearm.twist[1] * THIRD] });
  }
  if (name === 'wrist') {
    return limitsFor({ flex: LIMITS_DEG.wrist.flex, abd: LIMITS_DEG.wrist.dev, twist: [LIMITS_DEG.forearm.twist[0] * THIRD, LIMITS_DEG.forearm.twist[1] * THIRD] });
  }
  if (digit === 'thumb') {
    if (segment === 'metacarpal') return limitsFor(LIMITS_DEG.thumb.cmc);
    if (segment === 'phalanx-proximal') return limitsFor(LIMITS_DEG.thumb.mcp);
    if (segment === 'phalanx-distal') return limitsFor(LIMITS_DEG.thumb.ip);
    return limitsFor(NO_LIMIT);
  }
  if (digit) {
    if (segment === 'metacarpal') return limitsFor(LIMITS_DEG.metacarpal[digit] || NO_LIMIT);
    if (segment === 'phalanx-proximal') return limitsFor(LIMITS_DEG.finger.mcp);
    if (segment === 'phalanx-intermediate') return limitsFor(LIMITS_DEG.finger.pip);
    if (segment === 'phalanx-distal') return limitsFor(LIMITS_DEG.finger.dip);
  }
  return limitsFor(NO_LIMIT);
}

// Capsule radius per bone for the penetration checks: mean of half width
// and half thickness of the section that covers the bone.
function boneRadius(digit, segment) {
  if (!digit) return 0;
  const s = digit === 'thumb' ? SECTIONS_MM.thumb : SECTIONS_MM.finger[digit];
  const key = digit === 'thumb'
    ? { metacarpal: 'shaft', 'phalanx-proximal': 'proximal', 'phalanx-distal': 'distal' }[segment]
    : { metacarpal: 'head', 'phalanx-proximal': 'proximal', 'phalanx-intermediate': 'middle', 'phalanx-distal': 'distal' }[segment];
  if (!key) return 0;
  return ((s[key][0] + s[key][1]) / 4) * MM;
}

// Frame with -Z along `distal` and +Y as close as possible to `dorsal`.
function frameFrom(distal, dorsal) {
  const z = v3.normalize([0, 0, 0], v3.negate([0, 0, 0], distal));
  const y = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], dorsal, z));
  const x = v3.cross([0, 0, 0], y, z);
  return quat.fromBasis([0, 0, 0, 1], x, y, z);
}

class Joint {
  constructor(index, side, name, parent, opts) {
    this.index = index;
    this.side = side;
    this.name = name;
    this.id = `${side}:${name}`;
    this.parent = parent;
    this.digit = opts.digit || null;
    this.segment = opts.segment || null;
    this.kind = opts.kind;
    this.sideSign = side === 'right' ? 1 : -1;
    // Positive abd spreads away from the middle finger: ring and little spread ulnar.
    this.abdSign = (this.digit === 'ring' || this.digit === 'little') ? -1 : 1;
    this.length = opts.length || 0; // rest distance to the child joint along the bone, metres
    this.radius = opts.radius || 0;
    this.limits = jointLimits(name, this.digit, this.segment);
    this.restWorldPos = opts.worldPos;
    this.restWorldRot = opts.worldRot;
    this.restLocalPos = [0, 0, 0];
    this.restLocalRot = [0, 0, 0, 1];
    this.channels = { flex: 0, abd: 0, twist: 0 }; // twist is set to the pronation offset once the chain is built
    this.localRot = [0, 0, 0, 1]; // pose rotation on top of rest, in the joint's own rest frame
    this.localPos = [0, 0, 0];    // pose translation (shoulder anchor reactions only)
    this.worldPos = opts.worldPos.slice();
    this.worldRot = opts.worldRot.slice();
    this.children = [];
  }
}

// Positions of the right hand joints in hand space (metres), plus the
// distal and dorsal hint for each bone's frame. Returns a map by XR name.
function handLayout() {
  const out = new Map();
  const mm = (p) => [p[0] * MM, p[1] * MM, p[2] * MM];
  out.set('wrist', { pos: [0, 0, 0], distal: [0, 0, -1], dorsal: [0, 1, 0], length: CARPUS_MM * MM });
  for (const f of FINGERS) {
    const b = BONES_MM[f];
    const base = LAYOUT_MM.cmc[f];
    const head = LAYOUT_MM.head[f];
    const dx = head[0] - base[0];
    const dy = head[1] - base[1];
    const dz = -Math.sqrt(b.metacarpal * b.metacarpal - dx * dx - dy * dy);
    const dir = v3.normalize([0, 0, 0], [dx, dy, dz]);
    // Extended fingers run nearer the hand axis than the fanned metacarpals.
    const pdir = v3.normalize([0, 0, 0], v3.lerp([0, 0, 0], dir, [0, 0, -1], LAYOUT_MM.phalanxConverge));
    const dorsal = [0, 1, 0];
    let p = mm(base);
    const names = FINGER_SEGMENTS.map((s) => `${XR_PREFIX[f]}-${s}`);
    const lens = [b.metacarpal, b.proximal, b.middle, b.distal + b.tip];
    for (let i = 0; i < names.length; i++) {
      const d = i === 0 ? dir : pdir;
      out.set(names[i], { pos: p.slice(), distal: d, dorsal, length: (lens[i] || 0) * MM });
      if (i < lens.length) p = v3.addScaled([0, 0, 0], p, d, lens[i] * MM);
    }
  }
  const t = BONES_MM.thumb;
  const tdir = v3.normalize([0, 0, 0], LAYOUT_MM.thumbDir);
  const tdorsal = LAYOUT_MM.thumbDorsal;
  let p = mm(LAYOUT_MM.thumbCmc);
  const tnames = THUMB_SEGMENTS.map((s) => `thumb-${s}`);
  const tlens = [t.metacarpal, t.proximal, t.distal + t.tip];
  for (let i = 0; i < tnames.length; i++) {
    out.set(tnames[i], { pos: p.slice(), distal: tdir, dorsal: tdorsal, length: (tlens[i] || 0) * MM });
    if (i < tlens.length) p = v3.addScaled([0, 0, 0], p, tdir, tlens[i] * MM);
  }
  return out;
}

function parentName(name) {
  if (name === 'wrist') return 'forearm-twist-2';
  const m = /^(thumb|index-finger|middle-finger|ring-finger|pinky-finger)-(.+)$/.exec(name);
  const segs = m[1] === 'thumb' ? THUMB_SEGMENTS : FINGER_SEGMENTS;
  const i = segs.indexOf(m[2]);
  return i === 0 ? 'wrist' : `${m[1]}-${segs[i - 1]}`;
}

function digitOf(name) {
  const m = /^(thumb|index-finger|middle-finger|ring-finger|pinky-finger)-(.+)$/.exec(name);
  if (!m) return { digit: null, segment: null };
  const digit = Object.keys(XR_PREFIX).find((d) => XR_PREFIX[d] === m[1]);
  return { digit, segment: m[2] };
}

export function buildSide(side, offset = 0) {
  const s = side === 'right' ? 1 : -1;
  const mirror = (p) => [s * p[0], p[1], p[2]];
  const joints = [];
  const byName = new Map();
  const add = (name, parent, opts) => {
    const j = new Joint(offset + joints.length, side, name, parent ? byName.get(parent) : null, opts);
    joints.push(j);
    byName.set(name, j);
    if (j.parent) j.parent.children.push(j);
    return j;
  };
  const shoulder = [s * SHOULDER_M.x, SHOULDER_M.y, SHOULDER_M.z];
  const elbow = v3.add([0, 0, 0], shoulder, [0, 0, -ARM_MM.upperArm * MM]);
  const fl = ARM_MM.forearm * MM;
  const wristPos = v3.add([0, 0, 0], elbow, [0, 0, -fl]);
  // Arm bones: -Z along the bone, -Y toward the anterior side (the way the
  // elbow flexes). With the arm forward and palm down the elbow crease faces
  // up, so the anterior hint is world up and +Y points down.
  const armRot = frameFrom([0, 0, -1], [0, -1, 0]);
  add('shoulder', null, { kind: 'arm', worldPos: shoulder, worldRot: armRot.slice(), length: 0 });
  add('upper-arm', 'shoulder', { kind: 'arm', worldPos: shoulder.slice(), worldRot: armRot.slice(), length: ARM_MM.upperArm * MM, radius: (SECTIONS_MM.upperArm.mid[0] + SECTIONS_MM.upperArm.mid[1]) / 4 * MM });
  add('forearm', 'upper-arm', { kind: 'arm', worldPos: elbow, worldRot: armRot.slice(), length: fl * THIRD, radius: (SECTIONS_MM.forearm.belly[0] + SECTIONS_MM.forearm.belly[1]) / 4 * MM });
  add('forearm-twist-1', 'forearm', { kind: 'arm', worldPos: v3.add([0, 0, 0], elbow, [0, 0, -fl * THIRD]), worldRot: armRot.slice(), length: fl * THIRD, radius: (SECTIONS_MM.forearm.lower[0] + SECTIONS_MM.forearm.lower[1]) / 4 * MM });
  add('forearm-twist-2', 'forearm-twist-1', { kind: 'arm', worldPos: v3.add([0, 0, 0], elbow, [0, 0, -fl * 2 * THIRD]), worldRot: armRot.slice(), length: fl * THIRD, radius: (SECTIONS_MM.forearm.wrist[0] + SECTIONS_MM.forearm.wrist[1]) / 4 * MM });

  const layout = handLayout();
  for (const name of XR_JOINT_NAMES) {
    const L = layout.get(name);
    const { digit, segment } = digitOf(name);
    const worldPos = v3.add([0, 0, 0], wristPos, mirror(L.pos));
    const worldRot = frameFrom(mirror(L.distal), mirror(L.dorsal));
    add(name, parentName(name), { kind: 'hand', digit, segment, worldPos, worldRot, length: L.length, radius: name === 'wrist' ? (SECTIONS_MM.wrist[0] + SECTIONS_MM.wrist[1]) / 4 * MM : boneRadius(digit, segment) });
  }

  // Local rest transforms from the world rest frames.
  for (const j of joints) {
    if (!j.parent) {
      v3.copy(j.restLocalPos, j.restWorldPos);
      quat.copy(j.restLocalRot, j.restWorldRot);
      continue;
    }
    const inv = quat.conjugate([0, 0, 0, 1], j.parent.restWorldRot);
    quat.rotate(j.restLocalPos, inv, v3.sub([0, 0, 0], j.restWorldPos, j.parent.restWorldPos));
    quat.normalize(j.restLocalRot, quat.multiply([0, 0, 0, 1], inv, j.restWorldRot));
  }
  // Thumb CMC saddle basis in the wrist (hand) frame: X = in-plane axis
  // perpendicular to the thumb (palmar abduction), Y = palm normal (sweep
  // across the palm), Z completes it. The rest metacarpal direction has no
  // X component in this basis.
  // Pronation channels measure from the thumb up neutral; the bind pose is
  // fully pronated, a third of it on each bone of the chain.
  const third = deg(LIMITS_DEG.forearm.bindPronation) / 3;
  for (const name of ['forearm-twist-1', 'forearm-twist-2', 'wrist']) byName.get(name).twistOffset = third;
  // The wrist composes as a swing (flexion and deviation as one rotation
  // vector in the XY plane) followed by the pronation twist about the bone,
  // which stays continuous where an Euler split would jump.
  byName.get('wrist').swingTwist = true;
  const cmc = byName.get('thumb-metacarpal');
  const dRest = quat.rotate([0, 0, 0], cmc.restLocalRot, [0, 0, -1]);
  const ex = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], [0, 1, 0], dRest));
  const ey = [0, 1, 0];
  const ez = v3.cross([0, 0, 0], ex, ey);
  cmc.cmcBasis = quat.fromBasis([0, 0, 0, 1], ex, ey, ez);
  cmc.cmcRestDir = quat.rotate([0, 0, 0], quat.conjugate([0, 0, 0, 1], cmc.cmcBasis), dRest); // (0, dy, dz)
  return { side, joints, byName };
}

// Pose rotation from channels: q = Rz(twist) * Ry(abd) * Rx(-flex), with abd
// and twist mirrored for the left side so the same numbers mean the same
// anatomical motion on both hands.
const AX = [1, 0, 0];
const AY = [0, 1, 0];
const AZ = [0, 0, 1];
const tmpA = [0, 0, 0, 1];
const tmpB = [0, 0, 0, 1];
export function channelsToQuat(o, flex, abd, twist, sideSign = 1) {
  quat.fromAxisAngle(o, AZ, twist * sideSign);
  quat.fromAxisAngle(tmpA, AY, abd * sideSign);
  quat.multiply(o, o, tmpA);
  quat.fromAxisAngle(tmpB, AX, -flex);
  quat.multiply(o, o, tmpB);
  return o;
}

// Inverse of channelsToQuat: extract (flex, abd, twist) in the joint's own
// convention from a pose quaternion (ZYX Tait-Bryan decomposition).
export function quatToChannels(q, sideSign = 1) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  // Rotation matrix rows of R = Rz Ry Rx.
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const r10 = 2 * (x * y + w * z);
  const r00 = 1 - 2 * (y * y + z * z);
  const abd = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let a;
  let c;
  if (Math.abs(r20) < 0.999999) {
    a = Math.atan2(r21, r22);
    c = Math.atan2(r10, r00);
  } else {
    // Gimbal lock: fold everything into the flex term.
    const r01 = 2 * (x * y - w * z);
    const r11 = 1 - 2 * (x * x + z * z);
    a = Math.atan2(-r01, r11);
    c = 0;
  }
  return { flex: -a, abd: abd * sideSign, twist: c * sideSign };
}

export class Skeleton {
  constructor() {
    this.sides = {};
    this.joints = [];
    for (const side of SIDES) {
      const built = buildSide(side, this.joints.length);
      this.sides[side] = built;
      this.joints.push(...built.joints);
    }
    this.byId = new Map(this.joints.map((j) => [j.id, j]));
    this.reset();
  }

  joint(side, name) {
    return this.sides[side].byName.get(name);
  }

  // Set channel values on a joint, clamped to its limits, and rebuild its
  // local pose rotation.
  setChannels(joint, flex = 0, abd = 0, twist = 0) {
    const L = joint.limits;
    const c = joint.channels;
    c.flex = Math.min(L.flex[1], Math.max(L.flex[0], flex));
    c.abd = Math.min(L.abd[1], Math.max(L.abd[0], abd));
    c.twist = Math.min(L.twist[1], Math.max(L.twist[0], twist));
    if (joint.cmcBasis) return this.setCmc(joint);
    if (joint.swingTwist) return this.setSwingTwistJoint(joint);
    channelsToQuat(joint.localRot, c.flex, c.abd * joint.abdSign, c.twist - (joint.twistOffset || 0), joint.sideSign);
    return joint;
  }

  // Twist swing joint: the pronation twist turns about the forearm axis
  // first (like the twist bones above it), then the wrist swings:
  //   local = Rz((twist - offset) * side) * exp((-flex, abd * side, 0))
  setSwingTwistJoint(joint) {
    const c = joint.channels;
    const swing = quat.fromRotationVector([0, 0, 0, 1], [-c.flex, c.abd * joint.abdSign * joint.sideSign, 0]);
    const tw = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], (c.twist - (joint.twistOffset || 0)) * joint.sideSign);
    quat.normalize(joint.localRot, quat.multiply([0, 0, 0, 1], tw, swing));
    return joint;
  }

  measureSwingTwistJoint(joint) {
    const { swing, twist } = quat.twistSwing(joint.localRot, [0, 0, 1]);
    const ang = quat.angle(swing);
    const sn = Math.sqrt(Math.max(0, 1 - swing[3] * swing[3]));
    const axis = sn < 1e-9 ? [0, 0, 0] : [swing[0] / sn, swing[1] / sn, swing[2] / sn];
    const rx = axis[0] * ang;
    const ry = axis[1] * ang;
    return { flex: -rx, abd: ry / (joint.abdSign * joint.sideSign), twist: twist * joint.sideSign + (joint.twistOffset || 0) };
  }

  // Thumb CMC: rotations about hand frame axes, then twist about the bone.
  //   R_p = B * Ry(-flex * side) * Rx(abd) * B^T   (in the wrist frame)
  //   local = rest^-1 * R_p * rest * Rz(twist * side)
  setCmc(joint) {
    const c = joint.channels;
    const B = joint.cmcBasis;
    const Bi = quat.conjugate([0, 0, 0, 1], B);
    const ry = quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], -c.flex * joint.sideSign);
    const rx = quat.fromAxisAngle([0, 0, 0, 1], [1, 0, 0], c.abd);
    let rp = quat.multiply([0, 0, 0, 1], ry, rx);
    rp = quat.multiply([0, 0, 0, 1], B, quat.multiply([0, 0, 0, 1], rp, Bi));
    const rest = joint.restLocalRot;
    const ri = quat.conjugate([0, 0, 0, 1], rest);
    const rz = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], c.twist * joint.sideSign);
    let local = quat.multiply([0, 0, 0, 1], ri, quat.multiply([0, 0, 0, 1], rp, rest));
    local = quat.multiply([0, 0, 0, 1], local, rz);
    quat.normalize(joint.localRot, local);
    return joint;
  }

  // Inverse of setCmc from the pose rotation alone: the metacarpal direction
  // in the saddle basis gives abd then flex, and what remains is twist.
  measureCmc(joint) {
    const rest = joint.restLocalRot;
    const rp = quat.multiply([0, 0, 0, 1], rest, quat.multiply([0, 0, 0, 1], joint.localRot, quat.conjugate([0, 0, 0, 1], rest)));
    const Bi = quat.conjugate([0, 0, 0, 1], joint.cmcBasis);
    const d0 = joint.cmcRestDir;
    const dWorld = quat.rotate([0, 0, 0], rp, quat.rotate([0, 0, 0], joint.cmcBasis, d0));
    const d = quat.rotate([0, 0, 0], Bi, dWorld);
    // d = Ry(phi) Rx(a) d0 with d0 = (0, dy, dz): y1 = r cos(theta0 + a)
    const r = Math.hypot(d0[1], d0[2]);
    const theta0 = Math.atan2(d0[2], d0[1]);
    const cy = Math.max(-1, Math.min(1, d[1] / r));
    // Two candidates for the angle; keep the one whose z sign matches.
    let a = Math.acos(cy) - theta0;
    const z1 = r * Math.sin(theta0 + a);
    const zLen = Math.hypot(d[0], d[2]);
    if (Math.abs(z1 - zLen) > Math.abs(-z1 - zLen)) a = -Math.acos(cy) - theta0;
    const zz = r * Math.sin(theta0 + a);
    const phi = Math.atan2(d[0], zz === 0 ? 1e-12 : d[2] * Math.sign(zz)) * (zz < 0 ? 1 : 1);
    const flex = -phi / joint.sideSign;
    // Twist: remove the swing and read the rotation left about the bone.
    const ry = quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], phi);
    const rx = quat.fromAxisAngle([0, 0, 0, 1], [1, 0, 0], a);
    let swing = quat.multiply([0, 0, 0, 1], ry, rx);
    swing = quat.multiply([0, 0, 0, 1], joint.cmcBasis, quat.multiply([0, 0, 0, 1], swing, Bi));
    const ri = quat.conjugate([0, 0, 0, 1], rest);
    const swingLocal = quat.multiply([0, 0, 0, 1], ri, quat.multiply([0, 0, 0, 1], swing, rest));
    const rz = quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], swingLocal), joint.localRot);
    const twist = quat.twistAngle(rz, [0, 0, 1]) / joint.sideSign;
    return { flex, abd: a, twist };
  }

  // Ball joint (shoulder): decompose a pose rotation into a swing (cone
  // angle about an axis in the XY plane) and a twist about the bone, clamp
  // both, and store channels as { flex: swing angle, abd: 0, twist }.
  setSwingTwist(joint, q) {
    const { swing, twist } = quat.swingTwist(q, [0, 0, 1]);
    const swingAngle = quat.angle(swing);
    let twistAngle = quat.twistAngle(q, [0, 0, 1]);
    const L = joint.limits;
    const sMax = L.flex[1];
    let sq = swing;
    if (swingAngle > sMax) {
      // Scale the swing back onto the cone.
      const axis = v3.normalize([0, 0, 0], [swing[0], swing[1], swing[2]]);
      sq = quat.fromAxisAngle([0, 0, 0, 1], axis, sMax);
    }
    twistAngle = Math.min(L.twist[1], Math.max(L.twist[0], twistAngle));
    const tq = quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], twistAngle);
    quat.normalize(joint.localRot, quat.multiply([0, 0, 0, 1], sq, tq));
    joint.channels.flex = Math.min(swingAngle, sMax);
    joint.channels.abd = 0;
    joint.channels.twist = twistAngle;
    void twist;
    return joint;
  }

  // Channels measured back from a joint's pose rotation, in the joint's own convention.
  measureChannels(joint) {
    if (joint.cmcBasis) return this.measureCmc(joint);
    if (joint.swingTwist) return this.measureSwingTwistJoint(joint);
    if (joint.name === 'upper-arm') {
      const { swing } = quat.swingTwist(joint.localRot, [0, 0, 1]);
      return { flex: quat.angle(swing), abd: 0, twist: quat.twistAngle(joint.localRot, [0, 0, 1]) };
    }
    const c = quatToChannels(joint.localRot, joint.sideSign);
    return { flex: c.flex, abd: c.abd * joint.abdSign, twist: c.twist + (joint.twistOffset || 0) };
  }

  // Reset every joint to the rest pose.
  reset() {
    for (const j of this.joints) {
      j.channels.flex = 0; j.channels.abd = 0; j.channels.twist = j.twistOffset || 0;
      quat.identity(j.localRot);
      v3.set(j.localPos, 0, 0, 0);
    }
    return this.update();
  }

  // Forward kinematics: world = parent.world * restLocal * pose.
  update() {
    const tq = [0, 0, 0, 1];
    const tp = [0, 0, 0];
    for (const j of this.joints) {
      if (!j.parent) {
        v3.add(j.worldPos, j.restLocalPos, j.localPos);
        quat.multiply(j.worldRot, j.restLocalRot, j.localRot);
        continue;
      }
      const P = j.parent;
      v3.add(tp, j.restLocalPos, j.localPos);
      quat.rotate(tp, P.worldRot, tp);
      v3.add(j.worldPos, P.worldPos, tp);
      quat.multiply(tq, j.restLocalRot, j.localRot);
      quat.multiply(j.worldRot, P.worldRot, tq);
      quat.normalize(j.worldRot, j.worldRot);
    }
    return this;
  }

  // Flattened joint transforms for hashing: world position and rotation.
  transformValues() {
    const out = [];
    for (const j of this.joints) out.push(j.worldPos[0], j.worldPos[1], j.worldPos[2], j.worldRot[0], j.worldRot[1], j.worldRot[2], j.worldRot[3]);
    return out;
  }

  // World position of a bone's distal end (its child along the chain, or the
  // tip of a tip joint's parent).
  boneEnd(joint) {
    if (joint.children.length) return joint.children[0].worldPos;
    return joint.worldPos;
  }

  // Digit capsules (joint to next joint, bone radius) for a side.
  capsules(side) {
    const out = [];
    for (const j of this.sides[side].joints) {
      if (j.kind !== 'hand' || !j.digit || j.segment === 'tip') continue;
      const child = j.children[0];
      if (!child) continue;
      out.push({ joint: j, a: j.worldPos, b: child.worldPos, r: j.radius, digit: j.digit, segment: j.segment, side });
    }
    return out;
  }
}
