// Record and replay. A recording is the scene, the seed, the reduced motion
// setting and the list of user actions, each stamped with the clock frame it
// landed on (the number of fixed steps taken since the recording started).
// Replay rebuilds the scene from the same seed and feeds each action back in
// just before the step after its frame, so the final hands.hash() must equal
// the one taken when recording stopped.

export function createRecorder() {
  let rec = null; // the last finished recording
  let live = null; // the recording in progress
  let replay = null; // { rec, i, onDone }

  return {
    get recording() { return Boolean(live); },
    get replaying() { return Boolean(replay); },
    get last() { return rec; },
    get progress() { return replay ? { frame: replay.frame, of: replay.rec.endFrame } : null; },

    start({ scene, seed, reduced }) {
      live = { scene, seed, reduced, events: [], endFrame: 0, hash: null };
    },
    // Log an action at a frame. Repeated drags and slider moves inside one
    // frame collapse to the last value: only that one reaches the rig.
    log(frame, action) {
      if (!live) return;
      const prev = live.events[live.events.length - 1];
      const same = prev && prev.f === frame && prev.a.type === action.type && ['target', 'joint', 'spread', 'opposition'].includes(action.type)
        && prev.a.hand === action.hand && prev.a.finger === action.finger && prev.a.joint === action.joint;
      const entry = { f: frame, a: JSON.parse(JSON.stringify(action)) };
      if (same) live.events[live.events.length - 1] = entry;
      else live.events.push(entry);
    },
    stop(frame, hash) {
      if (!live) return null;
      live.endFrame = frame;
      live.hash = hash;
      rec = live;
      live = null;
      return rec;
    },
    discard() { live = null; },

    beginReplay(onDone) {
      if (!rec) return null;
      replay = { rec, i: 0, frame: 0, onDone };
      return rec;
    },
    cancelReplay() { replay = null; },
    // Before the step that takes the clock from frame f to f + 1.
    beforeStep(f, apply) {
      if (!replay) return;
      const ev = replay.rec.events;
      while (replay.i < ev.length && ev[replay.i].f <= f) apply(ev[replay.i++].a);
    },
    // After a step: finished once the recording's last frame is reached.
    afterStep(frame, apply, hashNow) {
      if (!replay) return;
      replay.frame = frame;
      if (frame < replay.rec.endFrame) return;
      this.beforeStep(frame, apply);
      const done = replay;
      replay = null;
      const hash = hashNow();
      done.onDone({ match: hash === done.rec.hash, hash, expected: done.rec.hash, rec: done.rec });
    },
  };
}
