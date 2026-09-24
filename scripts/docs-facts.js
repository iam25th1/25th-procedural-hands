// What the docs say, held to what the code does. Each fact ties one sentence
// in a doc to the value it quotes: a pattern that must match exactly once
// (so a rewritten sentence fails loudly until its fact is updated too), and
// the value the code or a machine-independent check gives now. Timings are
// not here: they are device-dependent, and the docs date them and name the
// machine instead. Alongside the facts, every repository path, npm script,
// export and backticked name a doc mentions must exist.
import fs from 'node:fs';
import path from 'node:path';
import { XR_JOINT_NAMES, JOINTS_PER_SIDE } from '../hands/src/skeleton.js';
import { FOREARM_TWIST, KULESH_SKIN_SHARE, HAND_MM, SEGMENT_FRACTION, STATURE_MM, ARM_MM } from '../hands/src/anatomy.js';
import { GRIPS } from '../hands/src/grasp.js';
import { MONK_TONES } from '../hands/src/skin.js';
import { GESTURES } from '../hands/src/gestures.js';
import { Skeleton } from '../hands/src/skeleton.js';
import { buildArmMesh, colorize } from '../hands/src/mesh.js';
import { SKIN_TONES, SLEEVE_COLOURS } from '../hands/src/defaults.js';
import * as api from '../hands/src/index.js';
import { CAPABILITIES } from './hands-matrix/capabilities.js';
import { CHECKS } from './hands-checks/index.js';
import { BUDGET, NODE_BUDGET } from './hands-checks/budget.js';
import { SANDBOX_BUDGET } from './hands-checks/sandbox-budget.js';
import { PLANNING_LIMIT } from './hands-checks/planning.js';
import { PLAN_TABLE } from '../server/plan-hash.js';

export const DOCS = ['README.md', 'hands/README.md', 'CONTRIBUTING.md', 'docs/dev-notes/README.md', 'docs/dev-notes/HANDS_X64_REPLAY.md', 'examples/consumer/README.md'];

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n) => WORDS[n] ?? String(n);
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fixed = (x, d) => x.toFixed(d);
const tris = (lod) => { const skel = new Skeleton(); return buildArmMesh(skel, 'left', { lod }).stats.triangles + buildArmMesh(skel, 'right', { lod }).stats.triangles; };

