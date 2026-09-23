// Registry of acceptance checks, grown commit by commit. Each entry:
// { name, run: async () => ({ pass, worst, limit, unit, note }) }.
import { servedChecks } from './served.js';

export const CHECKS = [
  ...servedChecks,
];
