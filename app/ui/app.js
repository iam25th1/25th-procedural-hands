// The interactive sandbox. One injected Clock, advanced from
// requestAnimationFrame wall time, steps the current scene in fixed STEP
// increments; pause, single step and speed act on that clock only. Every
// user action is a data object that goes through act(), so the recorder can
// replay it frame for frame from a fresh scene with the same seed.
//
// Vestibular safety: the camera moves only from the user's own input (a
// drag in Move camera mode, a pinch or the wheel, a scene, camera or action
// choice, Recentre). Nothing animates it.
import * as THREE from '/vendor/three.module.js';
import { animate, set } from '/vendor/anime.esm.js';
import { createView } from '/render/view.js';
import { Clock } from '/hands/src/clock.js';
import { createController, SCENE_LABELS } from './controllers.js';
import { createRecorder } from './recorder.js';
import { attachInput } from './input.js';
import { createPanels, TABS } from './panels.js';
import { cameraSettings, dragOrbit, dragLook, lookDirection } from './camera-map.js';
import { load, save } from './store.js';
import { el, button, segmented, toggle } from './dom.js';

const SPEEDS = [[0.1, '0.1x'], [0.25, '0.25x'], [1, '1x']];
const aspectBucket = (a) => (a < 0.8 ? 0 : a < 1.3 ? 1 : 2);
// The screen's shape, which only turning the device changes.
const screenAspect = () => window.innerWidth / Math.max(1, window.innerHeight);

