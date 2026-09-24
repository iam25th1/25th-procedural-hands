// Procedural grasp. From an object's shape and size the solver picks or is
// given a grip type from the GRASP taxonomy (Feix et al 2016), pre-shapes
// the hand with an aperture that grows with the object radius, then curls
// each phalanx of each active digit until its capsule meets the surface,
// records the contacts and returns the pose plus the object's transform in
// the hand frame so it can be attached.
import { v3, quat, clamp, deg, pointSegmentDistance, segmentDistance } from './math.js';
import { FINGERS, XR_PREFIX, capsuleEnd } from './skeleton.js';
import { POSES } from './poses.js';
import { clonePose, poseChannels, applyChannels } from './fingers.js';
import { MM } from './anatomy.js';
import * as dmath from './dmath.js';

// Signed distance of a point to an object given in the object's own frame.
export function objectSdf(obj, p) {
  switch (obj.shape) {
    case 'sphere':
      return v3.len(p) - obj.r;
    case 'cylinder': {
      // Axis along local Z, radius r, half length h, rounded ends.
      const radial = dmath.hypot(p[0], p[1]) - obj.r;
      const axial = Math.abs(p[2]) - obj.h;
      const outside = dmath.hypot(Math.max(radial, 0), Math.max(axial, 0));
      return outside + Math.min(Math.max(radial, axial), 0);
    }
    case 'box':
    case 'pillow': {
      const round = obj.round || 0;
      const q = [Math.abs(p[0]) - obj.hx + round, Math.abs(p[1]) - obj.hy + round, Math.abs(p[2]) - obj.hz + round];
      const outside = dmath.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      return outside + Math.min(Math.max(q[0], q[1], q[2]), 0) - round;
    }
    default:
      return Infinity;
  }
}

// Distance from a capsule (a-b, radius r) to the object surface, minimum
// over samples along the axis, in world space. obj has pos (world) and rot.
export function capsuleObjectDistance(obj, a, b, r, samples = 6) {
  const inv = quat.conjugate([0, 0, 0, 1], obj.rot);
  let best = Infinity;
  const tmp = [0, 0, 0];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    v3.lerp(tmp, a, b, t);
    v3.sub(tmp, tmp, obj.pos);
    quat.rotate(tmp, inv, tmp);
    best = Math.min(best, objectSdf(obj, tmp) - r);
  }
  return best;
}

// Radius of a sphere round an object's centre that holds all of it.
export function boundRadius(obj) {
  switch (obj.shape) {
    case 'sphere': return obj.r;
    case 'cylinder': return dmath.hypot(obj.r, obj.h);
    case 'box':
    case 'pillow': return dmath.hypot(obj.hx, obj.hy, obj.hz);
    default: return Infinity;
  }
}

// The least capsuleObjectDistance from a capsule to any of the shapes, with
// every shape skipped whose bound shows it cannot come under `cutoff`: a
// signed distance changes by at most the distance moved, so no point of the
// capsule can be nearer the surface than (its axis to the centre) minus the
// bound radius minus the capsule radius. Any true minimum below the cutoff
// comes back exactly; at or above it, the answer is at least the cutoff.
// shapes: [{ e, R }] with R = boundRadius(e).
export function envMin(shapes, a, b, r, cutoff = Infinity, samples = 6) {
  let d = Infinity;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const l2 = ux * ux + uy * uy + uz * uz;
  for (const { e, R } of shapes) {
    const lim = Math.min(d, cutoff);
    // Distance from the shape's centre to the capsule axis (no allocation:
    // this runs for every shape on every probe of the solver).
    const p = e.pos;
    let t = l2 < 1e-12 ? 0 : ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy + (p[2] - a[2]) * uz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = p[0] - (a[0] + ux * t), dy = p[1] - (a[1] + uy * t), dz = p[2] - (a[2] + uz * t);
    // 1 nm to spare, so rounding can never skip a shape that counts.
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) - R - r - 1e-9 >= lim) continue;
    d = Math.min(d, capsuleObjectDistance(e, a, b, r, samples));
  }
  return d;
}
export const bounded = (env) => env.map((e) => ({ e, R: boundRadius(e) }));

// Capsules of a hand's other digits (phalanges and metacarpals) that a
// digit must not pass through. Returns [{ a, b, r, name }].
export function obstacleCapsules(skel, side, excludeDigit) {
  const out = [];
  for (const j of skel.sides[side].joints) {
    if (j.kind !== 'hand' || !j.digit || j.segment === 'tip' || j.digit === excludeDigit) continue;
    out.push({ a: j.worldPos, b: capsuleEnd(j), r: j.radius, name: j.name });
  }
  return out;
}

// Signed clearance between a capsule and a set of capsules (negative = overlap).
export function capsuleSetDistance(caps, a, b, r) {
  let best = Infinity;
  for (const c of caps) best = Math.min(best, segmentDistance(a, b, c.a, c.b).d - r - c.r);
  return best;
}

// Object radius in the sense of "how wide is the thing the digits close on".
export function objectRadius(obj) {
  if (obj.shape === 'sphere') return obj.r;
  if (obj.shape === 'cylinder') return obj.r;
  // Boxes and pillows: the digits close across the narrower face width.
  return Math.min(obj.hx, obj.hy);
}

// Grip types from the taxonomy the rig implements, with the digits that
// close, the closing order and the pre-shape.
// capacity: the largest load in newtons the grip holds before the object
// slips (friction times grip force, design values in the range of measured
// adult grip and pinch strength: power grip about 300 to 450 N of squeeze,
// pinches 50 to 100 N, with a skin friction coefficient near 0.8 and a
// margin because nobody holds at full strength).
export const GRIPS = {
  powerCylinder: { pre: 'preCylinder', digits: ['index', 'middle', 'ring', 'little', 'thumb'], taxonomy: 'medium wrap (3)', thumbPad: true, thumbOver: true, capacity: 160 },
  spherical: { pre: 'preSphere', digits: ['index', 'middle', 'ring', 'little', 'thumb'], taxonomy: 'power sphere (11)', capacity: 110 },
  tipPinch: { pre: 'prePinch', digits: ['index', 'thumb'], taxonomy: 'tip pinch (24)', tip: true, steer: true, capacity: 10 },
  padPinch: { pre: 'prePinch', digits: ['index', 'thumb'], taxonomy: 'palmar pinch (9)', steer: true, capacity: 16 },
  tripod: { pre: 'preTripod', digits: ['index', 'middle', 'thumb'], taxonomy: 'tripod (14)', steer: true, capacity: 22 },
  lateral: { pre: 'lateral', digits: ['thumb'], support: ['index'], taxonomy: 'lateral (16)', steer: true, capacity: 30 },
  // The hand arrives flat over a handle, then curls its fingers round it.
  hook: { pre: 'hook', digits: ['index', 'middle', 'ring', 'little'], taxonomy: 'hook', hook: true, capacity: 220, approachPose: 'flat' },
  // Flat hand pressed on a face: two of these squeeze a box between the palms.
  press: { pre: 'press', digits: ['index', 'middle', 'ring', 'little'], taxonomy: 'palm press (two-hand squeeze)', capacity: 45 },
};

