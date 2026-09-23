// Registry of acceptance checks, grown commit by commit. Each entry:
// { name, run: async () => ({ pass, worst, limit, unit, note }) }.
import { servedChecks } from './served.js';
import { isolationChecks } from './isolation.js';
import { structureChecks } from './structure.js';
import { solverChecks } from './solvers.js';
import { budgetChecks } from './budget.js';
import { fingerChecks } from './fingers.js';
import { manipulationChecks, scenarioChecks } from './manipulation.js';
import { slingshotChecks } from './slingshot.js';
import { physicsChecks } from './physics.js';
import { sandboxBudgetChecks } from './sandbox-budget.js';

export const CHECKS = [
  ...servedChecks,
  ...isolationChecks,
  ...structureChecks,
  ...solverChecks,
  ...fingerChecks,
  ...physicsChecks,
  ...manipulationChecks,
  ...scenarioChecks,
  ...slingshotChecks,
  ...budgetChecks,
  ...sandboxBudgetChecks,
];
