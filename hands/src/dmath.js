// Deterministic elementary functions: the same bits on every JavaScript
// engine and every CPU.
//
// ECMA-262 leaves sin, cos, tan, asin, acos, atan, atan2, exp, log, pow and
// hypot "implementation-approximated" (21.3.2: an engine may use the C
// library of the platform it runs on), and they do differ: Node on
// linux-x64 returns a different last bit from Node on darwin-arm64 for 9 of
// them (1 ulp, a few hundred inputs in 50000), and linux-arm64 for 4. A
// replay recorded on one machine then parts from a live run on another
// (docs/dev-notes/HANDS_X64_REPLAY.md). The rig and the world use these
// instead: they are built only from operations the standard fixes exactly
// (+, -, *, /, Math.sqrt, Math.floor and Math.abs, which are correctly
// rounded or exact, and bit access through a big-endian DataView), so any
// conforming engine computes them bit for bit alike. Against V8's own
// Math, over 200000 seeded inputs each: sin, cos, asin, acos, atan, atan2,
// exp and log within 1 ulp; tan and hypot within 2; pow, as exp(y log x),
// within 4 ulp for most inputs and up to 35 where |y log x| is large (it
// serves only mesh shape and colour).
//
// Ported from musl libc (MIT) and FreeBSD msun, which carry this notice:
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================

const view = new DataView(new ArrayBuffer(8));
const hiWord = (x) => { view.setFloat64(0, x); return view.getInt32(0); };
const loWord = (x) => { view.setFloat64(0, x); return view.getUint32(4); };
const lowZeroed = (x) => { view.setFloat64(0, x); view.setUint32(4, 0); return view.getFloat64(0); };
const fromWords = (hi, lo) => { view.setInt32(0, hi); view.setUint32(4, lo); return view.getFloat64(0); };

// --- sin, cos, tan -------------------------------------------------------
const PIO4 = 7.85398163397448278999e-01;
const INVPIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;
const TOINT = 6755399441055744; // 1.5 * 2^52: x + TOINT - TOINT rounds to an integer, ties to even

