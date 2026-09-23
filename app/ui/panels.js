// The control centre's six panels: Actions (the palette for the current
// scene), Matrix (every capability as a row that plays it), Joints
// (per-joint sliders for all ten digits), Objects (grasp a chosen object at
// a chosen size and grip), Capture (record and replay a sequence of
// actions) and Settings. Panels only call back into the app; they
// never touch the rig themselves, so every change goes through the
// recorder.
import { el, button, segmented, toggle, humanize, clear } from './dom.js';
import { paletteFor, matrixRows, GRIP_LIST, OBJECT_LIST, objectLabel, gripLabel } from './catalog.js';
import { DIGITS, MONK_TONES } from '/hands/src/index.js';
import { SENSITIVITY } from './camera-map.js';

const DIGIT_NAMES = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Little' };
const JOINTS = {
  thumb: [['cmc', 'Base'], ['mcp', 'Knuckle'], ['ip', 'End joint']],
  finger: [['mcp', 'Knuckle'], ['pip', 'Middle joint'], ['dip', 'End joint']],
};
export const TABS = [['actions', 'Actions'], ['matrix', 'Matrix'], ['joints', 'Joints'], ['objects', 'Objects'], ['capture', 'Capture'], ['settings', 'Settings']];

function group(title, note = '') {
  const g = el('section', 'group');
  g.append(el('h2', 'group-title', title));
  if (note) g.append(el('p', 'group-note', note));
  const chips = el('div', 'chips');
  g.append(chips);
  return { g, chips };
}

function sliderRow(label, { min, max, step, value }, onInput) {
  const row = el('label', 'slider-row');
  const input = el('input', 'slider');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el('output', '', Number(value).toFixed(2));
  input.addEventListener('input', () => { out.textContent = Number(input.value).toFixed(2); onInput(Number(input.value)); });
  row.append(el('span', 'label', label), input, out);
  return { row, input, set(v) { input.value = String(v); out.textContent = Number(v).toFixed(2); } };
}

