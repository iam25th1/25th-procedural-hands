// Per-finger control, counting, finger sets and the gesture registry, sampled
// at 60 fps on both hands: limits, self-penetration, continuity, and that
// each finger does what it was asked while its neighbours stay inside
// natural coupling.
import { create, STEP, GESTURES, COUNTING, limitMargin, penetration, objectPenetration } from '../../hands/src/index.js';
import { COUPLING, LIMITS_DEG } from '../../hands/src/anatomy.js';
import { XR_PREFIX } from '../../hands/src/skeleton.js';
import { quat, segmentDistance } from '../../hands/src/math.js';
import { fingerViolation } from '../../hands/src/selfcontact.js';
import { MM } from '../../hands/src/anatomy.js';

// True when a finger's side is within 1 mm of a neighbour's.
function touching(skel, side, f) {
  const S = skel.sides[side];
  const mine = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].map((s) => S.byName.get(`${XR_PREFIX[f]}-${s}`));
  for (const n of NEIGHBOURS[f]) {
    for (const s of ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal']) {
      const o = S.byName.get(`${XR_PREFIX[n]}-${s}`);
      for (const m of mine) if (segmentDistance(m.worldPos, m.children[0].worldPos, o.worldPos, o.children[0].worldPos).d - m.radius - o.radius < 1 * MM) return true;
    }
  }
  return false;
}

const FINGERS = ['index', 'middle', 'ring', 'little'];
const DIGITS = ['thumb', ...FINGERS];
const deg = (r) => (r * 180) / Math.PI;
const jn = (f, seg) => `${XR_PREFIX[f]}-${seg}`;
const NEIGHBOURS = { index: ['middle'], middle: ['index', 'ring'], ring: ['middle', 'little'], little: ['ring'] };
const localRot = (j) => (j.parent ? quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], j.parent.worldRot), j.worldRot) : j.worldRot.slice());

// Runs `seconds` of steps and tracks the worst limit margin, self
// penetration and joint speed; onStep can add its own measures.
export function sample(h, seconds, acc, onStep) {
  const skel = h.skeleton;
  let prev = skel.joints.map(localRot);
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    h.step();
    const m = limitMargin(skel);
    if (m.worst < acc.margin) { acc.margin = m.worst; acc.marginAt = `${acc.label} ${m.where}`; }
    for (const side of ['left', 'right']) {
      const p = penetration(skel, side);
      if (p.worst > acc.pen) { acc.pen = p.worst; acc.penAt = `${acc.label} ${side} ${(i * STEP).toFixed(2)} s: ${p.where}`; }
    }
    skel.joints.forEach((j, k) => {
      const cur = localRot(j);
      const speed = quat.angleBetween(prev[k], cur) / STEP;
      if (speed > acc.speed) { acc.speed = speed; acc.speedAt = `${acc.label} ${j.id}`; }
      prev[k] = cur;
    });
    if (onStep) onStep(i * STEP);
  }
}
const newAcc = () => ({ margin: Infinity, pen: 0, speed: 0, label: '', marginAt: '', penAt: '', speedAt: '' });
const accNote = (a) => `margin ${a.margin.toFixed(3)} deg; self-penetration ${a.pen.toFixed(2)} mm${a.penAt ? ` at ${a.penAt}` : ''}; peak ${a.speed.toFixed(1)} rad/s`;
const accPass = (a) => a.margin >= -1e-6 && a.pen <= 1 && a.speed < 20;

