import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFacts, checkNames, DOCS } from '../scripts/docs-facts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A copy of the docs to plant stale values in (the code stays the real one).
function copyDocs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-facts-'));
  for (const f of [...DOCS, 'package.json', 'examples/consumer/package.json']) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}
const plant = (dir, file, from, to) => {
  const p = path.join(dir, file);
  const s = fs.readFileSync(p, 'utf8');
  assert.ok(s.includes(from), `${file} no longer says "${from}"`);
  fs.writeFileSync(p, s.replace(from, to));
};
// Facts that need no check report (the rest need npm run hands:check).
const codeOnly = (rows) => rows.filter((r) => !/no check ".*" in the report/.test(r.note));

test('docs facts: every figure the code alone can reproduce matches the docs', async () => {
  const rows = codeOnly(await checkFacts(ROOT, []));
  assert.ok(rows.length >= 30, `${rows.length} code-only facts`);
  for (const r of rows) assert.ok(r.ok, `${r.doc}: ${r.what}: ${r.note}`);
});

test('docs facts: stale values planted in a copy of the docs are caught, each by its own fact', async () => {
  const dir = copyDocs();
  try {
    // Values that went stale behind code changes in this repository's history.
    plant(dir, 'hands/README.md', 'Each side has 31 joints', 'Each side has 30 joints');
    plant(dir, 'README.md', 'eight grips', 'seven grips');
    plant(dir, 'README.md', '| Bones | 62 | 80 |', '| Bones | 60 | 80 |');
    plant(dir, 'hands/README.md', '(about 400 KB)', '(about 235 KB)');
    plant(dir, 'hands/README.md', 'at least 18.9 dE', 'at least 20 dE');
    plant(dir, 'README.md', 'leaving out the 7 device-dependent', 'leaving out the 6 device-dependent');
    const bad = (await checkFacts(dir, [])).filter((r) => !r.ok && !/no check ".*" in the report/.test(r.note)).map((r) => r.what).sort();
    assert.deepEqual(bad, ['bones and limit', 'device-dependent checks (README)', 'grips', 'joints per side', 'nail bed contrast, closest tone', 'plan table size'].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('docs facts: a quoted sentence rewritten without its fact fails rather than passing silently', async () => {
  const dir = copyDocs();
  try {
    plant(dir, 'README.md', '<summary>All 64 capabilities', '<summary>Sixty-four capabilities');
    const row = (await checkFacts(dir, [])).find((r) => r.what === 'capabilities');
    assert.equal(row.ok, false);
    assert.match(row.note, /not there/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('docs names: every path, npm script, export and backticked name in the docs exists', () => {
  assert.deepEqual(checkNames(ROOT), []);
});