// Suggest a grip from shape and size.
export function gripFor(obj) {
  if (obj.shape === 'cylinder') return 'powerCylinder';
  if (obj.shape === 'sphere') return obj.r <= 0.02 ? 'padPinch' : 'spherical';
  if (obj.shape === 'pillow') return 'spherical';
  return 'powerCylinder';
}

// Pre-shape aperture: the thumb tip to index tip gap before closing grows
// with the object radius. Returns metres.
export function aperture(radius) {
  return 2 * radius + 0.02 + 0.6 * radius;
}

const PAD_SQUISH = 0.45 * MM; // contact stops with this much pad compression
// A thumb resting on other digits may overlap their capsules by at most this
// much, leaving room for idle drift under the 1 mm penetration limit.
export const REST_OVERLAP = 0.5 * MM;
const STEP = deg(1.5);
const CURL_RATIO = 0.8; // thumb MCP flexion as a fraction of IP flexion while steering

// Solve the closure. hand side, object {shape, ..., pos, rot} in world space
// (already placed relative to the hand by the caller), grip key.
// Mutates the skeleton pose on that side and returns { pose, contacts, gripKey }.
// Flat, soft things (the sachet) are taken from an open hand so the fingers
// close onto them from above instead of starting inside them.
function prePoseFor(grip, obj) {
  return obj && obj.shape === 'pillow' ? 'preSachet' : grip.pre;
}

