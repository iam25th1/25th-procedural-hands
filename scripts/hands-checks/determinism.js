// Replay across machines: the simulation's math must be the same bits on
// every engine and CPU, or a plan table recorded on one machine replays
// another machine's answers (docs/dev-notes/HANDS_X64_REPLAY.md).
import { checkDeterminism } from '../determinism.js';
import { ROOT } from '../source-hash.js';
import { signature, SIGNATURE_EXPECTED } from '../../hands/src/dmath.js';

export const determinismChecks = [
  {
    name: 'determinism: the rig, the world, the scenarios and the planner use only the Math the standard fixes exactly (sin, pow and the rest go through dmath)',
    async run() {
      const r = checkDeterminism(ROOT);
      return { pass: r.problems.length === 0, worst: r.problems.length, limit: 0, unit: 'uses', note: r.problems.length ? r.problems.slice(0, 6).join('; ') : `${r.files} files in hands/src, app/scenes and app/plan` };
    },
  },
  {
    name: 'determinism: this engine computes dmath to the recorded bits (the signature a plan table must match to be replayed)',
    async run() {
      const got = signature();
      return { pass: got === SIGNATURE_EXPECTED, worst: got === SIGNATURE_EXPECTED ? 0 : 1, limit: 0, unit: 'mismatches', note: `signature ${got}, expected ${SIGNATURE_EXPECTED} (${process.platform}-${process.arch}, node ${process.version})` };
    },
  },
];
