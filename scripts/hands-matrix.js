// Prints the capability matrix: one row per capability, the check and sheet
// that prove it, and PASS or FAIL. A row passes only when every named check
// passed in the latest npm run hands:check report and that report was made
// from the current sources. Exits 1 on any FAIL or unproven row.
//
// --set=ci reads a report from hands:check --set=ci: a row proved by a
// device-dependent check that set did not run is DEVICE (not run here), not
// PASS, and does not fail the set; every other row is held as above. The
// full matrix (no --set) needs a full report, and fails any row whose check
// is missing from it.
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES } from './hands-matrix/capabilities.js';
import { ROOT, sourceHash } from './source-hash.js';

const reportFile = path.join(ROOT, 'artifacts', 'hands', 'check.json');
if (!fs.existsSync(reportFile)) {
  console.error('hands:matrix: no check report; run npm run hands:check first');
  process.exit(1);
}
const setArg = process.argv.find((a) => a.startsWith('--set='));
const SET = setArg ? setArg.slice(6) : 'full';
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const notRun = new Map(SET === 'ci' ? (report.notRun || []).map((c) => [c.name, c.device]) : []);
const fresh = report.source === sourceHash();
const byName = new Map(report.results.map((r) => [r.name, r]));

const rows = [];
for (const cap of CAPABILITIES) {
  const problems = [];
  const device = [];
  if (!cap.checks || cap.checks.length === 0) problems.push('no proving check');
  for (const name of cap.checks || []) {
    const r = byName.get(name);
    if (!r && notRun.has(name)) device.push(name);
    else if (!r) problems.push(`missing check "${name}"`);
    else if (!r.pass) problems.push(`check failed "${name}"`);
  }
  if (!cap.sheet) problems.push('no sheet');
  if (!fresh) problems.push('check report is stale');
  const result = problems.length ? 'FAIL' : device.length ? 'DEVICE' : 'PASS';
  const note = problems.length ? problems.join('; ') : device.length ? `not run in set ${SET}: ${device.length} device-dependent check${device.length > 1 ? 's' : ''}, run by npm run gate on the device` : '';
  rows.push({ group: cap.group, name: cap.name, proof: (cap.checks || []).join(' + '), sheet: cap.sheet || '', result, note });
}
const head = ['group', 'capability', 'result', 'proved by check', 'sheet', 'note'];
const table = rows.map((r) => [r.group, r.name, r.result, r.proof, r.sheet, r.note]);
const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(line(row));
const fails = rows.filter((r) => r.result === 'FAIL').length;
const devices = rows.filter((r) => r.result === 'DEVICE').length;
console.log(`\n${rows.length} capabilities, ${rows.length - fails - devices} PASS, ${fails} FAIL${SET === 'ci' ? `, ${devices} DEVICE (not run in set ci)` : ''}; check report ${report.when} (set ${report.set || 'full'}) ${fresh ? 'matches' : 'does NOT match'} the current sources (${report.source})`);
process.exit(fails || !fresh ? 1 : 0);
