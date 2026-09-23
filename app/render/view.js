// three.js scene, camera and lights for the sandbox. Everything drawn that is
// not the hands or the world's objects lives here: backdrop, ground, lights,
// camera framing. The camera only ever moves from the user's own input (the
// orbit) or from an explicit shot or scene choice; nothing here animates it.
import * as THREE from '/vendor/three.module.js';
import { fovFor } from './fov.js';
import { orbitPosition } from '/ui/camera-map.js';

export const EYE_HEIGHT = 1.55;
export const NEAR = 0.02;

export { fovFor };

export function createView(canvas, { preserveDrawingBuffer = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, NEAR, 80);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);

  // Bright overcast yard light: a sky dome in the world, and a warm key, a
  // cool fill and a rim riding with the camera, so any inspection angle is
  // lit from its upper front rather than from the shadow side.
  const hemi = new THREE.HemisphereLight(0xE6EDF2, 0x7A6558, 1.4);
  scene.add(hemi);
  scene.add(camera);
  const cameraLight = (color, intensity, x, y, z) => {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    light.target.position.set(0, 0, -1);
    camera.add(light, light.target);
    return light;
  };
  cameraLight(0xFFF1E0, 1.9, 0.5, 1.0, 0.65);
  cameraLight(0xD8E4EE, 0.9, -0.85, -0.35, 0.7);
  cameraLight(0xFFFFFF, 0.5, 0.2, 0.6, -1.5);

  const yard = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x8E5A3C, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -EYE_HEIGHT;
  yard.add(ground);
  scene.add(yard);

  const root = new THREE.Group();
  scene.add(root);

  function setBackdrop(kind) {
    // 'yard': sky over the ground; 'plain': a flat neutral backdrop for
    // inspecting the hands alone.
    if (kind === 'plain') {
      scene.background = new THREE.Color(0x9AA4A9);
      yard.visible = false;
    } else {
      scene.background = new THREE.Color(0x90A2AB);
      yard.visible = true;
    }
  }
  setBackdrop('yard');

  let width = 0;
  let height = 0;
  function resize(force = false) {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (!force && w === width && h === height) return false;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // The field of view follows the screen's shape, not the canvas's: the
    // control centre docking beside the view resizes the canvas, and that
    // must never change the field of view (vestibular safety). Only turning
    // the device does.
    const screenAspect = (globalThis.innerWidth && globalThis.innerHeight) ? globalThis.innerWidth / globalThis.innerHeight : camera.aspect;
    camera.fov = fovFor(screenAspect);
    camera.updateProjectionMatrix();
    return true;
  }

  // Place the camera: at an eye looking along a direction (first person), or
  // on an orbit around a target.
  function setEye(eye, dir = [0, 0, -1]) {
    camera.position.set(eye[0], eye[1], eye[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]);
  }
  function setOrbit(orbit) {
    const { target } = orbit;
    camera.position.set(...orbitPosition(orbit));
    camera.up.set(0, 1, 0);
    camera.lookAt(target[0], target[1], target[2]);
  }

  function render() {
    renderer.render(scene, camera);
    const info = renderer.info.render;
    return { calls: info.calls, triangles: info.triangles };
  }

  return { THREE, renderer, scene, camera, root, resize, render, setEye, setOrbit, setBackdrop, get size() { return { width, height }; } };
}
