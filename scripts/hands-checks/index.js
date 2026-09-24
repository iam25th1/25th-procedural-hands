// Registry of acceptance checks, grown commit by commit. Each entry:
// { name, run: async () => ({ pass, worst, limit, unit, note }) }.
import { servedChecks } from './served.js';
import { isolationChecks } from './isolation.js';
import { structureChecks } from './structure.js';
import { solverChecks } from './solvers.js';
import { budgetChecks } from './budget.js';
import { fingerChecks } from './fingers.js';
import { manipulationChecks, scenarioChecks } from './manipulation.js';
import { physicsChecks } from './physics.js';
import { sandboxBudgetChecks } from './sandbox-budget.js';
import { uiChecks } from './ui.js';
import { skinChecks } from './skin.js';
import { planChecks } from './plans.js';
import { videoChecks } from './video.js';
import { planningChecks } from './planning.js';
import { skinDeformChecks, pronationChecks } from './skin-deform.js';
import { glabrousChecks } from './glabrous.js';
import { thumbRestChecks } from './thumb-rest.js';
import { sleeveChecks } from './sleeve.js';
import { thumbShapeChecks } from './thumb-shape.js';
import { determinismChecks } from './determinism.js';

export const CHECKS = [
  ...servedChecks,
  ...isolationChecks,
  ...structureChecks,
  ...solverChecks,
  ...fingerChecks,
  ...physicsChecks,
  ...manipulationChecks,
  ...scenarioChecks,
  ...determinismChecks,
  ...planChecks,
  ...planningChecks,
  ...budgetChecks,
  ...sandboxBudgetChecks,
  ...uiChecks,
  ...skinChecks,
  ...skinDeformChecks,
  ...pronationChecks,
  ...glabrousChecks,
  ...thumbRestChecks,
  ...sleeveChecks,
  ...thumbShapeChecks,
  ...videoChecks,
];
