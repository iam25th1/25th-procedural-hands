// A fresh three.js scene using 25th-procedural-hands from outside the
// repository, imported by its package name as any consumer would. The
// library owns the rig and the skinned meshes; this file owns the renderer,
// camera, lights and loop.
import * as THREE from 'three';
import { create, createThreeView, handRotation } from '25th-procedural-hands';

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2126);
scene.add(new THREE.HemisphereLight(0xf2efe8, 0x3a3f45, 1.6));
const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
key.position.set(0.6, 1.2, 0.8);
scene.add(key);

// The hands: a deterministic rig stepped at a fixed 60 Hz, and a view of it
// (one skinned mesh per arm) added to our scene. Both hands are raised in
// front of the eye, palms toward it, fingers up (positions in metres from
// the eye; handRotation takes the finger direction and the palm direction).
const raised = (s) => ({ pos: [0.12 * s, -0.16, -0.36], rot: handRotation([-0.08 * s, 1, -0.15], [0.05 * s, 0.1, 1]), pole: [0.55 * s, -0.7, 0.1] });
const hands = create({ seed: 1, targets: { left: raised(-1), right: raised(1) } });
const view = createThreeView(hands, { skinTone: 'monk-6' });
scene.add(view.group);

// Something to do: the right hand counts one to five over and over, the
// left hand waves.
hands.gesture('wave', { hand: 'left' });
let count = 0;
function nextCount() {
  count = (count % 5) + 1;
  hands.count('right', count);
}
nextCount();
setInterval(nextCount, 900);

// A fixed camera at the eye, looking at the hands. It never moves on its own.
const camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
camera.position.set(0, -0.05, 0.12);
camera.lookAt(0, -0.14, -0.36);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h;
  renderer.setSize(w, h, false);
  camera.aspect = aspect;
  // Both hands in frame, the waving one included: a 62 deg vertical field
  // of view, widened on a narrow page to hold the horizontal one at 60 deg.
  const holdWide = (2 * Math.atan(Math.tan((30 * Math.PI) / 180) / aspect) * 180) / Math.PI;
  camera.fov = Math.max(62, holdWide);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
renderer.setAnimationLoop((now) => {
  hands.update(Math.min(0.1, (now - last) / 1000));
  last = now;
  view.update();
  renderer.render(scene, camera);
});
