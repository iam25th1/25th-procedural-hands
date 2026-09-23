// The hands module imports nothing but three and never touches the DOM. This
// runs in the gate (npm test) over every file under hands/src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIsolation, specifiers } from '../scripts/isolation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('isolation: hands/src imports only files inside hands/ and three, and never touches window or document', () => {
  const r = checkIsolation(ROOT);
  assert.ok(r.files >= 10, `scanned ${r.files} files`);
  assert.deepEqual(r.problems, []);
  console.log(`isolation: ${r.files} files under hands/src, ${r.imports} import specifiers, ${r.three} from 'three', 0 outside hands/, 0 window or document`);
});

test('isolation lexer: finds real imports, ignores comments and strings, sees through template literals', () => {
  const src = [
    "import * as THREE from 'three';",
    "import { a } from './a.js'; // import { b } from 'lodash'",
    '/* import x from "react"; */',
    "export { c } from '../src/c.js';",
    "const s = 'import y from \"fs\"';",
    'const t = `window ${1 + 2} document`;',
    "const d = await import('./d.js');",
    "import 'side-effect';",
  ].join('\n');
  const { specs, dynamic, code } = specifiers(src);
  assert.deepEqual(specs, ['three', './a.js', '../src/c.js', './d.js', 'side-effect']);
  assert.equal(dynamic, false);
  assert.doesNotMatch(code, /window|document|lodash|react/);
  assert.equal(specifiers('const m = await import(name);').dynamic, true);
});

test('isolation rule catches an outside import and DOM use', () => {
  const bad = specifiers("import { x } from '../../app/main.js';\nconst w = window.innerWidth; document.body;");
  assert.deepEqual(bad.specs, ['../../app/main.js']);
  assert.match(bad.code, /\bwindow\b/);
  assert.match(bad.code, /\bdocument\b/);
});
