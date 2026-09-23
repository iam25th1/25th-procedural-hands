// Scenario runner: one place that knows how to set up the sandbox for a
// capability and play its script, so the sandbox UI, shot mode, the checks
// and the capability matrix all run exactly the same frames. DOM free.
import { create, STEP, handRotation, v3 } from '../../hands/src/index.js';
import { buildSandbox } from './sandbox-world.js';
import { SCENARIOS, WAIT } from './capabilities.js';

export { STEP };

// Default hands for a player standing at a station.
export function readyTargets(x = 0) {
  const t = {};
  for (const side of ['left', 'right']) {
    const s = side === 'right' ? 1 : -1;
    t[side] = { pos: [x + 0.14 * s, -0.27, -0.33], rot: handRotation([-0.3 * s, 0.1, -0.95], [-0.45 * s, -0.88, 0.1]), pole: [x + 0.55 * s, -0.75, 0.05] };
  }
  return t;
}

// A fresh sandbox with hands standing at a station.
export function createSandbox({ seed = 1, station = 'ledge', reducedMotion = false } = {}) {
  const sb = buildSandbox({ seed });
  const x = sb.stations[station].x;
  const hands = create({ seed, world: sb.world, reducedMotion, targets: readyTargets(x) });
  hands.setBody([x, 0, 0]);
  hands.rig.snapAll();
  return { ...sb, hands, station, x, seed };
}

const MAX_WAIT = 2; // seconds a script may wait in all

// Play a scenario: returns a player with step() and the timeline state.
// planSource: answers costly solves from a recorded run (see plans.js); it
// is attached before the settling steps so the whole run goes through it.
export function startScenario(id, { seed = 1, reducedMotion = false, sandbox = null, planSource = null } = {}) {
  const sc = SCENARIOS[id];
  if (!sc) throw new Error(`unknown scenario ${id}`);
  const sb = sandbox || createSandbox({ seed, station: sc.station, reducedMotion });
  const ctx = makeContext(sb, sc);
  if (planSource) sb.hands.interaction.planSource = planSource;
  // Let the world settle before the first key.
  for (let i = 0; i < 12; i++) sb.hands.step();
  const t0 = sb.hands.time;
  if (sc.setup) sc.setup(ctx);
  const keys = sc.keys.slice().sort((a, b) => a[0] - b[0]);
  let next = 0;
  // A key may answer WAIT (a hand still on its way): it runs again next step
  // and everything after it in the script moves back by that step.
  let delay = 0;
  const player = {
    sb, sc, ctx, t0,
    get t() { return sb.hands.time - t0; },
    get delay() { return delay; },
    get duration() { return sc.duration + delay; },
    done: false,
    step() {
      const t = sb.hands.time - t0;
      while (next < keys.length && keys[next][0] + delay <= t + 1e-9) {
        if (keys[next][1](ctx, t - delay) === WAIT && delay < MAX_WAIT) { delay += STEP; break; }
        next++;
      }
      if (sc.tick) sc.tick(ctx, t - delay);
      sb.hands.step();
      if (sb.hands.time - t0 >= sc.duration + delay - 1e-9) player.done = true;
      return player;
    },
    stepTo(t) { while (player.t + 1e-9 < t) player.step(); return player; },
  };
  return player;
}

export function runScenario(id, { seed = 1, onStart = null, onStep = null, reducedMotion = false, planSource = null } = {}) {
  const p = startScenario(id, { seed, reducedMotion, planSource });
  if (onStart) onStart(p);
  while (!p.done) {
    p.step();
    if (onStep) onStep(p.t, p);
  }
  return p;
}

// The helpers a scenario script uses, in station coordinates (x relative to
// the station, so a script reads the same wherever its station stands).
function makeContext(sb, sc) {
  const { hands, world } = sb;
  const X = sb.x;
  const P = (x, y, z) => [X + x, y, z];
  const mirror = (side, v) => (side === 'right' ? v : [-v[0], v[1], v[2]]);
  const ctx = {
    sb, hands, world, X, P,
    body: (name) => world.body(name),
    prop: (name) => world.prop(name),
    rope: (name) => world.rope(name),
    part: (propName, partName) => { const p = world.prop(propName); return { prop: p, part: p.parts.find((q) => q.name === partName) }; },
    bodyPart: (bodyName, partName) => { const b = world.body(bodyName); return { body: b, part: b.parts.find((q) => q.name === partName) }; },
    // Hand rotation from finger and palm directions, mirrored for the left hand.
    rot: (side, finger, palm) => handRotation(mirror(side, finger), mirror(side, palm)),
    ready: (side) => readyTargets(X)[side],
    target: (side, t) => hands.setTarget(side, t),
    wrist: (side) => hands.joint(side, 'wrist').pos,
    // Move the wrist by an offset from where it is aiming now.
    nudge: (side, d, extra = {}) => { const cur = hands.target(side); hands.moveTo(side, { ...extra, pos: v3.add([0, 0, 0], cur.pos, d) }); },
    state: {},
  };
  void sc;
  return ctx;
}
