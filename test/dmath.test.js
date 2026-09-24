import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dmath from '../hands/src/dmath.js';
import { mulberry32 } from '../hands/src/rng.js';
import { mathProblems, checkDeterminism } from '../scripts/determinism.js';
import { fingerprintHash, usablePlanTable } from '../app/scenes/plans.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
const ord = (x) => { f64[0] = x; const b = i64[0]; return b < 0n ? -(b & 0x7fffffffffffffffn) : b; };
const ulps = (a, b) => { if (Object.is(a, b) || (a !== a && b !== b)) return 0; const d = ord(a) - ord(b); return Number(d < 0n ? -d : d); };

test('dmath: within its stated bounds of the engine\'s own Math over 20000 seeded inputs per function', () => {
  const r = mulberry32(99);
  const u = (a, b) => a + (b - a) * r();
  // Bounds against this engine's Math, which is itself within 1 ulp of the
  // true value: dmath's own error plus one.
  const cases = {
    sin: [() => [u(-50, 50)], 2], cos: [() => [u(-50, 50)], 2], tan: [() => [u(-1.55, 1.55)], 3],
    asin: [() => [u(-1, 1)], 2], acos: [() => [u(-1, 1)], 2], atan: [() => [u(-100, 100)], 2],
    atan2: [() => [u(-3, 3), u(-3, 3)], 2], exp: [() => [u(-740, 709)], 2], log: [() => [dmath.exp(u(-700, 700))], 2],
    pow: [() => [u(0, 5), u(-4, 4)], 40], hypot: [() => [u(-3, 3), u(-3, 3), u(-3, 3)], 3],
  };
  for (const [name, [gen, bound]] of Object.entries(cases)) {
    let worst = 0;
    for (let i = 0; i < 20000; i++) { const a = gen(); worst = Math.max(worst, ulps(dmath[name](...a), Math[name](...a))); }
    assert.ok(worst <= bound, `${name}: ${worst} ulp from Math (bound ${bound})`);
  }
});

test('dmath: the special values the standard fixes', () => {
  for (const f of ['sin', 'tan', 'asin', 'atan']) { assert.ok(Object.is(dmath[f](0), 0), `${f}(0)`); assert.ok(Object.is(dmath[f](-0), -0), `${f}(-0)`); }
  assert.equal(dmath.cos(0), 1);
  assert.equal(dmath.exp(0), 1);
  assert.equal(dmath.log(1), 0);
  assert.equal(dmath.acos(1), 0);
  assert.equal(dmath.pow(7.5, 0), 1);
  assert.equal(dmath.pow(3, 4), 81);
  assert.equal(dmath.hypot(3, 4), 5);
  assert.equal(dmath.exp(-Infinity), 0);
  assert.equal(dmath.exp(Infinity), Infinity);
  assert.equal(dmath.log(0), -Infinity);
  for (const [f, x] of [['sin', Infinity], ['cos', -Infinity], ['asin', 2], ['acos', -1.5], ['log', -1], ['sin', NaN], ['exp', NaN]]) assert.ok(Number.isNaN(dmath[f](x)), `${f}(${x}) is NaN`);
  assert.equal(dmath.atan2(0, -1), Math.PI);
  assert.equal(dmath.atan2(1, 0), Math.PI / 2);
  assert.throws(() => dmath.hypot(1, 2, 3, 4, 5));
});

test('dmath: this engine computes the recorded signature (the same bits as every other conforming engine)', () => {
  assert.equal(dmath.signature(), dmath.SIGNATURE_EXPECTED);
});

test('determinism rule: catches every platform-approximated Math use and **, ignores comments and strings', () => {
  assert.deepEqual(mathProblems('const a = Math.abs(x) + Math.sqrt(y) + Math.PI * Math.floor(z);'), []);
  assert.equal(mathProblems('const a = Math.sin(x);').length, 1);
  assert.equal(mathProblems('const a = Math . hypot(x, y);').length, 1);
  assert.equal(mathProblems('const { cos } = Math;').length, 1);
  assert.equal(mathProblems('const f = Math["pow"];').length, 1);
  assert.equal(mathProblems('const a = x ** 2;').length, 1);
  assert.deepEqual(mathProblems('// Math.sin in a comment\nconst s = "Math.cos(x) ** 2"; /* Math.pow */'), []);
  assert.deepEqual(checkDeterminism(ROOT).problems, []);
});

test('plan fingerprints are exact: inputs one ulp apart are different calls; a table under other math is refused', () => {
  // The x64 replay: a set-down whose inputs differed by 5.55e-17 matched the
  // arm64 recording once rounded to 1e-7, and replayed its answer.
  const a = 0.1 + 0.2;
  const b = 0.30000000000000004 + 5.551115123125783e-17;
  assert.notEqual(a, b);
  assert.notEqual(fingerprintHash(`right|tripod|${a}`), fingerprintHash(`right|tripod|${b}`));
  assert.equal(fingerprintHash(`right|tripod|${a}`), fingerprintHash(`right|tripod|${0.1 + 0.2}`));
  assert.equal(usablePlanTable({ runs: {}, math: dmath.signature() }).ok, true);
  const other = usablePlanTable({ runs: {}, math: '0000000000000' });
  assert.equal(other.ok, false);
  assert.match(other.reason, /solved live/);
  assert.equal(usablePlanTable(null).ok, false);
});
