// Acceptance suite. Every check reports PASS or FAIL with the worst measured
// value against its limit. Exits 1 when any check fails. The report is also
// written to artifacts/hands/check.json (with a hash of the sources it ran
// against) for npm run hands:matrix.
import fs from 'node:fs';
import path from 'node:path';
import { CHECKS } from './hands-checks/index.js';
import { ROOT, sourceHash } from './source-hash.js';

function fmt(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : (Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(2) : v.toFixed(3));
  return String(v);
}

const only = process.argv.find((a) => a.startsWith('--only='));
const ONLY = only ? new RegExp(only.slice(7)) : null;
const results = [];
const t0 = performance.now();
for (const check of CHECKS) {
  if (ONLY && !ONLY.test(check.name)) continue;
  const started = performance.now();
  let r;
  try {
    r = await check.run();
  } catch (err) {
    r = { pass: false, worst: 'threw', limit: '', note: String((err && err.stack) || err).split('\n').slice(0, 4).join(' | ') };
  }
  results.push({ name: check.name, ...r, ms: performance.now() - started });
  if (process.env.HANDS_CHECK_PROGRESS) console.error(`${r.pass ? 'PASS' : 'FAIL'} ${check.name} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}

const rows = results.map((r) => [r.name, r.pass ? 'PASS' : 'FAIL', `${fmt(r.worst)}${r.unit ? ' ' + r.unit : ''}`, `${fmt(r.limit)}${r.unit ? ' ' + r.unit : ''}`, r.note || '']);
const head = ['check', 'result', 'worst', 'limit', 'note'];
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of rows) console.log(line(row));
const fails = results.filter((r) => !r.pass).length;
console.log(`\n${results.length} checks, ${results.length - fails} PASS, ${fails} FAIL, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

if (!ONLY) {
  const outDir = path.join(ROOT, 'artifacts', 'hands');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'check.json'), JSON.stringify({ when: new Date().toISOString(), source: sourceHash(), results }, null, 2));
}
process.exit(fails ? 1 : 0);
