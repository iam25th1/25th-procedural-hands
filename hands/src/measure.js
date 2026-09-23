// Measurements the checks and tests use, and that a consumer can call to
// audit a pose: joint limit margins, self-penetration between digits, and
// penetration into a held or touched object. Distances in metres unless the
// name says mm.
import { segmentDistance, toDeg } from './math.js';
import { capsuleObjectDistance } from './grasp.js';
import { MM } from './anatomy.js';

// Smallest margin (degrees) between every measured channel and its limit;
// negative means a joint is past its limit.
export function limitMargin(skel, joints = skel.joints) {
  let worst = Infinity;
  let where = '';
  for (const j of joints) {
    const m = skel.measureChannels(j);
    for (const axis of ['flex', 'abd', 'twist']) {
      const L = j.limits[axis];
      if (L[0] === 0 && L[1] === 0) {
        const v = Math.abs(m[axis]);
        if (v > 1e-6 && -toDeg(v) < worst) { worst = -toDeg(v); where = `${j.id} ${axis} fixed`; }
        continue;
      }
      const margin = Math.min(L[1] - m[axis], m[axis] - L[0]);
      if (toDeg(margin) < worst) { worst = toDeg(margin); where = `${j.id} ${axis}`; }
    }
  }
  return { worst, where };
}

// Phalanx and metacarpal capsules of one hand.
export function handCapsules(skel, side) {
  const out = [];
  for (const j of skel.sides[side].joints) {
    if (j.kind !== 'hand' || !j.digit || j.segment === 'tip') continue;
    const c = j.children[0];
    out.push({ a: j.worldPos, b: c.worldPos, r: j.radius, digit: j.digit, segment: j.segment, name: j.name, side });
  }
  return out;
}

// Worst overlap in mm between capsules of different digits (finger to
// finger, and finger to palm through the metacarpals). A distal phalanx
// pressing another digit is an allowed pad contact up to allowedPads mm.
export function penetration(skel, side, allowedPads = 2.5) {
  const caps = handCapsules(skel, side);
  let worst = 0;
  let where = '';
  let padWorst = 0;
  for (let i = 0; i < caps.length; i++) {
    for (let k = i + 1; k < caps.length; k++) {
      const A = caps[i], B = caps[k];
      if (A.digit === B.digit) continue;
      if (A.segment === 'metacarpal' && B.segment === 'metacarpal') continue; // neighbouring metacarpals share the palm
      const overlap = (A.r + B.r) - segmentDistance(A.a, A.b, B.a, B.b).d;
      if (overlap <= 0) continue;
      const pad = A.segment === 'phalanx-distal' || B.segment === 'phalanx-distal';
      if (pad && overlap <= allowedPads * MM) { padWorst = Math.max(padWorst, overlap); continue; }
      if (overlap > worst) { worst = overlap; where = `${A.name} vs ${B.name}`; }
    }
  }
  return { worst: worst / MM, where, padWorst: padWorst / MM };
}

// Depth in mm that any phalanx capsule reaches into an object (shape with
// pos and rot). Recorded contact segments may press up to `allowed` mm (the
// pad squish); nothing else may enter at all.
export function objectPenetration(skel, side, obj, contacts = [], allowed = 1) {
  const ok = new Set(contacts.map((c) => c.joint));
  let worst = 0;
  let where = '';
  for (const c of handCapsules(skel, side)) {
    if (c.segment === 'metacarpal' && obj.ignorePalm) continue;
    const depth = -capsuleObjectDistance(obj, c.a, c.b, c.r);
    if (ok.has(c.name) && depth <= allowed * MM) continue;
    if (depth > worst) { worst = depth; where = c.name; }
  }
  return { worst: worst / MM, where };
}