// app: { act(action), playRow(row), goScene(kind), hands(), scene(),
//        hand(), setHand(h), setReduced(v), setPerf(v), recentre(),
//        camera(), setCamera(patch), skin(), setSkin(id) }
export function createPanels(app, drawer) {
  const panels = {};
  const handRow = el('div', 'hand-row');
  const handSeg = segmented([['left', 'Left'], ['right', 'Right'], ['both', 'Both']], app.hand(), (h) => { app.setHand(h); joints.refresh(); }, { label: 'Hand' });
  handRow.append(el('span', 'label', 'Hand'), handSeg.el);
  // Skin tone, beside the hand picker: the ten Monk Skin Tone Scale tones.
  const skinSeg = segmented(MONK_TONES.map((t) => [t.id, '']), app.skin(), (id) => app.setSkin(id), { label: 'Skin tone', className: 'tones' });
  for (const t of MONK_TONES) {
    const b = skinSeg.buttons.get(t.id);
    b.classList.add('tone', `tone-${t.monk}`);
    b.setAttribute('aria-label', t.label);
    b.title = `${t.label} on the Monk Skin Tone Scale`;
  }
  const skinRow = el('div', 'skin-row');
  skinRow.append(el('span', 'label', 'Skin'), skinSeg.el);
  drawer.append(handRow, skinRow);
  for (const [key, label] of TABS) {
    const p = el('section', 'panel');
    p.setAttribute('aria-label', label);
    p.hidden = true;
    panels[key] = p;
    drawer.append(p);
  }

  // Actions -----------------------------------------------------------------
  let active = null; // the last pressed action button, highlighted
  function mark(b) { if (active) active.classList.remove('on'); active = b; if (b) b.classList.add('on'); }
  function buildActions(scene) {
    clear(panels.actions);
    mark(null);
    for (const grp of paletteFor(scene)) {
      const { g, chips } = group(grp.title);
      if (grp.sets) {
        // Build any set of extended digits, then show it.
        const on = new Set(['index']);
        for (const d of DIGITS) {
          const t = toggle(DIGIT_NAMES[d], on.has(d), (v) => { if (v) on.add(d); else on.delete(d); });
          chips.append(t.el);
        }
        const show = button('Show set', 'primary', () => app.act({ type: 'set', digits: DIGITS.filter((d) => on.has(d)) }));
        chips.append(show);
      }
      for (const item of grp.items) {
        const b = button(item.label, '', () => { mark(b); app.act(item.action); });
        if (item.hint) b.title = item.hint;
        chips.append(b);
      }
      panels.actions.append(g);
    }
  }

  // Matrix ------------------------------------------------------------------
  function buildMatrix() {
    const list = el('div', 'matrix');
    for (const row of matrixRows()) {
      const b = button('', 'row', () => { for (const x of list.children) x.classList.remove('on'); b.classList.add('on'); app.playRow(row); });
      b.append(el('span', 'row-group', row.group), el('span', 'row-label', row.label));
      b.setAttribute('aria-label', `${row.group}: ${row.label}`);
      list.append(b);
    }
    panels.matrix.append(el('p', 'note', 'Every capability the module has. Press a row to play it in its scene.'), list);
  }
  buildMatrix();

  // Joints ------------------------------------------------------------------
  // Slider values remembered per hand; a digit not yet touched shows the
  // curl it has right now.
  const values = { left: {}, right: {} };
  const rows = [];
  const joints = {
    build() {
      const wrap = el('div', 'digits');
      for (const d of DIGITS) {
        const card = el('section', 'digit');
        card.append(el('h3', 'digit-title', DIGIT_NAMES[d]));
        for (const [joint, label] of JOINTS[d === 'thumb' ? 'thumb' : 'finger']) {
          const key = `${d}:${joint}`;
          const s = sliderRow(label, { min: 0, max: 1, step: 0.01, value: 0 }, (v) => { remember(key, v); app.act({ type: 'joint', finger: d, joint, value: v }); });
          rows.push({ key, s, digit: d, kind: 'curl' });
          card.append(s.row);
        }
        const spreadKey = `${d}:spread`;
        const sp = sliderRow('Spread', { min: d === 'thumb' ? 0 : -1, max: 1, step: 0.01, value: 0 }, (v) => { remember(spreadKey, v); app.act({ type: 'spread', finger: d, value: v }); });
        rows.push({ key: spreadKey, s: sp, kind: 'zero' });
        card.append(sp.row);
        if (d === 'thumb') {
          const op = sliderRow('Opposition', { min: 0, max: 1, step: 0.01, value: 0 }, (v) => { remember('thumb:opp', v); app.act({ type: 'opposition', value: v }); });
          rows.push({ key: 'thumb:opp', s: op, kind: 'zero' });
          card.append(op.row);
        }
        wrap.append(card);
      }
      const foot = el('div', 'joints-foot');
      foot.append(button('Reset fingers', '', () => { forget(); app.act({ type: 'releaseFingers' }); setTimeout(() => joints.refresh(), 0); }));
      panels.joints.append(el('p', 'note', 'Curl each joint of every digit, spread and thumb opposition. The hand picker chooses which hand.'), wrap, foot);
    },
    refresh() {
      const side = app.hand() === 'left' ? 'left' : 'right';
      const hands = app.hands();
      for (const r of rows) {
        const v = values[side][r.key];
        if (v !== undefined) r.s.set(v);
        else if (r.kind === 'curl' && hands) r.s.set(Math.round(hands.currentCurl(side, r.digit) * 100) / 100);
        else r.s.set(0);
      }
    },
  };
  const sidesNow = () => (app.hand() === 'both' ? ['left', 'right'] : [app.hand()]);
  function remember(key, v) { for (const side of sidesNow()) values[side][key] = v; }
  function forget() { for (const side of sidesNow()) values[side] = {}; }
  joints.build();

  // Objects -----------------------------------------------------------------
  const pick = { object: 'spherical', grip: 'auto', size: 1 };
  function buildObjects(scene) {
    clear(panels.objects);
    if (scene !== 'hands') {
      panels.objects.append(el('p', 'note', 'Objects are picked up in the Hands scene, where the rig is on its own for inspection. In the Sandbox the hands take objects from the ledge through the Actions tab.'));
      panels.objects.append(button('Open the Hands scene', 'primary', () => app.goScene('hands')));
      return;
    }
    const o = group('Object');
    const objSeg = segmented(OBJECT_LIST.map((k) => [k, objectLabel(k)]), pick.object, (k) => { pick.object = k; }, { label: 'Object', className: 'chips' });
    o.chips.replaceWith(objSeg.el);
    const size = sliderRow('Size', { min: 0.5, max: 1.5, step: 0.05, value: pick.size }, (v) => { pick.size = v; });
    o.g.append(size.row);
    const gr = group('Grip', 'Auto uses the grip the object is sized for.');
    const gripSeg = segmented([['auto', 'Auto'], ...GRIP_LIST.map((k) => [k, gripLabel(k)])], pick.grip, (k) => { pick.grip = k; }, { label: 'Grip', className: 'chips' });
    gr.chips.replaceWith(gripSeg.el);
    const go = el('div', 'chips');
    go.append(
      button('Grasp it', 'primary', () => app.act({ type: 'grasp', object: pick.object, grip: pick.grip, size: pick.size })),
      button('Let go', '', () => app.act({ type: 'release' })),
    );
    panels.objects.append(o.g, gr.g, go);
  }

  // Settings ----------------------------------------------------------------
  const settings = {};
  function buildSettings() {
    const wrap = el('div', 'settings');
    const line = (label, hint, control) => {
      const s = el('div', 'setting');
      const text = el('span', 'label', label);
      if (hint) text.append(el('span', 'hint', hint));
      s.append(text, control);
      return s;
    };
    const onOff = (label, on, fn) => {
      const seg = segmented([['off', 'Off'], ['on', 'On']], on ? 'on' : 'off', (k) => fn(k === 'on'), { label });
      return { el: seg.el, set: (v) => seg.set(v ? 'on' : 'off') };
    };
    settings.reduced = onOff('Reduced motion', app.reduced(), (v) => app.setReduced(v));
    settings.perf = onOff('Perf overlay', false, (v) => app.setPerf(v));
    const cam = app.camera();
    settings.invertX = onOff('Invert X', cam.invertX, (v) => app.setCamera({ invertX: v }));
    settings.invertY = onOff('Invert Y', cam.invertY, (v) => app.setCamera({ invertY: v }));
    const sens = sliderRow('Sensitivity', { min: SENSITIVITY.min, max: SENSITIVITY.max, step: SENSITIVITY.step, value: cam.sensitivity }, (v) => app.setCamera({ sensitivity: v }));
    wrap.append(
      line('Reduced motion', 'No interface animation; calmer idle sway and gestures on the rig.', settings.reduced.el),
      line('Perf overlay', 'Frame rate, frame and solver time, triangles and draw calls.', settings.perf.el),
      line('Camera', 'Frame the current station or the hands again.', button('Recentre', '', () => app.recentre())),
      el('h2', 'group-title', 'Move camera'),
      line('Invert X', 'Off: drag right and the camera moves right.', settings.invertX.el),
      line('Invert Y', 'Off: drag up and the camera moves up.', settings.invertY.el),
      sens.row,
    );
    panels.settings.append(wrap);
  }

  // Capture ------------------------------------------------------------------
  const capture = { seqRow: el('div', 'chips'), facts: el('dl', 'facts'), video: group('Video', 'Live records the view as you see it. Offline plays the scene again one 1/60 s step a frame and encodes every frame: 60 fps whatever the display does, nothing dropped. Either way you choose where the file goes.'), videoFacts: el('dl', 'facts') };
  function buildCapture() {
    panels.capture.append(capture.video.g);
    const seq = group('Actions', 'Records what you do, not video: every action with the frame it landed on, replayed from the same seed so it plays out exactly.');
    seq.chips.replaceWith(capture.seqRow);
    seq.g.append(capture.facts);
    panels.capture.append(seq.g);
    showRecording(null, null);
  }
  function fact(dl, k, v, cls = '') {
    dl.append(el('dt', '', k));
    dl.append(el('dd', cls, v));
  }
  function showRecording(rec, result) {
    const dl = capture.facts;
    clear(dl);
    if (!rec) {
      fact(dl, 'Nothing yet', 'Press Record actions, act, press Stop recording actions, then Replay actions.');
      fact(dl, 'Seed', String(app.seed()));
    } else {
      fact(dl, 'Scene', humanize(rec.scene));
      fact(dl, 'Seed', String(rec.seed));
      fact(dl, 'Actions', String(rec.events.length));
      fact(dl, 'Frames', `${rec.endFrame} at 60 per second`);
      fact(dl, 'Hash', String(rec.hash));
      if (result) {
        fact(dl, 'Replay hash', String(result.hash));
        fact(dl, 'Replay', result.match ? 'Matches the recording' : 'Differs from the recording', result.match ? 'match' : 'mismatch');
      }
    }
  }
  buildSettings();
  buildCapture();

  return {
    panels,
    show(tab) { for (const [key] of TABS) panels[key].hidden = key !== tab; handRow.hidden = tab === 'settings' || tab === 'capture'; skinRow.hidden = handRow.hidden; if (tab === 'joints') joints.refresh(); },
    setSequenceControls(...buttons) { capture.seqRow.append(...buttons); },
    setVideoControls({ liveBtn, lengthSeg, renderBtn, liveOk, offlineOk }) {
      const liveRow = el('div', 'chips');
      liveRow.append(liveBtn);
      const offRow = el('div', 'chips');
      offRow.append(lengthSeg, renderBtn);
      capture.video.chips.append(el('span', 'label', 'Live'), liveRow, el('span', 'label', 'Offline'), offRow);
      if (!liveOk) capture.video.g.append(el('p', 'group-note', 'This browser cannot record the view live.'));
      if (!offlineOk) capture.video.g.append(el('p', 'group-note', 'This browser has no WebCodecs video encoder, so offline rendering is not available.'));
      capture.video.g.append(capture.videoFacts);
    },
    // The video being made, or the last one saved.
    showVideo(v) {
      const dl = capture.videoFacts;
      clear(dl);
      if (!v) return;
      if (v.mode) fact(dl, 'Mode', v.mode === 'live' ? 'Live' : 'Offline, 60 fps, every frame');
      if (v.codec) fact(dl, 'Codec', `${v.codec} (${v.mime})`);
      if (v.width) fact(dl, 'Size', `${v.width} x ${v.height}`);
      if (v.bitrate) fact(dl, 'Bitrate', `${(v.bitrate / 1e6).toFixed(1)} Mbit/s`);
      if (v.frames) fact(dl, 'Frames', String(v.frames));
      if (v.seconds) fact(dl, 'Length', `${v.seconds.toFixed(1)} s`);
      if (v.name) fact(dl, 'File', v.name);
      if (v.size) fact(dl, 'File size', `${(v.size / 1048576).toFixed(1)} MB`);
      if (v.state) fact(dl, 'State', v.state);
    },
    rebuild(scene) { buildActions(scene); buildObjects(scene); values.left = {}; values.right = {}; joints.refresh(); },
    setHand(h) { handSeg.set(h); joints.refresh(); },
    setReduced(v) { settings.reduced.set(v); },
    showRecording,
    refreshJoints() { joints.refresh(); },
  };
}
