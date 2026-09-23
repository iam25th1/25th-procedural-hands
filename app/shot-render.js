// Shot mode: render exactly one frame from URL parameters (scene, capability
// or pose, time, camera, settings) and report it on window.__handsShot. The
// gallery and the budget check drive this; every frame is a pure function of
// its parameters, so it renders identically every time.
import { createView } from '/render/view.js';
import { createWorldView } from '/render/world-view.js';
import { createSlingshotView } from '/render/slingshot-view.js';
import { createThreeView } from '/hands/src/three-view.js';
import { startScenario } from '/scenes/runner.js';
import { SCENARIOS } from '/scenes/capabilities.js';
import { cameraFor } from '/scenes/cameras.js';
import { createHandsScene } from '/scenes/hands-scene.js';
import { createSlingshotScene, ACTION_NAMES } from '/scenes/slingshot-scene.js';
import { SKIN_TONES, SLEEVE_COLOURS } from '/hands/src/defaults.js';

export function renderShot(canvas, shot) {
  const view = createView(canvas, { preserveDrawingBuffer: true });
  const look = { lod: shot.lod, skinTone: SKIN_TONES[shot.skin % SKIN_TONES.length], sleeveColour: SLEEVE_COLOURS[shot.sleeve % SLEEVE_COLOURS.length] };
  const applyCamera = (cam) => { if (cam.eye) view.setEye(cam.eye, cam.dir); else view.setOrbit(cam); };

  if (shot.scene === 'hands') {
    const scene = createHandsScene({ seed: shot.seed, reducedMotion: shot.reduced });
    view.setBackdrop('plain');
    const hands = createThreeView(scene.hands, look);
    view.root.add(hands.group, scene.group);
    scene.apply(shot);
    scene.stepTo(shot.t);
    hands.update();
    scene.update();
    view.resize(true);
    applyCamera(cameraFor({ scene: 'hands', hands: scene.hands, shot, aspect: view.camera.aspect }));
    const draw = () => { hands.update(); scene.update(); return view.render(); };
    return { info: draw(), advance: (t) => { scene.stepTo(t); return draw(); } };
  }

  if (shot.scene === 'slingshot') {
    const name = ACTION_NAMES.includes(shot.action) ? shot.action : 'draw';
    const scene = createSlingshotScene({ seed: shot.seed, reducedMotion: shot.reduced });
    scene.play(name);
    scene.stepTo(shot.t);
    view.setBackdrop('yard');
    const hands = createThreeView(scene.hands, look);
    const tool = createSlingshotView(scene.hands, { lod: shot.lod });
    view.root.add(hands.group, tool.group);
    hands.update();
    tool.update();
    view.resize(true);
    const place = () => { if (shot.cam === 'orbit' || shot.yaw != null) {
      // Inspection: orbit round the middle of the two hands.
      // Inspection from behind and to the right of the shooter, fixed for an
      // action: both hands, the fork and the bands in frame.
      applyCamera({ target: [0.0, -0.14, -0.3], yaw: shot.yaw ?? 1.35, pitch: shot.pitch ?? 0.45, dist: (shot.dist ?? 0.62) / shot.zoom * (view.camera.aspect < 0.8 ? 1.5 : 1) });
    } else {
      // First person: just behind the player's eye, looking down the aim, so
      // the drawn pouch at the cheek stays in front of the near plane.
      applyCamera({ eye: [0.03, 0.03, 0.16], dir: [0, -0.18, -1] });
    } };
    place();
    const draw = () => { hands.update(); tool.update(); return view.render(); };
    return { info: draw(), advance: (t) => { scene.stepTo(t); place(); return draw(); } };
  }

  const id = shot.cap && SCENARIOS[shot.cap] ? shot.cap : 'grabCarryPlace';
  const player = startScenario(id, { seed: shot.seed, reducedMotion: shot.reduced });
  view.setBackdrop('yard');
  const worldView = createWorldView(player.sb.world, { seed: shot.seed });
  const hands = createThreeView(player.sb.hands, look);
  view.root.add(worldView.group, hands.group);
  player.stepTo(shot.t);
  worldView.update();
  hands.update();
  view.resize(true);
  const place = () => applyCamera(cameraFor({ scene: 'sandbox', scenario: { id, ...SCENARIOS[id] }, sb: player.sb, shot, aspect: view.camera.aspect }));
  place();
  const draw = () => { worldView.update(); hands.update(); return view.render(); };
  // A later time in the same run: step on from where it is (times only go
  // forward), so a strip of frames plays the scenario once.
  return { info: draw(), advance: (t) => { player.stepTo(t); if (shot.focus) place(); return draw(); } };
}
