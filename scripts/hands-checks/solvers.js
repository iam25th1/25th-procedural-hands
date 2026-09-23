// Solver acceptance: limits, penetration, contacts, IK, determinism and
// solver time. The manipulation checks add their own.
import { Skeleton, FINGERS, XR_PREFIX } from '../../hands/src/skeleton.js';
import { Rig } from '../../hands/src/rig.js';
import { POSES, POSE_NAMES } from '../../hands/src/poses.js';
import { poseChannels, applyChannels, clonePose } from '../../hands/src/fingers.js';
import { solveArm, handRotation } from '../../hands/src/ik.js';
import { preShape, placeObject, solveGrasp, capsuleObjectDistance, aperture, tipGap, GRIPS } from '../../hands/src/grasp.js';
import { v3, quat, toDeg, deg, segmentDistance } from '../../hands/src/math.js';
import { MM } from '../../hands/src/anatomy.js';
import { limitMargin, penetration, objectPenetration } from '../../hands/src/measure.js';
import { mulberry32 } from '../../hands/src/rng.js';
import { STEP } from '../../hands/src/clock.js';

const DIGIT_NAMES = ['thumb', ...FINGERS];

// Objects the lab grips, sized as the spec says: pebbles 2 to 3 cm across,
// rocks 5 to 7 cm, the fork handle 2.5 to 3 cm.
export const GRIP_OBJECTS = {
  powerCylinder: { shape: 'cylinder', r: 0.014, h: 0.09 },
  spherical: { shape: 'sphere', r: 0.03 },
  tipPinch: { shape: 'sphere', r: 0.011 },
  padPinch: { shape: 'sphere', r: 0.0125 },
  tripod: { shape: 'sphere', r: 0.015 },
};

// Limit, self-penetration and object penetration measures live in the
// module (hands/src/measure.js) so tests and checks share one definition.
export { limitMargin, penetration, objectPenetration };

