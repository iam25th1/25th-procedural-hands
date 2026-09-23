// Frame by frame audit of a capability scenario: everything the manipulation
// checks measure, gathered in one pass so every scenario is held to the same
// rules.
import { runScenario } from '../../app/scenes/runner.js';
import { SCENARIOS } from '../../app/scenes/capabilities.js';
import { EXPECT } from '../../app/scenes/expectations.js';
import { v3, quat, segmentDistance, pointSegmentDistance } from '../../hands/src/math.js';
import { capsuleObjectDistance } from '../../hands/src/grasp.js';
import { limitMargin, penetration, handCapsules } from '../../hands/src/measure.js';
import { STEP } from '../../hands/src/clock.js';
import { capsuleEnd } from '../../hands/src/skeleton.js';

const MM = 0.001;

function capsuleEndsOf(o) {
  if (o.a) return [o.a, o.b];
  const d = quat.rotate([0, 0, 0], o.rot, [0, 0, o.h]);
  return [v3.sub([0, 0, 0], o.pos, d), v3.add([0, 0, 0], o.pos, d)];
}

// Signed distance (m) from a hand capsule to a world shape; negative is overlap.
export function capsuleToShape(c, s) {
  if (s.shape === 'sphere') return pointSegmentDistance(s.pos, c.a, c.b).d - c.r - s.r;
  if (s.shape === 'capsule') { const [a, b] = capsuleEndsOf(s); return segmentDistance(c.a, c.b, a, b).d - c.r - s.r; }
  if (s.shape === 'box') return capsuleObjectDistance({ shape: 'box', hx: s.hx, hy: s.hy, hz: s.hz, pos: s.pos, rot: s.rot || [0, 0, 0, 1] }, c.a, c.b, c.r, 10);
  return Infinity;
}

// Every shape a hand could press into: bodies (and their parts), prop parts, statics.
export function worldShapes(world) {
  const out = [];
  for (const b of world.bodies) {
    out.push({ shape: b.shape, pos: b.pos, rot: b.rot, r: b.r, h: b.h, hx: b.hx, hy: b.hy, hz: b.hz, label: b.name, body: b });
    for (const p of b.parts) out.push({ ...b.partWorld(p), label: `${b.name}.${p.name}`, body: b });
  }
  for (const p of world.props) for (const part of p.parts) if (part.collide !== false) out.push({ ...p.partWorld(part), label: `${p.name}.${part.name}`, prop: p });
  for (const s of world.statics) out.push({ ...s, label: s.name });
  for (const rope of world.ropes || []) {
    for (let i = 0; i + 1 < rope.points.length; i++) out.push({ shape: 'capsule', a: rope.points[i], b: rope.points[i + 1], r: rope.r, label: `${rope.name}[${i}]`, rope });
  }
  return out;
}

const localRot = (j) => (j.parent ? quat.multiply([0, 0, 0, 1], quat.conjugate([0, 0, 0, 1], j.parent.worldRot), j.worldRot) : j.worldRot.slice());