// The colour model's palm lift and nail contrast per Monk tone (CIE Lab of
// the vertex colours, the same measure as test/mesh.test.js).
function colourModel() {
  const mesh = buildArmMesh(new Skeleton(), 'right', { lod: 'low' });
  const lab = ([r, g, b]) => {
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  return SKIN_TONES.map((tone) => {
    const { color } = colorize(mesh, { skinTone: tone, shirt: SLEEVE_COLOURS[1] });
    const mean = (pred) => { const a = [0, 0, 0]; let n = 0; mesh.meta.forEach((m, i) => { if (pred(m)) { a[0] += color[i * 3]; a[1] += color[i * 3 + 1]; a[2] += color[i * 3 + 2]; n++; } }); return a.map((v) => v / n); };
    const d = lab(mean((m) => m.region === 0 && m.palmar < 0.05 && m.shade === 1));
    const p = lab(mean((m) => m.region === 0 && m.palmar > 0.95 && (m.glabrous ?? 1) === 1 && m.shade === 1));
    const nail = lab(mean((m) => m.region === 1));
    return { palm: p[0] - d[0], nail: Math.hypot(nail[0] - d[0], nail[1] - d[1], nail[2] - d[2]) };
  });
}

// A check's result from the report (machine-independent checks only, so
// the facts hold in the CI set too).
const result = (ctx, prefix) => {
  const r = ctx.report.find((x) => x.name.startsWith(prefix));
  if (!r) throw new Error(`no check "${prefix}" in the report`);
  return r;
};
const noteNumber = (ctx, prefix, re) => { const m = result(ctx, prefix).note.match(re); if (!m) throw new Error(`"${prefix}" note does not match ${re}`); return m[1]; };

export const FACTS = [
  // Structure
  { doc: 'README.md', find: /\*\*Anatomical rig\*\*: (\d+) WebXR joints per hand/, value: () => String(XR_JOINT_NAMES.length), what: 'WebXR joints per hand' },
  { doc: 'README.md', find: /forearm and (\w+) twist bones, \d+ bones in all/, value: () => word(FOREARM_TWIST.length), what: 'twist bones' },
  { doc: 'README.md', find: /twist bones, (\d+) bones in all/, value: () => String(2 * JOINTS_PER_SIDE), what: 'bones in all' },
  { doc: 'hands/README.md', find: /\| `skeleton\.js` \| (\d+) joints per side/, value: () => String(JOINTS_PER_SIDE), what: 'joints per side (files table)' },
  { doc: 'hands/README.md', find: /\| `skeleton\.js` \| \d+ joints per side, (\d+) in all/, value: () => String(2 * JOINTS_PER_SIDE), what: 'bones in all (files table)' },
  { doc: 'hands/README.md', find: /Each side has (\d+) joints/, value: () => String(JOINTS_PER_SIDE), what: 'joints per side' },
  { doc: 'hands/README.md', find: /so a pair of arms is (\d+) bones/, value: () => String(2 * JOINTS_PER_SIDE), what: 'bones in a pair' },
  // Grips, gestures, tones, capabilities, checks
  { doc: 'README.md', find: /\*\*Grasping and manipulation\*\*: (\w+) grips/, value: () => word(Object.keys(GRIPS).length), what: 'grips' },
  { doc: 'README.md', find: /\(a pad pinch (\d+) N, a power grip \d+ N\)/, value: () => String(GRIPS.padPinch.capacity), what: 'pad pinch capacity' },
  { doc: 'README.md', find: /a power grip (\d+) N\)/, value: () => String(GRIPS.powerCylinder.capacity), what: 'power grip capacity' },
  { doc: 'README.md', find: /<summary>All (\d+) capabilities/, value: () => String(CAPABILITIES.length), what: 'capabilities' },
  { doc: 'README.md', find: /The hands come in the (\w+) tones of the/, value: () => word(MONK_TONES.length), what: 'Monk tones' },
  { doc: 'README.md', find: /\| Gestures \| ([^|]+) \|/, value: () => '', what: 'gestures row lists every registry gesture', test: (got) => Object.keys(GESTURES).length === got.split(',').length ? '' : `${got.split(',').length} listed, ${Object.keys(GESTURES).length} in GESTURES` },
  { doc: 'README.md', find: /leaving out the (\d+) device-dependent ones/, value: () => String(CHECKS.filter((c) => c.device).length), what: 'device-dependent checks (README)' },
  { doc: 'CONTRIBUTING.md', find: /<summary>The device-dependent checks, and why a shared runner cannot hold them<\/summary>\n\n\| Check \| Why it is device-dependent \|\n\| --- \| --- \|\n((?:\|[^\n]*\n)+)/, value: () => '', what: 'device-dependent checks (CONTRIBUTING table)', test: (got) => { const rows = got.trim().split('\n').reduce((n, l) => n + (/three checks/.test(l) ? 3 : 1), 0); const want = CHECKS.filter((c) => c.device).length; return rows === want ? '' : `${rows} in the table, ${want} tagged in the code`; } },
  // Anatomy
  { doc: 'README.md', find: /\\frac\{([\d.]+)\\ \\text\{mm\}\}\{0\.108\}/, value: () => fixed(HAND_MM.length, 1), what: 'ANSUR II hand length' },
  { doc: 'README.md', find: /\\frac\{L_\{\\text\{hand\}\}\}\{([\d.]+)\}/, value: () => String(SEGMENT_FRACTION.hand), what: 'hand fraction of stature' },
  { doc: 'README.md', find: /\\approx (\d+)\\ \\text\{mm\}/, value: () => fixed(STATURE_MM, 0), what: 'stature' },
  { doc: 'README.md', find: /L_\{\\text\{upper arm\}\} = ([\d.]+)\\,H/, value: () => String(SEGMENT_FRACTION.upperArm), what: 'upper arm fraction' },
  { doc: 'README.md', find: /L_\{\\text\{forearm\}\} = ([\d.]+)\\,H/, value: () => String(SEGMENT_FRACTION.forearm), what: 'forearm fraction' },
  { doc: 'README.md', find: /rising from ([\d.]+) near the elbow to [\d.]+ at the distal radius/, value: () => fixed(KULESH_SKIN_SHARE[0][1], 3), what: 'Kulesh share, level I' },
  { doc: 'README.md', find: /near the elbow to ([\d.]+) at the distal radius/, value: () => fixed(KULESH_SKIN_SHARE[7][1], 3), what: 'Kulesh share, level VIII' },
  { doc: 'hands/README.md', find: /which gives ([\d., and]+) from level I/, value: () => { const s = KULESH_SKIN_SHARE.map(([, v]) => fixed(v, 3)); return `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`; }, what: 'Kulesh shares, levels I to VIII' },
  { doc: 'hands/README.md', find: /the forearm \(elbow to wrist, ([\d.]+) mm\)/, value: () => fixed(ARM_MM.forearm, 1), what: 'forearm length' },
  { doc: 'hands/README.md', find: /the upper arm \(([\d.]+) mm\)/, value: () => fixed(ARM_MM.upperArm, 1), what: 'upper arm length' },
  { doc: 'hands/README.md', find: /hand length \((\d+) mm\)/, value: () => fixed(STATURE_MM, 0), what: 'stature (hands README)' },
  // Colour
  { doc: 'hands/README.md', find: /([\d.]+ to [\d.]+) L\* on Monk 1 to 5/, value: (ctx) => { const v = ctx.colour().slice(0, 5).map((c) => c.palm); return `${fixed(Math.min(...v), 1)} to ${fixed(Math.max(...v), 1)}`; }, what: 'palm lift, Monk 1 to 5 (vertex colours)' },
  { doc: 'hands/README.md', find: /rising to ([\d.]+) L\* on Monk 10 in the vertex colours/, value: (ctx) => fixed(ctx.colour()[9].palm, 1), what: 'palm lift, Monk 10 (vertex colours)' },
  { doc: 'hands/README.md', find: /at least ([\d.]+) dE from the skin on every tone/, value: (ctx) => fixed(Math.min(...ctx.colour().map((c) => c.nail)), 1), what: 'nail bed contrast, closest tone' },
  { doc: 'README.md', find: /\| Monk (\d+) \| `(#[0-9a-f]{6})` \| (\w+) \|/g, all: true, value: () => '', what: 'Monk tone table', test: (rows) => { const want = MONK_TONES.map((t) => `${t.monk}|${t.hex}|${t.undertone}`).join(' '); const got = rows.map((m) => `${m[1]}|${m[2]}|${m[3]}`).join(' '); return got === want ? '' : `table ${got} against code ${want}`; } },
  // Budgets: counts and limits (timings are device-dependent and dated instead)
  { doc: 'README.md', find: /\| Triangles, both arms, high LOD \| ([\d ]+) \| ([\d ]+) \|/, value: () => `${grouped(tris('high'))}|${grouped(BUDGET.trianglesHigh)}`, both: true, what: 'triangles, high LOD, and limit' },
  { doc: 'README.md', find: /\| Triangles, both arms, low LOD \| ([\d ]+) \| ([\d ]+) \|/, value: () => `${grouped(tris('low'))}|${grouped(BUDGET.trianglesLow)}`, both: true, what: 'triangles, low LOD, and limit' },
  { doc: 'README.md', find: /\| Draw calls, both arms \| (\d+) \| (\d+) \|/, value: (ctx) => `${result(ctx, 'budget: draw calls').worst}|${BUDGET.drawCalls}`, both: true, what: 'draw calls and limit' },
  { doc: 'README.md', find: /\| Bones \| (\d+) \| (\d+) \|/, value: () => `${2 * JOINTS_PER_SIDE}|${BUDGET.bones}`, both: true, what: 'bones and limit' },
  { doc: 'README.md', find: /\| Rig step \(one fixed step\), median in Node \| [^|]+ \| ([\d.]+) ms \|/, value: () => String(NODE_BUDGET.rigStepMs), what: 'rig step limit' },
  { doc: 'README.md', find: /\| Triangles, worst of six stations \| ([\d ]+) \| ([\d ]+) \|/, value: (ctx) => `${grouped(result(ctx, 'budget: triangles, draw calls and bones with the sandbox scene loaded').worst)}|${grouped(SANDBOX_BUDGET.triangles)}`, both: true, what: 'sandbox triangles and limit' },
  { doc: 'README.md', find: /\| Draw calls, worst of six stations \| (\d+) \| (\d+) \|/, value: (ctx) => `${noteNumber(ctx, 'budget: triangles, draw calls and bones with the sandbox scene loaded', /(\d+) draw calls/)}|${SANDBOX_BUDGET.calls}`, both: true, what: 'sandbox draw calls and limit' },
  { doc: 'README.md', find: /median in Node \| [^|]+ \| ([\d.]+) ms \|\n\| Sim step, median, live/, value: () => fixed(NODE_BUDGET.simStepMs, 1), what: 'Node sim step limit' },
  { doc: 'README.md', find: /\| Sim step, median, live in headless Chromium \| [^|]+ \| ([\d.]+) ms \|/, value: () => fixed(SANDBOX_BUDGET.liveStepMs, 1), what: 'live median limit' },
  { doc: 'README.md', find: /\| Sim step, 95th percentile, live \| [^|]+ \| ([\d.]+) ms \|/, value: () => fixed(SANDBOX_BUDGET.liveStepP95Ms, 1), what: 'live p95 limit' },
  { doc: 'README.md', find: /\| Sim step, worst step, live \| [^|]+ \| ([\d.]+) ms \|/, value: () => fixed(SANDBOX_BUDGET.liveStepWorstMs, 1), what: 'live worst limit' },
  { doc: 'README.md', find: /cold plans, live \| [^|]+ \| (\d+) ms \|/, value: () => String(PLANNING_LIMIT.frameMs), what: 'planning frame limit' },
  // Measured figures the machine-independent checks reproduce exactly
  { doc: 'hands/README.md', find: /The narrowest section keeps ([\d.]+) percent of its rest radius/, value: (ctx) => fixed(result(ctx, 'skinning: the forearm keeps its girth').worst, 1), what: 'candy wrap, narrowest section' },
  { doc: 'hands/README.md', find: /equal thirds kept ([\d.]+), and that is the check's floor/, value: (ctx) => noteNumber(ctx, 'skinning: the forearm keeps its girth', /equal-thirds rig kept ([\d.]+)/), what: 'candy wrap, equal thirds' },
  { doc: 'hands/README.md', find: /The last forearm ring \(s = ([\d.]+)\)/, value: (ctx) => noteNumber(ctx, 'skinning: forearm skin turns along the forearm', /0\.95 turns ([\d.]+)/), what: 'last forearm ring share' },
  { doc: 'hands/README.md', find: /the relaxed pose reads ([\d.]+) deg on both hands/, value: (ctx) => noteNumber(ctx, 'anatomy: first metacarpal rotation', /right ([\d.]+) deg/), what: 'first metacarpal rotation at rest' },
  { doc: 'hands/README.md', find: /leaves the thenar \(([\d.]+) mm across\)/, value: (ctx) => noteNumber(ctx, 'thumb: the skin tapers', /widest ([\d.]+) mm/), what: 'thumb width at the thenar' },
  { doc: 'hands/README.md', find: /the taper now changes by at most ([\d.]+) mm/, value: (ctx) => fixed(result(ctx, 'thumb: the skin tapers').worst, 2), what: 'thumb taper step' },
  { doc: 'hands/README.md', find: /holds it to ([\d.]+) mm \(`thumb: the skin tapers/, value: (ctx) => fixed(result(ctx, 'thumb: the skin tapers').limit, 2), what: 'thumb taper limit' },
  { doc: 'hands/README.md', find: /it is now at least ([\d.]+) mm in\)/, value: (ctx) => fixed(-result(ctx, 'sleeve: no skin the sleeve covers').worst, 1), what: 'skin inside the sleeve' },
  { doc: 'hands/README.md', find: /skins the arm through (\d+) shoulder poses/, value: (ctx) => noteNumber(ctx, 'sleeve: no skin the sleeve covers', /(\d+) shoulder poses/), what: 'sleeve shoulder poses' },
  { doc: 'hands/README.md', find: /The forearm's largest girth \((\d+) mm\)/, value: (ctx) => fixed(Number(noteNumber(ctx, 'proportion: forearm length and wrist girth', /largest forearm girth ([\d.]+) mm/)), 0), what: 'largest forearm girth' },
  { doc: 'hands/README.md', find: /can answer the costly solves \(([^)]*), the kinds `Interaction\.cached` records\)/, value: () => '', what: 'solve kinds a plan table records', test: (got) => { const doc = [...got.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort().join(' '); const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../hands/src/interact.js'), 'utf8'); const code = [...new Set([...src.matchAll(/cached\('(\w+)'/g)].map((m) => m[1]))].sort().join(' '); return doc === code ? '' : `doc lists ${doc}, interact.js records ${code}`; } },
  { doc: 'hands/README.md', find: /`app\/scenes\/plans\.json` \(about (\d+) KB\)/, value: () => '', what: 'plan table size', test: (got) => { const kb = fs.statSync(PLAN_TABLE).size / 1024; return Math.abs(kb - Number(got)) / kb <= 0.1 ? '' : `the table is ${kb.toFixed(0)} KB`; } },
];

// Every repository path, npm script, export and backticked name in the docs.
export function checkNames(root) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/consumer/package.json'), 'utf8'));
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', 'artifacts', '.git', 'dist'].includes(e.name)) walk(f, out); } else if (/\.(js|mjs)$/.test(e.name)) out.push(f); } return out; };
  const code = ['hands', 'app', 'scripts', 'server', 'test', 'examples/consumer'].flatMap((d) => walk(path.join(root, d))).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const Hands = api.create().constructor;
  const methods = new Set(Object.getOwnPropertyNames(Hands.prototype));
  const dirs = ['hands/src', 'scripts', 'scripts/hands-checks', 'app', 'app/scenes', 'app/plan', 'app/ui', 'server', 'test', 'docs/dev-notes', 'docs/assets', 'examples/consumer', '.'];
  for (const doc of DOCS) {
    const s = fs.readFileSync(path.join(root, doc), 'utf8');
    for (const m of s.matchAll(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/?`/g)) if (!fs.existsSync(path.join(root, m[1]))) problems.push(`${doc}: no path ${m[1]}`);
    for (const m of s.matchAll(/`([A-Za-z0-9_-]+\.(?:js|mjs|json|md|yml|svg|png))`/g)) if (!dirs.some((d) => fs.existsSync(path.join(root, d, m[1])))) problems.push(`${doc}: no file ${m[1]}`);
    for (const m of s.matchAll(/npm run ([a-z:]+)/g)) if (!pkg.scripts[m[1]] && !(example.scripts || {})[m[1]]) problems.push(`${doc}: no npm script ${m[1]}`);
    for (const m of s.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\([^`]*\))?`/g)) {
      const last = m[1].split('.').pop();
      if (last.length >= 4 && !fs.existsSync(path.join(root, m[1])) && !new RegExp(`\\b${last.replace(/\$/g, '\\$')}\\b`).test(code)) problems.push(`${doc}: ${m[0]} is not in the code`);
    }
  }
  const r = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const apiTable = r.slice(r.indexOf('<summary>The Hands API</summary>'), r.indexOf('<summary>Also exported</summary>'));
  for (const m of apiTable.matchAll(/`([a-zA-Z]+)\(/g)) if (m[1] !== 'create' && !methods.has(m[1])) problems.push(`README.md API table: Hands has no ${m[1]}()`);
  const also = r.slice(r.indexOf('<summary>Also exported</summary>'), r.indexOf('</details>', r.indexOf('<summary>Also exported</summary>')));
  for (const row of also.split('\n').filter((l) => l.startsWith('| `'))) for (const m of row.split('|')[1].matchAll(/`([A-Za-z_$][\w$]*)/g)) if (!(m[1] in api)) problems.push(`README.md exports table: ${m[1]} is not exported`);
  return problems;
}

// Evaluate every fact against the docs; returns rows { doc, what, ok, note }.
export async function checkFacts(root, report) {
  let colour = null;
  const ctx = { report, colour: () => (colour ||= colourModel()) };
  const rows = [];
  for (const f of FACTS) {
    const text = fs.readFileSync(path.join(root, f.doc), 'utf8');
    try {
      if (f.all) {
        const ms = [...text.matchAll(f.find)];
        const bad = ms.length ? f.test(ms) : 'no rows found';
        rows.push({ doc: f.doc, what: f.what, ok: !bad, note: bad || `${ms.length} rows` });
        continue;
      }
      const ms = [...text.matchAll(new RegExp(f.find.source, f.find.flags.includes('g') ? f.find.flags : `${f.find.flags}g`))];
      if (ms.length !== 1) { rows.push({ doc: f.doc, what: f.what, ok: false, note: `the sentence is ${ms.length ? `there ${ms.length} times` : 'not there'}: update the doc and this fact together` }); continue; }
      const got = f.both ? `${ms[0][1]}|${ms[0][2]}` : ms[0][1];
      if (f.test) { const bad = f.test(got); rows.push({ doc: f.doc, what: f.what, ok: !bad, note: bad || got }); continue; }
      const want = await f.value(ctx);
      rows.push({ doc: f.doc, what: f.what, ok: got === want, note: got === want ? got : `doc says ${got}, code gives ${want}` });
    } catch (e) {
      rows.push({ doc: f.doc, what: f.what, ok: false, note: String(e.message || e) });
    }
  }
  return rows;
}
