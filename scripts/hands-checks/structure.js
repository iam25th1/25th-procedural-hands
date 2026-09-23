// Structure: 25 joints per hand in the WebXR layout, left and right mirror
// within 0.1 mm, bone lengths equal the sourced data.
import { Skeleton, XR_JOINT_NAMES, FINGERS, XR_PREFIX } from '../../hands/src/skeleton.js';
import { BONES_MM, ARM_MM, MM } from '../../hands/src/anatomy.js';
import { v3 } from '../../hands/src/math.js';
import { mulberry32 } from '../../hands/src/rng.js';

export const structureChecks = [
  {
    name: 'structure: 25 joints per hand in the WebXR layout',
    async run() {
      const skel = new Skeleton();
      let worst = 0;
      const notes = [];
      for (const side of ['left', 'right']) {
        const hand = skel.sides[side].joints.filter((j) => j.kind === 'hand');
        const names = hand.map((j) => j.name);
        const mismatch = names.findIndex((n, i) => n !== XR_JOINT_NAMES[i]);
        if (hand.length !== 25 || mismatch >= 0) notes.push(`${side}: ${hand.length} joints, first mismatch at ${mismatch}`);
        worst = Math.max(worst, Math.abs(hand.length - 25));
      }
      return { pass: notes.length === 0, worst: 25 + worst, limit: 25, unit: 'joints', note: notes.join('; ') || `${skel.joints.length} joints total, ${XR_JOINT_NAMES.length} names in module order` };
    },
  },
  {
    name: 'structure: left and right mirror',
    async run() {
      const skel = new Skeleton();
      const rng = mulberry32(11);
      let worst = 0;
      for (let trial = 0; trial < 50; trial++) {
        skel.reset();
        if (trial) {
          for (const j of skel.sides.right.joints) {
            const L = skel.joint('left', j.name);
            const pick = (lim) => lim[0] + rng() * (lim[1] - lim[0]);
            const f = pick(j.limits.flex);
            const a = pick(j.limits.abd);
            const t = pick(j.limits.twist);
            skel.setChannels(j, f, a, t);
            skel.setChannels(L, f, a, t);
          }
          skel.update();
        }
        for (const j of skel.sides.right.joints) {
          const L = skel.joint('left', j.name);
          worst = Math.max(worst, v3.dist(v3.mirrorX([0, 0, 0], j.worldPos), L.worldPos));
        }
      }
      return { pass: worst <= 0.1 * MM, worst: worst / MM, limit: 0.1, unit: 'mm', note: '50 poses incl. rest' };
    },
  },
  {
    name: 'structure: bone lengths equal sourced data',
    async run() {
      const skel = new Skeleton();
      let worst = 0;
      const L = (side, a, c) => v3.dist(skel.joint(side, a).worldPos, skel.joint(side, c).worldPos) / MM;
      for (const side of ['left', 'right']) {
        for (const f of FINGERS) {
          const b = BONES_MM[f];
          const p = XR_PREFIX[f];
          worst = Math.max(worst,
            Math.abs(L(side, `${p}-metacarpal`, `${p}-phalanx-proximal`) - b.metacarpal),
            Math.abs(L(side, `${p}-phalanx-proximal`, `${p}-phalanx-intermediate`) - b.proximal),
            Math.abs(L(side, `${p}-phalanx-intermediate`, `${p}-phalanx-distal`) - b.middle),
            Math.abs(L(side, `${p}-phalanx-distal`, `${p}-tip`) - (b.distal + b.tip)));
        }
        const t = BONES_MM.thumb;
        worst = Math.max(worst,
          Math.abs(L(side, 'thumb-metacarpal', 'thumb-phalanx-proximal') - t.metacarpal),
          Math.abs(L(side, 'thumb-phalanx-proximal', 'thumb-phalanx-distal') - t.proximal),
          Math.abs(L(side, 'thumb-phalanx-distal', 'thumb-tip') - (t.distal + t.tip)),
          Math.abs(L(side, 'upper-arm', 'forearm') - ARM_MM.upperArm),
          Math.abs(L(side, 'forearm', 'wrist') - ARM_MM.forearm));
      }
      return { pass: worst < 1e-6, worst, limit: 1e-6, unit: 'mm', note: 'Buryanov and Kotiuk 2010 phalanges and metacarpals; Drillis and Contini arm segments' };
    },
  },
];