// env: other shapes (the table under an object, its neighbours) the digits
// stop against without taking hold of them.
export function solveGrasp(skel, side, obj, gripKey, startPose = null, env = []) {
  const grip = GRIPS[gripKey];
  const pose = clonePose(startPose || POSES[prePoseFor(grip, obj)]);
  const contacts = [];
  const apply = () => { applyChannels(skel, side, poseChannels(pose)); skel.updateSide(side); };
  apply();
  if (grip.fixed) return { pose, contacts, gripKey };

  const capsule = (name) => {
    const j = skel.joint(side, name);
    return { a: j.worldPos, b: capsuleEnd(j), r: j.radius, joint: j };
  };
  const dist = (name) => {
    const cp = capsule(name);
    return capsuleObjectDistance(obj, cp.a, cp.b, cp.r);
  };
  const record = (name) => {
    const cp = capsule(name);
    const inv = quat.conjugate([0, 0, 0, 1], obj.rot);
    // Contact point: the sample nearest the surface, pushed to the surface.
    let best = null;
    for (let i = 0; i <= 6; i++) {
      const p = v3.lerp([0, 0, 0], cp.a, cp.b, i / 6);
      const local = quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], p, obj.pos));
      const d = objectSdf(obj, local) - cp.r;
      if (!best || d < best.d) best = { d, p };
    }
    contacts.push({ digit: cp.joint.digit, segment: cp.joint.segment, joint: cp.joint.name, point: best.p, depth: -best.d });
  };

  // The surroundings with their bounds, so far shapes are skipped (exact:
  // see envMin).
  const envB = bounded(env);
  const envDist = (name, cutoff = Infinity) => {
    if (!env.length) return Infinity;
    const cp = capsule(name);
    return envMin(envB, cp.a, cp.b, cp.r, cutoff);
  };
  const minDist = (capsNames) => {
    let dmin = Infinity;
    for (const n of capsNames) { dmin = Math.min(dmin, dist(n)); dmin = Math.min(dmin, envDist(n, dmin)); }
    return dmin;
  };
  // Curl a channel until the given capsules touch or the limit is hit. The
  // step that crosses the surface is bisected so the contact lands just
  // inside the pad squish, never deeper than a millimetre.
  const curl = (setter, getter, limitMax, capsNames, maxIter = 120) => {
    for (let i = 0; i < maxIter; i++) {
      const dmin = minDist(capsNames);
      if (dmin <= PAD_SQUISH) return { touched: true, d: dmin };
      const cur = getter();
      if (cur >= limitMax - 1e-9) return { touched: false, d: dmin };
      const next = Math.min(limitMax, cur + STEP);
      setter(next);
      apply();
      const dNext = minDist(capsNames);
      if (dNext <= PAD_SQUISH) {
        // Bisect between cur (clear) and next (touching or deeper).
        let lo = cur;
        let hi = next;
        for (let k = 0; k < 8; k++) {
          const midV = (lo + hi) / 2;
          setter(midV); apply();
          const dm = minDist(capsNames);
          if (dm <= PAD_SQUISH) hi = midV; else lo = midV;
        }
        setter(hi); apply();
        return { touched: true, d: minDist(capsNames) };
      }
    }
    return { touched: false, d: Infinity };
  };

  for (const digit of grip.digits) {
    if (digit === 'thumb' && grip.thumbOver) {
      // Medium wrap: the thumb lies over the index, which is wrapped round
      // the handle, both thumb phalanges resting on it and neither passing
      // through the handle; the pad is then on the handle through the finger.
      const r = restThumbOn(skel, side, pose, ['index'], obj, env);
      pose.thumb = r.pose.thumb;
      apply();
      if (r.rested) {
        const cp = capsule('thumb-phalanx-distal');
        contacts.push({ digit: 'thumb', segment: cp.joint.segment, joint: cp.joint.name, point: cp.b.slice(), depth: 0, via: 'index-finger' });
      }
      continue;
    }
    if (digit === 'thumb') {
      // The thumb opposes: coordinate descent over CMC sweep, CMC palmar
      // abduction, MCP and IP flexion, each step taking whichever direction
      // brings the thumb pad closest to the surface, until the pad touches.
      const cmc = skel.joint(side, 'thumb-metacarpal');
      const mcp = skel.joint(side, 'thumb-phalanx-proximal');
      const ip = skel.joint(side, 'thumb-phalanx-distal');
      const names = ['thumb-phalanx-proximal', 'thumb-phalanx-distal'];
      const dofs = [
        { get: () => pose.thumb.cmc[0], set: (v) => { pose.thumb.cmc[0] = v; }, lim: cmc.limits.flex },
        { get: () => pose.thumb.cmc[1], set: (v) => { pose.thumb.cmc[1] = v; }, lim: cmc.limits.abd },
        { get: () => pose.thumb.mcp[0], set: (v) => { pose.thumb.mcp[0] = v; }, lim: mcp.limits.flex },
        { get: () => pose.thumb.ip, set: (v) => { pose.thumb.ip = v; }, lim: ip.limits.flex },
      ];
      // Objective: the nearest thumb capsule should sit in the pad squish
      // band (0 to PAD_SQUISH inside the surface); deeper penetration of the
      // object or of the other digits is penalised, so the thumb settles onto
      // the object, or onto the fingers wrapped around it, never through them.
      // Pinches and the tripod meet the object with the thumb pad; power and
      // spherical grips may also press with the proximal phalanx.
      const thumbCaps = grip.steer || grip.thumbPad ? ['thumb-phalanx-distal'] : ['thumb-phalanx-proximal', 'thumb-phalanx-distal'];
      // Both phalanges must clear the other digits and the palm whatever
      // part of the thumb makes the contact.
      const clearCaps = ['thumb-phalanx-proximal', 'thumb-phalanx-distal'];
      const obstacles = () => obstacleCapsules(skel, side, 'thumb');
      const palm = () => obstacles().filter((c) => c.name.endsWith('-metacarpal'));
      const clearance = (obs) => {
        let d = Infinity;
        for (const n of clearCaps) { const cp = capsule(n); d = Math.min(d, capsuleSetDistance(obs, cp.a, cp.b, cp.r)); }
        return d;
      };
      // Medium wrap: the thumb closes over the index, which is itself wrapped
      // round the handle, so the index's middle and end phalanges count as
      // the surface the thumb pad lands on; the pad is then on the handle
      // through the finger. Those two capsules are left out of the obstacle
      // set for the thumb, since resting on them is the goal.
      const overCaps = grip.thumbOver ? ['index-finger-phalanx-intermediate', 'index-finger-phalanx-distal'] : [];
      const overDist = () => {
        let d = Infinity;
        const t = capsule('thumb-phalanx-distal');
        for (const n of overCaps) { const c = capsule(n); d = Math.min(d, segmentDistance(t.a, t.b, c.a, c.b).d - t.r - c.r); }
        return d;
      };
      // The pad may rest on the index; the proximal phalanx must clear every digit.
      const fingerClear = () => {
        const obs = obstacles();
        const p = capsule('thumb-phalanx-proximal');
        const d = capsule('thumb-phalanx-distal');
        return Math.min(capsuleSetDistance(obs, p.a, p.b, p.r), capsuleSetDistance(obs.filter((c) => !overCaps.includes(c.name)), d.a, d.b, d.r));
      };
      const surface = () => Math.min(minDist(thumbCaps), overDist());
      const objective = () => {
        const dmin = surface();
        const gap = Math.max(dmin, 0);
        // Neither phalanx may press past the squish, whichever one touches.
        const deep = Math.max(0, -minDist(clearCaps) - PAD_SQUISH);
        const fingers = Math.max(0, -fingerClear() - 1 * MM);
        return gap + 25 * deep + 25 * fingers;
      };
      const inBand = () => { const d = surface(); return d <= PAD_SQUISH && d >= -PAD_SQUISH * 1.5 && fingerClear() >= -1 * MM; };
      const descend = () => {
        let best = objective();
        let touched = inBand();
        for (let iter = 0; iter < 200 && !touched; iter++) {
          let improved = false;
          const step = best < 4 * MM ? STEP / 4 : STEP;
          for (const d of dofs) {
            const cur = d.get();
            let bestV = cur;
            for (const dv of [step, -step]) {
              const v = Math.min(d.lim[1], Math.max(d.lim[0], cur + dv));
              if (v === cur) continue;
              d.set(v); apply();
              const dd = objective();
              if (dd < best - 1e-9) { best = dd; bestV = v; }
              d.set(cur);
            }
            if (bestV !== cur) { d.set(bestV); apply(); improved = true; }
            if (inBand()) { touched = true; break; }
          }
          if (!improved) break;
        }
        return { touched, best };
      };
      // Pinches first steer the thumb pad toward the far side of the object
      // (a clean objective with no local minimum against the index), then the
      // surface band takes over.
      const padPoint = () => {
        const j = skel.joint(side, 'thumb-phalanx-distal');
        const tip = j.children[0].worldPos;
        const dir = quat.rotate([0, 0, 0], j.worldRot, [0, -1, 0]);
        return v3.addScaled([0, 0, 0], v3.addScaled([0, 0, 0], tip, quat.rotate([0, 0, 0], j.worldRot, [0, 0, 1]), 0.006), dir, j.radius);
      };
      if (grip.steer || grip.thumbOver || obj.shape === 'pillow') {
        let target;
        if (obj.shape === 'pillow') {
          // A sachet across the palm: the thumb curls over its near end and
          // its pad presses the face away from the palm, a little toward the
          // fingers, so the sachet is held between thumb and palm.
          const s = skel.joint(side, 'wrist').sideSign;
          target = v3.add([0, 0, 0], obj.pos, quat.rotate([0, 0, 0], obj.rot, [-s * 0.055, -0.008, obj.hz + 0.002]));
        } else if (grip.thumbOver) {
          // Medium wrap: the thumb crosses over the index's end phalanx, on
          // its outer side away from the handle's axis.
          const axis = quat.rotate([0, 0, 0], obj.rot, [0, 0, 1]);
          const idxD = skel.joint(side, 'index-finger-phalanx-distal');
          const idxMid = v3.lerp([0, 0, 0], idxD.worldPos, idxD.children[0].worldPos, 0.5);
          const h = v3.dot(v3.sub([0, 0, 0], idxMid, obj.pos), axis);
          const centre = v3.addScaled([0, 0, 0], obj.pos, axis, h);
          const away = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], idxMid, centre));
          target = v3.addScaled([0, 0, 0], idxMid, away, idxD.radius + 0.002);
        } else {
          // Opposite the finger pads: the index pad for a pinch, the midpoint
          // of the index and middle pads for a tripod (measured from the
          // index alone the thumb would reach across the middle finger).
          const padOf = (f) => { const j = skel.joint(side, `${f}-phalanx-distal`); return v3.addScaled([0, 0, 0], j.children[0].worldPos, quat.rotate([0, 0, 0], j.worldRot, [0, 0, 1]), 0.006); };
          const fingers = grip.digits.filter((d) => d !== 'thumb').map((d) => XR_PREFIX[d]);
          const from = [0, 0, 0];
          for (const f of fingers) v3.addScaled(from, from, padOf(f), 1 / fingers.length);
          const away = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], obj.pos, from));
          target = v3.addScaled([0, 0, 0], obj.pos, away, objectRadius(obj) + 0.002);
        }
        // The steer moves the CMC freely but curls the MCP and IP together
        // (MCP at CURL_RATIO of the IP), the way a thumb closes, so it
        // cannot fold into a zigzag to reach the target, and it is kept out
        // of the palm so it rises over the metacarpals instead of passing
        // through them. The surface band afterwards frees all four joints.
        const curl = {
          get: () => pose.thumb.ip,
          set: (v) => { pose.thumb.ip = v; pose.thumb.mcp[0] = Math.min(mcp.limits.flex[1], Math.max(mcp.limits.flex[0], v * CURL_RATIO)); },
          lim: ip.limits.flex,
        };
        const steerDofs = [dofs[0], dofs[1], curl];
        // The steer may not push either phalanx into the palm, nor the proximal
        // phalanx through the object (the pad itself may cross a small object
        // on its way to the far side; the surface band then settles it).
        const throughOK = obj.shape !== 'pillow'; // a pad may cross a small object on its way round it
        const steerCost = () => v3.dist(padPoint(), target) + 25 * Math.max(0, -clearance(palm()) - 1 * MM) + (throughOK ? 0 : 25 * Math.max(0, -dist('thumb-phalanx-proximal') - PAD_SQUISH));
        let best = steerCost();
        for (let iter = 0; iter < 200 && v3.dist(padPoint(), target) > 4 * MM; iter++) {
          let improved = false;
          for (const d of steerDofs) {
            const cur = d.get();
            const curMcp = pose.thumb.mcp[0];
            let bestV = cur;
            for (const dv of [STEP, -STEP]) {
              const v = Math.min(d.lim[1], Math.max(d.lim[0], cur + dv));
              if (v === cur) continue;
              d.set(v); apply();
              const dd = steerCost();
              if (dd < best - 1e-9) { best = dd; bestV = v; }
              d.set(cur); pose.thumb.mcp[0] = curMcp;
            }
            if (bestV !== cur) { d.set(bestV); apply(); improved = true; }
          }
          if (!improved) break;
        }
      }
      // A few starts across palmar abduction avoid local minima around the object.
      const start = pose.thumb.cmc.slice();
      let result = null;
      let bestPose = null;
      const startMcp = pose.thumb.mcp[0];
      const startIp = pose.thumb.ip;
      for (const abd of grip.steer ? [start[1]] : [start[1], deg(10), deg(25), deg(-10)]) {
        pose.thumb.cmc = start.slice();
        pose.thumb.cmc[1] = Math.min(cmc.limits.abd[1], Math.max(cmc.limits.abd[0], abd));
        pose.thumb.mcp[0] = startMcp;
        pose.thumb.ip = startIp;
        apply();
        const r = descend();
        if (!result || r.best < result.best) { result = r; bestPose = clonePose(pose); }
        if (r.touched) break;
      }
      pose.thumb = bestPose.thumb;
      const touched = result.touched;
      apply();
      if (touched) {
        for (const n of names) if (dist(n) <= PAD_SQUISH + 0.3 * MM) record(n);
        if (grip.thumbOver && overDist() <= PAD_SQUISH + 0.3 * MM && !contacts.some((c) => c.digit === 'thumb')) {
          const cp = capsule('thumb-phalanx-distal');
          contacts.push({ digit: 'thumb', segment: cp.joint.segment, joint: cp.joint.name, point: cp.b.slice(), depth: 0, via: 'index-finger' });
        }
      }
      continue;
    }
    const p = XR_PREFIX[digit];
    const mcpMax = skel.joint(side, `${p}-phalanx-proximal`).limits.flex[1];
    const pipMax = skel.joint(side, `${p}-phalanx-intermediate`).limits.flex[1];
    const dipMax = skel.joint(side, `${p}-phalanx-distal`).limits.flex[1];
    const prox = `${p}-phalanx-proximal`;
    const mid = `${p}-phalanx-intermediate`;
    const dis = `${p}-phalanx-distal`;
    // MCP until any phalanx touches, then PIP (DIP follows), then DIP alone.
    // A hook keeps its knuckles where the pre-pose put them and curls only
    // the PIP and DIP around the handle.
    let r = grip.hook ? { touched: false } : curl((v) => { pose[digit].mcp[0] = v; }, () => pose[digit].mcp[0], mcpMax, [prox, mid, dis]);
    const proxTouched = r.touched && dist(prox) <= PAD_SQUISH + 0.3 * MM;
    if (!r.touched || proxTouched) {
      r = curl((v) => { pose[digit].pip = v; }, () => pose[digit].pip, pipMax, [mid, dis]);
      if (!r.touched || dist(mid) <= PAD_SQUISH + 0.3 * MM) {
        pose[digit].dip = pose[digit].dip ?? (2 / 3) * pose[digit].pip;
        r = curl((v) => { pose[digit].dip = v; }, () => pose[digit].dip, dipMax, [dis]);
      }
    }
    for (const n of [prox, mid, dis]) if (dist(n) <= PAD_SQUISH + 0.3 * MM) record(n);
  }
  // Relax pass: neighbouring fingers pull each other along (enslaving), so a
  // finger placed earlier can end up deeper once its neighbours close. Open
  // the PIP, then the MCP, of any finger pressing past the squish band.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const digit of grip.digits) {
      if (digit === 'thumb') continue;
      const p = XR_PREFIX[digit];
      const names = [`${p}-phalanx-proximal`, `${p}-phalanx-intermediate`, `${p}-phalanx-distal`];
      const objDeep = () => { let d = Infinity; for (const n of names) d = Math.min(d, dist(n)); return d; };
      for (const key of ['pip', 'mcp']) {
        for (let i = 0; i < 40 && objDeep() < -PAD_SQUISH; i++) {
          if (key === 'pip') pose[digit].pip = Math.max(0, pose[digit].pip - STEP / 3);
          else pose[digit].mcp[0] = Math.max(0, pose[digit].mcp[0] - STEP / 3);
          apply();
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  // Surfaces around the object: a digit pressing into the table is moved
  // whichever way lifts it off (opening a finger that points down would
  // only push it further in), the least it takes.
  if (env.length) {
    for (const digit of ['thumb', ...FINGERS]) {
      const names = digit === 'thumb' ? ['thumb-phalanx-proximal', 'thumb-phalanx-distal'] : ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${XR_PREFIX[digit]}-${seg}`);
      // Only depths past 0.2 mm count, so shapes that cannot reach that far in are skipped.
      const envDeep = () => { let d = Infinity; for (const n of names) d = Math.min(d, envDist(n, Math.min(d, -0.2 * MM))); return Math.max(0, -d - 0.2 * MM); };
      if (envDeep() <= 0) continue;
      const lim = (n) => skel.joint(side, n).limits.flex;
      const dofs = digit === 'thumb'
        ? [{ get: () => pose.thumb.mcp[0], set: (v) => { pose.thumb.mcp[0] = v; }, lim: lim('thumb-phalanx-proximal') }, { get: () => pose.thumb.ip, set: (v) => { pose.thumb.ip = v; }, lim: lim('thumb-phalanx-distal') }, { get: () => pose.thumb.cmc[0], set: (v) => { pose.thumb.cmc[0] = v; }, lim: skel.joint(side, 'thumb-metacarpal').limits.flex }]
        : [
          { get: () => pose[digit].mcp[0], set: (v) => { pose[digit].mcp[0] = v; }, lim: lim(names[0]) },
          { get: () => pose[digit].pip, set: (v) => { pose[digit].pip = v; }, lim: lim(names[1]) },
          { get: () => (pose[digit].dip ?? (2 / 3) * pose[digit].pip), set: (v) => { pose[digit].dip = v; }, lim: lim(names[2]) },
        ];
      const objPress = () => { let d = Infinity; for (const n of names) d = Math.min(d, dist(n)); return Math.max(0, -d - PAD_SQUISH); };
      for (let it = 0; it < 120 && envDeep() > 0; it++) {
        let best = null;
        for (const d of dofs) {
          const cur = d.get();
          for (const dv of [STEP / 2, -STEP / 2]) {
            const v = Math.min(d.lim[1], Math.max(d.lim[0], cur + dv));
            if (v === cur) continue;
            d.set(v); apply();
            const c = envDeep() * 50 + objPress() * 50;
            if (!best || c < best.c) best = { c, d, v };
            d.set(cur);
          }
        }
        apply();
        if (!best) break;
        best.d.set(best.v);
        apply();
      }
    }
  }
  // Digits that take no part in the grip keep clear of the object: a finger
  // opens until it no longer reaches into it, the thumb moves the least it
  // can to clear it.
  // Neighbouring fingers pull each other along, so moving a spare finger
  // must not draw a gripping one off the object: capsules touching now stay
  // touching.
  const gripCaps = grip.digits.filter((d) => d !== 'thumb').flatMap((d) => ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${XR_PREFIX[d]}-${seg}`)).filter((n) => dist(n) <= PAD_SQUISH + 0.3 * MM);
  const lifted = () => gripCaps.reduce((a, n) => a + Math.max(0, dist(n) - PAD_SQUISH), 0);
  for (const digit of ['thumb', ...FINGERS]) {
    if (grip.digits.includes(digit) || (grip.support || []).includes(digit)) continue;
    const names = digit === 'thumb' ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'] : ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${XR_PREFIX[digit]}-${seg}`);
    // 2.6 mm: a spare finger that grazes a light object on the way in knocks it off its perch.
    const depth = () => Math.max(0, -minDist(names) + 2.6 * MM) + (digit === 'thumb' ? 0 : lifted());
    // A spare digit already clear of the object keeps its pose.
    if (-minDist(names) + 2.6 * MM <= 0) continue;
    if (digit !== 'thumb') {
      // Curl in or open out, whichever takes the finger clear (a spare
      // finger pointing at the table clears it by curling, not by opening).
      const p = XR_PREFIX[digit];
      const lims = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => skel.joint(side, `${p}-${seg}`).limits.flex);
      const get = [() => pose[digit].mcp[0], () => pose[digit].pip, () => (pose[digit].dip ?? (2 / 3) * pose[digit].pip)];
      const set = [(v) => { pose[digit].mcp[0] = v; }, (v) => { pose[digit].pip = v; }, (v) => { pose[digit].dip = v; }];
      const descend = () => {
        for (let i = 0; i < 160 && depth() > 0; i++) {
          let best = null;
          for (let k = 0; k < 3; k++) {
            const cur = get[k]();
            for (const dv of [STEP / 2, -STEP / 2]) {
              const v = Math.min(lims[k][1], Math.max(lims[k][0], cur + dv));
              if (v === cur) continue;
              set[k](v); apply();
              const d = depth();
              if (!best || d < best.d) best = { d, k, v };
              set[k](cur);
            }
          }
          apply();
          if (!best) break;
          set[best.k](best.v);
          apply();
        }
        return depth();
      };
      // The descent can stall with the finger wrapped under the object; then
      // start again from a full curl and from a loose, near straight finger
      // and keep whichever ends clear (or least deep).
      const from = get.map((g) => g());
      let best = { d: descend(), v: get.map((g) => g()) };
      if (best.d > 0) {
        for (const start of [lims.map((l) => l[1]), lims.map((l) => Math.max(l[0], Math.min(l[1], 0.25)))]) {
          start.forEach((v, k) => set[k](v)); apply();
          const d = descend();
          const v = get.map((g) => g());
          const moved = v.reduce((a, x, k) => a + Math.abs(x - from[k]), 0);
          if (d < best.d - 1e-5 || (d <= 0 && best.d <= 0 && moved < best.moved)) best = { d, v, moved };
        }
        best.v.forEach((v, k) => set[k](v)); apply();
      }
      continue;
    }
    const cmc = skel.joint(side, 'thumb-metacarpal');
    const mcpJ = skel.joint(side, 'thumb-phalanx-proximal');
    const ipJ = skel.joint(side, 'thumb-phalanx-distal');
    const start = [pose.thumb.cmc[0], pose.thumb.cmc[1], pose.thumb.mcp[0], pose.thumb.ip];
    const dofs = [
      { get: () => pose.thumb.cmc[0], set: (v) => { pose.thumb.cmc[0] = v; }, lim: cmc.limits.flex },
      { get: () => pose.thumb.cmc[1], set: (v) => { pose.thumb.cmc[1] = v; }, lim: cmc.limits.abd },
      { get: () => pose.thumb.mcp[0], set: (v) => { pose.thumb.mcp[0] = v; }, lim: mcpJ.limits.flex },
      { get: () => pose.thumb.ip, set: (v) => { pose.thumb.ip = v; }, lim: ipJ.limits.flex },
    ];
    const others = () => obstacleCapsules(skel, side, 'thumb');
    const selfPen = () => {
      let d = Infinity;
      for (const n of ['thumb-phalanx-proximal', 'thumb-phalanx-distal']) { const cp = capsule(n); d = Math.min(d, capsuleSetDistance(others(), cp.a, cp.b, cp.r)); }
      return Math.max(0, -d - 0.5 * MM);
    };
    const cost = () => 400 * depth() / MM + 400 * selfPen() / MM + dofs.reduce((a, d, i) => a + Math.abs(d.get() - start[i]), 0) / deg(1);
    let best = cost();
    for (let it = 0; it < 160 && depth() > 0; it++) {
      let improved = false;
      for (const d of dofs) {
        const cur = d.get();
        let bestV = cur;
        for (const dv of [STEP, -STEP]) {
          const v = Math.min(d.lim[1], Math.max(d.lim[0], cur + dv));
          if (v === cur) continue;
          d.set(v); apply();
          const c = cost();
          if (c < best - 1e-9) { best = c; bestV = v; }
          d.set(cur);
        }
        if (bestV !== cur) { d.set(bestV); apply(); improved = true; }
      }
      if (!improved) break;
    }
    apply();
  }
  // A gripping finger drawn off the object by a spare neighbour closes onto
  // it again (and the spare one follows it a little: that is the coupling).
  for (const digit of grip.digits) {
    if (digit === 'thumb') continue;
    const p = XR_PREFIX[digit];
    const caps = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${p}-${seg}`);
    if (!caps.some((n) => gripCaps.includes(n)) || caps.some((n) => dist(n) <= PAD_SQUISH + 0.3 * MM)) continue;
    const lim = (n) => skel.joint(side, n).limits.flex[1];
    const r = curl((v) => { pose[digit].pip = v; }, () => pose[digit].pip, lim(caps[1]), caps);
    if (!r.touched) curl((v) => { pose[digit].mcp[0] = v; }, () => pose[digit].mcp[0], lim(caps[0]), caps);
  }
  const via = contacts.filter((c) => c.via);
  contacts.length = 0;
  for (const digit of grip.digits) {
    const names = digit === 'thumb' ? ['thumb-phalanx-proximal', 'thumb-phalanx-distal'] : ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${XR_PREFIX[digit]}-${seg}`);
    for (const n of names) if (dist(n) <= PAD_SQUISH + 0.3 * MM) record(n);
  }
  if (!contacts.some((c) => c.digit === 'thumb')) contacts.push(...via);
  return { pose, contacts, gripKey };
}

