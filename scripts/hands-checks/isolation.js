// The isolation rule as a check row: hands/src imports only hands/ and three.
import { checkIsolation } from '../isolation.js';
import { ROOT } from '../source-hash.js';

export const isolationChecks = [{
  name: 'isolation: hands/src imports nothing but three and never touches window or document',
  async run() {
    const r = checkIsolation(ROOT);
    return { pass: r.problems.length === 0, worst: r.problems.length, limit: 0, unit: 'violations', note: r.problems.length ? r.problems.join('; ') : `${r.files} files, ${r.imports} imports, ${r.three} from three` };
  },
}];
