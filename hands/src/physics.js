// Interaction physics: a small deterministic rigid body layer, no third
// party engine. Fixed timestep with substeps, seeded, iteration order fixed,
// so a replay of the same calls gives the same state bit for bit.
//
// Bodies are spheres, boxes and capsules with mass, gravity, friction and
// restitution. They collide with the ground plane, with static boxes and
// capsules (tables, panels, rungs), with each other, and with kinematic
// capsules (the phalanges and metacarpals of the hands), which push them
// through contact impulses. Constraints: hinge and slider props (lever,
// switch, knob, door, button, drawer) as one degree of freedom each,
// fixed rungs as static capsules, and ropes as chains of points held by
// distance constraints.
//
// Frames: bodies store pos and a unit quaternion rot. A box has half
// extents hx, hy, hz; a capsule has radius r and half length h along its
// local Z (the axis the grasp solver's cylinder uses).
import { v3, quat, clamp, segmentDistance, pointSegmentDistance } from './math.js';
import { mulberry32 } from './rng.js';

export const GRAVITY = -9.81;
const SLOP = 0.0003;
const SPECULATIVE = 0.01; // m: contacts are found this far ahead
const BAUMGARTE = 0.8;
const BOUNCE_THRESHOLD = 0.6; // m/s: slower impacts do not bounce, so resting contacts stay still
const SLEEP_SPEED = 0.012;
const SLEEP_TIME = 0.4;
const ROLL_RESIST = 0.35; // m/s^2 of slowing for a sphere rolling on a surface

let nextId = 1;

function inertia(shape, m, d) {
  if (shape === 'sphere') { const i = 0.4 * m * d.r * d.r; return [i, i, i]; }
  if (shape === 'box') {
    const x = 2 * d.hx, y = 2 * d.hy, z = 2 * d.hz;
    return [m / 12 * (y * y + z * z), m / 12 * (x * x + z * z), m / 12 * (x * x + y * y)];
  }
  const L = 2 * d.h + 2 * d.r;
  const ixy = m / 12 * (3 * d.r * d.r + L * L);
  return [ixy, ixy, 0.5 * m * d.r * d.r];
}

export class Body {
  constructor(o) {
    this.id = nextId++;
    this.name = o.name || `body${this.id}`;
    this.shape = o.shape;
    this.r = o.r || 0;
    this.h = o.h || 0;
    this.hx = o.hx || 0; this.hy = o.hy || 0; this.hz = o.hz || 0;
    this.round = o.round || 0;
    this.mass = o.mass ?? 1;
    this.invMass = this.mass > 0 ? 1 / this.mass : 0;
    this.I = inertia(this.shape, this.mass, this);
    this.invI = this.I.map((v) => (v > 0 ? 1 / v : 0));
    this.pos = (o.pos || [0, 0, 0]).slice();
    this.rot = (o.rot || [0, 0, 0, 1]).slice();
    this.vel = (o.vel || [0, 0, 0]).slice();
    this.ang = (o.ang || [0, 0, 0]).slice();
    this.friction = o.friction ?? 0.6;
    this.restitution = o.restitution ?? 0.2;
    this.linDamp = o.linDamp ?? 0.05;
    this.angDamp = o.angDamp ?? 0.4;
    this.kinematic = false; // true while a hand holds it
    this.heldBy = null;
    this.sleepT = 0;
    this.asleep = false;
    this.kind = o.kind || this.shape;
    this.userData = o.userData || {};
    this.contactThisStep = { hand: false, body: false, stat: false };
    // Extra parts in the body frame (a crate's handle, a bag's strap): hands
    // touch and grasp them; they ride the body. { name, shape, pos, rot, r, h, hx, hy, hz }
    this.parts = (o.parts || []).map((p) => ({ rot: [0, 0, 0, 1], pos: [0, 0, 0], ...p }));
  }
  partWorld(part) {
    return { ...part, pos: v3.add([0, 0, 0], this.pos, quat.rotate([0, 0, 0], this.rot, part.pos)), rot: quat.multiply([0, 0, 0, 1], this.rot, part.rot) };
  }
  // The shape the grasp solver closes on, in world space.
  graspShape() {
    if (this.shape === 'sphere') return { shape: 'sphere', r: this.r, pos: this.pos, rot: this.rot };
    if (this.shape === 'capsule') return { shape: 'cylinder', r: this.r, h: this.h + this.r * 0.6, pos: this.pos, rot: this.rot };
    return { shape: this.round ? 'pillow' : 'box', hx: this.hx, hy: this.hy, hz: this.hz, round: this.round, pos: this.pos, rot: this.rot };
  }
  // World inverse inertia applied to a vector.
  invIw(v) {
    const inv = quat.conjugate([0, 0, 0, 1], this.rot);
    const l = quat.rotate([0, 0, 0], inv, v);
    return quat.rotate([0, 0, 0], this.rot, [l[0] * this.invI[0], l[1] * this.invI[1], l[2] * this.invI[2]]);
  }
  velAt(p) {
    const r = v3.sub([0, 0, 0], p, this.pos);
    return v3.add([0, 0, 0], this.vel, v3.cross([0, 0, 0], this.ang, r));
  }
  lowest() {
    if (this.shape === 'sphere') return this.pos[1] - this.r;
    if (this.shape === 'capsule') { const a = quat.rotate([0, 0, 0], this.rot, [0, 0, this.h]); return this.pos[1] - Math.abs(a[1]) - this.r; }
    let lo = Infinity;
    for (const c of boxCorners(this)) lo = Math.min(lo, c[1]);
    return lo;
  }
  wake() { this.asleep = false; this.sleepT = 0; }
}