// Argument reduction: x = n pi/2 + (y0 + y1), |y0 + y1| <= about pi/4, by
// Cody and Waite with pi/2 in three parts and their tails (musl
// __rem_pio2, medium case, every refinement taken). Exact for |x| up to
// about 2^20 pi/2; beyond that it loses accuracy but stays deterministic.
let RY0 = 0;
let RY1 = 0;
function remPio2(x) {
  const fn = (x * INVPIO2 + TOINT) - TOINT;
  // pi/2 = PIO2_1 + PIO2_2 + PIO2_3 + PIO2_3T, each product by fn exact.
  let r = x - fn * PIO2_1;
  let t = r;
  let w = fn * PIO2_2;
  r = t - w;
  w = fn * PIO2_2T - ((t - r) - w);
  t = r;
  w = fn * PIO2_3;
  r = t - w;
  w = fn * PIO2_3T - ((t - r) - w);
  RY0 = r - w;
  RY1 = (r - RY0) - w;
  return fn;
}

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
function kSin(x, y, iy) {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
function kCos(x, y) {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const u = 1.0 - hz;
  return u + (((1.0 - u) - hz) + (z * r - x * y));
}

const T = [
  3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02,
  2.18694882948595424599e-02, 8.86323982359930005737e-03, 3.59207910759131235356e-03,
  1.45620945432529025516e-03, 5.88041240820264096874e-04, 2.46463134818469906812e-04,
  7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
  2.59073051863633712884e-05,
];
const PIO4_HI = 7.85398163397448278999e-01, PIO4_LO = 3.06161699786838301793e-17;
function kTan(x0, y0, odd) {
  let x = x0;
  let y = y0;
  const hx = hiWord(x);
  const big = (hx & 0x7fffffff) >= 0x3fe59428; // |x| >= 0.6744
  let sign = false;
  if (big) {
    if (hx < 0) { x = -x; y = -y; sign = true; }
    x = (PIO4_HI - x) + (PIO4_LO - y);
    y = 0.0;
  }
  const z = x * x;
  const w = z * z;
  const r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  const v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  const s = z * x;
  const rr = y + z * (s * (r + v) + y) + s * T[0];
  let u = x + rr;
  if (big) {
    const sg = 1 - 2 * odd;
    const vv = sg - 2.0 * (x + (rr - u * u / (u + sg)));
    return sign ? -vv : vv;
  }
  if (!odd) return u;
  // -1/(x + r), computed carefully: it has up to 2 ulp error otherwise.
  const w0 = lowZeroed(u);
  const vv = rr - (w0 - x);
  const a = -1.0 / u;
  const a0 = lowZeroed(a);
  u = a0 + a * (1.0 + a0 * w0 + a0 * vv);
  return u;
}

export function sin(x) {
  const ax = Math.abs(x);
  if (ax <= PIO4) {
    if (ax < 1.4901161193847656e-8) return x; // 2^-26
    return kSin(x, 0.0, 0);
  }
  if (!(ax < Infinity)) return x - x; // NaN or infinite
  const n = remPio2(x) & 3;
  if (n === 0) return kSin(RY0, RY1, 1);
  if (n === 1) return kCos(RY0, RY1);
  if (n === 2) return -kSin(RY0, RY1, 1);
  return -kCos(RY0, RY1);
}

export function cos(x) {
  const ax = Math.abs(x);
  if (ax <= PIO4) {
    if (ax < 7.450580596923828e-9) return 1.0; // 2^-27
    return kCos(x, 0.0);
  }
  if (!(ax < Infinity)) return x - x;
  const n = remPio2(x) & 3;
  if (n === 0) return kCos(RY0, RY1);
  if (n === 1) return -kSin(RY0, RY1, 1);
  if (n === 2) return -kCos(RY0, RY1);
  return kSin(RY0, RY1, 1);
}

export function tan(x) {
  const ax = Math.abs(x);
  if (ax <= PIO4) {
    if (ax < 7.450580596923828e-9) return x; // 2^-27
    return kTan(x, 0.0, 0);
  }
  if (!(ax < Infinity)) return x - x;
  const n = remPio2(x);
  return kTan(RY0, RY1, n & 1);
}

// --- asin, acos ----------------------------------------------------------
const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17;
const PS0 = 1.66666666666666657415e-01, PS1 = -3.25565818622400915405e-01, PS2 = 2.01212532134862925881e-01;
const PS3 = -4.00555345006794114027e-02, PS4 = 7.91534994289814532176e-04, PS5 = 3.47933107596021167570e-05;
const QS1 = -2.40339491173441421878e+00, QS2 = 2.02094576023350569471e+00, QS3 = -6.88283971605453293030e-01, QS4 = 7.70381505559019352791e-02;
function R(z) {
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  const q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  return p / q;
}

export function acos(x) {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) { // |x| >= 1 or NaN
    if (x === 1) return 0;
    if (x === -1) return 2 * PIO2_HI;
    return NaN;
  }
  if (ix < 0x3fe00000) { // |x| < 0.5
    if (ix <= 0x3c600000) return PIO2_HI; // |x| < 2^-57
    return PIO2_HI - (x - (PIO2_LO - x * R(x * x)));
  }
  if (hx < 0) { // x < -0.5
    const z = (1.0 + x) * 0.5;
    const s = Math.sqrt(z);
    const w = R(z) * s - PIO2_LO;
    return 2 * (PIO2_HI - (s + w));
  }
  const z = (1.0 - x) * 0.5; // x > 0.5
  const s = Math.sqrt(z);
  const df = lowZeroed(s);
  const c = (z - df * df) / (s + df);
  const w = R(z) * s + c;
  return 2 * (df + w);
}

