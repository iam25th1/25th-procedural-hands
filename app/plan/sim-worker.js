// The planning worker: a copy of the Sandbox scene's simulation that runs a
// few fixed steps ahead of the page, on the same seed and the same actions at
// the same frames, and answers every costly solve before the page needs it.
// It answers from the recorded plan table where it can and solves the rest
// here, off the page's main thread, then sends each answer on in call order
// (see sources.js). The page steps only as far as the worker has answered.
//
// Messages in (all tagged with the epoch of the scene they belong to):
//   { t: 'reset', epoch, seed, reduced, frame }  a fresh scene at this frame
//   { t: 'act', epoch, seq, stamp, a }           apply action a after step `stamp`
//   { t: 'advance', epoch, to }                  step until frame `to`
// Messages out:
//   { t: 'table', loaded, reason }               the recorded plan table is in use (or not, and why)
//   { t: 'progress', epoch, frame, acked, records, ms }  after each step
//   { t: 'error', epoch, message }
import { createController, setPlanTable, planPlayerFor } from '../ui/controllers.js';
import { teeSource } from './sources.js';

let epoch = -1;
let ctl = null;
let frame = 0;
let acked = 0;
let pending = []; // actions for later frames: { seq, stamp, a }, in order
let out = [];
// The tee sources write here; `out` is replaced after every message sent.
const sink = { push: (r) => out.push(r) };

const post = (m) => self.postMessage(m);

// The recorded plan table, fetched here: only this copy solves.
fetch('/scenes/plans.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((t) => { const use = setPlanTable(t); post({ t: 'table', loaded: use.ok, reason: use.reason }); })
  .catch(() => post({ t: 'table', loaded: false, reason: 'the plan table did not load' }));

function apply(p) {
  try {
    ctl.dispatch(p.a);
  } catch (e) {
    // The page applies the same action and reports it; keep in step with it.
    post({ t: 'error', epoch, message: String((e && e.message) || e) });
  }
  acked = p.seq;
}

function applyDue() {
  while (pending.length && pending[0].stamp <= frame) apply(pending.shift());
}

function flush(ms) {
  post({ t: 'progress', epoch, frame, acked, records: out, ms });
  out = [];
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.t === 'reset') {
    if (ctl) ctl.dispose();
    epoch = m.epoch;
    frame = m.frame;
    acked = 0;
    pending = [];
    out = [];
    ctl = createController('sandbox', {
      seed: m.seed,
      reducedMotion: m.reduced,
      headless: true,
      planning: { source: (id, seed, reduced) => teeSource(id ? planPlayerFor(id, seed, reduced) : null, sink) },
    });
    flush(0);
    return;
  }
  if (m.epoch !== epoch || !ctl) return;
  if (m.t === 'act') {
    pending.push({ seq: m.seq, stamp: m.stamp, a: m.a });
    pending.sort((x, y) => x.stamp - y.stamp || x.seq - y.seq);
    applyDue();
    flush(0);
    return;
  }
  if (m.t === 'advance') {
    while (frame < m.to) {
      const s = performance.now();
      applyDue();
      ctl.step();
      frame += 1;
      flush(performance.now() - s);
    }
    applyDue();
  }
};
