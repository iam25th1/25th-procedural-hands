// One injected clock drives the rig, the lab and the checks. Time only moves
// through step(), in fixed 60 Hz steps, and randomness comes from the clock's
// seeded generator, so a given (seed, time) always produces the same state
// whether it runs in Node, in the browser or in shot mode for a screenshot.
import { mulberry32 } from './rng.js';

export const STEP_HZ = 60;
export const STEP = 1 / STEP_HZ;
// Playback rates the lab offers. 0 is pause; single steps go through step().
export const RATES = [0, 0.1, 0.25, 1];
const MAX_WALL_DT = 0.25;

export class Clock {
  constructor({ seed = 1, rate = 1 } = {}) {
    this.seed = seed >>> 0;
    this.rate = rate;
    this.listeners = [];
    this.reset();
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.frame = 0;
    this.time = 0;
    this.acc = 0;
    return this;
  }

  onStep(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  // Advance by wall-clock seconds scaled by the playback rate. Long stalls
  // (tab hidden) are clamped so the sim never spirals trying to catch up.
  // canStep(frame), when given, is asked before each step whether the step
  // to `frame` may run now; at the first no, the rest of the wall time is
  // dropped: sim time waits (a plan still being worked out, a frame budget
  // spent) instead of rushing to catch up afterwards.
  advance(wallDt, canStep = null) {
    if (!(wallDt > 0) || this.rate <= 0) return 0;
    this.acc += Math.min(wallDt, MAX_WALL_DT) * this.rate;
    let steps = 0;
    while (this.acc >= STEP - 1e-9) {
      if (canStep && !canStep(this.frame + 1)) { this.acc = 0; break; }
      this.acc -= STEP;
      this.step();
      steps++;
    }
    return steps;
  }

  // Drop wall time that has built up but not yet been stepped (after a
  // deliberate pause of the page, such as a scene being rebuilt): the sim
  // carries on from where it is instead of rushing through the backlog.
  // The frame count and so the timeline are unchanged.
  discardBacklog() {
    this.acc = 0;
    return this;
  }

  step() {
    this.frame += 1;
    this.time = this.frame * STEP;
    for (const fn of this.listeners) fn(STEP, this.time, this);
  }

  // Run fixed steps until time >= t (shot mode).
  stepTo(t) {
    while (this.time + STEP <= t + 1e-9) this.step();
    return this.time;
  }

  random() {
    return this.rng();
  }
}
