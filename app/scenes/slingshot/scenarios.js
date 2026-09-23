// Scenarios: one place that knows how to put the rig into each action's
// starting state and run it, so the app's shot mode and the acceptance
// checks sample exactly the same frames. Everything steps at 60 Hz.
import { STEP } from '../../../hands/src/clock.js';
import { Rig } from '../../../hands/src/rig.js';
import { attachSlingshot, slingshotArmTargets } from './actions.js';

// A rig holding the slingshot, as the snapshot's Rig({ seed, handedness })
// was: the module rig with the first person arm targets and the slingshot
// controller attached.
export function slingshotRig({ seed = 1, handedness = 'right', reduced = false } = {}) {
  const rig = new Rig({ seed, reduced, targets: slingshotArmTargets(handedness) });
  attachSlingshot(rig, { handedness });
  return rig;
}

// Seconds each action needs to complete, for sampling and keyframe lists.
export const ACTION_DURATIONS = {
  idle: 3.0, loadPebble: 2.0, loadRock: 2.0, draw: 1.4, fullDrawHold: 1.5, release: 1.4, cancelDraw: 1.2,
  dryRelease: 1.4, switchAmmo: 2.4, pickup: 2.6, drink: 3.9, jump: 0.8, land: 0.8, crouch: 1.0, dash: 0.8,
  hitFlinch: 0.7, knockout: 1.8,
};

// Sample times per action for the gallery keyframes (seconds since start).
export const ACTION_KEYFRAMES = {
  idle: [0, 1.5, 3.0],
  loadPebble: [0.15, 0.55, 0.9, 1.3, 1.6],
  loadRock: [0.15, 0.55, 0.9, 1.3, 1.6],
  draw: [0.1, 0.3, 0.6, 1.2],
  fullDrawHold: [0.4, 1.2],
  release: [0.0, 0.05, 0.12, 0.3, 0.8, 1.3],
  cancelDraw: [0.2, 0.6, 1.1],
  dryRelease: [0.0, 0.12, 0.4, 0.8, 1.3],
  switchAmmo: [0.2, 0.7, 1.2, 1.9],
  pickup: [0.3, 0.7, 1.0, 1.6, 2.2],
  drink: [0.5, 1.1, 1.8, 2.5, 3.1],
  jump: [0.05, 0.2, 0.5],
  land: [0.03, 0.15, 0.5],
  crouch: [0.3, 0.9],
  dash: [0.05, 0.2, 0.5],
  hitFlinch: [0.05, 0.15, 0.4],
  knockout: [0.03, 0.1, 0.2, 0.6, 1.4],
};

function run(rig, seconds, onStep) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) {
    rig.step(STEP);
    if (onStep) onStep(rig.time);
  }
}

// Put the rig in the state the action starts from, deterministically.
export function prepare(rig, name) {
  const a = rig.actions;
  switch (name) {
    case 'draw':
    case 'fullDrawHold':
    case 'release':
    case 'cancelDraw':
      a.load('pebble');
      run(rig, 2.2);
      break;
    case 'dryRelease':
      run(rig, 0.5);
      break;
    case 'switchAmmo':
      a.load('pebble');
      run(rig, 2.2);
      break;
    default:
      run(rig, 0.5);
  }
  if (name === 'fullDrawHold' || name === 'release' || name === 'cancelDraw' || name === 'dryRelease') {
    a.setDraw(1);
    run(rig, 1.6);
  }
}

// Start the action at rig time zero of the scenario.
export function start(rig, name) {
  const a = rig.actions;
  switch (name) {
    case 'idle': break;
    case 'loadPebble': a.load('pebble'); break;
    case 'loadRock': a.load('rock'); break;
    case 'draw': a.setDraw(1); break;
    case 'fullDrawHold': break; // already held; the tremor grows with time
    case 'release': a.releaseDraw(); break;
    case 'cancelDraw': a.cancelDraw(); break;
    case 'dryRelease': a.releaseDraw(); break;
    case 'switchAmmo': a.switchAmmo(); break;
    case 'pickup': a.pickup(); break;
    case 'drink': a.drink(); break;
    case 'jump': case 'land': case 'crouch': case 'dash': case 'hitFlinch': a.reaction(name); break;
    case 'knockout': a.knockout(); break;
    default: throw new Error(`unknown action ${name}`);
  }
}

// Run a whole scenario, calling onStep(time, rig, phase) every frame after the
// action starts. Returns the rig time at which the action started.
export function runScenario(rig, name, onStep = null, duration = ACTION_DURATIONS[name]) {
  prepare(rig, name);
  const t0 = rig.time;
  start(rig, name);
  if (onStep) onStep(rig.time - t0, rig);
  run(rig, duration, (t) => onStep && onStep(t - t0, rig));
  return t0;
}

export { run };