export function startApp({ canvas, shot }) {
  const seed = Number.isFinite(shot.seed) ? shot.seed : 1;
  const view = createView(canvas);
  view.resize(true);
  const clock = new Clock({ seed, rate: 1 });
  const recorder = createRecorder();
  const prefersReduced = globalThis.matchMedia ? globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  const state = {
    scene: ['hands', 'sandbox'].includes(shot.scene) ? shot.scene : 'sandbox',
    hand: 'both', cam: 'inspect', moveCamera: false, reduced: prefersReduced || shot.reduced,
    speed: 1, paused: false, perf: false, tab: 'actions', open: false,
  };
  // The control centre starts collapsed; after that it remembers.
  const savedControls = load('controls', null);
  if (savedControls && typeof savedControls === 'object') {
    state.open = Boolean(savedControls.open);
    if (TABS.some(([k]) => k === savedControls.tab)) state.tab = savedControls.tab;
  }
  const status = document.getElementById('status');
  const header = document.querySelector('.topbar');
  let ctl = null;
  let orbit = null;
  let eye = null;
  let framedDist = 1; // the orbit distance the last framing chose, for zoom
  let look = { yaw: 0, pitch: 0 };
  // Camera drag settings: direct mapping unless the user inverts an axis.
  let camSettings = cameraSettings(load('camera', {}));
  let bucket = aspectBucket(screenAspect());
  let flash = null; // { text, kind, until } a short note in the status line
  let lastResult = null;

  document.documentElement.classList.toggle('reduced', state.reduced);

  // Scene ------------------------------------------------------------------
  function build(kind, reduced) {
    if (ctl) { view.root.remove(ctl.group); ctl.dispose(); }
    ctl = createController(kind, { seed, reducedMotion: reduced });
    view.root.add(ctl.group);
    view.setBackdrop(kind === 'hands' ? 'plain' : 'yard');
  }

  function setScene(kind) {
    if (recorder.recording) { recorder.discard(); note('Recording dropped: the scene changed'); }
    if (recorder.replaying) recorder.cancelReplay();
    state.scene = kind;
    build(kind, state.reduced);
    sceneSeg.set(kind);
    panels.rebuild(kind);
    frameCamera();
    syncTransport();
  }

  // Actions ----------------------------------------------------------------
  function applyAction(a) {
    const r = ctl.dispatch(a);
    if (a.type === 'reduced') setReducedUi(Boolean(a.value));
    if (r && r.reframe) frameCamera();
  }

  function act(action) {
    if (recorder.replaying) { note('Replaying: wait for it to finish'); return; }
    const a = { hand: state.hand, ...action };
    recorder.log(clock.frame, a);
    try {
      applyAction(a);
    } catch (e) {
      note(String(e.message || e), 'alert');
      console.warn(e);
    }
  }

  function playRow(row) {
    if (row.scene !== state.scene) setScene(row.scene);
    act(row.action);
  }

  // Clock ------------------------------------------------------------------
  let solverMs = 0;
  clock.onStep((dt, t, c) => {
    const s = performance.now();
    recorder.beforeStep(c.frame - 1, applyAction);
    ctl.step();
    recorder.afterStep(c.frame, applyAction, () => ctl.hands.hash());
    solverMs += performance.now() - s;
  });
  const applyRate = () => { clock.rate = state.paused ? 0 : state.speed; };

  function setPaused(p) {
    state.paused = p;
    applyRate();
    syncTransport();
  }

  // Record and replay ------------------------------------------------------
  function toggleRecord() {
    if (recorder.replaying) return;
    if (recorder.recording) {
      const rec = recorder.stop(clock.frame, ctl.hands.hash());
      lastResult = null;
      panels.showRecording(rec, null);
      note(`Recorded ${rec.events.length} actions over ${rec.endFrame} frames`, 'good');
    } else {
      // A recording starts from a fresh scene at frame 0 so replay can too.
      build(state.scene, state.reduced);
      clock.reset(seed);
      recorder.start({ scene: state.scene, seed, reduced: state.reduced });
      panels.rebuild(state.scene);
      frameCamera();
    }
    syncTransport();
  }

  function startReplay() {
    const rec = recorder.last;
    if (!rec || recorder.recording || recorder.replaying) return;
    if (rec.scene !== state.scene) { state.scene = rec.scene; sceneSeg.set(rec.scene); panels.rebuild(rec.scene); }
    build(rec.scene, rec.reduced);
    setReducedUi(rec.reduced);
    clock.reset(rec.seed);
    frameCamera();
    recorder.beginReplay((result) => {
      lastResult = result;
      panels.showRecording(result.rec, result);
      note(result.match ? 'Replay matched the recording' : 'Replay differs from the recording', result.match ? 'good' : 'alert');
      syncTransport();
    });
    if (state.paused) setPaused(false);
    if (rec.endFrame === 0) recorder.afterStep(0, applyAction, () => ctl.hands.hash());
    syncTransport();
  }

  // Camera -----------------------------------------------------------------
  function frameCamera() {
    const f = ctl.frame(state.cam === 'fp' ? 'fp' : 'inspect', view.camera.aspect);
    if (f.eye) { eye = f; look = { yaw: 0, pitch: 0 }; } else { orbit = { ...f, target: f.target.slice() }; framedDist = f.dist; }
    if (state.cam === 'fp' && !f.eye) eye = null;
    applyCamera();
  }
  // The control centre and the bar sit beside the view, never over it; only
  // the top bar overlays its top edge. The projection centre is moved down
  // into the band below the top bar so what the camera frames is the part
  // you can see.
  function applyViewOffset() {
    const { width, height } = view.size;
    const c = canvas.getBoundingClientRect();
    const top = Math.max(0, Math.min(height - 40, header.getBoundingClientRect().bottom - c.top));
    const shift = Math.round(height / 2 - (top + height) / 2);
    if (shift !== 0) view.camera.setViewOffset(width, height, 0, shift, width, height);
    else view.camera.clearViewOffset();
    view.camera.updateProjectionMatrix();
  }
  function applyCamera() {
    if (state.cam === 'fp' && eye) {
      view.setEye(eye.eye, lookDirection(eye.dir, look));
    } else if (orbit) {
      view.setOrbit(orbit);
    }
  }

  // Dragging the hand target on a plane facing the camera through the wrist.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const hit = new THREE.Vector3();
  let drag = null;
  function rayAt(p) {
    ndc.set((p.x / p.w) * 2 - 1, -(p.y / p.h) * 2 + 1);
    raycaster.setFromCamera(ndc, view.camera);
    return raycaster.ray.intersectPlane(plane, hit);
  }
  function pickSide(p) {
    if (state.hand !== 'both') return state.hand;
    let best = 'right';
    let bestD = Infinity;
    for (const side of ['left', 'right']) {
      const w = new THREE.Vector3(...ctl.hands.joint(side, 'wrist').pos).project(view.camera);
      const d = Math.hypot((w.x + 1) / 2 * p.w - p.x, (1 - w.y) / 2 * p.h - p.y);
      if (d < bestD) { bestD = d; best = side; }
    }
    return best;
  }
  attachInput(canvas, {
    cameraMode: () => state.moveCamera,
    dragStart(p) {
      if (recorder.replaying) return false;
      const side = pickSide(p);
      const t = ctl.hands.target(side);
      const normal = view.camera.getWorldDirection(new THREE.Vector3());
      plane.setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...t.pos));
      if (!rayAt(p)) return false;
      drag = { side, offset: [t.pos[0] - hit.x, t.pos[1] - hit.y, t.pos[2] - hit.z] };
      return true;
    },
    dragMove(p) {
      if (!drag || !rayAt(p)) return;
      act({ type: 'target', hand: drag.side, pos: [hit.x + drag.offset[0], hit.y + drag.offset[1], hit.z + drag.offset[2]].map((v) => Math.round(v * 1e5) / 1e5) });
    },
    dragEnd() { drag = null; },
    orbit(dx, dy) {
      if (state.cam === 'fp') look = dragLook(look, dx, dy, camSettings);
      else if (orbit) orbit = dragOrbit(orbit, dx, dy, camSettings);
      applyCamera();
    },
    zoom(k) {
      if (state.cam === 'fp' || !orbit) return;
      orbit.dist = Math.max(0.12, Math.min(6, orbit.dist * k));
      applyCamera();
    },
  });

  // Status line ------------------------------------------------------------
  function note(text, kind = '') { flash = { text, kind, until: performance.now() + 3500 }; }
  let shown = '';
  function refreshStatus(now) {
    let text;
    let kind = '';
    if (flash && now < flash.until) { text = flash.text; kind = flash.kind; } else {
      flash = null;
      text = `${SCENE_LABELS[state.scene]}: ${ctl.status}`;
      if (recorder.replaying) { const p = recorder.progress; text = `Replaying ${p.frame} of ${p.of}`; } else if (recorder.recording) text += ', recording';
      if (state.paused) text += ', paused';
    }
    const key = `${kind}|${text}`;
    if (key === shown) return;
    shown = key;
    status.textContent = text;
    status.classList.toggle('alert', kind === 'alert');
    status.classList.toggle('good', kind === 'good');
  }

  // Chrome -----------------------------------------------------------------
  const sceneSeg = segmented([['hands', 'Hands'], ['sandbox', 'Sandbox']], state.scene, (k) => setScene(k), { label: 'Scene', className: 'scenes ui' });
  const cam = el('div', 'cam ui');
  // Pressing the camera already in use frames it again (recentre).
  const camSeg = segmented([['inspect', 'Inspect'], ['fp', 'First person']], state.cam, (k) => { state.cam = k; frameCamera(); }, { label: 'Camera' });
  for (const b of camSeg.buttons.values()) b.title = 'Press again to recentre';
  const moveCam = toggle('Move camera', state.moveCamera, (v) => { state.moveCamera = v; note(v ? 'Drag moves the camera' : 'Drag moves the hand'); });
  moveCam.el.title = 'When on, dragging the view moves the camera the way you drag; when off, it moves the selected hand';
  cam.append(camSeg.el, moveCam.el);
  const perf = el('dl', 'perf ui');
  perf.hidden = true;
  const perfCells = {};
  for (const [k, label] of [['fps', 'fps'], ['frame', 'frame ms'], ['solver', 'solver ms'], ['tris', 'triangles'], ['calls', 'draw calls']]) {
    perf.append(el('dt', '', label));
    perfCells[k] = el('dd', '', '0');
    perf.append(perfCells[k]);
  }
  header.append(sceneSeg.el, cam, perf);

  // The control bar: always there, one compact row at the bottom of the
  // view. It opens the control centre and carries the time controls.
  const bar = el('div', 'bar ui');
  bar.setAttribute('aria-label', 'Control bar');
  const ccBtn = button('', 'cc-toggle', () => setOpen(!state.open));
  ccBtn.append(el('span', 'cc-label', 'Controls'), el('kbd', 'key', 'C'));
  ccBtn.setAttribute('aria-controls', 'control-centre');
  ccBtn.title = 'Show or hide the control centre (keyboard: C)';
  const transport = el('div', 'transport');
  transport.setAttribute('aria-label', 'Time controls');
  const pauseBtn = button('Pause', '', () => setPaused(!state.paused));
  pauseBtn.title = 'Pause or play (keyboard: Space)';
  const stepBtn = button('Step', '', () => { if (!state.paused) setPaused(true); clock.step(); });
  stepBtn.title = 'One fixed step of 1/60 s';
  const speedSeg = segmented(SPEEDS.map(([v, l]) => [String(v), l]), String(state.speed), (v) => { state.speed = Number(v); applyRate(); }, { label: 'Speed', className: 'speed' });
  transport.append(pauseBtn, stepBtn, speedSeg.el);
  bar.append(ccBtn, transport);

  // The control centre: docked beside the view (landscape and desktop) or
  // above the bar (portrait). The view shrinks to make room, so the panel
  // never lies over the hands or the station, in any camera.
  const centre = el('section', 'centre ui');
  centre.id = 'control-centre';
  centre.setAttribute('aria-label', 'Control centre');
  const centreHead = el('div', 'centre-head');
  const closeBtn = button('Close', '', () => setOpen(false));
  closeBtn.title = 'Hide the control centre (keyboard: C or Escape)';
  centreHead.append(el('h2', 'centre-title', 'Control centre'), closeBtn);
  const tabs = el('nav', 'tabs');
  tabs.setAttribute('aria-label', 'Panels');
  const tabBtns = new Map();
  for (const [key, label] of TABS) {
    const b = button(label, '', () => showTab(key));
    b.setAttribute('aria-controls', 'drawer');
    tabBtns.set(key, b);
    tabs.append(b);
  }
  const drawer = el('div', 'drawer');
  drawer.id = 'drawer';
  centre.append(centreHead, tabs, drawer);
  document.body.append(centre, bar);

  // Sequence record and replay live in the Capture tab.
  const recBtn = button('Rec', 'rec', toggleRecord);
  const replayBtn = button('Replay', '', startReplay);

  const panels = createPanels({
    act, playRow, goScene: setScene,
    hands: () => (ctl ? ctl.hands : null),
    hand: () => state.hand,
    setHand: (h) => { state.hand = h; },
    reduced: () => state.reduced,
    setReduced: (v) => act({ type: 'reduced', value: v }),
    setPerf: (v) => { state.perf = v; perf.hidden = !v; },
    recentre: frameCamera,
    camera: () => camSettings,
    setCamera: (patch) => { camSettings = cameraSettings({ ...camSettings, ...patch }); save('camera', camSettings); },
    seed: () => seed,
  }, drawer);
  panels.setSequenceControls(recBtn, replayBtn);

  function syncTabs() {
    for (const [key, b] of tabBtns) {
      const on = key === state.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  function syncTransport() {
    setText(pauseBtn, state.paused ? 'Play' : 'Pause');
    pauseBtn.classList.toggle('on', state.paused);
    setText(recBtn, recorder.recording ? 'Stop' : 'Rec');
    recBtn.classList.toggle('on', recorder.recording);
    recBtn.disabled = recorder.replaying;
    replayBtn.disabled = !recorder.last || recorder.recording || recorder.replaying;
    replayBtn.classList.toggle('on', recorder.replaying);
  }
  function setReducedUi(v) {
    state.reduced = v;
    document.documentElement.classList.toggle('reduced', v);
    panels.setReduced(v);
  }

  // Control centre open and close, and tab changes: anime.js v4 animate(),
  // instant under reduced motion. Opening docks the centre first (the view
  // makes room at once, so nothing is ever drawn under it), then slides it
  // in; closing slides it out, then gives the room back.
  let centreAnim = null;
  const wide = () => window.matchMedia('(orientation: landscape), (min-width: 900px)').matches;
  function persist() { save('controls', { open: state.open, tab: state.tab }); }
  function setOpen(open, instant = false) {
    state.open = open;
    persist();
    ccBtn.classList.toggle('on', open);
    ccBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (centreAnim) { centreAnim.cancel(); centreAnim = null; }
    const axis = wide() ? 'translateX' : 'translateY';
    const other = axis === 'translateX' ? 'translateY' : 'translateX';
    const root = document.documentElement;
    if (open) {
      root.classList.add('cc-open');
      centre.inert = false;
      if (instant || state.reduced) { set(centre, { [axis]: 0, [other]: 0, opacity: 1 }); return; }
      centreAnim = animate(centre, { [axis]: { from: '100%', to: 0 }, [other]: 0, opacity: { from: 0, to: 1 }, duration: 260, ease: 'outCubic', onComplete: () => { centreAnim = null; } });
      return;
    }
    const done = () => { centreAnim = null; if (!state.open) { root.classList.remove('cc-open'); centre.inert = true; } };
    if (instant || state.reduced) { set(centre, { [axis]: '100%', [other]: 0, opacity: 0 }); done(); return; }
    centreAnim = animate(centre, { [axis]: { to: '100%' }, opacity: { to: 0 }, duration: 200, ease: 'inCubic', onComplete: done });
  }
  let tabAnim = null;
  function showTab(key, { instant = false, open = true } = {}) {
    state.tab = key;
    persist();
    panels.show(key);
    syncTabs();
    if (open && !state.open) setOpen(true);
    if (tabAnim) { tabAnim.cancel(); tabAnim = null; }
    const pane = panels.panels[key];
    if (instant || state.reduced) { set(pane, { opacity: 1, translateY: 0 }); return; }
    tabAnim = animate(pane, { opacity: { from: 0, to: 1 }, translateY: { from: 10, to: 0 }, duration: 180, ease: 'outCubic', onComplete: () => { tabAnim = null; } });
  }

  // Keyboard: C (or Escape to close) for the control centre, Space for pause.
  // Ignored while typing in a field.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || (t.tagName === 'INPUT' && t.type !== 'range') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setOpen(!state.open); } else if (e.key === 'Escape' && state.open) { e.preventDefault(); setOpen(false); } else if (e.key === ' ' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); setPaused(!state.paused); }
  });

  // Frame loop -------------------------------------------------------------
  const perfState = { frames: 0, acc: 0, fps: 0, lastShow: 0 };
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    if (view.resize()) {
      // A turn of the phone reframes for the new shape, keeping the user's angle and zoom.
      const b = aspectBucket(screenAspect());
      if (b !== bucket && orbit) {
        const keep = { yaw: orbit.yaw, pitch: orbit.pitch, zoom: orbit.dist / framedDist };
        frameCamera();
        if (orbit) Object.assign(orbit, { yaw: keep.yaw, pitch: keep.pitch, dist: framedDist * keep.zoom });
      }
      bucket = b;
      applyViewOffset();
      applyCamera();
      if (!centreAnim) setOpen(state.open, true);
    }
    const t0 = performance.now();
    solverMs = 0;
    let info = { calls: 0, triangles: 0 };
    try {
      clock.advance(dt);
      ctl.sync();
      info = view.render();
    } catch (e) {
      setPaused(true);
      note(`Stopped: ${e.message || e}`, 'alert');
      console.warn(e);
    }
    const frameMs = performance.now() - t0;
    perfState.frames += 1;
    perfState.acc += dt;
    if (state.perf && now - perfState.lastShow > 250) {
      perfState.fps = perfState.acc > 0 ? perfState.frames / perfState.acc : 0;
      perfState.frames = 0;
      perfState.acc = 0;
      perfState.lastShow = now;
      perfCells.fps.textContent = perfState.fps.toFixed(0);
      perfCells.frame.textContent = frameMs.toFixed(1);
      perfCells.solver.textContent = solverMs.toFixed(1);
      perfCells.tris.textContent = info.triangles.toLocaleString('en-GB');
      perfCells.calls.textContent = String(info.calls);
    }
    refreshStatus(now);
    syncTransport();
  }

  // Start ------------------------------------------------------------------
  build(state.scene, state.reduced);
  panels.rebuild(state.scene);
  showTab(state.tab, { instant: true, open: false });
  setOpen(state.open, true);
  view.resize(true);
  frameCamera();
  syncTransport();
  applyViewOffset();
  // For the headless checks: read-only handles, never used by the UI itself.
  window.__handsApp = {
    get scene() { return state.scene; },
    get frame() { return clock.frame; },
    hash: () => ctl.hands.hash(),
    get recording() { return recorder.recording; },
    get replaying() { return recorder.replaying; },
    get result() { return lastResult; },
    // The camera's position and its own right and up vectors, world space.
    camera() {
      const e = view.camera.matrixWorld.elements;
      return { pos: view.camera.position.toArray(), right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], fov: view.camera.fov };
    },
    // Both wrists and middle fingertips projected to CSS pixels on the page.
    handsOnScreen() {
      const c = canvas.getBoundingClientRect();
      const out = [];
      for (const side of ['left', 'right']) {
        for (const j of ['wrist', 'middle-finger-tip']) {
          const v = new THREE.Vector3(...ctl.hands.joint(side, j).pos).project(view.camera);
          out.push({ side, joint: j, x: c.left + (v.x + 1) / 2 * c.width, y: c.top + (1 - v.y) / 2 * c.height, inFront: v.z < 1 });
        }
      }
      return out;
    },
    // Where the control centre and the 3D view sit on screen, in CSS pixels.
    layout() {
      const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return { canvas: box(canvas), centre: box(centre), bar: box(bar), topbar: box(header), open: state.open, tab: state.tab, viewport: { w: window.innerWidth, h: window.innerHeight } };
    },
  };
  requestAnimationFrame((t) => { last = t; frame(t); });
}
