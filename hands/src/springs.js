// Critically damped springs. Every animated channel in the rig moves through
// one of these rather than a linear lerp: the target can change every frame
// and the value follows with no overshoot and a natural settle.
//
//   x'' = -w^2 (x - target) - 2 w x'
//
// The step uses the exact closed form solution over dt, so it is stable for
// any step and bit for bit repeatable for a given sequence of targets.
export class Spring {
  constructor(omega, x = 0, maxRate = Infinity) {
    this.w = omega;
    this.x = x;
    this.v = 0;
    this.target = x;
    this.maxRate = maxRate; // optional cap on |velocity| so big jumps stay continuous
  }

  snap(x) {
    this.x = x;
    this.v = 0;
    this.target = x;
    return this;
  }

  step(dt) {
    const w = this.w;
    const A = this.x - this.target;
    const B = this.v + w * A;
    const e = Math.exp(-w * dt);
    let x = this.target + (A + B * dt) * e;
    let v = (B - w * (A + B * dt)) * e;
    // Neither the speed at the end of the step nor the distance covered in
    // it may pass the cap (a stiff spring covers ground fast and ends slow).
    if (Math.abs(v) > this.maxRate || Math.abs(x - this.x) > this.maxRate * dt) {
      // Move at the capped rate toward where the spring wanted to go.
      const dir = Math.sign(x - this.x) || Math.sign(v);
      x = this.x + dir * Math.min(Math.abs(x - this.x), this.maxRate * dt);
      v = dir * Math.min(Math.abs(v), this.maxRate);
    }
    this.x = x;
    this.v = v;
    return this.x;
  }

  // Time for the response to settle within 2 percent of a unit step: about 5.8 / w.
  static settleTime(omega) {
    return 5.8 / omega;
  }
}

// A group of named springs stepping together.
export class SpringSet {
  constructor() {
    this.map = new Map();
  }
  get(name, omega, initial = 0) {
    let s = this.map.get(name);
    if (!s) {
      s = new Spring(omega, initial);
      this.map.set(name, s);
    }
    return s;
  }
  step(dt) {
    for (const s of this.map.values()) s.step(dt);
  }
}

// Under damped second order oscillator for things that should ring and
// settle (the slingshot bands after release): damping ratio zeta below one.
export class Oscillator {
  constructor(omega, zeta, x = 0) {
    this.w = omega;
    this.z = zeta;
    this.x = x;
    this.v = 0;
    this.target = x;
  }
  snap(x) { this.x = x; this.v = 0; this.target = x; return this; }
  kick(v) { this.v += v; return this; }
  step(dt) {
    // Semi implicit Euler with sub steps keeps it stable and deterministic.
    const n = Math.max(1, Math.ceil(this.w * dt / 0.25));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.w * this.w * (this.x - this.target) - 2 * this.z * this.w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  // Envelope amplitude relative to a unit displacement after t seconds.
  static envelope(omega, zeta, t) {
    return Math.exp(-zeta * omega * t);
  }
}