export function asin(x) {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) { // |x| >= 1 or NaN
    if (x === 1 || x === -1) return x * PIO2_HI;
    return NaN;
  }
  if (ix < 0x3fe00000) { // |x| < 0.5
    if (ix < 0x3e500000 && ix >= 0x00100000) return x; // 2^-1022 <= |x| < 2^-26
    return x + x * R(x * x);
  }
  const z = (1 - Math.abs(x)) * 0.5;
  const s = Math.sqrt(z);
  const r = R(z);
  let y;
  if (ix >= 0x3fef3333) { // |x| > 0.975
    y = PIO2_HI - (2 * (s + s * r) - PIO2_LO);
  } else {
    const f = lowZeroed(s);
    const c = (z - f * f) / (s + f);
    y = 0.5 * PIO2_HI - (2 * s * r - (PIO2_LO - 2 * c) - (0.5 * PIO2_HI - 2 * f));
  }
  return hx < 0 ? -y : y;
}

// --- atan, atan2 ---------------------------------------------------------
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02,
];

export function atan(x0) {
  let x = x0;
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  const neg = hx < 0;
  let id;
  if (ix >= 0x44100000) { // |x| >= 2^66 or NaN
    if (x !== x) return x;
    return neg ? -ATANHI[3] : ATANHI[3];
  }
  if (ix < 0x3fdc0000) { // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) { // |x| < 1.1875
      if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); } // 7/16 <= |x| < 11/16
      else { id = 1; x = (x - 1.0) / (x + 1.0); } // 11/16 <= |x| < 19/16
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); } // |x| < 2.4375
    else { id = 3; x = -1.0 / x; } // 2.4375 <= |x| < 2^66
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return neg ? -r : r;
}

const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16;
export function atan2(y, x) {
  if (x !== x || y !== y) return x + y;
  const hx = hiWord(x), lx = loWord(x), hy = hiWord(y), ly = loWord(y);
  if (hx === 0x3ff00000 && lx === 0) return atan(y); // x = 1
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2); // 2 * sign(x) + sign(y)
  const ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  if ((iy | ly) === 0) { // y = 0
    if (m <= 1) return y;
    return m === 2 ? PI : -PI;
  }
  if ((ix | lx) === 0) return m & 1 ? -PI / 2 : PI / 2; // x = 0
  if (ix === 0x7ff00000) { // x infinite
    if (iy === 0x7ff00000) return [PI / 4, -PI / 4, 3 * PI / 4, -3 * PI / 4][m];
    return [0.0, -0.0, PI, -PI][m];
  }
  if (ix + (64 << 20) < iy || iy === 0x7ff00000) return m & 1 ? -PI / 2 : PI / 2; // |y/x| > 2^64
  const z = (m & 2) && iy + (64 << 20) < ix ? 0.0 : atan(Math.abs(y / x)); // |y/x| < 2^-64, x < 0
  if (m === 0) return z;
  if (m === 1) return -z;
  if (m === 2) return PI - (z - PI_LO);
  return (z - PI_LO) - PI;
}

// --- exp, log, pow -------------------------------------------------------
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;

// y * 2^n, exactly (musl scalbn).
function scalbn(x, n0) {
  let y = x;
  let n = n0;
  if (n > 1023) {
    y *= 8.98846567431158e307; n -= 1023; // 2^1023
    if (n > 1023) { y *= 8.98846567431158e307; n -= 1023; if (n > 1023) n = 1023; }
  } else if (n < -1022) {
    y *= 2.2250738585072014e-308 * 9007199254740992; n += 1022 - 53; // 2^-1022 * 2^53
    if (n < -1022) { y *= 2.2250738585072014e-308 * 9007199254740992; n += 1022 - 53; if (n < -1022) n = -1022; }
  }
  return y * fromWords((0x3ff + n) << 20, 0);
}