// Place an object relative to the hand for a grip: returns { pos, rot } in world.
// Hand frame: -Z along the metacarpals, -Y out of the palm, +X ulnar (right).
export function placeObject(skel, side, obj, gripKey) {
  const wr = skel.joint(side, 'wrist');
  const s = wr.sideSign;
  const local = (x, y, z) => v3.add([0, 0, 0], wr.worldPos, quat.rotate([0, 0, 0], wr.worldRot, [x * s, y, z]));
  const R = objectRadius(obj);
  switch (gripKey) {
    case 'powerCylinder': {
      // Handle lies across the palm, oblique from the index side distal to the
      // ulnar side proximal, its axis in the palm plane, centre below the palm.
      // Palm surface sits about 17 mm palmar of the hand frame origin; the handle rests on it.
      const centre = local(0.004, -(R + 0.019), -0.072);
      const axisLocal = v3.normalize([0, 0, 0], [0.94 * s, 0, 0.34]);
      const axis = quat.rotate([0, 0, 0], wr.worldRot, axisLocal);
      const rot = quat.fromTo([0, 0, 0, 1], [0, 0, 1], axis);
      return { pos: centre, rot };
    }
    case 'spherical': {
      if (obj.shape === 'pillow') {
        // A sachet lies flat across the palm, long axis from thumb to little
        // finger, its far edge just past the knuckles, so the fingers curl
        // over that edge and the thumb presses its top face. It sits on the
        // thenar and hypothenar mounds (14 mm above the palm's hollow) and
        // its thumb end stops short of the thumb's base, the rest overhanging
        // the little finger side, so the thumb comes over it from the side.
        const centre = local(0.04, -(obj.hz + 0.033), -0.06);
        const R_local = quat.fromBasis([0, 0, 0, 1], [1, 0, 0], [0, 0, 1], [0, -1, 0]);
        return { pos: centre, rot: quat.multiply([0, 0, 0, 1], wr.worldRot, R_local) };
      }
      const centre = local(-0.004, -(R + 0.021), -0.078);
      return { pos: centre, rot: [0, 0, 0, 1] };
    }
    case 'tipPinch':
    case 'padPinch':
    case 'tripod': {
      // Between the pre-shaped thumb and index: the caller pre-shapes first,
      // so the object sits at the midpoint of the two pads (a little palmar
      // of the tips) and both digits close onto it.
      // On the index pad (and the middle pad for a tripod): the object rests
      // against the finger pad with the pad slightly compressed, and the thumb
      // closes onto it from the other side.
      const pads = [];
      for (const f of gripKey === 'tripod' ? ['index-finger', 'middle-finger'] : ['index-finger']) {
        const tip = skel.joint(side, `${f}-tip`).worldPos;
        const dist = skel.joint(side, `${f}-phalanx-distal`);
        const padDir = quat.rotate([0, 0, 0], dist.worldRot, [0, -1, 0]);
        const along = quat.rotate([0, 0, 0], dist.worldRot, [0, 0, 1]);
        // Pad centre line: back from the tip along the bone; the sphere must
        // sit (capsule radius + R) from it, less the pad squish.
        pads.push({ p: v3.addScaled([0, 0, 0], tip, along, 0.006), dir: padDir, reach: dist.radius - 0.0006 + R });
      }
      if (pads.length === 1) return { pos: v3.addScaled([0, 0, 0], pads[0].p, pads[0].dir, pads[0].reach), rot: [0, 0, 0, 1] };
      // Two pads: on the bisecting normal through the midpoint, at the height that is tangent to both.
      const mid = v3.lerp([0, 0, 0], pads[0].p, pads[1].p, 0.5);
      const half = v3.dist(pads[0].p, pads[1].p) / 2;
      const n = v3.normalize([0, 0, 0], v3.add([0, 0, 0], pads[0].dir, pads[1].dir));
      const reach = (pads[0].reach + pads[1].reach) / 2;
      const h = Math.sqrt(Math.max(0, reach * reach - half * half));
      return { pos: v3.addScaled([0, 0, 0], mid, n, h), rot: [0, 0, 0, 1] };
    }
    case 'lateral': {
      // Against the radial side of the index middle phalanx, under the thumb pad.
      const j = skel.joint(side, 'index-finger-phalanx-intermediate');
      const mid = v3.lerp([0, 0, 0], j.worldPos, j.children[0].worldPos, 0.5);
      const radial = quat.rotate([0, 0, 0], j.worldRot, [-s, 0, 0]);
      const palmar = quat.rotate([0, 0, 0], j.worldRot, [0, -1, 0]);
      const dir = v3.normalize([0, 0, 0], v3.add([0, 0, 0], radial, v3.scale([0, 0, 0], palmar, 0.35)));
      if (obj.shape !== 'box') return { pos: v3.addScaled([0, 0, 0], mid, dir, j.radius + R - 0.0006), rot: [0, 0, 0, 1] };
      // A flat object (a key) lies with its face on the finger's side, its
      // long axis out past the knuckles, held near its back end.
      const fwd = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], quat.rotate([0, 0, 0], wr.worldRot, [0, 0, -1]), dir));
      // The object's longer flat axis (X or Z) runs out along fwd.
      const longX = obj.hx > obj.hz;
      const rot = longX
        ? quat.fromBasis([0, 0, 0, 1], fwd, dir, v3.cross([0, 0, 0], fwd, dir))
        : quat.fromBasis([0, 0, 0, 1], v3.cross([0, 0, 0], dir, fwd), dir, fwd);
      const hold = Math.max(0, (longX ? obj.hx : obj.hz) - 0.009);
      const pos = v3.addScaled([0, 0, 0], v3.addScaled([0, 0, 0], mid, dir, j.radius + obj.hy - 0.0006), fwd, hold);
      // The proximal phalanx is thicker than the middle one: the face rests
      // on whichever side stands out further.
      for (let k = 0; k < 3; k++) {
        let deep = 0;
        for (const seg of ['phalanx-proximal', 'phalanx-intermediate']) {
          const c = skel.joint(side, `index-finger-${seg}`);
          deep = Math.max(deep, -capsuleObjectDistance({ ...obj, pos, rot }, c.worldPos, capsuleEnd(c), c.radius));
        }
        if (deep <= 0.0006) break;
        v3.addScaled(pos, pos, dir, deep - 0.0005);
      }
      return { pos, rot };
    }
    case 'press': {
      // A flat face against the palm: the object's own Y runs along the palm
      // normal, its face on the most palmar point of the palm and the thenar
      // as the hand is shaped now.
      const half = obj.shape === 'sphere' ? obj.r : (obj.hy ?? R);
      const inv = quat.conjugate([0, 0, 0, 1], wr.worldRot);
      let depth = 0.0185;
      for (const j of skel.sides[side].joints) {
        if (j.kind !== 'hand' || j.segment !== 'metacarpal') continue;
        for (const p of [j.worldPos, j.children[0].worldPos]) {
          const l = quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], p, wr.worldPos));
          depth = Math.max(depth, -l[1] + j.radius);
        }
      }
      return { pos: local(0.002, -(depth + half + 0.0003), -0.066), rot: wr.worldRot.slice() };
    }
    case 'hook': {
      // A handle under the proximal phalanges just short of the PIP joints:
      // the hand arrives with its fingers flat over it, then curls the middle
      // and end phalanges down round its far side. The PIP joints sit where
      // the knuckles put them whether the fingers are flat or curled.
      const a = skel.joint(side, 'index-finger-phalanx-proximal');
      const b = skel.joint(side, 'pinky-finger-phalanx-proximal');
      const pa = skel.joint(side, 'index-finger-phalanx-intermediate').worldPos;
      const pb = skel.joint(side, 'pinky-finger-phalanx-intermediate').worldPos;
      const centre = v3.lerp([0, 0, 0], pa, pb, 0.5);
      const palmar = quat.rotate([0, 0, 0], a.worldRot, [0, -1, 0]);
      const back = quat.rotate([0, 0, 0], a.worldRot, [0, 0, 1]);
      const axis = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], pb, pa));
      const pos = v3.addScaled([0, 0, 0], v3.addScaled([0, 0, 0], centre, palmar, (a.radius + b.radius) / 2 + R + 0.0008), back, R * 0.6);
      return { pos, rot: quat.fromTo([0, 0, 0, 1], [0, 0, 1], axis) };
    }
    default:
      return { pos: local(0, -0.03, -0.07), rot: [0, 0, 0, 1] };
  }
}

