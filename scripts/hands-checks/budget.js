// Budget, mobile first, for the hands module alone: triangles at high and
// low LOD, draw calls (one per arm mesh) and bones. Solver timing is measured
// in the solver check; the sandbox scene's own budgets in sandbox-budget.js.
import { Skeleton } from '../../hands/src/skeleton.js';
import { buildArmMesh } from '../../hands/src/mesh.js';

export const BUDGET = { trianglesHigh: 20000, trianglesLow: 8000, drawCalls: 6, bones: 80 };

export function rigTriangles(lod, extra = 0) {
  const skel = new Skeleton();
  return buildArmMesh(skel, 'left', { lod }).stats.triangles + buildArmMesh(skel, 'right', { lod }).stats.triangles + extra;
}

export const budgetChecks = [
  {
    name: 'budget: triangles at high LOD',
    async run() {
      const t = rigTriangles('high');
      return { pass: t <= BUDGET.trianglesHigh, worst: t, limit: BUDGET.trianglesHigh, unit: 'tris', note: 'both arms with nails and sleeves' };
    },
  },
  {
    name: 'budget: triangles at low LOD',
    async run() {
      const t = rigTriangles('low');
      return { pass: t <= BUDGET.trianglesLow, worst: t, limit: BUDGET.trianglesLow, unit: 'tris', note: 'both arms with nails and sleeves' };
    },
  },
  {
    name: 'budget: draw calls',
    async run() {
      const calls = 2; // one SkinnedMesh per arm, single material each
      return { pass: calls <= BUDGET.drawCalls, worst: calls, limit: BUDGET.drawCalls, unit: 'calls', note: 'one per arm mesh' };
    },
  },
  {
    name: 'budget: bones',
    async run() {
      const n = new Skeleton().joints.length;
      return { pass: n <= BUDGET.bones, worst: n, limit: BUDGET.bones, unit: 'bones' };
    },
  },
];
