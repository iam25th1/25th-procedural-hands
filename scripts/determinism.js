// The determinism rule for the simulation: code that decides where the
// hands and the world go (hands/src, the scripted scenarios in app/scenes
// and the planning code in app/plan) may use Math only for what ECMA-262
// fixes exactly, so every conforming engine on every CPU computes the same
// bits. Elementary functions the standard leaves implementation-approximated
// (sin, cos, pow, hypot and the rest, 21.3.2) go through hands/src/dmath.js,
// the one file allowed to build them. The ** operator is
// implementation-approximated too (Number::exponentiate), so it is refused
// as well. Comments and strings are stripped first (the isolation lexer).
import fs from 'node:fs';
import path from 'node:path';
import { lex } from './isolation.js';

export const DIRS = ['hands/src', 'app/scenes', 'app/plan'];
export const EXEMPT = ['hands/src/dmath.js'];
// Exact (or exactly specified) in ECMA-262: abs, sign, floor, ceil, round,
// trunc, min, max, imul, clz32, fround, sqrt (the correctly rounded root)
// and the constants.
export const EXACT = new Set(['abs', 'sign', 'floor', 'ceil', 'round', 'trunc', 'min', 'max', 'imul', 'clz32', 'fround', 'sqrt', 'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2']);

// Problems in one source text: every use of Math that is not Math.<exact
// member>, and every ** operator.
export function mathProblems(src) {
  const { code } = lex(src);
  const out = [];
  const lineOf = (i) => code.slice(0, i).split('\n').length;
  for (const m of code.matchAll(/\bMath\b(\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const member = m[2];
    if (!member) out.push(`line ${lineOf(m.index)}: Math used other than as Math.<member>`);
    else if (!EXACT.has(member)) out.push(`line ${lineOf(m.index)}: Math.${member} is implementation-approximated; use dmath.${member}`);
  }
  for (const m of code.matchAll(/\*\*/g)) out.push(`line ${lineOf(m.index)}: ** is implementation-approximated; use dmath.pow`);
  return out;
}

export function checkDeterminism(root) {
  const problems = [];
  let files = 0;
  for (const dir of DIRS) {
    const abs = path.join(root, dir);
    for (const name of fs.readdirSync(abs).filter((f) => f.endsWith('.js')).sort()) {
      const rel = `${dir}/${name}`;
      if (EXEMPT.includes(rel)) continue;
      files++;
      for (const p of mathProblems(fs.readFileSync(path.join(abs, name), 'utf8'))) problems.push(`${rel} ${p}`);
    }
  }
  return { files, problems };
}