// Express an object's world transform in the wrist frame so it follows the hand.
export function attachToHand(skel, side, obj) {
  const wr = skel.joint(side, 'wrist');
  const inv = quat.conjugate([0, 0, 0, 1], wr.worldRot);
  return {
    pos: quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], obj.pos, wr.worldPos)),
    rot: quat.multiply([0, 0, 0, 1], inv, obj.rot),
  };
}

export function attachedWorld(skel, side, attachment) {
  const wr = skel.joint(side, 'wrist');
  return {
    pos: v3.add([0, 0, 0], wr.worldPos, quat.rotate([0, 0, 0], wr.worldRot, attachment.pos)),
    rot: quat.multiply([0, 0, 0, 1], wr.worldRot, attachment.rot),
  };
}

// Thumb to index tip gap for a pose applied on a side (for the aperture check).
export function tipGap(skel, side) {
  return v3.dist(skel.joint(side, 'thumb-tip').worldPos, skel.joint(side, 'index-finger-tip').worldPos);
}

// Pre-shape the hand for an object: scale the pre-pose so the thumb to index
// gap equals the aperture. Opens the MCP and PIP of the index and the thumb
// CMC flexion by a factor found by bisection.
export function preShape(skel, side, obj, gripKey) {
  const grip = GRIPS[gripKey];
  const base = clonePose(POSES[prePoseFor(grip, obj)]);
  const want = aperture(objectRadius(obj));
  // Scale the closing fingers and the thumb together so pads that must
  // meet an object side by side (tripod) stay level.
  const fingers = grip.digits.filter((d) => d !== 'thumb');
  const apply = (k) => {
    const p = clonePose(base);
    for (const f of fingers.length ? fingers : ['index']) { p[f].mcp[0] *= k; p[f].pip *= k; }
    p.thumb.cmc[0] *= k; p.thumb.mcp[0] *= k; p.thumb.ip *= k;
    applyChannels(skel, side, poseChannels(p));
    skel.updateSide(side);
    return p;
  };
  // The aperture is the thumb to index gap: it sizes a grip the thumb
  // opposes. A grip without the thumb (a hook, a flat press) keeps its
  // pre-pose as authored; scaling it by where the thumb tip happens to be
  // moved the fingers a hook places its handle against.
  if (!grip.digits.includes('thumb') && !(grip.support || []).includes('thumb')) {
    const pose = apply(1);
    return { pose, gap: tipGap(skel, side), want };
  }
  let lo = 0;
  let hi = 1.6;
  let pose = apply(1);
  for (let i = 0; i < 24; i++) {
    const midK = (lo + hi) / 2;
    pose = apply(midK);
    if (tipGap(skel, side) > want) lo = midK; else hi = midK;
  }
  pose = apply((lo + hi) / 2);
  return { pose, gap: tipGap(skel, side), want };
}

