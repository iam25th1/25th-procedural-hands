// Renders the slingshot (static fork mesh, dynamic bands and pouch), the
// loaded stone, a carried stone, the ledge stone, the sachet and any
// projectiles. Fork, bands plus pouch, and one stone each take a draw call.
import * as THREE from '/vendor/three.module.js';
import { buildStone, buildSachet } from '/hands/src/stones.js';
import { buildFork } from '../scenes/slingshot/slingshot.js';

function geometryFrom(g, dynamic = false) {
  const geo = new THREE.BufferGeometry();
  const usage = dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage;
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3).setUsage(usage));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3).setUsage(usage));
  geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3).setUsage(usage));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  return geo;
}

const MAT_WOOD = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
const MAT_RUBBER = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0, side: THREE.FrontSide });
const MAT_STONE = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
const MAT_SACHET = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0 });

// Takes the rig the slingshot is attached to (see attachSlingshot), or a
// hands instance whose rig it is.
export function createSlingshotView(rigOrHands, { lod = 'high' } = {}) {
  const rig = rigOrHands.rig || rigOrHands;
  const group = new THREE.Group();
  const cat = rig.slingshot;
  cat.lod = lod;
  cat.fork = buildFork(5, { lod });
  const fork = new THREE.Mesh(geometryFrom(cat.fork), MAT_WOOD);
  fork.frustumCulled = false;
  group.add(fork);

  let bandMesh = null;
  // One mesh per role (loaded, carried, ledge, each projectile) as well as
  // kind and size: the ledge pebble and a carried pebble are the same stone
  // and must not fight over one mesh.
  const stones = new Map(); // key -> mesh
  const stoneMesh = (kind, r, seed, role) => {
    const key = `${role}:${kind}:${r}:${seed}`;
    if (!stones.has(key)) {
      const m = new THREE.Mesh(geometryFrom(buildStone(kind, seed, r, { lod })), MAT_STONE);
      m.frustumCulled = false;
      m.visible = false;
      group.add(m);
      stones.set(key, m);
    }
    return stones.get(key);
  };
  const sachet = new THREE.Mesh(geometryFrom(buildSachet()), MAT_SACHET);
  sachet.frustumCulled = false;
  sachet.visible = false;
  group.add(sachet);

  function place(mesh, pos, rot) {
    mesh.visible = true;
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.quaternion.set(rot[0], rot[1], rot[2], rot[3]); else mesh.quaternion.identity();
  }

  return {
    group,
    update() {
      const a = rig.actions;
      if (a.grabDemo && a.grabDemo.kind === 'fork' && a.heldKind !== 'fork') {
        // Grab demo: the fork lies on the ledge until it is taken.
        place(fork, a.grabDemo.pos, a.grabDemo.rot);
      } else if (a.heldKind === 'fork') {
        // Grab demo: the fork follows the grabbing hand's handle grip.
        const held = rig.attachedObject(rig.pinchSide);
        const roll = a.forkRoll(a.forkAttachment);
        const rot = held ? [0, 0, 0, 1] : cat.forkRot;
        const wr = rig.skel.joint(rig.pinchSide, 'wrist').worldRot;
        const q = [wr[0], wr[1], wr[2], wr[3]];
        // hand rotation times the fork roll (same relation the fork hand uses)
        const r = [
          q[3] * roll[0] + q[0] * roll[3] + q[1] * roll[2] - q[2] * roll[1],
          q[3] * roll[1] - q[0] * roll[2] + q[1] * roll[3] + q[2] * roll[0],
          q[3] * roll[2] + q[0] * roll[1] - q[1] * roll[0] + q[2] * roll[3],
          q[3] * roll[3] - q[0] * roll[0] - q[1] * roll[1] - q[2] * roll[2],
        ];
        void rot;
        place(fork, held ? held.pos : cat.forkPos, held ? r : cat.forkRot);
      } else {
        place(fork, cat.forkPos, cat.forkRot);
      }
      // Bands and pouch: rebuilt each frame.
      const g = cat.geometry();
      if (!bandMesh || bandMesh.geometry.attributes.position.count !== g.stats.vertices) {
        if (bandMesh) { group.remove(bandMesh); bandMesh.geometry.dispose(); }
        bandMesh = new THREE.Mesh(geometryFrom(g, true), MAT_RUBBER);
        bandMesh.frustumCulled = false;
        group.add(bandMesh);
      } else {
        bandMesh.geometry.attributes.position.array.set(g.positions);
        bandMesh.geometry.attributes.normal.array.set(g.normals);
        bandMesh.geometry.attributes.position.needsUpdate = true;
        bandMesh.geometry.attributes.normal.needsUpdate = true;
      }
      for (const m of stones.values()) m.visible = false;
      sachet.visible = false;
      const loaded = cat.stoneWorld();
      if (loaded) place(stoneMesh(loaded.kind, loaded.r, 2, 'loaded'), loaded.pos, cat.forkRot);
      if (a.carry) {
        const held = rig.attachedObject(rig.pinchSide);
        if (held) place(stoneMesh(a.carry.kind, a.carry.r, 2, 'carry'), held.pos, held.rot);
      }
      // The grab demos use the ledge stone's spot, so it steps aside while one runs.
      if (a.ledgeStone.present && !a.grabDemo) place(stoneMesh(a.ledgeStone.kind, a.ledgeStone.r, 2, 'ledge'), a.ledgeStone.pos, null);
      if (a.sachet) {
        const held = rig.attachedObject(rig.pinchSide);
        if (held) place(sachet, held.pos, held.rot);
      }
      if (a.grabDemo && !a.heldKind) {
        // Grab demo: the object rests on the ledge before and after the grasp.
        const d = a.grabDemo;
        if (d.kind === 'sachet') place(sachet, d.pos, d.rot);
        else if (d.kind !== 'fork') place(stoneMesh(d.kind, d.obj.r, 2, 'demo'), d.pos, d.rot);
      }
      cat.projectiles.forEach((p, i) => {
        if (p.kind === 'sachet') place(sachet, p.pos, p.rot);
        else place(stoneMesh(p.kind, p.r, 2, `flight${i}`), p.pos, null);
      });
    },
    // Frees the geometry this view built. The materials are shared by every
    // slingshot view, so they stay.
    dispose() {
      for (const m of [fork, sachet, bandMesh, ...stones.values()]) {
        if (!m) continue;
        group.remove(m);
        m.geometry.dispose();
      }
      stones.clear();
      bandMesh = null;
    },
    stats() {
      let tris = fork.geometry.index.count / 3;
      if (bandMesh) tris += bandMesh.geometry.index.count / 3;
      for (const m of stones.values()) if (m.visible) tris += m.geometry.index.count / 3;
      return { triangles: tris };
    },
  };
}