// A prop with one degree of freedom: a hinge (rotation q about axis through
// anchor) or a slider (translation q along axis). Its collision parts are
// boxes, spheres and capsules given in the prop's frame at q = 0.
export class Prop {
  constructor(o) {
    this.id = nextId++;
    this.name = o.name;
    this.type = o.type; // 'hinge' | 'slider'
    this.anchor = o.anchor.slice();
    this.axis = v3.normalize([0, 0, 0], o.axis);
    this.baseRot = (o.rot || [0, 0, 0, 1]).slice(); // prop frame orientation at q = 0
    this.q = o.q ?? 0;
    this.qd = 0;
    this.min = o.min;
    this.max = o.max;
    this.inertia = o.inertia ?? 0.02; // kg m^2 for a hinge, kg for a slider
    this.damping = o.damping ?? 0.5;
    this.spring = o.spring || null; // { k, rest } return spring (button)
    this.detents = o.detents || null; // { wells: [q...], k } bistable snap (switch)
    this.friction = o.friction ?? 0; // resisting torque or force (lever, drawer)
    this.parts = o.parts.map((p) => ({ ...p }));
    this.driver = null; // { hand, target(q) } set by a hand that holds a part
    this.touchedThisStep = false;
    this.userData = o.userData || {};
  }
  rotAt(q = this.q) {
    if (this.type === 'hinge') return quat.multiply([0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], this.axis, q), this.baseRot);
    return this.baseRot.slice();
  }
  originAt(q = this.q) {
    return this.type === 'slider' ? v3.addScaled([0, 0, 0], this.anchor, this.axis, q) : this.anchor.slice();
  }
  // World pose of a point and frame given in the prop frame.
  worldPoint(local, q = this.q) { return v3.add([0, 0, 0], this.originAt(q), quat.rotate([0, 0, 0], this.rotAt(q), local)); }
  worldRot(localRot = [0, 0, 0, 1], q = this.q) { return quat.multiply([0, 0, 0, 1], this.rotAt(q), localRot); }
  // d(point)/dq for a world point attached to the prop.
  jacobian(p) {
    if (this.type === 'slider') return this.axis.slice();
    return v3.cross([0, 0, 0], this.axis, v3.sub([0, 0, 0], p, this.anchor));
  }
  partWorld(part, q = this.q) {
    const pos = this.worldPoint(part.pos || [0, 0, 0], q);
    const rot = this.worldRot(part.rot || [0, 0, 0, 1], q);
    return { ...part, pos, rot };
  }
  // Coordinate that brings a point fixed on the prop (local) nearest to a world point.
  project(local, target) {
    if (this.type === 'slider') {
      const p0 = this.worldPoint(local, 0);
      return clamp(v3.dot(v3.sub([0, 0, 0], target, p0), this.axis), this.min, this.max);
    }
    const p0 = v3.sub([0, 0, 0], this.worldPoint(local, 0), this.anchor);
    const t = v3.sub([0, 0, 0], target, this.anchor);
    const a = v3.reject([0, 0, 0], p0, this.axis);
    const b = v3.reject([0, 0, 0], t, this.axis);
    if (v3.len(a) < 1e-9 || v3.len(b) < 1e-9) return this.q;
    const ang = Math.atan2(v3.dot(v3.cross([0, 0, 0], a, b), this.axis), v3.dot(a, b));
    // Unwrap to the branch nearest the current angle.
    let q = ang;
    while (q - this.q > Math.PI) q -= 2 * Math.PI;
    while (q - this.q < -Math.PI) q += 2 * Math.PI;
    return clamp(q, this.min, this.max);
  }
  // Generalised force from springs, detents and friction (not the driver).
  passiveForce() {
    let f = -this.damping * this.qd;
    if (this.spring) f += -this.spring.k * (this.q - this.spring.rest);
    if (this.detents) {
      // Bistable: pulled toward the nearest well.
      let best = this.detents.wells[0];
      for (const w of this.detents.wells) if (Math.abs(this.q - w) < Math.abs(this.q - best)) best = w;
      f += -this.detents.k * (this.q - best);
    }
    return f;
  }
}

// A rope: a chain of points held by distance constraints, the top pinned.
export class Rope {
  constructor(o) {
    this.id = nextId++;
    this.name = o.name || 'rope';
    this.n = o.segments + 1;
    this.segLen = o.length / o.segments;
    this.r = o.r ?? 0.012;
    this.top = o.top.slice();
    this.points = [];
    this.prev = [];
    for (let i = 0; i < this.n; i++) {
      const p = [this.top[0], this.top[1] - i * this.segLen, this.top[2]];
      this.points.push(p);
      this.prev.push(p.slice());
    }
    this.pins = new Map([[0, this.top.slice()]]); // index -> world position
    this.damping = o.damping ?? 0.02;
    this.iterations = o.iterations ?? 60; // enough passes that a rope does not visibly stretch
  }
  pin(i, pos) { this.pins.set(i, pos.slice()); }
  unpin(i) { if (i !== 0) this.pins.delete(i); }
  nearestIndex(p) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.n; i++) { const d = v3.dist(this.points[i], p); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  // Segment near index i as a cylinder for the grasp solver.
  graspShape(i) {
    const a = this.points[Math.max(0, i - 1)];
    const b = this.points[Math.min(this.n - 1, i + 1)];
    const mid = v3.lerp([0, 0, 0], a, b, 0.5);
    const dir = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], b, a));
    return { shape: 'cylinder', r: this.r, h: v3.dist(a, b) / 2 + 0.02, pos: mid, rot: quat.fromTo([0, 0, 0, 1], [0, 0, 1], dir) };
  }
  step(dt, g) {
    for (let i = 0; i < this.n; i++) {
      if (this.pins.has(i)) continue;
      const p = this.points[i];
      const q = this.prev[i];
      const vx = (p[0] - q[0]) * (1 - this.damping);
      const vy = (p[1] - q[1]) * (1 - this.damping);
      const vz = (p[2] - q[2]) * (1 - this.damping);
      v3.copy(q, p);
      p[0] += vx; p[1] += vy + g * dt * dt; p[2] += vz;
    }
    for (const [i, pos] of this.pins) { v3.copy(this.prev[i], this.points[i]); v3.copy(this.points[i], pos); }
    for (let it = 0; it < this.iterations; it++) {
      for (let i = 0; i + 1 < this.n; i++) {
        const a = this.points[i];
        const b = this.points[i + 1];
        const d = v3.sub([0, 0, 0], b, a);
        const len = v3.len(d) || 1e-9;
        const diff = (len - this.segLen) / len;
        const wa = this.pins.has(i) ? 0 : 1;
        const wb = this.pins.has(i + 1) ? 0 : 1;
        if (wa + wb === 0) continue;
        v3.addScaled(a, a, d, (diff * wa) / (wa + wb));
        v3.addScaled(b, b, d, (-diff * wb) / (wa + wb));
      }
    }
  }
  // Longest stretch of any segment relative to its rest length.
  maxStretch() {
    let worst = 0;
    for (let i = 0; i + 1 < this.n; i++) worst = Math.max(worst, Math.abs(v3.dist(this.points[i], this.points[i + 1]) - this.segLen) / this.segLen);
    return worst;
  }
}

