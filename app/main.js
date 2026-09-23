// Sandbox entry. Starts the renderer on the plain backdrop; the scenes land
// with the module.
import * as THREE from '/vendor/three.module.js';
import { animate } from '/vendor/anime.esm.js';

const canvas = document.getElementById('view');
const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171A);
const camera = new THREE.PerspectiveCamera(60, 1, 0.025, 50);

function resize() {
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
addEventListener('resize', resize);
resize();
status.textContent = `three r${THREE.REVISION} ready`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
animate(status, { opacity: [0, 1], duration: reduced ? 0 : 240, ease: 'outCubic' });