export { clamp, pointSegmentDistance };


// Settle a pose's thumb so it rests on the fingers or palm instead of passing
// through them: nudges CMC sweep and abduction, MCP and IP away from any
// overlap deeper than the pad squish, staying as close to the authored
// angles as the clearance allows. Applies the pose on the skeleton side.
export function settleThumb(skel, side, pose) {
  const out = clonePose(pose);
  const apply = () => { applyChannels(skel, side, poseChannels(out)); skel.updateSide(side); };
  apply();
  const cmc = skel.joint(side, 'thumb-metacarpal');
  const mcp = skel.joint(side, 'thumb-phalanx-proximal');
  const ip = skel.joint(side, 'thumb-phalanx-distal');
  const thumbCaps = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'];
  const clearance = () => {
    const obs = obstacleCapsules(skel, side, 'thumb');
    let d = Infinity;
    for (const n of thumbCaps) {
      const j = skel.joint(side, n);
      d = Math.min(d, capsuleSetDistance(obs, j.worldPos, capsuleEnd(j), j.radius));
    }
    return d;
  };
  const dofs = [
    { get: () => out.thumb.cmc[0], set: (v) => { out.thumb.cmc[0] = v; }, lim: cmc.limits.flex },
    { get: () => out.thumb.cmc[1], set: (v) => { out.thumb.cmc[1] = v; }, lim: cmc.limits.abd },
    { get: () => out.thumb.mcp[0], set: (v) => { out.thumb.mcp[0] = v; }, lim: mcp.limits.flex },
    { get: () => out.thumb.ip, set: (v) => { out.thumb.ip = v; }, lim: ip.limits.flex },
  ];
  let clear = clearance();
  for (let iter = 0; iter < 200 && clear < -PAD_SQUISH; iter++) {
    let bestGain = 0;
    let move = null;
    for (const d of dofs) {
      const cur = d.get();
      for (const dv of [STEP, -STEP]) {
        const v = Math.min(d.lim[1], Math.max(d.lim[0], cur + dv));
        if (v === cur) continue;
        d.set(v); apply();
        const c = clearance();
        if (c - clear > bestGain) { bestGain = c - clear; move = { d, v }; }
        d.set(cur);
      }
    }
    if (!move) break;
    move.d.set(move.v);
    apply();
    clear = clearance();
  }
  apply();
  return { pose: out, clearance: clear };
}