// ---- geometry helpers ---------------------------------------------------

// A sphere round a shape (a body with its parts, a static, a prop part).
function boundOf(x) {
  let c;
  let r;
  if (x.shape === 'capsule' && x.a) { c = v3.lerp([0, 0, 0], x.a, x.b, 0.5); r = v3.dist(x.a, x.b) / 2 + x.r; } else {
    c = x.pos;
    r = x.shape === 'sphere' ? x.r : x.shape === 'capsule' ? (x.h || 0) + x.r : Math.hypot(x.hx || 0, x.hy || 0, x.hz || 0);
  }
  if (x.parts && x.parts.length) {
    for (const p of x.parts) {
      const reach = v3.len(p.pos || [0, 0, 0]) + (p.shape === 'sphere' ? p.r : p.shape === 'capsule' ? (p.h || 0) + p.r : Math.hypot(p.hx || 0, p.hy || 0, p.hz || 0));
      r = Math.max(r, reach);
    }
  }
  return { c, r };
}

// Corners, edge midpoints and face centres: enough points that two boxes
// resting edge across edge (a key across a narrow post) still touch.
export function boxSamples(b) {
  const out = [];
  for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
    if (sx === 0 && sy === 0 && sz === 0) continue;
    out.push(v3.add([0, 0, 0], b.pos, quat.rotate([0, 0, 0], b.rot, [sx * b.hx, sy * b.hy, sz * b.hz])));
  }
  return out;
}

export function boxCorners(b) {
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(v3.add([0, 0, 0], b.pos, quat.rotate([0, 0, 0], b.rot, [sx * b.hx, sy * b.hy, sz * b.hz])));
  }
  return out;
}

// Closest point on an oriented box to p, and whether p is inside.
export function closestOnBox(box, p) {
  const inv = quat.conjugate([0, 0, 0, 1], box.rot);
  const l = quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], p, box.pos));
  const h = [box.hx, box.hy, box.hz];
  const c = [clamp(l[0], -h[0], h[0]), clamp(l[1], -h[1], h[1]), clamp(l[2], -h[2], h[2])];
  const inside = Math.abs(l[0]) < h[0] && Math.abs(l[1]) < h[1] && Math.abs(l[2]) < h[2];
  let faceN = null;
  let faceDepth = 0;
  if (inside) {
    // Nearest face: push out along it.
    let best = Infinity;
    let axis = 0;
    for (let i = 0; i < 3; i++) { const d = h[i] - Math.abs(l[i]); if (d < best) { best = d; axis = i; } }
    const n = [0, 0, 0];
    n[axis] = Math.sign(l[axis]) || 1;
    faceN = quat.rotate([0, 0, 0], box.rot, n);
    faceDepth = best;
    c[axis] = Math.sign(l[axis]) * h[axis];
  }
  return { point: v3.add([0, 0, 0], box.pos, quat.rotate([0, 0, 0], box.rot, c)), inside, faceN, faceDepth };
}

// Sphere (c, r) against a box: contact pushing the sphere out, or null.
function sphereBox(c, r, box) {
  const q = closestOnBox(box, c);
  if (q.inside) return { n: q.faceN, depth: r + q.faceDepth, point: q.point };
  const d = v3.sub([0, 0, 0], c, q.point);
  const dist = v3.len(d);
  if (dist >= r) return null;
  return { n: v3.scale([0, 0, 0], d, 1 / (dist || 1)), depth: r - dist, point: q.point };
}

// Segment (a, b, r) against a box: deepest of samples along the segment.
function segmentBox(a, b, r, box, samples = 6) {
  let best = null;
  for (let i = 0; i <= samples; i++) {
    const c = v3.lerp([0, 0, 0], a, b, i / samples);
    const k = sphereBox(c, r, box);
    if (k && (!best || k.depth > best.depth)) best = { ...k, at: c };
  }
  return best;
}

function capsuleEnds(b) {
  const d = quat.rotate([0, 0, 0], b.rot, [0, 0, b.h]);
  return [v3.sub([0, 0, 0], b.pos, d), v3.add([0, 0, 0], b.pos, d)];
}

// ---- the world ----------------------------------------------------------

