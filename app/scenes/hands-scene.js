// Hands scene: the rig alone on a plain backdrop for inspection. Both hands
// are raised in front of the eye, palms toward it, fingers up, so counting
// and gestures read from the front; a grip shot shows the object in the hand.
import * as THREE from '/vendor/three.module.js';
import { create, STEP, handRotation, OBJECTS } from '/hands/src/index.js';

export const PRESENT = {
  // Raised, palms toward the viewer: counting and gestures read at a glance.
  raised: (side) => { const s = side === 'right' ? 1 : -1; return { pos: [0.12 * s, -0.16, -0.36], rot: handRotation([-0.08 * s, 1, -0.15], [0.05 * s, 0.1, 1]), pole: [0.55 * s, -0.7, 0.1] }; },
  // Held out in front, palm down, relaxed: anatomy.
  rest: (side) => { const s = side === 'right' ? 1 : -1; return { pos: [0.12 * s, -0.24, -0.36], rot: handRotation([-0.2 * s, 0.05, -0.98], [-0.2 * s, -0.98, 0.05]), pole: [0.55 * s, -0.75, 0.05] }; },
  // Fist held across the body, palm toward the viewer: a thumbs up reads
  // with the thumb pointing up.
  across: (side) => { const s = side === 'right' ? 1 : -1; return { pos: [0.1 * s, -0.2, -0.34], rot: handRotation([-0.95 * s, 0.05, -0.3], [-0.3 * s, 0, 0.95]), pole: [0.55 * s, -0.75, 0.05] }; },
  // Lowered out of the way at the side: the hand not being inspected.
  away: (side) => { const s = side === 'right' ? 1 : -1; return { pos: [0.34 * s, -0.7, 0.02], rot: handRotation([0.1 * s, -0.95, -0.2], [-0.95 * s, 0, 0.1]), pole: [0.55 * s, -0.8, 0.1] }; },
  // Held out, palm up and turned in a little: grips show the object.
  offer: (side) => { const s = side === 'right' ? 1 : -1; return { pos: [0.13 * s, -0.22, -0.36], rot: handRotation([-0.25 * s, 0.15, -0.95], [-0.45 * s, 0.85, 0.2]), pole: [0.55 * s, -0.75, 0.05] }; },
};

// Objects the grips close on in the Hands scene, sized as the checks size them.
export const GRIP_OBJECTS = {
  powerCylinder: { shape: 'cylinder', r: 0.014, h: 0.07 },
  spherical: { shape: 'sphere', r: 0.03 },
  tipPinch: { shape: 'sphere', r: 0.011 },
  padPinch: { shape: 'sphere', r: 0.0125 },
  tripod: { shape: 'sphere', r: 0.015 },
  lateral: { shape: 'box', hx: 0.012, hy: 0.0025, hz: 0.022 },
  hook: { shape: 'cylinder', r: 0.01, h: 0.06 },
  press: { shape: 'box', hx: 0.05, hy: 0.03, hz: 0.05 },
  ...Object.fromEntries(Object.entries(OBJECTS).map(([k, v]) => [`preset:${k}`, v])),
};

export function createHandsScene({ seed = 1, reducedMotion = false } = {}) {
  const hands = create({ seed, reducedMotion, targets: { left: PRESENT.raised('left'), right: PRESENT.raised('right') } });
  const group = new THREE.Group();
  const objMat = new THREE.MeshStandardMaterial({ color: 0x9A9186, roughness: 0.85 });
  const objMeshes = {};

  // The hands a shot is about take the presentation; with one hand named,
  // the other is lowered out of the frame.
  let only = null;
  function setPresent(kind, snap = true) {
    for (const side of ['left', 'right']) hands.setTarget(side, PRESENT[only && side !== only ? 'away' : kind](side), { snap });
  }

  function apply(shot) {
    const sides = shot.hand === 'both' ? ['left', 'right'] : [shot.hand];
    only = shot.hand === 'both' ? null : shot.hand;
    if (shot.grip) {
      setPresent('offer');
      hands.rig.step(0);
      for (const side of sides) hands.grasp(side, GRIP_OBJECTS[shot.grip] || GRIP_OBJECTS.spherical, shot.grip.startsWith('preset:') ? null : shot.grip);
      hands.rig.snapAll();
      return;
    }
    if (shot.count !== null) { setPresent('raised'); hands.count(shot.hand, shot.count, shot.style, { snap: true }); return; }
    if (shot.set) { setPresent('raised'); hands.showFingers(shot.hand, shot.set === 'none' ? [] : shot.set.split('+'), { snap: true }); return; }
    if (shot.gesture) { setPresent(shot.gesture === 'thumbsUp' ? 'across' : 'raised'); hands.gesture(shot.gesture, { hand: shot.hand, snap: true }); return; }
    setPresent(shot.pose ? 'raised' : 'rest');
    if (shot.pose) hands.setPose(shot.hand, shot.pose, { snap: true });
    hands.rig.snapAll();
  }

  // Step on to t seconds since the shot was applied (times only go forward).
  let elapsed = 0;
  function stepTo(t) {
    const n = Math.round((t - elapsed) / STEP);
    for (let i = 0; i < n; i++) hands.step();
    elapsed += Math.max(0, n) * STEP;
  }

  function update() {
    for (const side of ['left', 'right']) {
      const held = hands.held(side);
      let mesh = objMeshes[side];
      if (!held) { if (mesh) mesh.visible = false; continue; }
      const key = `${held.shape}:${held.r}:${held.h}:${held.hx}`;
      if (!mesh || mesh.userData.key !== key) {
        if (mesh) { group.remove(mesh); mesh.geometry.dispose(); }
        let g;
        if (held.shape === 'sphere') g = new THREE.SphereGeometry(held.r, 24, 16);
        else if (held.shape === 'cylinder') { g = new THREE.CylinderGeometry(held.r, held.r, 2 * held.h, 20); g.rotateX(Math.PI / 2); }
        else g = new THREE.BoxGeometry(2 * held.hx, 2 * held.hy, 2 * held.hz);
        mesh = new THREE.Mesh(g, objMat);
        mesh.userData.key = key;
        group.add(mesh);
        objMeshes[side] = mesh;
      }
      mesh.visible = true;
      mesh.position.set(held.pos[0], held.pos[1], held.pos[2]);
      mesh.quaternion.set(held.rot[0], held.rot[1], held.rot[2], held.rot[3]);
    }
  }

  return { hands, group, apply, stepTo, update, setPresent };
}
