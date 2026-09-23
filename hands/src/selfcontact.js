// Self contact guard for the thumb. Named poses are solved clear of the
// fingers, but the straight line between two poses in joint space can carry
// the thumb through a finger on the way (a relaxed hand closing into a fist
// sweeps the thumb across the index). Each step, if a thumb phalanx presses
// into another digit past what a pad contact allows, a short coordinate
// descent on the thumb's own channels moves it the least it can to slide
// over that digit instead, and the springs carry on from there.
import { segmentDistance, deg } from './math.js';
import { MM } from './anatomy.js';
import { capsuleEnd } from './skeleton.js';

const ALLOW = { 'thumb-phalanx-proximal': 0.7 * MM, 'thumb-phalanx-distal': 1.8 * MM };
const THUMB = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'];
const STEPS = [deg(1.5), deg(0.5)];
const MAX_ITER = 6;

function capsule(j) { return { a: j.worldPos, b: capsuleEnd(j), r: j.radius }; }

export function thumbViolation(skel, side) {
  const S = skel.sides[side];
  let worst = 0;
  const others = [];
  for (const j of S.joints) if (j.kind === 'hand' && j.digit && j.digit !== 'thumb' && j.segment !== 'tip') others.push(capsule(j));
  for (const name of ['thumb-phalanx-proximal', 'thumb-phalanx-distal']) {
    const t = capsule(S.byName.get(name));
    for (const o of others) {
      const over = t.r + o.r - segmentDistance(t.a, t.b, o.a, o.b).d - ALLOW[name];
      if (over > worst) worst = over;
    }
  }
  return worst;
}

// springs: the hand's channel springs by joint name. Returns true if it moved the thumb.
export function guardThumb(skel, side, springs) {
  if (thumbViolation(skel, side) <= 0) return false;
  const joints = THUMB.map((n) => skel.sides[side].byName.get(n));
  const dofs = [
    { j: 0, ch: 'flex' }, { j: 0, ch: 'abd' }, { j: 1, ch: 'flex' }, { j: 2, ch: 'flex' },
  ];
  const desired = dofs.map((d) => springs[THUMB[d.j]][d.ch].x);
  const cur = desired.slice();
  const apply = () => {
    for (let k = 0; k < THUMB.length; k++) {
      const s = springs[THUMB[k]];
      const vals = { flex: s.flex.x, abd: s.abd.x, twist: s.twist.x };
      dofs.forEach((d, i) => { if (d.j === k) vals[d.ch] = cur[i]; });
      skel.setChannels(joints[k], vals.flex, vals.abd, vals.twist);
    }
    skel.update();
  };
  const cost = () => { apply(); return 200 * thumbViolation(skel, side) / MM + dofs.reduce((acc, d, i) => acc + Math.abs(cur[i] - desired[i]), 0) / deg(1); };
  let best = cost();
  for (const step of STEPS) {
    for (let it = 0; it < MAX_ITER; it++) {
      let improved = false;
      for (let i = 0; i < dofs.length; i++) {
        const L = joints[dofs[i].j].limits[dofs[i].ch];
        const keep = cur[i];
        let bestV = keep;
        for (const dv of [step, -step]) {
          cur[i] = Math.min(L[1], Math.max(L[0], keep + dv));
          if (cur[i] === keep) continue;
          const c = cost();
          if (c < best - 1e-9) { best = c; bestV = cur[i]; }
        }
        cur[i] = bestV;
        if (bestV !== keep) improved = true;
      }
      if (!improved) break;
    }
  }
  // Commit the moved thumb to the springs so the next step starts from it.
  dofs.forEach((d, i) => { const s = springs[THUMB[d.j]][d.ch]; if (s.x !== cur[i]) { s.x = cur[i]; s.v = 0; } });
  apply();
  return true;
}

// Neighbouring fingers stop against each other: spreading a finger toward a
// straight neighbour ends where their sides meet, the way a real finger does.
const PAIRS = [['index', 'middle'], ['middle', 'ring'], ['ring', 'little']];
const PREFIX = { index: 'index-finger', middle: 'middle-finger', ring: 'ring-finger', little: 'pinky-finger' };
const SEGS = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'];
const SIDE_ALLOW = 0.7 * MM;

function pairOverlap(skel, side, a, b) {
  const S = skel.sides[side];
  let worst = 0;
  for (const sa of SEGS) {
    const A = capsule(S.byName.get(`${PREFIX[a]}-${sa}`));
    for (const sb of SEGS) {
      const B = capsule(S.byName.get(`${PREFIX[b]}-${sb}`));
      const over = A.r + B.r - segmentDistance(A.a, A.b, B.a, B.b).d - SIDE_ALLOW;
      if (over > worst) worst = over;
    }
  }
  return worst;
}

