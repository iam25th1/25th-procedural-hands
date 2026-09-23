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
import { el, button, segmented, toggle } from './dom.js';

const SPEEDS = [[0.1, '0.1x'], [0.25, '0.25x'], [1, '1x']];
const aspectBucket = (a) => (a < 0.8 ? 0 : a < 1.3 ? 1 : 2);

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
    speed: 1, paused: false, perf: false, tab: 'actions', open: true,
  };
  const status = document.getElementById('status');
  const header = document.querySelector('.topbar');
  let ctl = null;
  let orbit = null;
  let eye = null;
  let framedDist = 1; // the orbit distance the last framing chose, for zoom
  const look = { yaw: 0, pitch: 0 };
  let bucket = aspectBucket(view.camera.aspect);
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
    if (f.eye) { eye = f; look.yaw = 0; look.pitch = 0; } else { orbit = { ...f, target: f.target.slice() }; framedDist = f.dist; }
    if (state.cam === 'fp' && !f.eye) eye = null;
    applyCamera();
  }
  // The drawer covers the bottom of the canvas, so the projection centre is
  // shifted up into the band between the top bar and the open drawer. It is
  // fixed by the layout (the open drawer, even while closed), so opening or
  // closing the drawer never moves the picture.
  function applyViewOffset() {
    const { width, height } = view.size;
    const top = header.getBoundingClientRect().bottom;
    const bottom = window.innerHeight - dock.offsetHeight;
    const shift = Math.round(Math.max(0, height / 2 - (top + Math.max(top + 40, bottom)) / 2));
    if (shift > 0) view.camera.setViewOffset(width, height, 0, shift, width, height);
    else view.camera.clearViewOffset();
    view.camera.updateProjectionMatrix();
  }
  function applyCamera() {
    if (state.cam === 'fp' && eye) {
      const [dx, dy, dz] = eye.dir;
      const yaw = Math.atan2(dx, -dz) + look.yaw;
      const pitch = Math.max(-1.4, Math.min(1.4, Math.atan2(dy, Math.hypot(dx, dz)) + look.pitch));
      view.setEye(eye.eye, [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]);
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
      if (state.cam === 'fp') {
        look.yaw -= dx * 0.005;
        look.pitch -= dy * 0.005;
      } else if (orbit) {
        orbit.yaw -= dx * 0.008;
        orbit.pitch = Math.max(-1.4, Math.min(1.4, orbit.pitch + dy * 0.006));
      }
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
  const moveCam = toggle('Move camera', state.moveCamera, (v) => { state.moveCamera = v; note(v ? 'Drag turns the camera' : 'Drag moves the hand'); });
  moveCam.el.title = 'When on, dragging the view turns the camera; when off, it moves the selected hand';
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

  const dock = el('div', 'dock ui');
  const transport = el('div', 'transport');
  transport.setAttribute('aria-label', 'Time controls');
  const pauseBtn = button('Pause', '', () => setPaused(!state.paused));
  const stepBtn = button('Step', '', () => { if (!state.paused) setPaused(true); clock.step(); });
  const speedSeg = segmented(SPEEDS.map(([v, l]) => [String(v), l]), String(state.speed), (v) => { state.speed = Number(v); applyRate(); }, { label: 'Speed' });
  const recBtn = button('Rec', 'rec', toggleRecord);
  const replayBtn = button('Replay', '', startReplay);
  transport.append(pauseBtn, stepBtn, speedSeg.el, recBtn, replayBtn);
  const tabs = el('nav', 'tabs');
  tabs.setAttribute('aria-label', 'Panels');
  const tabBtns = new Map();
  for (const [key, label] of TABS) {
    const b = button(label, '', () => {
      if (state.open && state.tab === key) setDrawer(false);
      else { state.tab = key; panels.show(key); syncTabs(); setDrawer(true); }
    });
    b.setAttribute('aria-controls', 'drawer');
    tabBtns.set(key, b);
    tabs.append(b);
  }
  const drawer = el('div', 'drawer');
  drawer.id = 'drawer';
  dock.append(transport, tabs, drawer);
  document.body.append(dock);

  const panels = createPanels({
    act, playRow, goScene: setScene,
    hands: () => (ctl ? ctl.hands : null),
    hand: () => state.hand,
    setHand: (h) => { state.hand = h; },
    reduced: () => state.reduced,
    setReduced: (v) => act({ type: 'reduced', value: v }),
    setPerf: (v) => { state.perf = v; perf.hidden = !v; },
    recentre: frameCamera,
    seed: () => seed,
  }, drawer);

  function syncTabs() {
    for (const [key, b] of tabBtns) {
      const on = state.open && key === state.tab;
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

  // Drawer open and close: anime.js v4 animate(), instant under reduced motion.
  let drawerAnim = null;
  function closedShift() {
    const safe = Math.max(0, parseFloat(getComputedStyle(drawer).paddingBottom) - 14);
    return Math.max(0, drawer.offsetHeight - safe);
  }
  function setDrawer(open, instant = false) {
    state.open = open;
    syncTabs();
    if (drawerAnim) { drawerAnim.pause(); drawerAnim = null; }
    if (open) drawer.inert = false;
    const to = open ? 0 : closedShift();
    const done = () => { drawerAnim = null; if (!state.open) drawer.inert = true; };
    if (instant || state.reduced) { set(dock, { translateY: to }); done(); return; }
    drawerAnim = animate(dock, { translateY: to, duration: 280, ease: 'outCubic', onComplete: done });
  }

  // Frame loop -------------------------------------------------------------
  const perfState = { frames: 0, acc: 0, fps: 0, lastShow: 0 };
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    if (view.resize()) {
      // A turn of the phone reframes for the new shape, keeping the user's angle and zoom.
      const b = aspectBucket(view.camera.aspect);
      if (b !== bucket && orbit) {
        const keep = { yaw: orbit.yaw, pitch: orbit.pitch, zoom: orbit.dist / framedDist };
        frameCamera();
        if (orbit) Object.assign(orbit, { yaw: keep.yaw, pitch: keep.pitch, dist: framedDist * keep.zoom });
      }
      bucket = b;
      applyViewOffset();
      applyCamera();
      if (!state.open) setDrawer(false, true);
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
  panels.show(state.tab);
  syncTabs();
  frameCamera();
  syncTransport();
  setDrawer(true, true);
  applyViewOffset();
  // For the headless checks: read-only handles, never used by the UI itself.
  window.__handsApp = {
    get scene() { return state.scene; },
    get frame() { return clock.frame; },
    hash: () => ctl.hands.hash(),
    get recording() { return recorder.recording; },
    get replaying() { return recorder.replaying; },
    get result() { return lastResult; },
  };
  requestAnimationFrame((t) => { last = t; frame(t); });
}
