// The recorded plan table (app/scenes/plans.json, built by npm run
// hands:plans): it must be built from the sources as they are now, and every
// scenario replayed from it must reach the same state, bit for bit, as the
// live run the other checks audit: the table changes when a solve runs, never
// what it answers.
import fs from 'node:fs';
import { SCENARIOS } from '../../app/scenes/capabilities.js';
import { runScenario } from '../../app/scenes/runner.js';
import { STEP } from '../../hands/src/clock.js';
import { planPlayer, planKey } from '../../app/scenes/plans.js';
import { planSourceHash, PLAN_TABLE } from '../../server/plan-hash.js';
import { auditAll } from './audit.js';

export const planChecks = [
  {
    name: 'plans: the recorded plan table matches the sources, and every scenario replayed from it ends bit for bit where the live run does',
    async run() {
      let table;
      try { table = JSON.parse(fs.readFileSync(PLAN_TABLE, 'utf8')); } catch { return { pass: false, worst: 1, limit: 0, unit: 'problems', note: 'no plan table: run npm run hands:plans' }; }
      const now = planSourceHash();
      if (table.sourceHash !== now) return { pass: false, worst: 1, limit: 0, unit: 'problems', note: `plan table built from ${table.sourceHash}, sources are ${now}: run npm run hands:plans` };
      const live = new Map(auditAll().map((r) => [r.id, r.hashes]));
      const bad = [];
      let solves = 0;
      let used = 0;
      for (const id of Object.keys(SCENARIOS)) {
        const list = table.runs[planKey(id, false)] || [];
        const player = planPlayer(list);
        const hashes = [];
        runScenario(id, { seed: table.seed, planSource: player, onStep: (t, p) => { if (Math.abs(t - Math.round(t)) < STEP / 2) hashes.push(p.sb.hands.hash()); } });
        solves += list.length;
        used += player.used;
        if (player.stopped || player.used !== list.length) bad.push(`${id}: used ${player.used} of ${list.length} recorded solves`);
        const want = live.get(id);
        if (!want || want.join() !== hashes.join()) bad.push(`${id}: state differs from the live run`);
      }
      return { pass: bad.length === 0, worst: bad.length, limit: 0, unit: 'scenarios off', note: bad.length ? bad.slice(0, 4).join('; ') : `${Object.keys(SCENARIOS).length} scenarios, ${used} of ${solves} recorded solves used, every state hash equal to the live run; source ${now}` };
    },
  },
];
