// Manipulation, climbing, contact, strength and weight checks: every
// capability scenario is played frame by frame (audit.js) and held to the
// same rules. The scenarios are the ones the sandbox's capability matrix
// plays, so what passes here is what a viewer sees.
import { auditAll, auditScenario } from './audit.js';
import { runScenario } from '../../app/scenes/runner.js';
import { SCENARIOS } from '../../app/scenes/capabilities.js';
import { capsuleObjectDistance } from '../../hands/src/grasp.js';
import { handCapsules } from '../../hands/src/measure.js';
import { STEP } from '../../hands/src/clock.js';

const MM = 0.001;
export const LIMITS = {
  pen: 1, // mm, hand into anything
  self: 1, // mm, finger into finger or palm
  gripGap: 2, // mm, a contact digit off what it holds once the grip has formed
  follow: 5, // mm, a hand off what it follows (position plus the turn as its arc 8 cm out)
  speed: 20, // rad/s, any joint
  jump: 40, // mm per frame, the wrist
};

function worstOf(results, key) {
  let best = null;
  for (const r of results) if (!best || r[key] > best[key]) best = r;
  return best;
}

// One row per capability scenario: it plays clean and does what it is for.
export function clean(r) {
  const bad = [];
  if (r.pen / MM > LIMITS.pen) bad.push(`penetration ${(r.pen / MM).toFixed(2)} mm at ${r.penAt}`);
  if (r.self > LIMITS.self) bad.push(`self ${r.self.toFixed(2)} mm`);
  if (r.missed) bad.push(`${r.missed} grasp missed`);
  if (r.gripGap / MM > LIMITS.gripGap) bad.push(`grip gap ${(r.gripGap / MM).toFixed(2)} mm`);
  if (r.followErr / MM > LIMITS.follow) bad.push(`follow ${(r.followErr / MM).toFixed(2)} mm`);
  if (r.speed >= LIMITS.speed) bad.push(`${r.speed.toFixed(1)} rad/s`);
  if (r.jump / MM >= LIMITS.jump) bad.push(`wrist step ${(r.jump / MM).toFixed(1)} mm`);
  if (r.margin < -1e-6) bad.push(`limit ${r.marginAt}`);
  if (r.driftViolations || r.floating) bad.push(`${r.driftViolations} drift, ${r.floating} floating`);
  if (r.disturbed.length) bad.push(`knocked: ${r.disturbed.join(', ')}`);
  return bad;
}
export const scenarioChecks = Object.entries(SCENARIOS).map(([id, sc]) => ({
  name: `capability: ${sc.label}`,
  async run() {
    const r = auditAll().find((x) => x.id === id);
    const bad = clean(r);
    if (!r.achieved) bad.push(`not achieved: ${r.achievedNote}`);
    return { pass: bad.length === 0, worst: r.pen / MM, limit: LIMITS.pen, unit: 'mm', note: bad.length ? bad.join('; ') : `${r.achievedNote}; ${r.frames} frames, ${r.grasped} grips` };
  },
}));