export const fingerChecks = [
  {
    name: 'fingers: each finger reaches its full range on every joint independently, neighbours inside natural coupling',
    async run() {
      let worstShort = 0;
      let worstLeak = -Infinity;
      let where = '';
      const acc = newAcc();
      for (const side of ['left', 'right']) {
        for (const f of FINGERS) {
          const h = create({ reducedMotion: true });
          acc.label = `${side} ${f}`;
          h.setPose('both', 'open', { snap: true });
          for (const d of FINGERS) h.setFinger(side, d, 0, 0, { snap: true });
          for (const j of ['mcp', 'pip', 'dip']) h.setFingerJoint(side, f, j, 1);
          sample(h, 1.2, acc);
          const L = LIMITS_DEG.finger;
          const short = Math.max(
            L.mcp.flex[1] - deg(h.joint(side, jn(f, 'phalanx-proximal')).channels.flex),
            L.pip.flex[1] - deg(h.joint(side, jn(f, 'phalanx-intermediate')).channels.flex),
            L.dip.flex[1] - deg(h.joint(side, jn(f, 'phalanx-distal')).channels.flex));
          if (short > worstShort) { worstShort = short; where = `${side} ${f}`; }
          for (const d of FINGERS) if (d !== f) h.releaseFingers(side, d);
          sample(h, 1.2, acc);
          for (const n of NEIGHBOURS[f]) {
            const k = (COUPLING.enslave[n] || {})[f] || 0;
            const leak = deg(h.joint(side, jn(n, 'phalanx-intermediate')).channels.flex) - k * L.pip.flex[1];
            if (leak > worstLeak) worstLeak = leak;
          }
        }
      }
      const pass = worstShort <= 1.5 && worstLeak <= 4 && acc.margin >= -1e-6;
      return { pass, worst: worstShort, limit: 1.5, unit: 'deg short of full flexion', note: `worst ${where}; neighbour beyond its enslaving fraction by at most ${worstLeak.toFixed(1)} deg (allowed 4, idle drift); limit margin ${acc.margin.toFixed(3)} deg` };
    },
  },
  {
    name: 'fingers: thumb curl, spread and opposition reach their range inside the limits on both hands',
    async run() {
      let worst = Infinity;
      const notes = [];
      const acc = newAcc();
      for (const side of ['left', 'right']) {
        const h = create({ reducedMotion: true });
        acc.label = side;
        h.setPose(side, 'open', { snap: true });
        h.setFingerJoint(side, 'thumb', 'mcp', 1);
        h.setFingerJoint(side, 'thumb', 'ip', 1);
        sample(h, 1.2, acc);
        const mcpShort = LIMITS_DEG.thumb.mcp.flex[1] - deg(h.joint(side, 'thumb-phalanx-proximal').channels.flex);
        const ipShort = LIMITS_DEG.thumb.ip.flex[1] - deg(h.joint(side, 'thumb-phalanx-distal').channels.flex);
        h.setThumbOpposition(side, 1);
        sample(h, 1.2, acc);
        const opp = h.joint(side, 'thumb-metacarpal').channels;
        h.releaseFingers(side);
        h.setFinger(side, 'thumb', 0, 1);
        sample(h, 1.2, acc);
        const spreadFlex = deg(h.joint(side, 'thumb-metacarpal').channels.flex);
        worst = Math.min(worst, 1.5 - Math.max(mcpShort, ipShort), deg(opp.abd) - 30, deg(opp.twist) - 10, -spreadFlex - 20);
        notes.push(`${side}: MCP and IP within ${Math.max(mcpShort, ipShort).toFixed(2)} deg of full, opposition abd ${deg(opp.abd).toFixed(0)} twist ${deg(opp.twist).toFixed(0)}, spread sweep ${spreadFlex.toFixed(0)}`);
      }
      return { pass: worst >= 0 && acc.margin >= -1e-6, worst, limit: 0, unit: 'deg headroom', note: notes.join('; ') };
    },
  },
  {
    name: 'fingers: control blends over the active pose, on either hand, at any time',
    async run() {
      const h = create({ reducedMotion: true });
      const acc = newAcc();
      acc.label = 'blend';
      h.setPose('both', 'fist', { snap: true });
      h.setFinger('right', 'index', 0);
      h.setFinger('left', 'little', 0, 0.5);
      sample(h, 1, acc);
      const a = deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex);
      const b = deg(h.joint('right', 'ring-finger-phalanx-intermediate').channels.flex);
      const c = deg(h.joint('left', 'pinky-finger-phalanx-intermediate').channels.flex);
      h.gesture('v', { hand: 'right' });
      h.gesture('spread', { hand: 'left' });
      sample(h, 1, acc);
      const d = deg(h.joint('right', 'middle-finger-phalanx-intermediate').channels.flex);
      const e = deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex);
      const ok = a < 8 && b > 90 && c < 8 && d < 15 && e < 8;
      return { pass: ok && accPass(acc), worst: Math.max(a, c, e), limit: 8, unit: 'deg on controlled digits', note: `right index out of a fist ${a.toFixed(1)}, ring stays ${b.toFixed(1)}, left little ${c.toFixed(1)}; V under control: middle ${d.toFixed(1)} index ${e.toFixed(1)}; ${accNote(acc)}` };
    },
  },
  {
    name: 'fingers: spread -1 to 1 reaches MCP abduction both ways on every finger, both hands',
    async run() {
      const acc = newAcc();
      let worst = 0;
      let where = '';
      for (const side of ['left', 'right']) {
        for (const f of FINGERS) {
          for (const sp of [1, -1]) {
            const h = create({ reducedMotion: true });
            acc.label = `${side} ${f} ${sp}`;
            h.setPose('both', 'open', { snap: true });
            h.setFinger(side, f, 0, sp);
            sample(h, 1.0, acc);
            const got = deg(h.joint(side, jn(f, 'phalanx-proximal')).channels.abd);
            const want = LIMITS_DEG.finger.mcp.abd[sp > 0 ? 1 : 0];
            // A finger swung toward a straight neighbour stops where their
            // sides meet; that is the anatomical end of its range there.
            const stopped = fingerViolation(h.skeleton, side) === 0 && touching(h.skeleton, side, f);
            const short = stopped ? 0 : Math.abs(got - want);
            if (short > worst) { worst = short; where = `${side} ${f} ${sp > 0 ? 'out' : 'in'} at ${got.toFixed(1)} deg`; }
          }
        }
      }
      return { pass: worst <= 1.5 && accPass(acc), worst, limit: 1.5, unit: 'deg short of the abduction limit', note: `worst ${where}; ${accNote(acc)}` };
    },
  },
  ...['index', 'thumb'].map((style) => ({
    name: `counting: 1 to 5 ${style} first on both hands, right digits up, no self-penetration`,
    async run() {
      const acc = newAcc();
      let wrong = 0;
      const notes = [];
      for (let n = 1; n <= 5; n++) {
        const h = create({ reducedMotion: true });
        acc.label = `${style} ${n}`;
        h.count('both', n, style);
        sample(h, 1.0, acc);
        const up = new Set(COUNTING[style][n - 1]);
        for (const side of ['left', 'right']) {
          for (const f of FINGERS) {
            const pip = deg(h.joint(side, jn(f, 'phalanx-intermediate')).channels.flex);
            if (up.has(f) ? pip >= 20 : pip <= 80) { wrong++; notes.push(`${n} ${side} ${f} ${pip.toFixed(0)}`); }
          }
        }
      }
      return { pass: wrong === 0 && accPass(acc), worst: acc.pen, limit: 1, unit: 'mm', note: `${wrong} digits wrong${notes.length ? ` (${notes.join(', ')})` : ''}; ${accNote(acc)}` };
    },
  })),
  {
    name: 'finger sets: all 32 combinations extend exactly the chosen digits, inside limits, no self-penetration',
    async run() {
      const acc = newAcc();
      let wrong = 0;
      const notes = [];
      for (let mask = 0; mask < 32; mask++) {
        const set = DIGITS.filter((_, i) => mask & (1 << i));
        const h = create({ reducedMotion: true });
        acc.label = set.join('+') || 'none';
        h.showFingers('both', set);
        sample(h, 0.9, acc);
        for (const f of FINGERS) {
          const pip = deg(h.joint('left', jn(f, 'phalanx-intermediate')).channels.flex);
          if (set.includes(f) ? pip >= 20 : pip <= 80) { wrong++; notes.push(`${acc.label} ${f} ${pip.toFixed(0)}`); }
        }
      }
      return { pass: wrong === 0 && accPass(acc), worst: acc.pen, limit: 1, unit: 'mm', note: `${wrong} digits wrong${notes.length ? ` (${notes.slice(0, 4).join(', ')})` : ''}; includes middle only and index and little; ${accNote(acc)}` };
    },
  },
  {
    name: 'gestures: every registry gesture reachable, inside limits, no self-penetration, continuous at 60 fps, both hands',
    async run() {
      const acc = newAcc();
      let objWorst = 0;
      let unreached = 0;
      const names = Object.keys(GESTURES);
      for (const name of names) {
        const h = create({ seed: 51 });
        acc.label = name;
        sample(h, 0.3, acc);
        h.gesture(name);
        sample(h, 2.5, acc, () => {
          for (const side of ['left', 'right']) {
            const held = h.held(side);
            if (held) objWorst = Math.max(objWorst, objectPenetration(h.skeleton, side, held, h.contacts(side)).worst);
          }
        });
        const entry = GESTURES[name];
        if (entry.pose && !entry.osc) {
          const target = h.rig.targetChannels('right');
          for (const f of FINGERS) {
            const n = jn(f, 'phalanx-intermediate');
            if (Math.abs(h.joint('right', n).channels.flex - target[n].flex) > 0.12) unreached++;
          }
        }
      }
      const pass = accPass(acc) && objWorst <= 1 && unreached === 0;
      return { pass, worst: Math.max(acc.pen, objWorst), limit: 1, unit: 'mm', note: `${names.length} gestures (${names.join(', ')}); ${unreached} digits short of their pose; held object ${objWorst.toFixed(2)} mm; ${accNote(acc)}` };
    },
  },
];
