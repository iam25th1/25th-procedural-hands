// Acceptance suite. Every check reports PASS or FAIL with the worst measured
// value against its limit. Exits 1 when any check fails. The report is also
// written to artifacts/hands/check.json (with a hash of the sources it ran
// against) for npm run hands:matrix.
//
// --set=ci runs only the machine-independent checks: those without a
// `device` reason. Device-dependent checks (wall-clock budgets measured on
// a particular machine, and the video renders' time limit) are not run in
// that set, keep their limits unchanged, and are named in the output and
// the report; npm run gate runs every check.
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
const setArg = process.argv.find((a) => a.startsWith('--set='));
const SET = setArg ? setArg.slice(6) : 'full';
if (SET !== 'full' && SET !== 'ci') { console.error(`hands:check: unknown --set=${SET} (full or ci)`); process.exit(2); }
const notRun = SET === 'ci' ? CHECKS.filter((c) => c.device).map((c) => ({ name: c.name, device: c.device })) : [];
const results = [];
const t0 = performance.now();
for (const check of CHECKS) {
  if (ONLY && !ONLY.test(check.name)) continue;
  if (SET === 'ci' && check.device) continue;
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
if (notRun.length) {
  console.log(`\nNot run in the ${SET} set: ${notRun.length} device-dependent checks, unchanged, run by npm run gate on the device:`);
  for (const c of notRun) console.log(`  ${c.name} (${c.device})`);
}
console.log(`\n${results.length} checks, ${results.length - fails} PASS, ${fails} FAIL${SET === 'ci' ? `, ${notRun.length} device-dependent not run (set ci)` : ''}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

if (!ONLY) {
  const outDir = path.join(ROOT, 'artifacts', 'hands');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'check.json'), JSON.stringify({ when: new Date().toISOString(), source: sourceHash(), set: SET, notRun, results }, null, 2));
}
process.exit(fails ? 1 : 0);
