// Build the recorded plan table: play every scripted scenario from the
// sandbox's seed, with reduced motion off and on, recording each costly
// solve, and write app/scenes/plans.json with the hash of the sources it was
// built from. The server serves the table only while that hash still
// matches (server/plan-hash.js), and hands:check replays every scenario from
// it and requires the same state, bit for bit, as a live run.
//   npm run hands:plans
import fs from 'node:fs';
import { SCENARIOS } from '../app/scenes/capabilities.js';
import { runScenario } from '../app/scenes/runner.js';
import { planRecorder, planKey } from '../app/scenes/plans.js';
import { planSourceHash, PLAN_TABLE } from '../server/plan-hash.js';

export const PLAN_SEED = 1;

export function buildPlans() {
  const runs = {};
  for (const id of Object.keys(SCENARIOS)) {
    for (const reduced of [false, true]) {
      const rec = planRecorder();
      runScenario(id, { seed: PLAN_SEED, reducedMotion: reduced, planSource: rec });
      runs[planKey(id, reduced)] = rec.list;
    }
  }
  return { sourceHash: planSourceHash(), seed: PLAN_SEED, runs };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const t0 = Date.now();
  const table = buildPlans();
  const text = JSON.stringify(table);
  fs.writeFileSync(PLAN_TABLE, text);
  const n = Object.values(table.runs).reduce((a, l) => a + l.length, 0);
  console.log(`plans: ${Object.keys(table.runs).length} runs, ${n} recorded solves, ${(text.length / 1024).toFixed(0)} KB, source ${table.sourceHash}, ${((Date.now() - t0) / 1000).toFixed(1)} s -> app/scenes/plans.json`);
}
