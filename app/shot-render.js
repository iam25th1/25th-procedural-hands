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
import { create } from '/hands/src/index.js';

export function renderShot(canvas, shot) {
  const view = createView(canvas, { preserveDrawingBuffer: true });
  const measureFlag = shot.palmKey ? { palmKey: true } : shot.palmMatch ? { palmMatchesDorsal: true } : null;
  const look = { lod: shot.lod, skinTone: measureFlag ? { ...skinTone(SKIN_TONES[shot.skin % SKIN_TONES.length]), ...measureFlag } : SKIN_TONES[shot.skin % SKIN_TONES.length], sleeveColour: SLEEVE_COLOURS[shot.sleeve % SLEEVE_COLOURS.length] };
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

  // One right arm on a plain backdrop, straight forward from the shoulder,
  // the hand in a named pose and the forearm turned to shot.pron degrees
  // (0 thumb up, 90 palm down): for inspecting the rest pose, the skinning
  // and the forearm's twist from fixed views (cam palm, back, side for the
  // radial side, ulnar; focus 'forearm' frames the forearm instead).
  if (shot.scene === 'arm') {
    const hands = create({ seed: shot.seed });
    if (shot.pose) hands.setPose('right', shot.pose, { snap: true });
    const skel = hands.skeleton;
    const deg = Math.PI / 180;
    // Pronation shared over the joints that carry the bind pronation, in
    // the parts they carry it.
    const chain = skel.sides.right.joints.filter((jt) => jt.twistOffset);
    const bindPron = chain.reduce((acc, jt) => acc + jt.twistOffset, 0);
    for (const jt of chain) skel.setChannels(jt, 0, 0, (shot.pron * deg) * (jt.twistOffset / bindPron));
    // The wrist straight: no flexion or deviation (and no pronation of its own).
    const wj = skel.joint('right', 'wrist');
    if (!chain.includes(wj)) skel.setChannels(wj, 0, 0, 0);
    for (const n of ['upper-arm', 'forearm']) { const j = skel.joint('right', n); j.localRot = [0, 0, 0, 1]; j.channels.flex = 0; }
    skel.update();
    view.setBackdrop('plain');
    const arms = createThreeView(hands, look);
    arms.arms.left.group.visible = false;
    view.root.add(arms.group);
    arms.update();
    view.resize(true);
    const j = (n) => skel.joint('right', n);
    const onForearm = shot.focus === 'left'; // focus=left is reused as "frame the forearm"
    const target = onForearm ? j('forearm').worldPos.map((v, i) => (v + j('wrist').worldPos[i]) / 2) : j('wrist').worldPos.map((v, i) => (v * 0.35 + j('middle-finger-phalanx-proximal').worldPos[i] * 0.65));
    // Views in the bind frame (arm along -Z, palm down at pron 90), fixed
    // whatever the forearm's turn so before and after compare like for like.
    const dirs = { palm: [0, -1, -0.2], back: [0, 1, -0.2], side: [-1, 0.1, -0.05], ulnar: [1, 0.1, -0.05], three: [-0.6, 0.55, -0.3] };
    const d = dirs[shot.cam] || dirs.back;
    const L = Math.hypot(d[0], d[1], d[2]);
    const yaw = Math.atan2(d[0], d[2]);
    const pitch = Math.asin(d[1] / L);
    view.setOrbit({ target, yaw: shot.yaw ?? yaw, pitch: shot.pitch ?? pitch, dist: (shot.dist ?? (onForearm ? 0.5 : 0.22)) / shot.zoom });
    return { info: view.render(), advance: () => view.render() };
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