export function exp(x0) {
  let x = x0;
  const hx0 = hiWord(x);
  const neg = hx0 < 0;
  const hx = hx0 & 0x7fffffff;
  if (hx >= 0x4086232b) { // |x| >= 708.39 or NaN
    if (x !== x) return x;
    if (x > 709.782712893383973096) return Infinity;
    if (x < -745.13321910194110842) return 0;
  }
  let k = 0;
  let hi = 0;
  let lo = 0;
  if (hx > 0x3fd62e42) { // |x| > 0.5 ln2
    if (hx >= 0x3ff0a2b2) k = Math.trunc(INVLN2 * x + (neg ? -0.5 : 0.5)); // |x| >= 1.5 ln2
    else k = neg ? -1 : 1;
    hi = x - k * LN2_HI;
    lo = k * LN2_LO;
    x = hi - lo;
  } else if (hx > 0x3e300000) { // |x| > 2^-28
    hi = x;
  } else {
    return 1 + x;
  }
  const xx = x * x;
  const c = x - xx * (P1 + xx * (P2 + xx * (P3 + xx * (P4 + xx * P5))));
  const y = 1 + (x * c / (2 - c) - lo + hi);
  return k === 0 ? y : scalbn(y, k);
}

const TWO54 = 1.80143985094819840000e+16;
const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;
export function log(x0) {
  let x = x0;
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) { // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54; // subnormal: scale up
    hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = fromWords(hx | (i0 ^ 0x3ff00000), loWord(x)); // normalise x or x/2
  k += i0 >> 20;
  const f = x - 1.0;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) { // -2^-20 <= f < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const Rr = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - Rr;
    return dk * LN2_HI - ((Rr - dk * LN2_LO) - f);
  }
  const s = f / (2.0 + f);
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const Rr = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + Rr));
    return dk * LN2_HI - ((hfsq - (s * (hfsq + Rr) + dk * LN2_LO)) - f);
  }
  if (k === 0) return f - s * (f - Rr);
  return dk * LN2_HI - ((s * (f - Rr) - dk * LN2_LO) - f);
}

// x^y for the rig's uses (x >= 0 in practice). Integer powers are repeated
// squaring; the rest are exp(y log x), a few ulp from the true value.
export function pow(x, y) {
  if (y === 0) return 1;
  if (x !== x || y !== y) return NaN;
  if (x === 1) return 1;
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let n = Math.abs(y);
    let b = x;
    let r = 1;
    while (n > 0) { if (n & 1) r *= b; b *= b; n = Math.floor(n / 2); }
    return y < 0 ? 1 / r : r;
  }
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN; // a non-integer power of a negative number
  if (x === Infinity) return y > 0 ? Infinity : 0;
  return exp(y * log(x));
}

// Square root of the sum of squares. Plain, not scaled: the rig's lengths
// are nowhere near overflow or underflow.
export function hypot(a, b, c = 0, d = 0) {
  if (arguments.length > 4) throw new Error('dmath.hypot takes at most four values');
  return Math.sqrt(a * a + b * b + c * c + d * d);
}

// This engine's fingerprint of the functions above: fixed inputs, the bits
// of every result hashed (two FNV-1a passes over each double's 8 bytes). A
// recorded plan table carries the one it was built under and is replayed
// only where the engine computes the same one: an engine that got any of
// these differently would replay answers that are not its own.
// The signature every conforming engine computes (hands:check and the unit
// tests hold this machine to it; CI holds x64 and arm64 Linux to it).
export const SIGNATURE_EXPECTED = '045fd281eb106';
let SIGNATURE = null;
export function signature() {
  if (SIGNATURE) return SIGNATURE;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const put = (x) => {
    view.setFloat64(0, x);
    for (let i = 0; i < 8; i++) {
      const c = view.getUint8(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
  };
  for (let i = 0; i < 256; i++) {
    const x = -5 + i * 0.0390625; // exactly representable steps over [-5, 5)
    put(sin(x)); put(cos(x)); put(tan(x * 0.3)); put(asin(x / 5.01)); put(acos(x / 5.01));
    put(atan(x)); put(atan2(x, 1.7 - x * 0.3)); put(exp(x)); put(log(Math.abs(x) + 0.001));
    put(pow(Math.abs(x) + 0.1, x * 0.7)); put(hypot(x, 0.3, x * 0.5)); put(Math.sqrt(Math.abs(x)) / 3 + x * 1.1);
  }
  SIGNATURE = a.toString(16).padStart(8, '0') + (b >>> 12).toString(16).padStart(5, '0');
  return SIGNATURE;
}
