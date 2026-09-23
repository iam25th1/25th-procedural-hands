// Prints the capability matrix: one row per capability, the check and sheet
// that prove it, and PASS or FAIL. A row passes only when every named check
// passed in the latest npm run hands:check report and that report was made
// from the current sources. Exits 1 on any FAIL or unproven row.
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES } from './hands-matrix/capabilities.js';
import { ROOT, sourceHash } from './source-hash.js';

const reportFile = path.join(ROOT, 'artifacts', 'hands', 'check.json');
if (!fs.existsSync(reportFile)) {
  console.error('hands:matrix: no check report; run npm run hands:check first');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const fresh = report.source === sourceHash();
const byName = new Map(report.results.map((r) => [r.name, r]));

const rows = [];
for (const cap of CAPABILITIES) {
  const problems = [];
  if (!cap.checks || cap.checks.length === 0) problems.push('no proving check');
  for (const name of cap.checks || []) {
    const r = byName.get(name);
    if (!r) problems.push(`missing check "${name}"`);
    else if (!r.pass) problems.push(`check failed "${name}"`);
  }
  if (!cap.sheet) problems.push('no sheet');
  if (!fresh) problems.push('check report is stale');
  rows.push({ group: cap.group, name: cap.name, proof: (cap.checks || []).join(' + '), sheet: cap.sheet || '', result: problems.length ? 'FAIL' : 'PASS', note: problems.join('; ') });
}
const head = ['group', 'capability', 'result', 'proved by check', 'sheet', 'note'];
const table = rows.map((r) => [r.group, r.name, r.result, r.proof, r.sheet, r.note]);
const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(line(row));
const fails = rows.filter((r) => r.result !== 'PASS').length;
console.log(`\n${rows.length} capabilities, ${rows.length - fails} PASS, ${fails} FAIL; check report ${report.when} ${fresh ? 'matches' : 'does NOT match'} the current sources (${report.source})`);
process.exit(fails || !fresh ? 1 : 0);
