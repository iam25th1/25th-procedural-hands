// Shot mode: render exactly one frame from URL parameters (scene, capability
// or pose, time, camera, settings) and report it on window.__handsShot. The
// gallery and the budget check drive this; every frame is a pure function of
// its parameters, so it renders identically every time.
import { createView } from '/render/view.js';
import { createWorldView } from '/render/world-view.js';
import { createThreeView } from '/hands/src/three-view.js';
import { startScenario } from '/scenes/runner.js';
import { SCENARIOS } from '/scenes/capabilities.js';
import { cameraFor } from '/scenes/cameras.js';
import { createHandsScene } from '/scenes/hands-scene.js';
import { SKIN_TONES, SLEEVE_COLOURS } from '/hands/src/defaults.js';
import { skinTone } from '/hands/src/skin.js';

export function renderShot(canvas, shot) {
  const view = createView(canvas, { preserveDrawingBuffer: true });
  const look = { lod: shot.lod, skinTone: shot.palmMatch ? { ...skinTone(SKIN_TONES[shot.skin % SKIN_TONES.length]), palmMatchesDorsal: true } : SKIN_TONES[shot.skin % SKIN_TONES.length], sleeveColour: SLEEVE_COLOURS[shot.sleeve % SLEEVE_COLOURS.length] };
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
