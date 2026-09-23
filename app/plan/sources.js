// Plan sources for planning off the page's main thread. A plan source answers
// Interaction.cached(kind, fp, compute) (see hands/src/interact.js): take()
// hands back an answer or undefined, put() is told what a live solve found.
//
// The planning worker runs its own copy of the sandbox a few steps ahead of
// the page, on the same seed and the same actions, so it makes the same
// solve calls in the same order. Its tee source answers from the recorded
// plan table where it can, solves the rest itself, and sends every answer on
// in call order. The page's stream source hands those answers back in the
// same order, so the page never solves: it only waits, with sim time
// stopped, until the worker has answered the step it is about to take.
// Plain data and functions: the worker, the page and the Node tests share it.
import { fingerprintHash } from '../scenes/plans.js';

const copy = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

// Worker side. inner: a recorded plan player for a scripted run, or null.
// out: an array that receives [kind, fingerprint hash, answer] per call.
export function teeSource(inner, out) {
  return {
    get used() { return inner ? inner.used : 0; },
    get size() { return inner ? inner.size : 0; },
    get stopped() { return inner ? inner.stopped : true; },
    get miss() { return inner ? inner.miss : null; },
    // The run has left its script: later answers are solved, not recorded.
    stop() { if (inner) inner.stop(); },
    take(kind, fp) {
      const v = inner ? inner.take(kind, fp) : undefined;
      // A copy now: the caller may change the answer before it is sent.
      if (v !== undefined) out.push([kind, fingerprintHash(fp), copy(v)]);
      return v;
    },
    put(kind, fp, v) {
      if (inner) inner.put(kind, fp, v);
      out.push([kind, fingerprintHash(fp), copy(v)]);
    },
  };
}

// Page side: answers in the order the worker sent them. A call that does
// not match the next answer (kind and fingerprint) means the two copies have
// parted; from then on every solve runs here, as it would with no worker,
// and the parting is kept for the checks.
export function streamSource() {
  const queue = [];
  let head = 0;
  let received = 0;
  let live = 0;
  let parted = null;
  return {
    get used() { return head; },
    get size() { return received; },
    get stopped() { return Boolean(parted); },
    get miss() { return parted; },
    // Solves the page ran itself (only after a parting).
    get live() { return live; },
    push(records) {
      for (const r of records) queue.push(r);
      received += records.length;
    },
    stop() {},
    take(kind, fp) {
      if (parted) { live++; return undefined; }
      const e = queue[head];
      if (!e || e[0] !== kind || e[1] !== fingerprintHash(fp)) {
        parted = { at: head, kind, expected: e ? e[0] : null, queued: queue.length - head };
        live++;
        return undefined;
      }
      queue[head] = null; // answered once; let it go
      head++;
      return e[2];
    },
    put() {},
  };
}
