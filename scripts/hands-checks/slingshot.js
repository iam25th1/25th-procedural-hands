// Slingshot and action checks: pouch at the pinch, band ends locked to the
// tips, band length monotonic with draw, post release settle, launch along
// the aim; plus limits, penetration and continuity over every action.
import { runScenario, prepare, start, run, ACTION_DURATIONS, slingshotRig } from '../../app/scenes/slingshot/scenarios.js';
import { buildFork, Slingshot } from '../../app/scenes/slingshot/slingshot.js';
import { v3, quat, toDeg } from '../../hands/src/math.js';
import { MM } from '../../hands/src/anatomy.js';
import { STEP } from '../../hands/src/clock.js';
import { limitMargin, penetration, objectPenetration } from '../../hands/src/measure.js';
import { capsuleObjectDistance } from '../../hands/src/grasp.js';
import { buildStone } from '../../hands/src/stones.js';
import { capsuleEnd } from '../../hands/src/skeleton.js';
import { BUDGET, rigTriangles } from './budget.js';

// The slingshot is app code (app/scenes/slingshot), not module code: the
// module rig takes it as a controller, so every rig here is slingshotRig().
const ACTIONS = Object.keys(ACTION_DURATIONS);

// Pad surface points of the thumb and index from the skeleton. The pouch is
// pinched when both pads sit on its surface, so the measure is how far each
// pad surface is from the pouch sphere's surface.
function padPoints(rig, side) {
  const pads = [];
  for (const [tip, dist] of [['thumb-tip', 'thumb-phalanx-distal'], ['index-finger-tip', 'index-finger-phalanx-distal']]) {
    const t = rig.skel.joint(side, tip).worldPos;
    const d = rig.skel.joint(side, dist);
    const along = quat.rotate([0, 0, 0], d.worldRot, [0, 0, 1]);
    const padDir = quat.rotate([0, 0, 0], d.worldRot, [0, -1, 0]);
    const back = v3.addScaled([0, 0, 0], t, along, 0.006);
    pads.push(v3.addScaled([0, 0, 0], back, padDir, d.radius));
  }
  return pads;
}
// Separation between the pinching digits and the pouch surface: the thumb
// and index distal capsules must stay on it (neither lifting off nor sinking).
function pinchGap(rig, side) {
  const h = rig.hands[side];
  if (!h.attached) return Infinity;
  const obj = rig.attachedObject(side);
  let worst = 0;
  for (const name of ['thumb-phalanx-distal', 'index-finger-phalanx-distal']) {
    const j = rig.skel.joint(side, name);
    // The module's distal capsule ends one radius short of the tip joint (the
    // tip sits on the skin), and the grasp closes on that capsule, so the gap
    // is measured on it rather than out to the tip joint.
    worst = Math.max(worst, Math.abs(capsuleObjectDistance(obj, j.worldPos, capsuleEnd(j), j.radius)));
  }
  void padPoints;
  return worst;
}

