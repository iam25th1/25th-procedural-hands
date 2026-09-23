// Scene controllers for the interactive sandbox. Each owns one scene (Hands
// or Sandbox): its hands instance, the three.js objects that draw
// it, and a dispatch(action) that applies a plain data action. Actions are
// data so the recorder can log them and replay them on a fresh controller
// with the same seed, stamped with the clock frame they landed on.
//
// step() advances exactly one fixed STEP; the app's single Clock calls it.
// Nothing here reads wall time or Math.random, so a replay is exact.
import * as THREE from '/vendor/three.module.js';
import { STEP, GRIPS, DIGITS } from '/hands/src/index.js';
import { createThreeView } from '/hands/src/three-view.js';
import { SKIN_TONES, SLEEVE_COLOURS } from '/hands/src/defaults.js';
import { createWorldView } from '/render/world-view.js';
import { createSandbox, startScenario } from '/scenes/runner.js';
import { SCENARIOS } from '/scenes/capabilities.js';
import { STATIONS } from '/scenes/sandbox-world.js';
import { createHandsScene, GRIP_OBJECTS } from '/scenes/hands-scene.js';
import { cameraFor } from '/scenes/cameras.js';
import { humanize } from './dom.js';

const LOOK = { lod: 'high', skinTone: SKIN_TONES[0], sleeveColour: SLEEVE_COLOURS[0] };
const sidesOf = (hand) => (hand === 'both' ? ['left', 'right'] : [hand]);
const secs = (t) => Math.round(t / STEP);

const OBJECT_NAMES = {
  powerCylinder: 'Handle', spherical: 'Ball', tipPinch: 'Bead', padPinch: 'Pebble', tripod: 'Marble',
  lateral: 'Card', hook: 'Strap', press: 'Block',
};
export const objectLabel = (key) => (key.startsWith('preset:') ? `${humanize(key)} preset` : OBJECT_NAMES[key] || humanize(key));

export const SCENE_LABELS = { hands: 'Hands', sandbox: 'Sandbox' };

// Timed sequences a single press plays, as [seconds, action] pairs. They run
// on the controller's own step count, so they replay exactly.
const SET_PRESETS = [['middle'], ['index', 'little'], ['thumb', 'little'], ['index', 'middle'], ['thumb', 'index'], []];
export const SEQUENCES = {
  countIndex: { label: 'Count 1 to 5, index first', keys: [1, 2, 3, 4, 5].map((n, i) => [i * 0.8, { type: 'count', n, style: 'index' }]) },
  countThumb: { label: 'Count 1 to 5, thumb first', keys: [1, 2, 3, 4, 5].map((n, i) => [i * 0.8, { type: 'count', n, style: 'thumb' }]) },
  fingerSets: { label: 'Finger sets in turn', keys: SET_PRESETS.map((digits, i) => [i * 0.9, { type: 'set', digits }]) },
  curlEach: {
    label: 'Curl each digit in turn',
    keys: [
      [0, { type: 'stopGesture' }],
      ...DIGITS.flatMap((finger, i) => [[0.1 + i * 0.6, { type: 'curl', finger, value: 1 }], [0.4 + i * 0.6, { type: 'curl', finger, value: 0 }]]),
      [0.2 + DIGITS.length * 0.6, { type: 'releaseFingers' }],
    ],
  },
};

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) m.dispose();
  });
}

function scaled(base, size) {
  const out = { ...base };
  for (const k of ['r', 'h', 'hx', 'hy', 'hz', 'round']) if (typeof out[k] === 'number') out[k] = +(out[k] * size).toFixed(5);
  return out;
}

const NO_SHOT = { cam: null, focus: null, hand: 'both', yaw: null, pitch: null, dist: null, zoom: 1 };

// Finger and target actions every scene shares. Returns true when handled.
function applyFingers(hands, a) {
  const hand = a.hand || 'both';
  switch (a.type) {
    case 'joint':
      hands.setFingerJoint(hand, a.finger, a.joint, a.value);
      return true;
    case 'spread':
      for (const side of sidesOf(hand)) {
        // Taking a digit over starts from its current curl so it never jumps.
        const ctl = hands.rig.hands[side].control[a.finger];
        hands.setFinger(side, a.finger, ctl ? undefined : hands.currentCurl(side, a.finger), a.value);
      }
      return true;
    case 'curl':
      hands.setFinger(hand, a.finger, a.value);
      return true;
    case 'opposition':
      hands.setThumbOpposition(hand, a.value);
      return true;
    case 'releaseFingers':
      hands.releaseFingers(hand);
      return true;
    case 'stopGesture':
      hands.stopGesture(hand);
      return true;
    case 'target':
      for (const side of sidesOf(hand)) {
        const cur = hands.target(side);
        hands.setTarget(side, { pos: a.pos.slice(), rot: cur.rot, pole: cur.pole });
      }
      return true;
    case 'reduced':
      hands.rig.reduced = Boolean(a.value);
      return true;
    default:
      return false;
  }
}

// Shared step scheduling: queued sequence keys fire on this step count.
function scheduler() {
  let n = 0;
  let queue = [];
  return {
    get n() { return n; },
    clear() { queue = []; },
    play(seq, hand) {
      queue = seq.keys.map(([t, a]) => ({ at: n + secs(t), a: { hand, ...a } }));
      queue.sort((p, q) => p.at - q.at);
    },
    run(apply) {
      while (queue.length && queue[0].at <= n) apply(queue.shift().a);
    },
    tick() { n += 1; },
    get busy() { return queue.length > 0; },
  };
}

