// three.js view of a rig: one SkinnedMesh per arm built from the procedural
// arm mesh, bones driven from the rig's skeleton every frame. One draw call
// per arm: a single MeshStandardMaterial with vertex colours and a per vertex
// roughness attribute (skin, palm, nail, cloth) patched in with
// onBeforeCompile. No textures and no DOM: the caller owns the renderer.
import * as THREE from 'three';
import { buildArmMesh, colorize } from './mesh.js';
import { m4 } from './math.js';
import { DEFAULTS } from './defaults.js';

export function makeSkinMaterial() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float aRough;\nvarying float vRough;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vRough;\n#include <common>')
      .replace('float roughnessFactor = roughness;', 'float roughnessFactor = vRough;');
  };
  material.customProgramCacheKey = () => 'hands-skin-vrough';
  return material;
}

function armView(skel, side, opts) {
  const joints = skel.sides[side].joints;
  const tmp = new Array(16);
  const bones = joints.map((j) => {
    const bone = new THREE.Bone();
    bone.matrixAutoUpdate = false;
    bone.matrixWorld.fromArray(m4.compose(tmp, j.restWorldPos, j.restWorldRot));
    return bone;
  });
  const skeleton = new THREE.Skeleton(bones);
  const material = opts.flat ? new THREE.MeshBasicMaterial({ vertexColors: true }) : makeSkinMaterial();
  let colours = { skinTone: opts.skinTone, shirt: opts.sleeveColour };
  let current = null;

  function build(lod) {
    const mesh = buildArmMesh(skel, side, { lod });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mesh.skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(mesh.skinWeight, 4));
    const col = colorize(mesh, colours);
    geo.setAttribute('color', new THREE.BufferAttribute(col.color, 3));
    geo.setAttribute('aRough', new THREE.BufferAttribute(col.roughness, 1));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const sm = new THREE.SkinnedMesh(geo, material);
    sm.name = `${side}-arm`;
    sm.frustumCulled = false;
    sm.bind(skeleton, new THREE.Matrix4());
    return { sm, mesh };
  }

  const group = new THREE.Group();
  current = build(opts.lod);
  group.add(current.sm);

  return {
    group,
    get mesh() { return current.sm; },
    get triangles() { return current.mesh.stats.triangles; },
    update() {
      for (let i = 0; i < joints.length; i++) bones[i].matrixWorld.fromArray(m4.compose(tmp, joints[i].worldPos, joints[i].worldRot));
    },
    setLod(lod) {
      group.remove(current.sm);
      current.sm.geometry.dispose();
      current = build(lod);
      group.add(current.sm);
    },
    recolor(next) {
      colours = { skinTone: next.skinTone ?? colours.skinTone, shirt: next.sleeveColour ?? colours.shirt };
      const col = colorize(current.mesh, colours);
      current.sm.geometry.attributes.color.array.set(col.color);
      current.sm.geometry.attributes.color.needsUpdate = true;
      current.sm.geometry.attributes.aRough.array.set(col.roughness);
      current.sm.geometry.attributes.aRough.needsUpdate = true;
    },
    dispose() {
      current.sm.geometry.dispose();
      material.dispose();
      skeleton.dispose();
    },
  };
}

// Both arms of a hands instance (or a bare Rig) as one Group to add to a scene.
export function createThreeView(hands, { lod = DEFAULTS.lod, skinTone = DEFAULTS.skinTone, sleeveColour = DEFAULTS.sleeveColour, flat = false } = {}) {
  const skel = (hands.rig || hands).skel;
  const group = new THREE.Group();
  group.name = 'hands';
  const arms = {};
  for (const side of ['left', 'right']) {
    arms[side] = armView(skel, side, { lod, skinTone, sleeveColour, flat });
    group.add(arms[side].group);
  }
  return {
    group,
    arms,
    update() { arms.left.update(); arms.right.update(); },
    setLod(next) { arms.left.setLod(next); arms.right.setLod(next); },
    recolor(next) { arms.left.recolor(next); arms.right.recolor(next); },
    get triangles() { return arms.left.triangles + arms.right.triangles; },
    dispose() { arms.left.dispose(); arms.right.dispose(); },
  };
}
