// Recorded plans. A scripted scenario run from the same seed is the same run
// every time, to the last bit on any engine (the rig's elementary functions
// are hands/src/dmath.js, the same bits everywhere), so the costly solves it
// makes (where the hand grips, how it pre-shapes, which way it comes in)
// give the same answers every time. A
// recorder keeps them, in call order, with a fingerprint of each call's
// inputs; a player hands them back to a later run of the same scenario, so
// that run skips the solves and still ends in the same state to the last bit.
// The player answers only while each call matches the recorded one (kind and
// fingerprint); at the first difference, or once the run is disturbed by
// anything not in the script, it stops and every later solve runs live.
// Plain data and functions: used by the sandbox, the table builder
// (scripts/hands-plans.js) and the checks alike.
import { signature } from '../../hands/src/dmath.js';

// A call's fingerprint is kept as a 52-bit hash (two FNV-1a passes) of its
// inputs written out in full. String(n) of a number is exact (ECMA-262
// Number::toString gives the shortest string that reads back to the same
// double), so equal fingerprints mean equal inputs, to the last bit. It is a
// guard against a run that has left the script, not the key to the answer:
// a call whose inputs differ at all is a miss, and it and every solve after
// it run live. Inputs used to be rounded to 1e-7 first, so that an engine
// rounding a sine differently could still use the table; that let a
// recorded answer stand in for this engine's own (x64 replayed an arm64
// grasp; docs/dev-notes/HANDS_X64_REPLAY.md). The rig's elementary
// functions are now the same bits on every engine (hands/src/dmath.js), and
// a table is used only where the engine reproduces the functions it was
// built with (usablePlanTable below).
export function fingerprintHash(fp) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < fp.length; i++) {
    const c = fp.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + (b >>> 12).toString(16).padStart(5, '0'));
}

// The whole state of a run (every joint's transform and every body, prop
// and rope in its world) hashed over the exact bits of each value, for
// comparing a replay with a live run bit for bit. (hands.hash() rounds to
// 1e-6 first: it is for spotting a changed run, not an equal one.)
const bitsView = new DataView(new ArrayBuffer(8));
export function exactStateHash(hands) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const put = (x) => {
    bitsView.setFloat64(0, x);
    for (let i = 0; i < 8; i++) {
      const c = bitsView.getUint8(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
  };
  for (const v of hands.rig.skel.transformValues()) put(v);
  if (hands.world) for (const v of hands.world.stateValues()) put(v);
  return a.toString(16).padStart(8, '0') + (b >>> 12).toString(16).padStart(5, '0');
}

// Whether this engine may replay a recorded table: only if it computes the
// rig's elementary functions to the same bits as the engine that built it.
// Otherwise every solve runs live, and the reason says why.
export function usablePlanTable(table) {
  if (!table || !table.runs) return { ok: false, reason: 'no plan table' };
  if (table.math !== signature()) return { ok: false, reason: `this engine computes the rig's math as ${signature()}, the table was built under ${table.math || 'an unrecorded one'}: every plan is solved live` };
  return { ok: true, reason: '' };
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