export const solverChecks = [
  {
    name: 'limits: no joint passes its limit (poses and 10000 seeded blends)',
    async run() {
      const rig = new Rig({ seed: 5 });
      let worst = Infinity;
      let where = '';
      const note = (m) => { if (m.worst < worst) { worst = m.worst; where = m.where; } };
      for (const name of POSE_NAMES) {
        rig.setPose('left', name, { snap: true });
        rig.setPose('right', name, { snap: true });
        rig.step(0);
        note(limitMargin(rig.skel));
      }
      const rng = mulberry32(99);
      const names = POSE_NAMES;
      for (let i = 0; i < 10000; i++) {
        const side = rng() < 0.5 ? 'left' : 'right';
        const a = names[Math.floor(rng() * names.length)];
        const b = names[Math.floor(rng() * names.length)];
        const mask = {};
        for (const d of DIGIT_NAMES) mask[d] = rng();
        rig.setPose(side, a, { snap: true });
        rig.setLayer(side, 'blend', b, { mask, weight: rng(), snap: true });
        rig.tremor = rng() < 0.2 ? 1 : 0;
        rig.step(STEP);
        note(limitMargin(rig.skel));
      }
      return { pass: worst >= -1e-6, worst, limit: 0, unit: 'deg margin', note: where };
    },
  },
  {
    name: 'penetration: finger to finger and finger to palm (all poses)',
    async run() {
      const rig = new Rig({ seed: 6 });
      let worst = 0;
      let where = '';
      let pads = 0;
      for (const name of POSE_NAMES) {
        for (const side of ['left', 'right']) {
          rig.setPose(side, name, { snap: true });
          rig.step(0);
          const p = penetration(rig.skel, side);
          pads = Math.max(pads, p.padWorst);
          if (p.worst > worst) { worst = p.worst; where = `${name} ${side}: ${p.where}`; }
        }
      }
      return { pass: worst <= 1, worst, limit: 1, unit: 'mm', note: `${where || 'clean'}; worst allowed pad press ${pads.toFixed(2)} mm` };
    },
  },
  {
    name: 'penetration: finger to object capsule (all grips)',
    async run() {
      const rig = new Rig({ seed: 6 });
      let worst = 0;
      let where = '';
      for (const [key, obj] of Object.entries(GRIP_OBJECTS)) {
        for (const side of ['left', 'right']) {
          rig.setPose(side, 'relaxed', { snap: true });
          rig.step(0);
          const att = rig.grasp(side, obj, key);
          rig.snapHand(side);
          rig.step(0);
          const world = rig.attachedObject(side);
          const p = objectPenetration(rig.skel, side, world, att.contacts);
          if (p.worst > worst) { worst = p.worst; where = `${key} ${side}: ${p.where}`; }
          const q = penetration(rig.skel, side);
          if (q.worst > worst) { worst = q.worst; where = `${key} ${side}: ${q.where}`; }
          rig.release(side);
        }
      }
      return { pass: worst <= 1, worst, limit: 1, unit: 'mm', note: where || 'clean' };
    },
  },
  {
    name: 'contacts: power grip four fingers and thumb, pad pinch thumb and index, spherical four digits',
    async run() {
      const skel = new Skeleton();
      const problems = [];
      let minDigits = Infinity;
      for (const side of ['left', 'right']) {
        const run = (key) => {
          const obj = GRIP_OBJECTS[key];
          const pre = preShape(skel, side, obj, key);
          const placed = placeObject(skel, side, obj, key);
          const r = solveGrasp(skel, side, { ...obj, ...placed }, key, pre.pose);
          return new Set(r.contacts.map((c) => c.digit));
        };
        const power = run('powerCylinder');
        if (!DIGIT_NAMES.every((d) => power.has(d))) problems.push(`${side} power grip: ${[...power].join(',')}`);
        const pinch = run('padPinch');
        if (!(pinch.has('thumb') && pinch.has('index'))) problems.push(`${side} pad pinch: ${[...pinch].join(',')}`);
        const sph = run('spherical');
        if (sph.size < 4) problems.push(`${side} spherical: ${[...sph].join(',')}`);
        minDigits = Math.min(minDigits, power.size, sph.size);
      }
      return { pass: problems.length === 0, worst: minDigits, limit: 4, unit: 'digits', note: problems.join('; ') || 'power 5, pinch thumb+index, spherical >= 4 on both hands' };
    },
  },
  {
    name: 'contacts: pre-shape aperture grows monotonically with radius 0.8 to 4 cm',
    async run() {
      const skel = new Skeleton();
      let prev = -1;
      let worstDrop = 0;
      const gaps = [];
      for (let r = 0.008; r <= 0.04 + 1e-9; r += 0.002) {
        const key = r <= 0.02 ? 'padPinch' : 'spherical';
        const pre = preShape(skel, 'right', { shape: 'sphere', r }, key);
        if (prev >= 0 && pre.gap < prev) worstDrop = Math.max(worstDrop, prev - pre.gap);
        gaps.push(pre.gap);
        prev = pre.gap;
      }
      return { pass: worstDrop <= 1e-6, worst: worstDrop / MM, limit: 0, unit: 'mm drop', note: `gap ${(gaps[0] / MM).toFixed(0)} to ${(gaps[gaps.length - 1] / MM).toFixed(0)} mm over ${gaps.length} radii` };
    },
  },
  {
    name: 'ik: reachable targets met within 2 mm',
    async run() {
      const skel = new Skeleton();
      const rng = mulberry32(31);
      let worst = 0;
      let n = 0;
      for (const side of ['left', 'right']) {
        const s = side === 'right' ? 1 : -1;
        const shoulder = skel.joint(side, 'upper-arm').worldPos.slice();
        const reach = skel.joint(side, 'upper-arm').length + v3.dist(skel.joint(side, 'forearm').restWorldPos, skel.joint(side, 'wrist').restWorldPos);
        for (let i = 0; i < 600; i++) {
          const t = [shoulder[0] + (rng() - 0.5) * 0.5, shoulder[1] + (rng() - 0.3) * 0.4, shoulder[2] - 0.12 - rng() * 0.4];
          const d = v3.dist(t, shoulder);
          if (d > reach * 0.97 || d < 0.2) continue;
          const rot = handRotation([0.2 * s, 0.3, -1], [-s, 0.3, 0.1]);
          const r = solveArm(skel, side, t, rot, [s * 0.5, -0.7, 0]);
          worst = Math.max(worst, r.error);
          n++;
        }
      }
      return { pass: worst <= 0.002, worst: worst / MM, limit: 2, unit: 'mm', note: `${n} targets` };
    },
  },
  {
    name: 'ik: unreachable targets extend fully without elbow flips',
    async run() {
      const skel = new Skeleton();
      const rng = mulberry32(32);
      let worstFlex = 0;
      let worstDir = 0;
      let flips = 0;
      for (const side of ['left', 'right']) {
        const s = side === 'right' ? 1 : -1;
        const shoulder = skel.joint(side, 'upper-arm').worldPos.slice();
        const pole = [s * 0.5, -0.7, 0];
        let prevSide = null;
        for (let i = 0; i < 200; i++) {
          const dir = v3.normalize([0, 0, 0], [(rng() - 0.5) * 0.6, (rng() - 0.6) * 0.5, -1]);
          const t = v3.addScaled([0, 0, 0], shoulder, dir, 0.8 + rng() * 0.8);
          const r = solveArm(skel, side, t, handRotation(dir, [-s, 0, 0]), pole);
          worstFlex = Math.max(worstFlex, r.flex);
          const w = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], skel.joint(side, 'wrist').worldPos, shoulder));
          worstDir = Math.max(worstDir, Math.acos(Math.min(1, v3.dot(w, dir))));
          const u = dir;
          const e = v3.reject([0, 0, 0], v3.sub([0, 0, 0], r.elbow, shoulder), u);
          const p = v3.reject([0, 0, 0], v3.sub([0, 0, 0], pole, shoulder), u);
          const sideSign = Math.sign(v3.dot(e, p) || 1);
          if (prevSide !== null && sideSign !== prevSide) flips++;
          prevSide = sideSign;
        }
      }
      const worst = Math.max(toDeg(worstFlex), toDeg(worstDir), flips);
      return { pass: worstFlex < deg(2) && worstDir < deg(0.5) && flips === 0, worst, limit: 2, unit: 'deg', note: `max elbow flex ${toDeg(worstFlex).toFixed(2)} deg, direction error ${toDeg(worstDir).toFixed(3)} deg, ${flips} flips` };
    },
  },
  {
    name: 'ik: forearm twist shared across the twist bones',
    async run() {
      const skel = new Skeleton();
      const rng = mulberry32(33);
      let worst = 0;
      let maxTwist = 0;
      for (const side of ['left', 'right']) {
        const s = side === 'right' ? 1 : -1;
        const shoulder = skel.joint(side, 'upper-arm').worldPos.slice();
        for (let i = 0; i < 200; i++) {
          const t = [shoulder[0] + (rng() - 0.5) * 0.3, shoulder[1] + (rng() - 0.2) * 0.3, shoulder[2] - 0.25 - rng() * 0.2];
          const roll = (rng() - 0.5) * deg(160);
          const palm = [Math.sin(roll) * s, -Math.cos(roll), 0];
          solveArm(skel, side, t, handRotation([0, 0.1, -1], palm), [s * 0.5, -0.7, 0]);
          const t1 = skel.joint(side, 'forearm-twist-1').channels.twist;
          const t2 = skel.joint(side, 'forearm-twist-2').channels.twist;
          const tw = skel.joint(side, 'wrist').channels.twist;
          worst = Math.max(worst, Math.abs(t1 - t2), Math.abs(t2 - tw));
          maxTwist = Math.max(maxTwist, Math.abs(t1 + t2 + tw));
        }
      }
      return { pass: worst < 1e-9, worst: toDeg(worst), limit: 0, unit: 'deg spread', note: `equal thirds; up to ${toDeg(maxTwist).toFixed(0)} deg total twist used` };
    },
  },
  {
    name: 'determinism: same clock and seed give identical joint hashes',
    async run() {
      const script = (rig, frame) => {
        if (frame === 20) rig.setPose('right', 'fist');
        if (frame === 50) rig.setLayer('left', 'g', 'v', { mask: { index: 1, middle: 1, thumb: 0.5 } });
        if (frame === 90) rig.grasp('right', GRIP_OBJECTS.padPinch, 'padPinch');
        if (frame === 140) { rig.release('right'); rig.setPose('right', 'relaxed'); rig.tremor = 1; }
        if (frame === 200) rig.setArmTarget('left', { pos: [-0.2, -0.1, -0.3] });
      };
      const run = (seed) => {
        const rig = new Rig({ seed });
        const out = [];
        for (let f = 1; f <= 300; f++) {
          script(rig, f);
          rig.step(STEP);
          if (f % 50 === 0) out.push(rig.hash());
        }
        return out;
      };
      const a = run(11);
      const b = run(11);
      const c = run(12);
      const mismatches = a.filter((h, i) => h !== b[i]).length;
      const same = a.filter((h, i) => h === c[i]).length;
      return { pass: mismatches === 0 && same < a.length, worst: mismatches, limit: 0, unit: 'mismatches', note: `${a.length} samples; seed 12 differs in ${a.length - same}` };
    },
  },
  {
    name: 'continuity: local joint angular speed under 20 rad/s across pose changes, hand root jump under 5 cm',
    async run() {
      const rig = new Rig({ seed: 8 });
      const localRot = (j) => (j.parent ? quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], j.parent.worldRot), j.worldRot) : j.worldRot.slice());
      let prev = rig.skel.joints.map(localRot);
      let prevRoot = { left: rig.skel.joint('left', 'wrist').worldPos.slice(), right: rig.skel.joint('right', 'wrist').worldPos.slice() };
      let worstSpeed = 0;
      let worstJump = 0;
      let where = '';
      const names = POSE_NAMES;
      for (let f = 1; f <= names.length * 30; f++) {
        if (f % 30 === 1) {
          const name = names[Math.floor(f / 30) % names.length];
          rig.setPose('left', name);
          rig.setPose('right', name);
        }
        rig.step(STEP);
        rig.skel.joints.forEach((j, k) => {
          const cur = localRot(j);
          const speed = quat.angleBetween(prev[k], cur) / STEP;
          if (speed > worstSpeed) { worstSpeed = speed; where = j.id; }
          prev[k] = cur;
        });
        for (const side of ['left', 'right']) {
          const w = rig.skel.joint(side, 'wrist').worldPos;
          worstJump = Math.max(worstJump, v3.dist(w, prevRoot[side]));
          prevRoot[side] = w.slice();
        }
      }
      return { pass: worstSpeed < 20 && worstJump < 0.05, worst: worstSpeed, limit: 20, unit: 'rad/s', note: `${where}; root jump ${(worstJump / MM).toFixed(1)} mm (limit 50)` };
    },
  },
  {
    name: 'budget: solver time per frame (median)',
    async run() {
      const rig = new Rig({ seed: 9 });
      const times = [];
      for (let f = 1; f <= 600; f++) {
        if (f % 60 === 0) rig.setPose('right', POSE_NAMES[(f / 60) % POSE_NAMES.length]);
        const t0 = performance.now();
        rig.step(STEP);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      return { pass: median <= 0.5, worst: median, limit: 0.5, unit: 'ms', note: `p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} ms in Node` };
    },
  },
];

export { applyChannels, poseChannels, clonePose, POSES, GRIPS, aperture, tipGap };