export const manipulationChecks = [
  {
    name: 'manipulation: no hand to object penetration beyond 1 mm in any capability scenario',
    async run() {
      const all = auditAll();
      const w = worstOf(all, 'pen');
      return { pass: w.pen / MM <= LIMITS.pen, worst: w.pen / MM, limit: LIMITS.pen, unit: 'mm', note: `${all.length} scenarios, ${all.reduce((a, r) => a + r.frames, 0)} frames; worst ${w.id} at ${w.penAt || 'none'}` };
    },
  },
  {
    name: 'manipulation: every grasp a scenario asks for takes hold',
    async run() {
      const all = auditAll();
      const missed = all.reduce((a, r) => a + r.missed, 0);
      const grasped = all.reduce((a, r) => a + r.grasped, 0);
      const where = all.filter((r) => r.missed).map((r) => `${r.id} ${r.missAt}`).join(', ');
      return { pass: missed === 0 && grasped > 0, worst: missed, limit: 0, unit: 'missed', note: `${grasped} grasps taken${where ? `; missed: ${where}` : ''}` };
    },
  },
  {
    name: 'manipulation: a held object never leaves the grip (contacts within 2 mm, the hand on what it follows within 5 mm)',
    async run() {
      const all = auditAll();
      const g = worstOf(all, 'gripGap');
      const f = worstOf(all, 'followErr');
      const held = all.reduce((a, r) => a + r.heldFrames, 0);
      const pass = g.gripGap / MM <= LIMITS.gripGap && f.followErr / MM <= LIMITS.follow;
      return { pass, worst: g.gripGap / MM, limit: LIMITS.gripGap, unit: 'mm', note: `${held} held frames; grip gap worst ${g.id} ${g.gripAt}; follow worst ${(f.followErr / MM).toFixed(2)} mm (limit ${LIMITS.follow}) ${f.id} ${f.followAt}` };
    },
  },
  {
    name: 'climbing: at least one hand attached from the first grip to the last letting go',
    async run() {
      const ids = Object.keys(SCENARIOS).filter((id) => SCENARIOS[id].group === 'climbing');
      const rows = auditAll().filter((r) => ids.includes(r.id));
      let worst = Infinity;
      const notes = [];
      for (const r of rows) {
        const m = r.firstGrasp === null ? 0 : r.minAttachedHolding;
        worst = Math.min(worst, m);
        notes.push(`${r.id} ${m === Infinity ? 'n/a' : m} (${r.grasped} grips)`);
      }
      return { pass: rows.length > 0 && worst >= 1, worst, limit: 1, unit: 'hands', note: notes.join('; ') };
    },
  },
  {
    name: 'contact: pushed and pulled objects move only through contact, nothing is knocked, and nothing at rest floats',
    async run() {
      const all = auditAll();
      const knocked = all.filter((r) => r.disturbed.length).map((r) => `${r.id}: ${r.disturbed.join(', ')}`);
      const drift = all.reduce((a, r) => a + r.driftViolations, 0) + knocked.length;
      const floating = all.reduce((a, r) => a + r.floating, 0);
      const where = all.filter((r) => r.driftViolations || r.floating).map((r) => `${r.id} ${r.driftAt || r.floatAt}`).join(', ');
      return { pass: drift === 0 && floating === 0, worst: drift + floating, limit: 0, unit: 'frames', note: `${drift} moved without contact or knocked, ${floating} floating${where ? `: ${where}` : ''}${knocked.length ? `; knocked ${knocked.join('; ')}` : ''}` };
    },
  },
  {
    // A set-down ends with the body resting on its surface, let go: from the
    // call until the hand is clear of it, it is held or rests on a surface at
    // every frame (never dropped the last centimetre, never left on a digit).
    name: 'set-down: every body set down is held or resting on its surface at every frame until the hand is clear, and ends let go and resting',
    async run() {
      const all = auditAll();
      let n = 0;
      let bad = 0;
      const notes = [];
      for (const r of all) {
        for (const e of r.setDowns) {
          n++;
          const fail = e.unsupported > 0 || !e.released || !e.clear;
          if (fail) { bad++; notes.push(`${r.id} ${e.side} ${e.body.name}: ${!e.released ? 'never let go' : !e.clear ? 'hand never clear of it resting' : `${e.unsupported} frames neither held nor resting from ${e.at}`}`); }
        }
      }
      const frames = all.reduce((a, r) => a + r.setDowns.reduce((b, e) => b + e.unsupported, 0), 0);
      return { pass: n > 0 && bad === 0, worst: bad, limit: 0, unit: 'set-downs', note: `${n} set-downs over ${all.filter((r) => r.setDowns.length).length} scenarios; ${frames} unsupported frames${notes.length ? `; ${notes.join('; ')}` : ''}` };
    },
  },
  {
    name: 'continuity: every scenario under 20 rad/s per joint, wrist under 4 cm a frame, no self-penetration over 1 mm, inside limits',
    async run() {
      const all = auditAll();
      const s = worstOf(all, 'speed');
      const j = worstOf(all, 'jump');
      const p = worstOf(all, 'self');
      let margin = Infinity;
      let mAt = '';
      for (const r of all) if (r.margin < margin) { margin = r.margin; mAt = `${r.id} ${r.marginAt}`; }
      const pass = s.speed < LIMITS.speed && j.jump / MM < LIMITS.jump && p.self <= LIMITS.self && margin >= -1e-6;
      return { pass, worst: s.speed, limit: LIMITS.speed, unit: 'rad/s', note: `speed ${s.id} ${s.speedAt}; wrist step ${(j.jump / MM).toFixed(1)} mm (${j.id} ${j.jumpAt}); self ${p.self.toFixed(2)} mm (${p.id}); limit margin ${margin.toFixed(4)} (${mAt})` };
    },
  },
  {
    name: 'strength: too heavy a load or too hard a jerk slips, the fingers come off it; nothing else slips',
    async run() {
      const all = auditAll();
      const bad = [];
      for (const id of ['slipHeavy', 'slipJerk']) if (!all.find((r) => r.id === id).slipped) bad.push(`${id} did not slip`);
      for (const r of all) if (!['slipHeavy', 'slipJerk'].includes(r.id) && r.slipped) bad.push(`${r.id} slipped`);
      // After a slip the fingers visibly lose the object: it falls clear of
      // every digit within 0.3 s.
      let worstClear = Infinity;
      for (const id of ['slipHeavy', 'slipJerk']) {
        let slipAt = null;
        let body = null;
        let clear = 0;
        runScenario(id, {
          onStart: (p) => p.sb.hands.on('slipped', (e) => { if (slipAt === null) { slipAt = p.t; body = e.object; } }),
          onStep: (t, p) => {
            if (slipAt === null || !body || t > slipAt + 0.3 + STEP / 2 || t < slipAt + 0.3 - STEP / 2) return;
            let d = Infinity;
            const shape = body.graspShape();
            for (const side of ['left', 'right']) for (const c of handCapsules(p.sb.hands.skeleton, side)) d = Math.min(d, capsuleObjectDistance(shape, c.a, c.b, c.r, 6));
            clear = d;
          },
        });
        worstClear = Math.min(worstClear, slipAt === null ? 0 : clear);
      }
      if (worstClear < 0.003) bad.push(`object only ${(worstClear / MM).toFixed(1)} mm clear 0.3 s after the slip`);
      return { pass: bad.length === 0, worst: worstClear / MM, limit: 3, unit: 'mm clear', note: bad.join('; ') || `slipHeavy and slipJerk slip, the rest hold; fingers ${(worstClear / MM).toFixed(1)} mm clear of the object 0.3 s after` };
    },
  },
  {
    name: 'weight: a heavier load lowers the wrist further (pebble < rock < iron shot)',
    async run() {
      const all = auditAll();
      const sag = (id, side) => all.find((r) => r.id === id).maxSag[side] / MM;
      const pebble = sag('padPinch', 'right');
      const rock = sag('grabCarryPlace', 'right');
      const shot = sag('slipJerk', 'left');
      const pass = pebble > 0 && pebble < rock && rock < shot;
      return { pass, worst: shot, limit: '', unit: 'mm sag', note: `wrist drop: pebble ${pebble.toFixed(1)} mm, rock ${rock.toFixed(1)} mm, iron shot ${shot.toFixed(1)} mm` };
    },
  },
  {
    name: 'determinism: a scripted 30 s sandbox run hashes identically when replayed',
    async run() {
      // At least 30 s of the sandbox, every station: the first run is the
      // audit's, the replay is fresh.
      const ids = [];
      let seconds = 0;
      for (const id of ['grabCarryPlace', 'throwCatch', 'twoHand', 'pullLever', 'drawer', 'pushCrate', 'dragCrate', 'climb', 'rope']) { ids.push(id); seconds += SCENARIOS[id].duration; if (seconds >= 30) break; }
      const first = auditAll().filter((r) => ids.includes(r.id));
      let mismatches = 0;
      let samples = 0;
      for (const r of first) {
        const again = auditScenario(r.id);
        samples += r.hashes.length;
        r.hashes.forEach((h, i) => { if (again.hashes[i] !== h) mismatches++; });
        if (again.hashes.length !== r.hashes.length) mismatches++;
      }
      const other = auditScenario(ids[0], { seed: 12 });
      const differs = other.hashes.some((h, i) => h !== first[0].hashes[i]);
      return { pass: mismatches === 0 && seconds >= 30 && differs, worst: mismatches, limit: 0, unit: 'mismatches', note: `${seconds.toFixed(1)} s over ${ids.join(', ')}; ${samples} hashes (joints, bodies, props, ropes); seed 12 ${differs ? 'differs' : 'does not differ'}` };
    },
  },
  {
    // sim step ms in Node, the same metric the perf overlay shows live.
    name: 'budget: sim step ms, median, sandbox loaded in Node (script keys, rig, interaction, physics)',
    async run() {
      const ms = auditAll().flatMap((r) => r.stepMs).sort((a, b) => a - b);
      const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
      const median = at(0.5);
      // docs/HANDS_SANDBOX_SPEC.md, BUDGETS: sandbox scene loaded.
      return { pass: median <= 1.2, worst: median, limit: 1.2, unit: 'ms median', note: `p95 ${at(0.95).toFixed(3)} ms over ${ms.length} frames in Node` };
    },
  },
];