// The pose a hand should be in just before it grasps: the solved contact
// pose opened by a margin on every closing digit, so the springs then close
// straight onto the surface without sweeping through the object first.
// env: shapes around the object in the same frame as this skeleton's hand.
export function openedGraspPose(skel, side, obj, gripKey, env = [], wide = 1) {
  const grip = GRIPS[gripKey];
  const pre = preShape(skel, side, obj, gripKey);
  const placed = placeObject(skel, side, obj, gripKey);
  const solved = solveGrasp(skel, side, { ...obj, ...placed }, gripKey, pre.pose, env).pose;
  const out = clonePose(solved);
  const open = (v, d, lim) => Math.max(lim[0], v - d);
  // Each digit opens as far as asked, or as far as the surroundings allow (a
  // finger opening toward the panel a knob sits on stops short of it).
  const envDeep = (digit) => {
    if (!env.length) return 0;
    applyChannels(skel, side, poseChannels(out)); skel.updateSide(side);
    const names = digit === 'thumb' ? ['thumb-phalanx-proximal', 'thumb-phalanx-distal'] : ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${XR_PREFIX[digit]}-${seg}`);
    let d = Infinity;
    for (const n of names) { const j = skel.joint(side, n); for (const e of env) d = Math.min(d, capsuleObjectDistance(e, j.worldPos, capsuleEnd(j), j.radius)); }
    return Math.max(0, -d);
  };
  const before = clonePose(out);
  const limitDigit = (digit) => {
    if (envDeep(digit) <= 0.0002) return;
    // Back off toward the solved pose until clear.
    const target = clonePose(out);
    for (let k = 7; k >= 0; k--) {
      const u = k / 8;
      const mix = (a, b) => a + (b - a) * u;
      if (digit === 'thumb') {
        out.thumb.cmc = before.thumb.cmc.map((v, i) => mix(v, target.thumb.cmc[i]));
        out.thumb.mcp = before.thumb.mcp.map((v, i) => mix(v, target.thumb.mcp[i]));
        out.thumb.ip = mix(before.thumb.ip, target.thumb.ip);
      } else {
        out[digit].mcp = before[digit].mcp.map((v, i) => mix(v, target[digit].mcp[i]));
        out[digit].pip = mix(before[digit].pip, target[digit].pip);
        if (target[digit].dip != null) out[digit].dip = mix(before[digit].dip ?? (2 / 3) * before[digit].pip, target[digit].dip);
      }
      if (envDeep(digit) <= 0.0002) return;
    }
  };
  for (const digit of grip.digits) {
    if (digit === 'thumb') {
      const cmc = skel.joint(side, 'thumb-metacarpal');
      const mcp = skel.joint(side, 'thumb-phalanx-proximal');
      const ip = skel.joint(side, 'thumb-phalanx-distal');
      out.thumb.cmc[0] = open(out.thumb.cmc[0], deg(14) * wide, cmc.limits.flex);
      out.thumb.cmc[1] = Math.min(cmc.limits.abd[1], out.thumb.cmc[1] + deg(8));
      out.thumb.mcp[0] = open(out.thumb.mcp[0], deg(10) * wide, mcp.limits.flex);
      out.thumb.ip = open(out.thumb.ip, deg(10) * wide, ip.limits.flex);
      continue;
    }
    const p = XR_PREFIX[digit];
    out[digit].mcp[0] = open(out[digit].mcp[0], deg(8) * wide, skel.joint(side, `${p}-phalanx-proximal`).limits.flex);
    out[digit].pip = open(out[digit].pip, deg(12) * wide, skel.joint(side, `${p}-phalanx-intermediate`).limits.flex);
    if (out[digit].dip != null) out[digit].dip = open(out[digit].dip, deg(8) * wide, skel.joint(side, `${p}-phalanx-distal`).limits.flex);
  }
  for (const digit of grip.digits) limitDigit(digit);
  return out;
}

// Rest the thumb on named fingers: for a fist or a count the thumb lies
// across the curled fingers rather than hovering beside them. Coordinate
// descent over CMC sweep and abduction, MCP and IP brings the thumb's two
// phalanges onto the nearest phalanx of each named finger, inside the pad
// band, without pressing more than a millimetre into any digit or the palm.
export function restThumbOn(skel, side, pose, fingers, obj = null, env = []) {
  const out = clonePose(pose);
  const apply = () => { applyChannels(skel, side, poseChannels(out)); skel.updateSide(side); };
  apply();
  const cmc = skel.joint(side, 'thumb-metacarpal');
  const mcp = skel.joint(side, 'thumb-phalanx-proximal');
  const ip = skel.joint(side, 'thumb-phalanx-distal');
  const thumbCaps = ['thumb-phalanx-proximal', 'thumb-phalanx-distal'];
  const cap = (n) => { const j = skel.joint(side, n); return { a: j.worldPos, b: capsuleEnd(j), r: j.radius }; };
  const targets = fingers.map((f) => ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((seg) => `${XR_PREFIX[f]}-${seg}`));
  const distTo = (names) => {
    let d = Infinity;
    for (const tn of thumbCaps) { const t = cap(tn); for (const n of names) { const c = cap(n); d = Math.min(d, segmentDistance(t.a, t.b, c.a, c.b).d - t.r - c.r); } }
    return d;
  };
  const clearance = () => {
    const obs = obstacleCapsules(skel, side, 'thumb');
    let d = Infinity;
    for (const tn of thumbCaps) { const t = cap(tn); d = Math.min(d, capsuleSetDistance(obs, t.a, t.b, t.r)); }
    return d;
  };
  const objDist = () => {
    if (!obj && !env.length) return Infinity;
    let d = Infinity;
    for (const tn of [...thumbCaps, 'thumb-metacarpal']) {
      const t = cap(tn);
      if (obj && tn !== 'thumb-metacarpal') d = Math.min(d, capsuleObjectDistance(obj, t.a, t.b, t.r));
      for (const e of env) d = Math.min(d, capsuleObjectDistance(e, t.a, t.b, t.r) + PAD_SQUISH);
    }
    return d;
  };
  const objective = () => {
    let sum = 0;
    for (const names of targets) sum += Math.max(0, distTo(names));
    return sum + 25 * Math.max(0, -clearance() - REST_OVERLAP) + 25 * Math.max(0, -objDist() - PAD_SQUISH);
  };
  const done = () => targets.every((names) => distTo(names) <= 2 * PAD_SQUISH) && clearance() >= -REST_OVERLAP && objDist() >= -PAD_SQUISH;
  const dofs = [
    { get: () => out.thumb.cmc[0], set: (v) => { out.thumb.cmc[0] = v; }, lim: cmc.limits.flex },
    { get: () => out.thumb.cmc[1], set: (v) => { out.thumb.cmc[1] = v; }, lim: cmc.limits.abd },
    { get: () => out.thumb.mcp[0], set: (v) => { out.thumb.mcp[0] = v; }, lim: mcp.limits.flex },
    { get: () => out.thumb.ip, set: (v) => { out.thumb.ip = v; }, lim: ip.limits.flex },
  ];
  let best = objective();
  for (let iter = 0; iter < 300 && !done(); iter++) {
    let improved = false;
    for (const d of dofs) {
      const cur = d.get();
      let bestV = cur;
      for (const dv of [STEP, -STEP]) {
        const v = Math.min(d.lim[1], Math.max(d.lim[0], cur + dv));
        if (v === cur) continue;
        d.set(v); apply();
        const c = objective();
        if (c < best - 1e-9) { best = c; bestV = v; }
        d.set(cur);
      }
      if (bestV !== cur) { d.set(bestV); apply(); improved = true; }
      if (done()) break;
    }
    if (!improved) break;
  }
  apply();
  return { pose: out, rested: done() };
}
