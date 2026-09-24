// Two bone arm IK (shoulder, elbow, wrist) with a pole target, anatomical
// limits, reach clamping without elbow flips, and wrist orientation targets
// whose forearm rotation is shared across the three twist bones as the
// forearm's skin shares it (the wrist joint itself does not pronate).
//
// Law of cosines: for upper arm a, forearm b and shoulder to target d,
//   cos(elbow interior) = (a^2 + b^2 - d^2) / (2ab)
//   cos(shoulder offset) = (a^2 + d^2 - b^2) / (2ad)
import { v3, quat, clamp, deg } from './math.js';
import { FOREARM_TWIST, LIMITS_DEG } from './anatomy.js';
import { TWIST_PART } from './skeleton.js';

const REACH_MARGIN = 0.99995; // never fully lock the elbow (about 1.6 degrees of residual flex)

// Solve one arm. target: world wrist position; targetRot: world hand rotation
// (WebXR wrist frame: -Z along the metacarpals, -Y out of the palm); pole:
// world point the elbow should point toward. Returns diagnostics.
export function solveArm(skel, side, target, targetRot, pole) {
  const ua = skel.joint(side, 'upper-arm');
  const fa = skel.joint(side, 'forearm');
  const chain = FOREARM_TWIST.map((t) => skel.joint(side, t.name));
  const wr = skel.joint(side, 'wrist');
  const S = ua.worldPos; // shoulder position is current (parent chain already updated)
  const a = ua.length;
  // Elbow to wrist: the forearm joint's own length only reaches the first twist bone.
  const b = v3.dist(fa.restWorldPos, wr.restWorldPos);

  const toT = v3.sub([0, 0, 0], target, S);
  let d = v3.len(toT);
  const dMax = (a + b) * REACH_MARGIN;
  const dMin = Math.abs(a - b) + 0.01;
  const reachable = d <= dMax && d >= dMin;
  d = clamp(d, dMin, dMax);
  const u = v3.normalize([0, 0, 0], toT);
  if (v3.len(toT) < 1e-9) v3.set(u, 0, 0, -1);

  // Elbow interior angle and flexion, clamped to the joint limit.
  let cosE = clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1);
  let flex = Math.PI - Math.acos(cosE);
  const fl = fa.limits.flex;
  const flexClamped = clamp(flex, fl[0], fl[1]);
  if (flexClamped !== flex) {
    flex = flexClamped;
    cosE = Math.cos(Math.PI - flex);
    d = Math.sqrt(Math.max(1e-9, a * a + b * b - 2 * a * b * cosE));
  }
  const cosS = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const alpha = Math.acos(cosS);

  // Elbow in the plane of shoulder, target and pole, on the pole side.
  let pdir = v3.reject([0, 0, 0], v3.sub([0, 0, 0], pole, S), u);
  if (v3.len(pdir) < 1e-6) pdir = v3.reject([0, 0, 0], [0, -1, 0], u);
  v3.normalize(pdir, pdir);
  const E = v3.add([0, 0, 0], S, v3.add([0, 0, 0], v3.scale([0, 0, 0], u, a * Math.cos(alpha)), v3.scale([0, 0, 0], pdir, a * Math.sin(alpha))));
  const W = v3.addScaled([0, 0, 0], S, u, d); // where the wrist lands (equals target when reachable)

  // Upper arm frame: -Z toward the elbow, -Y toward the forearm's bend side.
  const zU = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], S, E));
  const bend = v3.reject([0, 0, 0], v3.sub([0, 0, 0], W, E), zU);
  let yU;
  if (v3.len(bend) < 1e-6) yU = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], v3.negate([0, 0, 0], pdir), zU));
  else yU = v3.normalize([0, 0, 0], v3.negate([0, 0, 0], bend));
  const xU = v3.cross([0, 0, 0], yU, zU);
  const qU = quat.fromBasis([0, 0, 0, 1], xU, yU, zU);

  // Upper arm pose relative to its rest, expressed as channels and clamped.
  const parentRot = ua.parent.worldRot;
  const restWorld = quat.multiply([0, 0, 0, 1], parentRot, ua.restLocalRot);
  const local = quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], restWorld), qU);
  skel.setSwingTwist(ua, local);
  skel.setChannels(fa, flex, 0, 0);

  // Wrist orientation: relative rotation from the forearm frame, split into
  // twist about the forearm (the twist bones) and swing at the wrist.
  // Update the chain so the forearm's world rotation is current.
  skel.update();
  // Rest chain from the forearm to the wrist carries the bind pronation, so
  // the extra rotation the target needs is measured against it, then the
  // total pronation from neutral is wrapped and clamped and shared over the
  // twist bones in their sourced parts (anatomy.js); the wrist takes none.
  const restChain = [...chain, wr].reduce((q, j) => quat.multiply([0, 0, 0, 1], q, j.restLocalRot), [0, 0, 0, 1]);
  const base = quat.multiply([0, 0, 0, 1], fa.worldRot, restChain);
  const rel = quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], base), targetRot);
  // Twist about the forearm axis first (the chain's convention), then the
  // wrist swing (flexion, deviation) as one rotation vector: continuous.
  const st = quat.twistSwing(rel, [0, 0, 1]);
  const ang = quat.angle(st.swing);
  const sn = Math.sqrt(Math.max(0, 1 - st.swing[3] * st.swing[3]));
  const axis = sn < 1e-9 ? [0, 0, 0] : [st.swing[0] / sn, st.swing[1] / sn, st.swing[2] / sn];
  const wc = { flex: -axis[0] * ang, abd: (axis[1] * ang) * wr.sideSign, twist: st.twist * wr.sideSign };
  const offset = chain.reduce((acc, j) => acc + (j.twistOffset || 0), 0);
  let total = offset + wc.twist;
  total = ((total + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // Continuity: of the equivalent branches, take the one nearest the last solve.
  const last = wr.lastPronation;
  if (last !== undefined) {
    for (const cand of [total - 2 * Math.PI, total + 2 * Math.PI]) if (Math.abs(cand - last) < Math.abs(total - last)) total = cand;
  }
  wr.lastPronation = total;
  const range = LIMITS_DEG.forearm.twist.map(deg);
  const pron = clamp(total, range[0], range[1]);
  for (const j of chain) skel.setChannels(j, 0, 0, pron * TWIST_PART[j.name]);
  skel.setChannels(wr, wc.flex, wc.abd * wr.abdSign, 0);
  skel.update();

  const err = v3.dist(wr.worldPos, target);
  return { reachable, error: err, elbow: E.slice(), flex, twist: pron, wristFlex: wr.channels.flex, wristDev: wr.channels.abd };
}

// Hand orientation from a desired finger direction (-Z) and palm direction (-Y).
export function handRotation(fingerDir, palmDir) {
  const z = v3.normalize([0, 0, 0], v3.negate([0, 0, 0], fingerDir));
  const y = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], v3.negate([0, 0, 0], palmDir), z));
  const x = v3.cross([0, 0, 0], y, z);
  return quat.fromBasis([0, 0, 0, 1], x, y, z);
}
