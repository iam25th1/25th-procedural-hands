// Registry of acceptance checks, grown commit by commit. Each entry:
// { name, run: async () => ({ pass, worst, limit, unit, note }) }.
import { servedChecks } from './served.js';
import { isolationChecks } from './isolation.js';
import { structureChecks } from './structure.js';
import { solverChecks } from './solvers.js';
import { budgetChecks } from './budget.js';
import { fingerChecks } from './fingers.js';
import { manipulationChecks, scenarioChecks } from './manipulation.js';

export const CHECKS = [
  ...servedChecks,
  ...isolationChecks,
  ...structureChecks,
  ...solverChecks,
  ...fingerChecks,
  ...manipulationChecks,
  ...scenarioChecks,
  ...budgetChecks,
];