export function auditScenario(id, { seed = 1 } = {}) {
  const r = {
    id, frames: 0,
    pen: 0, penAt: '',
    self: 0, selfAt: '',
    margin: Infinity, marginAt: '',
    speed: 0, speedAt: '', jump: 0, jumpAt: '',
    gripGap: 0, gripAt: '', heldFrames: 0,
    followErr: 0, followAt: '',
    floating: 0, floatAt: '',
    driftViolations: 0, driftAt: '',
    minAttached: Infinity, attachedFrames: 0,
    events: [],
    grasped: 0, missed: 0, missAt: '', slipped: 0, released: 0,
    firstGrasp: null, lastRelease: null, attachedSeries: [],
    maxSag: { left: 0, right: 0 }, loads: { left: 0, right: 0 },
    stepMs: [],
    measures: {}, runState: {},
    hashes: [],
  };
  let prevRot = null;
  let prevRoot = null;
  let prevState = null;
  runScenario(id, {
    seed,
    // Every grasp a script asks for must take hold: one that closes on air fails.
    onStart: (p) => {
      if (EXPECT[id] && EXPECT[id].setup) EXPECT[id].setup(p.ctx);
      p.sb.hands.on('grasped', () => { r.grasped++; if (r.firstGrasp === null) r.firstGrasp = p.t; });
      p.sb.hands.on('released', (e) => {
        if (e.missed) { r.missed++; r.missAt = `${p.t.toFixed(2)} s ${e.hand}`; return; }
        r.released++;
        r.lastRelease = p.t;
      });
      p.sb.hands.on('slipped', () => { r.slipped++; });
      // Solver time per frame, the whole step: rig, interaction and world.
      const step = p.sb.hands.step.bind(p.sb.hands);
      p.sb.hands.step = () => { const t0 = performance.now(); const out = step(); r.stepMs.push(performance.now() - t0); return out; };
    },
    onStep: (t, p) => {
      const { hands, world } = p.sb;
      const skel = hands.skeleton;
      r.frames++;
      // Hand into anything, 1 mm at most.
      const shapes = worldShapes(world);
      for (const side of ['left', 'right']) {
        for (const c of handCapsules(skel, side)) {
          for (const s of shapes) {
            const d = capsuleToShape(c, s);
            if (-d > r.pen) { r.pen = -d; r.penAt = `${t.toFixed(2)} s ${side} ${c.name} into ${s.label}`; }
          }
        }
        const sp = penetration(skel, side);
        if (sp.worst > r.self) { r.self = sp.worst; r.selfAt = `${t.toFixed(2)} s ${side} ${sp.where}`; }
      }
      const m = limitMargin(skel);
      if (m.worst < r.margin) { r.margin = m.worst; r.marginAt = `${t.toFixed(2)} s ${m.where}`; }
      // Continuity.
      const rots = skel.joints.map(localRot);
      if (prevRot) {
        skel.joints.forEach((j, k) => {
          const speed = quat.angleBetween(prevRot[k], rots[k]) / STEP;
          if (speed > r.speed) { r.speed = speed; r.speedAt = `${t.toFixed(2)} s ${j.id}`; }
        });
      }
      prevRot = rots;
      const roots = ['left', 'right'].map((s) => skel.joint(s, 'wrist').worldPos.slice());
      if (prevRoot) roots.forEach((w, i) => { const d = v3.dist(w, prevRoot[i]); if (d > r.jump) { r.jump = d; r.jumpAt = `${t.toFixed(2)} s ${i ? 'right' : 'left'}`; } });
      prevRoot = roots;
      // A held object never leaves the grip: every recorded contact stays on it.
      for (const side of ['left', 'right']) {
        const rec = hands.holding(side);
        if (rec) r.attachedFrames++;
        const att = hands.rig.hands[side].attached;
        if (!rec || !att) continue;
        r.heldFrames++;
        const obj = hands.held(side);
        // The grip is formed once every contact digit has closed onto the
        // object (the fingers take a moment to close); from then on none may
        // lift off or press in.
        const gaps = att.contacts.filter((c) => !c.via).map((c) => {
          const j = skel.joint(side, c.joint);
          return { c, d: capsuleObjectDistance(obj, j.worldPos, capsuleEnd(j), j.radius) };
        });
        if (!att.formedAt) {
          if (gaps.every((g) => Math.abs(g.d) <= 1 * MM)) att.formedAt = t;
          else if (att.since === undefined) att.since = t;
          if (!att.formedAt && t - att.since > 0.45) { r.gripGap = Math.max(r.gripGap, Math.max(...gaps.map((g) => Math.abs(g.d)))); r.gripAt = `${t.toFixed(2)} s ${side} grip never formed`; }
        }
        if (att.formedAt) {
          for (const g of gaps) if (Math.abs(g.d) > r.gripGap) { r.gripGap = Math.abs(g.d); r.gripAt = `${t.toFixed(2)} s ${side} ${g.c.joint}`; }
        }
        // A hand that follows what it holds lands on it.
        const arm = hands.rig.arms[side];
        if (arm.follow) {
          const want = arm.follow();
          const wj = skel.joint(side, 'wrist');
          // Position error, plus the turn error as the arc it makes 8 cm out (a fingertip).
          const e = v3.dist(want.pos, wj.worldPos) + quat.angleBetween(want.rot, wj.worldRot) * 0.08;
          if (e > r.followErr) { r.followErr = e; r.followAt = `${t.toFixed(2)} s ${side}`; }
        }
      }
      // What the scenario is for, measured as it plays.
      const ex = EXPECT[id];
      if (ex) {
        for (const [k, v] of Object.entries(ex.measure(p.ctx))) {
          const m = r.measures[k] || (r.measures[k] = { first: v, last: v, min: v, max: v });
          m.last = v; m.min = Math.min(m.min, v); m.max = Math.max(m.max, v);
        }
        if (ex.run) ex.run(p.ctx, r.runState);
      }
      const attachedNow = ['left', 'right'].filter((s) => hands.holding(s)).length;
      r.minAttached = Math.min(r.minAttached, attachedNow);
      r.attachedSeries.push([t, attachedNow]);
      for (const side of ['left', 'right']) {
        const arm = hands.rig.arms[side];
        r.maxSag[side] = Math.max(r.maxSag[side], arm.sag.x);
        r.loads[side] = Math.max(r.loads[side], arm.load);
      }
      // Nothing floats: a free body at rest is resting on something.
      for (const b of world.bodies) {
        if (b.kinematic) continue;
        const still = v3.len(b.vel) < 0.02;
        if (still && !world.isSupported(b, 0.0015)) { r.floating++; r.floatAt = `${t.toFixed(2)} s ${b.name}`; }
      }
      // Objects move only through contact: a body's horizontal speed or a
      // prop's displacement from rest grows only on a step where a hand
      // (or a body pushed by one) touched it or a hand holds it.
      const state = world.bodies.map((b) => ({ h: Math.hypot(b.vel[0], b.vel[2]), c: b.contactThisStep.hand || b.contactThisStep.body || b.kinematic }))
        .concat(world.props.map((pp) => ({ q: Math.abs(pp.q - (pp.spring ? pp.spring.rest : pp.userData.rest ?? pp.q0 ?? 0)), c: pp.touchedThisStep || Boolean(pp.driver), prop: pp })));
      if (prevState) {
        state.forEach((s, i) => {
          const was = prevState[i];
          // A body tipping or falling after it was pushed is gravity, not drift.
          const b = world.bodies[i];
          const upright = b && v3.len(b.ang) < 0.5 && b.vel[1] > -0.05;
          if (s.h !== undefined && s.h > was.h + 0.01 && !s.c && upright) { r.driftViolations++; r.driftAt = `${t.toFixed(2)} s ${b.name}`; }
          if (s.prop && s.prop.detents == null && s.q > was.q + 1e-4 && !s.c) { r.driftViolations++; r.driftAt = `${t.toFixed(2)} s ${s.prop.name}`; }
        });
      }
      prevState = state;
      if (Math.abs(t - Math.round(t)) < STEP / 2) r.hashes.push(hands.hash());
    },
  });
  // Hands attached from the first grip to the last letting go (a climb).
  r.minAttachedHolding = Infinity;
  if (r.firstGrasp !== null) {
    const end = r.lastRelease ?? Infinity;
    for (const [t, n] of r.attachedSeries) if (t > r.firstGrasp + 1e-9 && t < end - 1e-9) r.minAttachedHolding = Math.min(r.minAttachedHolding, n);
  }
  delete r.attachedSeries;
  if (EXPECT[id]) [r.achieved, r.achievedNote] = EXPECT[id].verify(r.measures, r, r.runState);
  else [r.achieved, r.achievedNote] = [false, 'no expectation written'];
  return r;
}

// Every scenario audited once per process: several checks read the same run.
const cache = new Map();
export function auditAll({ seed = 1 } = {}) {
  const key = String(seed);
  if (!cache.has(key)) cache.set(key, Object.keys(SCENARIOS).map((id) => auditScenario(id, { seed })));
  return cache.get(key);
}

export function summarize(r) {
  return `${r.id}: pen ${(r.pen / MM).toFixed(2)} mm (${r.penAt}); self ${r.self.toFixed(2)} mm (${r.selfAt}); margin ${r.margin.toFixed(3)} (${r.marginAt}); speed ${r.speed.toFixed(1)} rad/s (${r.speedAt}); jump ${(r.jump / MM).toFixed(1)} mm; grip gap ${(r.gripGap / MM).toFixed(2)} mm (${r.gripAt}) over ${r.heldFrames} held frames; follow ${(r.followErr / MM).toFixed(2)} mm (${r.followAt}); floating ${r.floating} (${r.floatAt}); drift ${r.driftViolations} (${r.driftAt}); grasps ${r.grasped} missed ${r.missed} (${r.missAt}); ${r.achieved ? 'achieved' : 'NOT achieved'}: ${r.achievedNote}`;
}

export { SCENARIOS };