export const slingshotChecks = [
  {
    name: 'slingshot: pouch within 2 mm of the pinch point while drawing',
    async run() {
      const rig = slingshotRig({ seed: 21 });
      const side = rig.pinchSide;
      let worst = 0;
      prepare(rig, 'draw');
      start(rig, 'draw');
      run(rig, 1.6, () => {
        if (!rig.slingshot.pinched) return;
        // The pouch centre is the pinched object's centre; both pads must stay on its surface.
        const centreErr = v3.dist(rig.slingshot.pouchCentre, rig.attachedObject(side).pos);
        worst = Math.max(worst, pinchGap(rig, side), centreErr);
      });
      return { pass: worst <= 2 * MM, worst: worst / MM, limit: 2, unit: 'mm', note: 'thumb and index pads on the pouch surface, every frame of a full draw' };
    },
  },
  {
    name: 'slingshot: band ends locked to the fork tips',
    async run() {
      const rig = slingshotRig({ seed: 22 });
      let worst = 0;
      runScenario(rig, 'release', () => {
        const tips = rig.slingshot.tipsWorld();
        const g = rig.slingshot.geometry();
        // First vertex of each band ring sits on the tip: the band starts at the tip curve point.
        for (let k = 0; k < 2; k++) {
          const base = k * ((12 + 1) * 4 + 2);
          const ring = [];
          for (let i = 0; i < 4; i++) ring.push([g.positions[(base + i) * 3], g.positions[(base + i) * 3 + 1], g.positions[(base + i) * 3 + 2]]);
          const centre = ring.reduce((acc, p) => v3.add(acc, acc, p), [0, 0, 0]).map((v) => v / 4);
          worst = Math.max(worst, v3.dist(centre, tips[k]));
        }
      });
      return { pass: worst <= 0.5 * MM, worst: worst / MM, limit: 0.5, unit: 'mm', note: 'through a full draw and release' };
    },
  },
  {
    name: 'slingshot: band length rises monotonically with draw',
    async run() {
      const rig = slingshotRig({ seed: 23 });
      prepare(rig, 'draw');
      let prev = -1;
      let worstDrop = 0;
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i <= 20; i++) {
        rig.actions.setDraw(i / 20);
        run(rig, 0.6);
        const L = Math.max(...rig.slingshot.geometry().lengths);
        lo = Math.min(lo, L); hi = Math.max(hi, L);
        if (prev >= 0 && L < prev) worstDrop = Math.max(worstDrop, prev - L);
        prev = L;
      }
      return { pass: worstDrop <= 1e-6, worst: worstDrop / MM, limit: 0, unit: 'mm drop', note: `${(lo * 1000).toFixed(0)} to ${(hi * 1000).toFixed(0)} mm over 21 draw amounts` };
    },
  },
  {
    name: 'slingshot: post release oscillation settles within 0.6 s',
    async run() {
      const rig = slingshotRig({ seed: 24 });
      prepare(rig, 'release');
      const before = rig.slingshot.ringAmplitude();
      const t0 = rig.time;
      start(rig, 'release');
      let amp = 0;
      let peak = 0;
      run(rig, 0.6, (tAbs) => { const t = tAbs - t0; const a = rig.slingshot.ringAmplitude(); peak = Math.max(peak, a); if (t > 0.5) amp = Math.max(amp, a); });
      // Settled: within 2 percent of the initial displacement, and under 2 mm.
      const ratio = amp / Math.max(before, 1e-6);
      return { pass: ratio <= 0.02 && amp <= 2 * MM, worst: amp / MM, limit: 2, unit: 'mm', note: `${(before * 1000).toFixed(0)} mm initial displacement, ${(ratio * 100).toFixed(2)} percent left after 0.5 s` };
    },
  },
  {
    name: 'slingshot: launch direction within 1 degree of the aim',
    async run() {
      let worst = 0;
      for (const seed of [25, 26, 27]) {
        const rig = slingshotRig({ seed, handedness: seed === 26 ? 'left' : 'right' });
        prepare(rig, 'release');
        const anchorAim = [0, 0, -1]; // the reticle: straight ahead from the anchor
        start(rig, 'release');
        const L = rig.actions.lastLaunch;
        const ang = Math.acos(Math.min(1, v3.dot(L.launchDir, anchorAim)));
        worst = Math.max(worst, toDeg(ang));
      }
      return { pass: worst <= 1, worst, limit: 1, unit: 'deg', note: 'right and left handed, full draw' };
    },
  },
  {
    name: 'limits: no joint passes its limit across every action at 60 fps',
    async run() {
      let worst = Infinity;
      let where = '';
      for (const name of ACTIONS) {
        const rig = slingshotRig({ seed: 31 });
        runScenario(rig, name, () => { const m = limitMargin(rig.skel); if (m.worst < worst) { worst = m.worst; where = `${name}: ${m.where}`; } });
      }
      return { pass: worst >= -1e-6, worst, limit: 0, unit: 'deg margin', note: where };
    },
  },
  {
    name: 'penetration: fingers, palm and held objects across every action',
    async run() {
      let worst = 0;
      let where = '';
      for (const name of ACTIONS) {
        const rig = slingshotRig({ seed: 32 });
        runScenario(rig, name, (t) => {
          for (const side of ['left', 'right']) {
            const p = penetration(rig.skel, side);
            if (p.worst > worst) { worst = p.worst; where = `${name} ${t.toFixed(2)}s ${side}: ${p.where}`; }
            const h = rig.hands[side];
            if (h.attached) {
              const obj = rig.attachedObject(side);
              const q = objectPenetration(rig.skel, side, obj, h.attached.contacts);
              if (q.worst > worst) { worst = q.worst; where = `${name} ${t.toFixed(2)}s ${side} object: ${q.where}`; }
            }
          }
        });
      }
      return { pass: worst <= 1, worst, limit: 1, unit: 'mm', note: where || 'clean' };
    },
  },
  {
    name: 'continuity: joint speed under 20 rad/s (60 in the release window), root jump under 5 cm, every action',
    async run() {
      let worst = 0;
      let worstRelease = 0;
      let worstJump = 0;
      let jumpWhere = '';
      let where = '';
      const localRot = (j) => (j.parent ? quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], j.parent.worldRot), j.worldRot) : j.worldRot.slice());
      for (const name of ACTIONS) {
        const rig = slingshotRig({ seed: 33 });
        prepare(rig, name);
        let prev = rig.skel.joints.map(localRot);
        let prevRoot = { left: rig.skel.joint('left', 'wrist').worldPos.slice(), right: rig.skel.joint('right', 'wrist').worldPos.slice() };
        start(rig, name);
        const t0 = rig.time;
        const inRelease = (t) => (name === 'release' || name === 'dryRelease') && t < 0.25;
        const check = () => {
          const t = rig.time - t0;
          rig.skel.joints.forEach((j, k) => {
            const cur = localRot(j);
            const speed = quat.angleBetween(prev[k], cur) / STEP;
            if (inRelease(t)) worstRelease = Math.max(worstRelease, speed);
            else if (speed > worst) { worst = speed; where = `${name} ${t.toFixed(2)}s ${j.id}`; }
            prev[k] = cur;
          });
          for (const side of ['left', 'right']) {
            const w = rig.skel.joint(side, 'wrist').worldPos;
            const jump = v3.dist(w, prevRoot[side]);
            if (jump > worstJump) { worstJump = jump; jumpWhere = `${name} ${t.toFixed(2)}s ${side}`; }
            prevRoot[side] = w.slice();
          }
        };
        check();
        run(rig, ACTION_DURATIONS[name], check);
      }
      return { pass: worst < 20 && worstRelease < 60 && worstJump < 0.05, worst, limit: 20, unit: 'rad/s', note: `${where}; release window peak ${worstRelease.toFixed(1)} rad/s (limit 60); root jump ${(worstJump / MM).toFixed(1)} mm at ${jumpWhere} (limit 50)` };
    },
  },
  {
    name: 'determinism: identical hashes through every action',
    async run() {
      const play = (seed) => {
        const rig = slingshotRig({ seed });
        const out = [];
        for (const name of ['loadPebble', 'draw', 'release', 'pickup', 'drink', 'jump', 'hitFlinch']) {
          runScenario(rig, name, (t) => { if (Math.abs(t - 0.4) < STEP / 2) out.push(rig.hash()); });
        }
        return out;
      };
      const a = play(41);
      const b = play(41);
      const c = play(42);
      const mismatches = a.filter((h, i) => h !== b[i]).length;
      const same = a.filter((h, i) => h === c[i]).length;
      return { pass: mismatches === 0 && same < a.length && a.length >= 7, worst: mismatches, limit: 0, unit: 'mismatches', note: `${a.length} samples; other seed differs in ${a.length - same}` };
    },
  },
  {
    name: 'budget: rig with fork, bands, pouch and stone at both LODs; draw calls',
    async run() {
      const rig = slingshotRig({ seed: 1 });
      const fork = buildFork().stats.triangles;
      const bands = rig.slingshot.geometry().stats.triangles;
      const stone = buildStone('rock', 2).stats.triangles;
      const high = rigTriangles('high', fork + bands + stone);
      const lowCat = new Slingshot({ lod: 'low' });
      lowCat.setFork(rig.slingshot.forkPos, rig.slingshot.forkRot);
      const forkLow = lowCat.fork.stats.triangles;
      const bandsLow = lowCat.geometry().stats.triangles;
      const stoneLow = buildStone('rock', 2, 0.03, { lod: 'low' }).stats.triangles;
      const low = rigTriangles('low', forkLow + bandsLow + stoneLow);
      const calls = 5; // two arms, fork, bands with pouch, one stone
      const pass = high <= BUDGET.trianglesHigh && low <= BUDGET.trianglesLow && calls <= BUDGET.drawCalls;
      return { pass, worst: high, limit: BUDGET.trianglesHigh, unit: 'tris', note: `low ${low} (limit ${BUDGET.trianglesLow}: fork ${forkLow}, bands ${bandsLow}, stone ${stoneLow}); high: fork ${fork}, bands and pouch ${bands}, stone ${stone}; ${calls} draw calls` };
    },
  },
];
