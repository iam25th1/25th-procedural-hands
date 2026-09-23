// Recorded plans. A scripted scenario run from the same seed is the same run
// every time (to the last bit under one engine), so the costly solves it makes (where the hand grips, how it
// pre-shapes, which way it comes in) give the same answers every time. A
// recorder keeps them, in call order, with a fingerprint of each call's
// inputs; a player hands them back to a later run of the same scenario, so
// that run skips the solves and still ends in the same state to the last bit.
// The player answers only while each call matches the recorded one (kind and
// fingerprint); at the first difference, or once the run is disturbed by
// anything not in the script, it stops and every later solve runs live.
// Plain data and functions: used by the sandbox, the table builder
// (scripts/hands-plans.js) and the checks alike.

// A call's fingerprint is kept as a 52-bit hash (two FNV-1a passes): it is a
// guard against a run that has left the script, not the key to the answer.
// Numbers in it are first rounded to 1e-7 (0.1 micrometre or microradian).
// Two JavaScript engines can round a sine or a power differently in the last
// bit, so a browser replaying a run recorded under Node sees inputs a few
// units in the last place away from the recorded ones; rounded, they match,
// and the recorded answer (the solve for inputs within 0.1 micrometre) is
// used. Under the engine the table was built with, answers are bit for bit.
const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
export function quantize(fp) {
  return fp.replace(NUMBER, (n) => String(Math.round(Number(n) * 1e7)));
}
export function fingerprintHash(raw) {
  const fp = quantize(raw);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < fp.length; i++) {
    const c = fp.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + (b >>> 12).toString(16).padStart(5, '0'));
}

export function planRecorder() {
  const list = [];
  return {
    list,
    take: () => undefined,
    put: (kind, fp, v) => list.push({ kind, fp: fingerprintHash(fp), v: JSON.parse(JSON.stringify(v)) }),
  };
}

export function planPlayer(list) {
  let i = 0;
  let live = false;
  return {
    get used() { return i; },
    get stopped() { return live; },
    get size() { return list.length; },
    // Where it stopped, if a call did not match: what was asked and expected.
    miss: null,
    // Stop answering: the run has left the script.
    stop() { live = true; },
    take(kind, fp) {
      if (live) return undefined;
      const e = list[i];
      if (!e || e.kind !== kind || e.fp !== fingerprintHash(fp)) { live = true; this.miss = { at: i, kind, expected: e ? e.kind : null, fp }; return undefined; }
      i++;
      // A fresh copy: the caller may keep and change what it gets.
      return JSON.parse(JSON.stringify(e.v));
    },
    put() {},
  };
}

// Key of a run in the table.
export const planKey = (id, reduced) => `${id}${reduced ? ':reduced' : ''}`;