function handsController({ seed, reducedMotion }) {
  const scene = createHandsScene({ seed, reducedMotion });
  const hands = scene.hands;
  scene.setPresent('raised', true);
  hands.rig.snapAll();
  const view = createThreeView(hands, LOOK);
  const group = new THREE.Group();
  group.add(view.group, scene.group);
  const sched = scheduler();
  let playing = 'Hands raised';

  function apply(a) {
    if (applyFingers(hands, a)) return;
    const hand = a.hand || 'both';
    switch (a.type) {
      case 'present': scene.setPresent(a.kind, false); playing = `Hands ${a.kind === 'rest' ? 'at rest' : a.kind === 'offer' ? 'offered' : 'raised'}`; break;
      case 'gesture': scene.setPresent('raised', false); hands.gesture(a.name, { hand }); playing = humanize(a.name); break;
      case 'count': scene.setPresent('raised', false); hands.count(hand, a.n, a.style); playing = `Count ${a.n}, ${a.style} first`; break;
      case 'set': scene.setPresent('raised', false); hands.showFingers(hand, a.digits); playing = a.digits.length ? `Showing ${a.digits.join(' and ')}` : 'Closed hand'; break;
      case 'grasp': {
        const base = GRIP_OBJECTS[a.object] || GRIP_OBJECTS.spherical;
        const grip = a.grip && a.grip !== 'auto' ? a.grip : (Object.hasOwn(GRIPS, a.object) ? a.object : null);
        hands.stopGesture(hand);
        for (const side of sidesOf(hand)) hands.release(side);
        scene.setPresent('offer', false);
        for (const side of sidesOf(hand)) hands.grasp(side, scaled(base, a.size || 1), grip);
        playing = `${objectLabel(a.object)} in ${grip ? `a ${humanize(grip).toLowerCase()}` : 'its own'} grip`;
        break;
      }
      case 'release': hands.release(hand); playing = 'Released'; break;
      default: throw new Error(`the Hands scene has no action ${a.type}`);
    }
  }

  return {
    kind: 'hands',
    group,
    get hands() { return hands; },
    get status() { return sched.busy ? `${playing}, playing` : playing; },
    dispatch(a) {
      if (a.type === 'sequence') {
        const seq = SEQUENCES[a.id];
        sched.play(seq, a.hand || 'both');
        playing = seq.label;
        return { reframe: false };
      }
      if (!['joint', 'spread', 'opposition', 'target', 'reduced'].includes(a.type)) sched.clear();
      apply(a);
      return { reframe: false };
    },
    step() { sched.run(apply); hands.step(); sched.tick(); },
    sync() { view.update(); scene.update(); },
    frame(mode, aspect) {
      const cam = cameraFor({ scene: 'hands', hands, shot: { ...NO_SHOT, cam: mode === 'fp' ? 'fp' : 'front' }, aspect });
      if (cam.eye) return { eye: cam.eye, dir: cam.dir };
      // A portrait phone sees the hands in the band above the drawer: stand
      // back far enough that both hands and a waving arm stay in it.
      return { ...cam, dist: cam.dist * (aspect < 0.8 ? 1.45 : 1.1) };
    },
    dispose() { view.dispose(); disposeTree(scene.group); hands.dispose(); },
  };
}

function sandboxController({ seed, reducedMotion }) {
  let reduced = reducedMotion;
  let sb = createSandbox({ seed, station: 'ledge', reducedMotion: reduced });
  let player = null;
  let worldView = null;
  let handsView = null;
  const group = new THREE.Group();
  const sched = scheduler();

  function mount() {
    worldView = createWorldView(sb.world, { seed });
    handsView = createThreeView(sb.hands, LOOK);
    group.add(worldView.group, handsView.group);
  }
  function unmount() {
    group.remove(worldView.group, handsView.group);
    handsView.dispose();
    disposeTree(worldView.group);
    sb.hands.dispose();
  }
  mount();

  function apply(a) {
    if (applyFingers(sb.hands, a)) { if (a.type === 'reduced') reduced = Boolean(a.value); return false; }
    switch (a.type) {
      case 'scenario':
        unmount();
        player = startScenario(a.id, { seed, reducedMotion: reduced });
        sb = player.sb;
        mount();
        return true;
      case 'station':
        unmount();
        player = null;
        sb = createSandbox({ seed, station: a.station, reducedMotion: reduced });
        mount();
        return true;
      default: throw new Error(`the Sandbox scene has no action ${a.type}`);
    }
  }

  return {
    kind: 'sandbox',
    group,
    get hands() { return sb.hands; },
    get station() { return sb.station; },
    get status() {
      if (player) return `${player.sc.label}${player.done ? ', done' : ''}`;
      return STATIONS[sb.station].label;
    },
    dispatch(a) {
      if (a.type === 'sequence') {
        sched.play(SEQUENCES[a.id], a.hand || 'both');
        return { reframe: false };
      }
      return { reframe: apply(a) };
    },
    step() {
      sched.run(apply);
      if (player && !player.done) player.step();
      else sb.hands.step();
      sched.tick();
    },
    sync() { worldView.update(); handsView.update(); },
    frame(mode, aspect) {
      if (mode === 'fp') {
        // The eye sits at the body anchor, looking ahead and down at the hands.
        const b = sb.hands.rig.body;
        return { eye: [b[0], b[1], b[2]], dir: [0, -0.62, -1] };
      }
      return cameraFor({ scene: 'sandbox', scenario: player ? player.sc : null, sb, shot: NO_SHOT, aspect });
    },
    dispose() { unmount(); },
  };
}

export function createController(kind, opts) {
  if (kind === 'hands') return handsController(opts);
  return sandboxController(opts);
}

export { SCENARIOS, STATIONS, GRIP_OBJECTS, GRIPS };
