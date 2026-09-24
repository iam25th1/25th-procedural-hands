// The recorded plan table (app/scenes/plans.json, built by npm run
// hands:plans): it must be built from the sources as they are now, under
// the same elementary functions this engine computes (dmath's signature),
// and every scenario replayed from it, with reduced motion off and on, must
// reach the same state as a live run bit for bit at every frame: the table
// changes when a solve runs, never what it answers. Held to the exact bits
// of the whole state, not hands.hash() (which rounds to 1e-6): a replay
// 3e-15 away from its live run is a replay of another machine's answers.
import fs from 'node:fs';
import { SCENARIOS } from '../../app/scenes/capabilities.js';
import { runScenario } from '../../app/scenes/runner.js';
import { planPlayer, planKey, exactStateHash, usablePlanTable } from '../../app/scenes/plans.js';
import { planSourceHash, PLAN_TABLE } from '../../server/plan-hash.js';
import { auditAll } from './audit.js';

// Every frame's exact state hash for one run.
function frames(id, seed, reducedMotion, planSource) {
  const out = [];
  runScenario(id, { seed, reducedMotion, planSource, onStep: (t, p) => out.push(exactStateHash(p.sb.hands)) });
  return out;
}

export const planChecks = [
  {
    name: 'plans: the recorded plan table matches the sources and this engine\'s math, and every scenario replayed from it, reduced motion off and on, ends bit for bit where the live run does at every frame',
    async run() {
      let table;
      try { table = JSON.parse(fs.readFileSync(PLAN_TABLE, 'utf8')); } catch { return { pass: false, worst: 1, limit: 0, unit: 'problems', note: 'no plan table: run npm run hands:plans' }; }
      const now = planSourceHash();
      if (table.sourceHash !== now) return { pass: false, worst: 1, limit: 0, unit: 'problems', note: `plan table built from ${table.sourceHash}, sources are ${now}: run npm run hands:plans` };
      const use = usablePlanTable(table);
      if (!use.ok) return { pass: false, worst: 1, limit: 0, unit: 'problems', note: use.reason };
      const liveOff = new Map(auditAll().map((r) => [r.id, r.exact]));
      const bad = [];
      let runs = 0;
      let solves = 0;
      let used = 0;
      let compared = 0;
      for (const id of Object.keys(SCENARIOS)) {
        for (const reduced of [false, true]) {
          const key = planKey(id, reduced);
          const list = table.runs[key] || [];
          const player = planPlayer(list);
          const replay = frames(id, table.seed, reduced, player);
          const live = reduced ? frames(id, table.seed, true, null) : liveOff.get(id);
          runs++;
          solves += list.length;
          used += player.used;
          compared += replay.length;
          if (player.stopped || player.used !== list.length) bad.push(`${key}: used ${player.used} of ${list.length} recorded solves${player.miss ? ` (missed at ${player.miss.at}, ${player.miss.kind})` : ''}`);
          const n = Math.max(live ? live.length : 0, replay.length);
          const first = live ? Array.from({ length: n }, (_, f) => f).find((f) => live[f] !== replay[f]) : 0;
          if (first !== undefined) bad.push(`${key}: state differs from the live run from frame ${first}`);
        }
      }
      return { pass: bad.length === 0, worst: bad.length, limit: 0, unit: 'runs off', note: bad.length ? bad.slice(0, 4).join('; ') : `${runs} runs (${Object.keys(SCENARIOS).length} scenarios, reduced motion off and on), ${used} of ${solves} recorded solves used, ${compared} frames each equal to the live run bit for bit; math ${table.math}, source ${now}` };
    },
  },
];
