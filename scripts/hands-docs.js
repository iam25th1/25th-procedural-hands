// Docs against code (scripts/docs-facts.js): every figure the docs quote
// that the code or a machine-independent check reproduces, and every path,
// npm script, export and name they mention. Reads the report of the latest
// npm run hands:check (full or ci set), which must be from the current
// sources. Exits 1 on any mismatch. Timings are not checked: they are
// device-dependent, and the docs date them and name the machine instead.
import fs from 'node:fs';
import path from 'node:path';
import { checkFacts, checkNames, FACTS } from './docs-facts.js';
import { ROOT, sourceHash } from './source-hash.js';

const reportFile = path.join(ROOT, 'artifacts', 'hands', 'check.json');
if (!fs.existsSync(reportFile)) { console.error('hands:docs: no check report; run npm run hands:check first'); process.exit(1); }
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
if (report.source !== sourceHash()) { console.error(`hands:docs: the check report (${report.source}) is not from the current sources (${sourceHash()}); run npm run hands:check first`); process.exit(1); }

const rows = await checkFacts(ROOT, report.results);
const names = checkNames(ROOT);
const table = rows.map((r) => [r.doc, r.what, r.ok ? 'PASS' : 'FAIL', r.note]);
const head = ['doc', 'fact', 'result', 'value'];
const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(line(row));
console.log(`\nnames: ${names.length ? names.length + ' problems' : 'every path, npm script, export and backticked name in the docs exists'}`);
for (const p of names) console.log(`  ${p}`);
const fails = rows.filter((r) => !r.ok).length + names.length;
console.log(`\n${FACTS.length} facts, ${rows.filter((r) => r.ok).length} PASS, ${rows.filter((r) => !r.ok).length} FAIL; ${names.length} name problems; check report ${report.when} (set ${report.set || 'full'})`);
process.exit(fails ? 1 : 0);
