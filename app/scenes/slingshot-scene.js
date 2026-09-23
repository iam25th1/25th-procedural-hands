// The Slingshot scene without a DOM or a renderer: a hands instance holding
// the slingshot, and a way to play any slingshot action and step to a time in
// it. The app's shot mode and the gallery draw what this produces; the
// checks and tests drive the same scenarios, so all of them see one motion.
import { create, STEP } from '../../hands/src/index.js';
import { attachSlingshot, slingshotArmTargets } from './slingshot/actions.js';
import { prepare, start, ACTION_DURATIONS, ACTION_KEYFRAMES } from './slingshot/scenarios.js';

export const ACTION_NAMES = Object.keys(ACTION_DURATIONS);
export { ACTION_DURATIONS, ACTION_KEYFRAMES };

export function createSlingshotScene({ seed = 1, reducedMotion = false } = {}) {
  let hands = null;
  let t0 = 0;

  // Each play starts from a fresh rig, as every check does, so a shot of an
  // action at a time is the same whichever action was played before it.
  function build() {
    if (hands) hands.dispose();
    hands = create({ seed, reducedMotion, targets: slingshotArmTargets('right') });
    attachSlingshot(hands.rig, { handedness: 'right' });
    t0 = hands.rig.time;
  }
  build();

  return {
    get hands() { return hands; },
    get rig() { return hands.rig; },
    get slingshot() { return hands.rig.slingshot; },
    get actions() { return hands.rig.actions; },
    names: ACTION_NAMES,
    durations: ACTION_DURATIONS,
    keyframes: ACTION_KEYFRAMES,
    // Put the rig in the action's starting state and start it, exactly as
    // the scenarios do; time since play is zero afterwards.
    play(name) {
      if (!Object.hasOwn(ACTION_DURATIONS, name)) throw new Error(`unknown slingshot action ${name}; actions are ${ACTION_NAMES.join(', ')}`);
      build();
      prepare(hands.rig, name);
      t0 = hands.rig.time;
      start(hands.rig, name);
      return this;
    },
    // Step in fixed 60 Hz steps until t seconds have passed since play. Time
    // only runs forward: a t already passed is a no-op.
    stepTo(t) {
      const n = Math.round((t - (hands.rig.time - t0)) / STEP);
      for (let i = 0; i < n; i++) hands.step();
      return hands.rig.time - t0;
    },
    get time() { return hands.rig.time - t0; },
    dispose() { if (hands) hands.dispose(); hands = null; },
  };
}
