// The page's side of planning off the main thread (see sim-worker.js). The
// worker runs the Sandbox scene's simulation LOOKAHEAD steps ahead of the
// page and answers every costly solve; this keeps it fed with the frames and
// actions it needs, hands its answers to the page's copy through a stream
// source, and says how far the page may step: never past the last frame the
// worker has answered. While the worker is still working, the page keeps
// drawing at full rate with sim time stopped, and says so ("Planning").
//
// An action taken now lands on a frame the worker has not stepped past (the
// furthest one requested of it), at most LOOKAHEAD steps on, so both copies
// apply it at the same point of the timeline. The recorder logs it there too.
import { streamSource } from './sources.js';

export const LOOKAHEAD = 2;

export function createPlanner({ onTable = () => {}, onError = () => {}, onFail = () => {} } = {}) {
  let worker = null;
  try {
    worker = new Worker('/plan/sim-worker.js', { type: 'module', name: 'planning' });
  } catch {
    worker = null; // no module workers here: plans are solved on the page
  }
  let epoch = 0;
  let active = false; // this scene plans in the worker
  let ready = 0; // last frame the worker has stepped and answered
  let issued = 0; // furthest frame asked of the worker
  let acked = 0; // last action the worker has applied
  let seq = 0;
  let stream = null;
  let tableLoaded = false;
  let waiters = [];
  let workerMs = [];
  const settle = () => { const keep = []; for (const w of waiters) { if (ready >= w.frame) w.resolve(); else keep.push(w); } waiters = keep; };

  if (worker) {
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.t === 'table') { tableLoaded = m.loaded; onTable(m.loaded); return; }
      if (m.epoch !== epoch) return;
      if (m.t === 'progress') {
        if (stream && m.records.length) stream.push(m.records);
        ready = m.frame;
        acked = m.acked;
        if (m.ms > 0) { workerMs.push(m.ms); if (workerMs.length > 600) workerMs.shift(); }
        settle();
      } else if (m.t === 'error') onError(m.message);
    };
    // The worker could not load or run: plans are solved on the page from
    // here on (the next scene built plans there), and the page is told.
    worker.onerror = (e) => {
      onError(`planning worker: ${e.message || 'failed'}`);
      worker = null;
      active = false;
      stream = null;
      for (const w of waiters) w.resolve();
      waiters = [];
      onFail();
    };
  }

  return {
    get available() { return Boolean(worker); },
    get active() { return active; },
    get ready() { return ready; },
    get acked() { return acked; },
    get tableLoaded() { return tableLoaded; },
    // The worker's own time per step, most recent last (for the overlay).
    get workerMs() { return workerMs; },
    // A new scene at `frame`. Only the Sandbox scene plans; for any other,
    // the planner stands aside and the page steps freely.
    reset({ kind, seed, reduced, frame }) {
      epoch += 1;
      for (const w of waiters) w.resolve();
      waiters = [];
      active = Boolean(worker) && kind === 'sandbox';
      ready = frame;
      issued = frame;
      acked = 0;
      seq = 0;
      workerMs = [];
      stream = active ? streamSource() : null;
      if (active) worker.postMessage({ t: 'reset', epoch, seed, reduced, frame });
      return active ? { source: () => stream } : null;
    },
    get stream() { return stream; },
    // Ask the worker to have stepped to frame `to`.
    request(to) {
      if (!active || to <= issued) return;
      issued = to;
      worker.postMessage({ t: 'advance', epoch, to });
    },
    // The frame an action taken now lands on.
    stampFor(frame) { return active ? Math.max(frame, issued) : frame; },
    // Send an action to the worker; returns its sequence number.
    act(stamp, a) {
      if (!active) return 0;
      seq += 1;
      worker.postMessage({ t: 'act', epoch, seq, stamp, a });
      return seq;
    },
    // Resolves once the worker has answered frame `frame` (offline render).
    until(frame) {
      if (!active || ready >= frame) return Promise.resolve();
      this.request(frame);
      return new Promise((resolve) => waiters.push({ frame, resolve }));
    },
    stats() {
      if (!stream) return null;
      return { used: stream.used, of: stream.size, stopped: stream.stopped, miss: stream.miss, live: stream.live, ready, issued };
    },
  };
}