export class World {
  constructor({ seed = 1, gravity = GRAVITY, groundY = -1.55, substeps = 2, iterations = 10 } = {}) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.gravity = gravity;
    this.groundY = groundY;
    this.substeps = substeps;
    this.iterations = iterations;
    this.bodies = [];
    this.statics = []; // { shape: 'box'|'capsule', pos, rot, hx..., a, b, r, name, friction }
    this.props = [];
    this.ropes = [];
    this.handCaps = []; // kinematic capsules: { a, b, r, va, vb, side, name, digit, segment }
    // Tethers: a point on a body pulled to a moving point (a hand's grip on
    // a handle while dragging), with at most `strength` newtons.
    this.tethers = [];
    this.time = 0;
    this.frame = 0;
    this.contacts = [];
    this.log = []; // per step contact summary for checks: { frame, body, hand }
    this.listeners = [];
  }

  add(o) {
    if (o instanceof Prop) { this.props.push(o); return o; }
    if (o instanceof Rope) { this.ropes.push(o); return o; }
    const b = o instanceof Body ? o : new Body(o);
    this.bodies.push(b);
    return b;
  }
  addStatic(s) {
    const st = { friction: 0.7, restitution: 0.1, rot: [0, 0, 0, 1], ...s };
    this.statics.push(st);
    return st;
  }
  body(name) { return this.bodies.find((b) => b.name === name) || null; }
  prop(name) { return this.props.find((p) => p.name === name) || null; }
  rope(name) { return this.ropes.find((r) => r.name === name) || null; }
  onContact(fn) { this.listeners.push(fn); }

  // Kinematic hand capsules for this step, with the velocity each end moved at.
  setHandCapsules(caps, dt) {
    const prev = new Map(this.handCaps.map((c) => [c.key, c]));
    this.handCaps = caps.map((c) => {
      const key = `${c.side}:${c.name}`;
      const p = prev.get(key);
      const va = p && dt > 0 ? v3.scale([0, 0, 0], v3.sub([0, 0, 0], c.a, p.a), 1 / dt) : [0, 0, 0];
      const vb = p && dt > 0 ? v3.scale([0, 0, 0], v3.sub([0, 0, 0], c.b, p.b), 1 / dt) : [0, 0, 0];
      return { ...c, a: c.a.slice(), b: c.b.slice(), va, vb, key };
    });
  }

  // Static and prop colliders as boxes, spheres or capsules in world space.
  staticShapes() {
    const out = this.statics.slice();
    for (const p of this.props) for (const part of p.parts) if (part.collide !== false) out.push({ ...p.partWorld(part), prop: p });
    return out;
  }

  step(dt) {
    // Contact flags cover the whole step: any substep that touched counts.
    for (const b of this.bodies) b.contactThisStep = { hand: false, body: false, stat: false };
    for (const p of this.props) p.touchedThisStep = Boolean(p.driver);
    const h = dt / this.substeps;
    for (let s = 0; s < this.substeps; s++) this.substep(h);
    for (const r of this.ropes) r.step(dt, this.gravity);
    this.time += dt;
    this.frame++;
  }

  substep(dt) {
    // Forces.
    for (const b of this.bodies) {
      if (b.kinematic || b.asleep) continue;
      b.vel[1] += this.gravity * dt;
    }
    this.stepProps(dt);
    // Speculative contacts: anything within reach this substep, so a body
    // stops at the surface instead of sinking in and being pushed back.
    const contacts = this.detect(SPECULATIVE);
    this.dt = dt;
    this.contacts = contacts;
    // Velocity iterations: sequential impulses with Coulomb friction, and
    // the tethers of hands dragging bodies.
    for (const c of contacts) { c.jn = 0; c.jt = null; }
    for (const t of this.tethers) { t.acc = [0, 0, 0]; t.saturated = false; t.body.wake(); t.body.contactThisStep.hand = true; }
    for (let it = 0; it < this.iterations; it++) {
      for (const c of contacts) this.solveContact(c, it === 0);
      for (const t of this.tethers) this.solveTether(t, dt);
    }
    // Integrate.
    for (const b of this.bodies) {
      if (b.kinematic || b.asleep) continue;
      v3.addScaled(b.pos, b.pos, b.vel, dt);
      const w = b.ang;
      const wl = Math.hypot(w[0], w[1], w[2]);
      if (wl > 1e-9) b.rot = quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], quat.fromAxisAngle([0, 0, 0, 1], [w[0] / wl, w[1] / wl, w[2] / wl], wl * dt), b.rot));
      const ld = Math.max(0, 1 - b.linDamp * dt);
      const ad = Math.max(0, 1 - b.angDamp * dt);
      v3.scale(b.vel, b.vel, ld);
      v3.scale(b.ang, b.ang, ad);
      // Rolling resistance: a ball or pebble rolling on a surface slows to a
      // stop instead of rolling on for ever (no real one is a perfect sphere).
      if ((b.shape === 'sphere' || b.shape === 'capsule') && (b.contactThisStep.stat || b.contactThisStep.body)) {
        const v = v3.len(b.vel);
        if (v > 1e-9) v3.scale(b.vel, b.vel, Math.max(0, v - ROLL_RESIST * dt) / v);
        const w = v3.len(b.ang);
        if (w > 1e-9) v3.scale(b.ang, b.ang, Math.max(0, w - (ROLL_RESIST / b.r) * dt) / w);
      }
    }
    // Position projection so resting contacts never sink: per body the
    // deepest contact each pass, so the corners of a box do not add up.
    for (let it = 0; it < 4; it++) {
      const cs = this.detect(0).filter((c) => c.depth > SLOP);
      if (!cs.length) break;
      const deepest = new Map();
      for (const c of cs) {
        const key = c.kind === 'prop' ? `p${c.prop.id}` : `b${c.A.id}`;
        const d = deepest.get(key);
        if (!d || c.depth > d.depth) deepest.set(key, c);
      }
      for (const c of deepest.values()) this.project(c);
    }
    // Sleep bodies that have come to rest on something.
    for (const b of this.bodies) {
      if (b.kinematic) { b.asleep = false; continue; }
      const slow = v3.len(b.vel) < SLEEP_SPEED && v3.len(b.ang) < SLEEP_SPEED * 10;
      const supported = b.contactThisStep.stat || b.contactThisStep.body;
      if (slow && supported && !b.contactThisStep.hand) {
        b.sleepT += dt;
        if (b.sleepT > SLEEP_TIME) { b.asleep = true; v3.set(b.vel, 0, 0, 0); v3.set(b.ang, 0, 0, 0); }
      } else { b.sleepT = 0; if (b.asleep && (b.contactThisStep.hand || !supported)) b.asleep = false; }
    }
  }

  // Props a hand holds step before the hands do (Interaction.pre), so the
  // hand that follows them lands where they are.
  stepDriven(dt) {
    const h = dt / this.substeps;
    for (let s = 0; s < this.substeps; s++) this.stepProps(h, true);
  }

  // 1 DOF props: passive forces, the driving hand, limits.
  stepProps(dt, driven = false) {
    for (const p of this.props) {
      if (Boolean(p.driver) !== driven) continue;
      let f = p.passiveForce();
      if (p.driver) {
        // The holding hand pulls the prop toward where its grip wants to be,
        // with at most the hand's strength; friction resists the motion.
        const want = p.driver.target();
        const pull = clamp(p.driver.stiffness * (want - p.q) - p.driver.damping * p.qd, -p.driver.strength, p.driver.strength);
        f += pull;
        p.touchedThisStep = true;
      }
      if (p.friction > 0) {
        if (Math.abs(p.qd) > 1e-4) f -= Math.sign(p.qd) * p.friction;
        else if (Math.abs(f) <= p.friction) f = 0;
        else f -= Math.sign(f) * p.friction;
      }
      p.qd += (f / p.inertia) * dt;
      p.q += p.qd * dt;
      if (p.q < p.min) { p.q = p.min; if (p.qd < 0) p.qd = 0; }
      if (p.q > p.max) { p.q = p.max; if (p.qd > 0) p.qd = 0; }
    }
  }

  // Contacts: { A (dynamic body), B (body or null), n from B into A, point, depth, vB, mu, e, kind }.
  detect(margin = 0) {
    this.margin = margin;
    const out = [];
    const statics = this.staticShapes();
    const dyn = this.bodies;
    // Broad phase: bounding spheres (parts included) keep the narrow phase
    // to the pairs that could touch; same order, so still deterministic.
    const pad = margin + SPECULATIVE;
    const sb = statics.map((st) => boundOf(st));
    const db = dyn.map((b) => boundOf(b));
    const near = (a, b) => v3.dist(a.c, b.c) <= a.r + b.r + pad;
    const hb = this.handCaps.map((hc) => ({ c: v3.lerp([0, 0, 0], hc.a, hc.b, 0.5), r: v3.dist(hc.a, hc.b) / 2 + hc.r }));
    for (let i = 0; i < dyn.length; i++) {
      const A = dyn[i];
      // Ground.
      this.vsGround(A, out);
      for (let k = 0; k < statics.length; k++) if (near(db[i], sb[k])) this.vsShape(A, statics[k], out, 'stat');
      for (let k = i + 1; k < dyn.length; k++) if (near(db[i], db[k])) this.vsBody(A, dyn[k], out);
      if (A.kinematic) continue;
      for (let h = 0; h < this.handCaps.length; h++) {
        const hc = this.handCaps[h];
        if (!near(db[i], hb[h])) continue;
        if (A.heldBy && A.heldBy.includes(hc.side)) continue;
        if (A.letGo && A.letGo.hand === hc.side && this.time < A.letGo.until) continue; // fingers opening off a handle
        if (A.ignoreHands && A.ignoreHands.includes(hc.side)) continue; // a hand about to catch it
        this.vsHand(A, hc, out);
      }
    }
    // Hands pushing props through contact.
    for (const p of this.props) {
      if (p.driver) continue;
      for (const part of p.parts) {
        if (part.collide === false) continue;
        const w = p.partWorld(part);
        const wb = boundOf(w);
        for (let h = 0; h < this.handCaps.length; h++) {
          const hc = this.handCaps[h];
          if (!near(wb, hb[h])) continue;
          // A hand that has just let go of this prop opens off it without
          // knocking it (the fingers leave the handle as they open).
          if (p.letGo && p.letGo.hand === hc.side && this.time < p.letGo.until) continue;
          const k = this.capsuleVsShape(hc.a, hc.b, hc.r + margin, w);
          if (k) out.push({ prop: p, part, hand: hc, n: k.n, point: k.point, depth: k.depth - margin, kind: 'prop' });
        }
      }
    }
    return out;
  }

  vsGround(A, out) {
    if (A.kinematic) return;
    const pts = A.shape === 'sphere' ? [[A.pos, A.r]] : A.shape === 'capsule' ? capsuleEnds(A).map((e) => [e, A.r]) : boxCorners(A).map((c) => [c, 0]);
    for (const [p, r] of pts) {
      const depth = this.groundY + r - p[1];
      if (depth > -this.margin) out.push({ A, B: null, n: [0, 1, 0], point: [p[0], this.groundY, p[2]], depth, vB: [0, 0, 0], mu: A.friction * 0.9, e: A.restitution, kind: 'stat' });
    }
  }

  // Shape in world space vs a dynamic body.
  vsShape(A, s, out, kind) {
    if (A.kinematic) return;
    const m = this.margin;
    const push = (k, pointOnA) => out.push({ A, B: null, n: k.n, point: pointOnA || k.point, depth: k.depth - m, vB: [0, 0, 0], mu: Math.sqrt(A.friction * (s.friction ?? 0.7)), e: Math.min(A.restitution, s.restitution ?? 0.2), kind, prop: s.prop || null });
    if (A.shape === 'sphere') {
      const k = this.sphereVsShape(A.pos, A.r + m, s);
      if (k) push(k);
    } else if (A.shape === 'capsule') {
      const [a, b] = capsuleEnds(A);
      const k = this.capsuleVsShape(a, b, A.r + m, s);
      if (k) push({ ...k, n: v3.negate([0, 0, 0], k.n) });
    } else {
      // Box: its corners, edges and faces inside the shape, and the shape's inside it.
      for (const c of (s.shape === 'box' ? boxSamples(A) : boxCorners(A))) {
        const k = this.sphereVsShape(c, m, s);
        if (k) push(k, c);
      }
      if (s.shape === 'box') {
        for (const c of boxSamples(s)) {
          const q = closestOnBox(A, c);
          if (q.inside) push({ n: v3.negate([0, 0, 0], q.faceN), depth: q.faceDepth + m, point: c }, c);
        }
      }
    }
  }

  // Sphere (c, r) vs a static shape: n pushes the sphere out.
  sphereVsShape(c, r, s) {
    if (s.shape === 'box') return sphereBox(c, r, s);
    if (s.shape === 'sphere') {
      const d = v3.sub([0, 0, 0], c, s.pos);
      const L = v3.len(d);
      if (L >= r + s.r) return null;
      return { n: v3.scale([0, 0, 0], d, 1 / (L || 1)), depth: r + s.r - L, point: v3.addScaled([0, 0, 0], s.pos, d, s.r / (L || 1)) };
    }
    if (s.shape === 'capsule') {
      const [a, b] = s.a ? [s.a, s.b] : capsuleEnds(s);
      const q = pointSegmentDistance(c, a, b);
      if (q.d >= r + s.r) return null;
      const d = v3.sub([0, 0, 0], c, q.q);
      return { n: v3.scale([0, 0, 0], d, 1 / (q.d || 1)), depth: r + s.r - q.d, point: v3.addScaled([0, 0, 0], q.q, d, s.r / (q.d || 1)) };
    }
    return null;
  }

  // Capsule segment (a, b, r) vs a shape: n points from the capsule into the shape.
  capsuleVsShape(a, b, r, s) {
    if (s.shape === 'box') {
      const k = segmentBox(a, b, r, s);
      return k ? { n: v3.negate([0, 0, 0], k.n), depth: k.depth, point: k.point } : null;
    }
    if (s.shape === 'sphere') {
      const q = pointSegmentDistance(s.pos, a, b);
      if (q.d >= r + s.r) return null;
      const d = v3.sub([0, 0, 0], s.pos, q.q);
      return { n: v3.scale([0, 0, 0], d, 1 / (q.d || 1)), depth: r + s.r - q.d, point: v3.addScaled([0, 0, 0], s.pos, d, -s.r / (q.d || 1)) };
    }
    if (s.shape === 'capsule') {
      const [c, e] = s.a ? [s.a, s.b] : capsuleEnds(s);
      const q = segmentDistance(a, b, c, e);
      if (q.d >= r + s.r) return null;
      const d = v3.sub([0, 0, 0], q.pb, q.pa);
      return { n: v3.scale([0, 0, 0], d, 1 / (q.d || 1)), depth: r + s.r - q.d, point: v3.addScaled([0, 0, 0], q.pb, d, -s.r / (q.d || 1)) };
    }
    return null;
  }

  vsBody(A, B, out) {
    if (A.kinematic && B.kinematic) return;
    // Treat the second body as a shape; the contact acts on both.
    const shapeB = B.shape === 'capsule' ? { shape: 'capsule', a: capsuleEnds(B)[0], b: capsuleEnds(B)[1], r: B.r } : B;
    const shapeA = A.shape === 'capsule' ? { shape: 'capsule', a: capsuleEnds(A)[0], b: capsuleEnds(A)[1], r: A.r } : A;
    const tmp = [];
    if (!A.kinematic) this.vsShape(A, shapeB, tmp, 'body');
    else {
      this.vsShape(B, shapeA, tmp, 'body');
      for (const c of tmp) out.push({ ...c, A: B, B: A, vB: A.velAt(c.point) });
      return;
    }
    for (const c of tmp) out.push({ ...c, B, vB: null });
  }

  vsHand(A, hc0, out) {
    const hc = this.margin ? { ...hc0, r: hc0.r + this.margin } : hc0;
    let k = null;
    if (A.shape === 'sphere') {
      const q = pointSegmentDistance(A.pos, hc.a, hc.b);
      if (q.d < A.r + hc.r) {
        const d = v3.sub([0, 0, 0], A.pos, q.q);
        k = { n: v3.scale([0, 0, 0], d, 1 / (q.d || 1)), depth: A.r + hc.r - q.d, point: v3.addScaled([0, 0, 0], q.q, d, hc.r / (q.d || 1)), t: q.t };
      }
    } else if (A.shape === 'capsule') {
      const [a, b] = capsuleEnds(A);
      const q = segmentDistance(a, b, hc.a, hc.b);
      if (q.d < A.r + hc.r) {
        const d = v3.sub([0, 0, 0], q.pa, q.pb);
        k = { n: v3.scale([0, 0, 0], d, 1 / (q.d || 1)), depth: A.r + hc.r - q.d, point: v3.addScaled([0, 0, 0], q.pb, d, hc.r / (q.d || 1)), t: q.t };
      }
    } else {
      const s = segmentBox(hc.a, hc.b, hc.r, A);
      if (s) k = { n: v3.negate([0, 0, 0], s.n), depth: s.depth, point: s.point, t: pointSegmentDistance(s.at, hc.a, hc.b).t };
    }
    for (const part of A.parts) {
      const w = A.partWorld(part);
      const q = this.capsuleVsShape(hc.a, hc.b, hc.r, w);
      if (q && (!k || q.depth > k.depth)) k = { n: v3.negate([0, 0, 0], q.n), depth: q.depth, point: q.point, t: pointSegmentDistance(q.point, hc.a, hc.b).t };
    }
    if (!k) return;
    // The capsules are already where the hand is at the end of this step, so
    // a hand still apart from the body is a fixed wall for it: carrying the
    // hand's last speed forward would push away things it never reaches (a
    // reaching hand slows as it arrives). Once touching, the hand moves the
    // body with its own velocity.
    const vB = k.depth - this.margin > -0.001 ? v3.lerp([0, 0, 0], hc.va, hc.vb, k.t) : [0, 0, 0];
    out.push({ A, B: null, hand: hc0, n: k.n, point: k.point, depth: k.depth - this.margin, vB, mu: A.friction, e: 0, kind: 'hand' });
  }

  // Height of the highest surface under a body (static tops it sits over,
  // or the ground): where it lands if set down or dropped straight.
  surfaceBelow(body) {
    const low = body.lowest();
    // Points across the body's underside: a capsule rests on whatever is
    // under any part of its length (the posts of a rack), a box on whatever
    // is under a corner or its middle.
    let pts;
    let r = 0;
    if (body.shape === 'sphere') { pts = [body.pos]; r = body.r * 0.3; } else if (body.shape === 'capsule') {
      const [a, b] = capsuleEnds(body);
      pts = [0, 0.25, 0.5, 0.75, 1].map((u) => v3.lerp([0, 0, 0], a, b, u));
      r = body.r * 0.5;
    } else pts = [body.pos, ...boxCorners(body)];
    let best = this.groundY;
    for (const p of pts) best = Math.max(best, this.surfaceUnder([p[0], low + 0.01, p[2]], r));
    return best;
  }

  // The highest static top under a point (within r of it across), not above it.
  surfaceUnder(p, r = 0) {
    let best = this.groundY;
    for (const s of this.statics) {
      if (s.shape !== 'box') continue;
      const inv = quat.conjugate([0, 0, 0, 1], s.rot || [0, 0, 0, 1]);
      const l = quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], p, s.pos));
      const top = s.pos[1] + s.hy;
      if (Math.abs(l[0]) <= s.hx + r && Math.abs(l[2]) <= s.hz + r && top <= p[1] + 0.005 && top > best) best = top;
    }
    return best;
  }

  // Is a body resting on something (within tol metres of a surface under it)?
  isSupported(body, tol = 0.002) {
    const was = body.kinematic;
    body.kinematic = false;
    const out = [];
    this.margin = tol;
    this.vsGround(body, out);
    for (const s of this.statics) this.vsShape(body, s, out, 'stat');
    for (const b of this.bodies) if (b !== body && !(b.heldBy && b.heldBy.length)) this.vsShape(body, b.shape === 'capsule' ? { shape: 'capsule', a: capsuleEnds(b)[0], b: capsuleEnds(b)[1], r: b.r } : b, out, 'body');
    body.kinematic = was;
    this.margin = 0;
    return out.some((c) => c.n[1] > 0.7);
  }

  solveContact(c, first) {
    if (c.kind === 'prop') return this.solvePropContact(c, first);
    const A = c.A;
    const B = c.B;
    if (A.kinematic) return;
    const rA = v3.sub([0, 0, 0], c.point, A.pos);
    const vA = A.velAt(c.point);
    const vB = c.vB || (B ? B.velAt(c.point) : [0, 0, 0]);
    const vrel = v3.sub([0, 0, 0], vA, vB);
    const vn = v3.dot(vrel, c.n);
    const bDyn = B && !B.kinematic;
    const rB = bDyn ? v3.sub([0, 0, 0], c.point, B.pos) : null;
    const k = (dir) => {
      let m = A.invMass + v3.dot(v3.cross([0, 0, 0], A.invIw(v3.cross([0, 0, 0], rA, dir)), rA), dir);
      if (bDyn) m += B.invMass + v3.dot(v3.cross([0, 0, 0], B.invIw(v3.cross([0, 0, 0], rB, dir)), rB), dir);
      return m;
    };
    if (first && c.depth > -0.001) {
      A.contactThisStep[c.kind === 'hand' ? 'hand' : c.kind === 'body' ? 'body' : 'stat'] = true;
      if (bDyn) B.contactThisStep.body = true;
      if (c.kind === 'hand' || (B && B.kinematic)) A.wake();
    }
    // A fast impact bounces, whether it lands this substep or has just landed.
    if (first) c.bias = vn < -BOUNCE_THRESHOLD && (c.depth > -0.001 || -c.depth < -vn * this.dt) ? -c.e * vn : 0;
    const kn = k(c.n);
    // A contact still apart may close its gap this substep but not more.
    const gap = Math.max(0, -c.depth);
    let dj = (-vn - gap / this.dt + c.bias) / kn;
    const old = c.jn;
    c.jn = Math.max(0, old + dj);
    dj = c.jn - old;
    const J = v3.scale([0, 0, 0], c.n, dj);
    this.applyImpulse(A, J, rA);
    if (bDyn) this.applyImpulse(B, v3.negate([0, 0, 0], J), rB);
    // Friction: accumulated tangent impulse clamped to the Coulomb cone.
    const vA2 = A.velAt(c.point);
    const vB2 = c.vB || (B ? B.velAt(c.point) : [0, 0, 0]);
    const vr2 = v3.sub([0, 0, 0], vA2, vB2);
    const vt = v3.reject([0, 0, 0], vr2, c.n);
    const vtl = v3.len(vt);
    if (!c.jt) c.jt = [0, 0, 0];
    if (vtl > 1e-9) {
      const t = v3.scale([0, 0, 0], vt, 1 / vtl);
      const want = v3.addScaled([0, 0, 0], c.jt, t, -vtl / k(t));
      const L = v3.len(want);
      const cap = c.mu * c.jn;
      if (L > cap) v3.scale(want, want, cap / L);
      const dJt = v3.sub([0, 0, 0], want, c.jt);
      c.jt = want;
      this.applyImpulse(A, dJt, rA);
      if (bDyn) this.applyImpulse(B, v3.negate([0, 0, 0], dJt), rB);
    }
    if (c.kind === 'hand' && first && c.depth > -0.001) this.emit({ type: 'contact', body: A, hand: c.hand.side, digit: c.hand.digit, segment: c.hand.segment, point: c.point });
  }

  // A hand capsule pushing a free prop part: resolve along the prop's one
  // degree of freedom with the hand as an immovable pusher.
  solvePropContact(c, first) {
    const p = c.prop;
    // u: from the hand into the part (the contact normal). The part moves
    // along u at ju * qd; the hand at vH.
    const u = c.n;
    const ju = v3.dot(p.jacobian(c.point), u);
    if (Math.abs(ju) < 1e-9) return;
    const vPart = p.qd * ju;
    const vH = v3.dot(v3.lerp([0, 0, 0], c.hand.va, c.hand.vb, 0.5), u);
    // The capsules are already where the hand is at the end of this step: a
    // hand still apart only stops the part closing the gap (like a wall), a
    // touching hand pushes it along at its own speed, and a finger already
    // into the part pushes it back out of the way (a pressed button), a
    // little each substep.
    const gap = Math.max(0, -c.depth);
    const touching = c.depth > -0.001;
    const into = Math.max(0, c.depth - SLOP) * BAUMGARTE / this.dt;
    const need = (touching ? vH : 0) - gap / this.dt + into - vPart;
    if (first && touching) { p.touchedThisStep = true; if (!c.emitted) { c.emitted = true; this.emit({ type: 'contact', prop: p, hand: c.hand.side, digit: c.hand.digit, segment: c.hand.segment, point: c.point }); } }
    if (need > 0) p.qd += need / ju;
  }


  solveTether(t, dt) {
    const b = t.body;
    const r = quat.rotate([0, 0, 0], b.rot, t.local);
    const p = v3.add([0, 0, 0], b.pos, r);
    const target = t.target;
    const err = v3.sub([0, 0, 0], p, target.pos);
    // Velocity the point should have: the hand's, plus a pull closing the gap.
    const want = v3.sub([0, 0, 0], target.vel, v3.scale([0, 0, 0], err, 0.35 / dt));
    const dv = v3.sub([0, 0, 0], want, b.velAt(p));
    const j = [0, 0, 0];
    // A dragged body rests on something: the tether pulls it along the
    // surface only and leaves its weight to what it rests on.
    const axes = t.axes || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (const axis of axes) {
      const k = b.invMass + v3.dot(v3.cross([0, 0, 0], b.invIw(v3.cross([0, 0, 0], r, axis)), r), axis);
      v3.addScaled(j, j, axis, v3.dot(dv, axis) / k);
    }
    // No more than the grip's strength over the substep.
    const cap = t.strength * dt;
    const next = v3.add([0, 0, 0], t.acc, j);
    const mag = v3.len(next);
    if (mag > cap) { v3.scale(next, next, cap / mag); t.saturated = true; }
    const dj = v3.sub([0, 0, 0], next, t.acc);
    t.acc = next;
    this.applyImpulse(b, dj, r);
    t.load = v3.len(t.acc) / dt;
  }

  applyImpulse(b, J, r) {
    if (b.kinematic) return;
    v3.addScaled(b.vel, b.vel, J, b.invMass);
    v3.add(b.ang, b.ang, b.invIw(v3.cross([0, 0, 0], r, J)));
  }

  project(c) {
    if (c.kind === 'prop') {
      const p = c.prop;
      // The part moves along the normal (hand into part) out of the finger.
      const ju = v3.dot(p.jacobian(c.point), c.n);
      if (Math.abs(ju) < 1e-9) return;
      const dq = (c.depth - SLOP * 0.5) / ju;
      if (Math.max(0, c.depth - SLOP * 0.5) > 0) p.q = clamp(p.q + dq, p.min, p.max);
      return;
    }
    const A = c.A;
    if (A.kinematic) return;
    const B = c.B && !c.B.kinematic ? c.B : null;
    const corr = Math.max(0, c.depth - SLOP) * BAUMGARTE;
    if (corr <= 0) return;
    const wa = A.invMass;
    const wb = B ? B.invMass : 0;
    v3.addScaled(A.pos, A.pos, c.n, (corr * wa) / (wa + wb));
    if (B) v3.addScaled(B.pos, B.pos, c.n, (-corr * wb) / (wa + wb));
  }

  emit(e) { for (const fn of this.listeners) fn(e); }

  // A pure prediction of a free body's centre over `seconds`, with this
  // world's integrator and no contacts (for planning a catch).
  predict(body, seconds, dt = 1 / 60) {
    const pos = body.pos.slice();
    const vel = body.vel.slice();
    const out = [];
    const h = dt / this.substeps;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      for (let s = 0; s < this.substeps; s++) {
        vel[1] += this.gravity * h;
        v3.addScaled(pos, pos, vel, h);
        v3.scale(vel, vel, Math.max(0, 1 - body.linDamp * h));
      }
      out.push({ t: (i + 1) * dt, pos: pos.slice(), vel: vel.slice() });
    }
    return out;
  }

  // Values for determinism hashes.
  stateValues() {
    const out = [];
    for (const b of this.bodies) out.push(...b.pos, ...b.rot, ...b.vel);
    for (const p of this.props) out.push(p.q, p.qd);
    for (const r of this.ropes) for (const pt of r.points) out.push(...pt);
    return out;
  }
}