export function fingerViolation(skel, side) {
  let worst = 0;
  for (const [a, b] of PAIRS) worst = Math.max(worst, pairOverlap(skel, side, a, b));
  return worst;
}

export function guardFingers(skel, side, springs) {
  let moved = false;
  for (const [a, b] of PAIRS) {
    if (pairOverlap(skel, side, a, b) <= 0) continue;
    moved = true;
    const ja = skel.sides[side].byName.get(`${PREFIX[a]}-phalanx-proximal`);
    const jb = skel.sides[side].byName.get(`${PREFIX[b]}-phalanx-proximal`);
    const sa = springs[ja.name];
    const sb = springs[jb.name];
    const set = () => {
      skel.setChannels(ja, sa.flex.x, sa.abd.x, sa.twist.x);
      skel.setChannels(jb, sb.flex.x, sb.abd.x, sb.twist.x);
      skel.update();
    };
    // Which way separates them: try a small step on each finger's spread.
    const dir = (s, j) => {
      const keep = s.abd.x;
      s.abd.x = keep + deg(0.5); set();
      const up = pairOverlap(skel, side, a, b);
      s.abd.x = keep - deg(0.5); set();
      const down = pairOverlap(skel, side, a, b);
      s.abd.x = keep; set();
      void j;
      return up < down ? 1 : -1;
    };
    const da = dir(sa, ja);
    const db = dir(sb, jb);
    for (let it = 0; it < 40 && pairOverlap(skel, side, a, b) > 0; it++) {
      sa.abd.x = Math.min(ja.limits.abd[1], Math.max(ja.limits.abd[0], sa.abd.x + da * deg(0.25)));
      sb.abd.x = Math.min(jb.limits.abd[1], Math.max(jb.limits.abd[0], sb.abd.x + db * deg(0.25)));
      sa.abd.v = 0; sb.abd.v = 0;
      set();
    }
  }
  return moved;
}

// Fingers rest on what they meet: after the springs move a hand, any digit
// that presses into a static surface (a table, a panel, a rung it is not
// holding) is opened, joint by joint, the least it takes to lie on it.
// shapes: [{ distance(a, b, r) -> signed metres }] near the hand.
const ENV_ALLOW = 0.3 * MM;
const DIGIT_JOINTS = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'],
  index: ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal'],
  middle: ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal'],
  ring: ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal'],
  little: ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal'],
};

function digitDepth(skel, side, names, shapes) {
  let worst = 0;
  const S = skel.sides[side];
  for (const n of names) {
    const j = S.byName.get(n);
    const a = j.worldPos;
    const b = capsuleEnd(j);
    for (const s of shapes) {
      const d = -s.distance(a, b, j.radius) - ENV_ALLOW;
      if (d > worst) worst = d;
    }
  }
  return worst;
}

export function guardEnvironment(skel, side, springs, shapes, skip = {}) {
  if (!shapes.length) return false;
  let moved = false;
  for (const [digit, names] of Object.entries(DIGIT_JOINTS)) {
    if (skip[digit]) continue;
    if (digitDepth(skel, side, names, shapes) <= 0) continue;
    moved = true;
    const joints = names.map((n) => skel.sides[side].byName.get(n));
    // Degrees of freedom the guard may use: every flexion, and for the thumb
    // its palmar abduction at the CMC as well.
    const dofs = joints.map((j, k) => ({ j, s: springs[names[k]].flex, lim: j.limits.flex }));
    if (digit === 'thumb') dofs.push({ j: joints[0], s: springs[names[0]].abd, lim: joints[0].limits.abd });
    const apply = (j) => { const sp = springs[j.name]; skel.setChannels(j, sp.flex.x, sp.abd.x, sp.twist.x); skel.update(); };
    for (let it = 0; it < 16; it++) {
      const depth = digitDepth(skel, side, names, shapes);
      if (depth <= 0) break;
      // Move whichever joint, either way, lifts the digit off the surface
      // most (opening a finger that points down would push it further in).
      let best = null;
      for (const d of dofs) {
        const keep = d.s.x;
        for (const dv of [deg(0.75), -deg(0.75)]) {
          const v = Math.min(d.lim[1], Math.max(d.lim[0], keep + dv));
          if (v === keep) continue;
          d.s.x = v;
          apply(d.j);
          const dd = digitDepth(skel, side, names, shapes);
          if (!best || dd < best.d) best = { d: dd, dof: d, v };
        }
        d.s.x = keep;
        apply(d.j);
      }
      if (!best || best.d >= depth) break;
      best.dof.s.x = best.v;
      best.dof.s.v = 0;
      apply(best.dof.j);
    }
  }
  return moved;
}
