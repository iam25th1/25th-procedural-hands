// Draws the sandbox world: static furniture merged into a few meshes by
// material, one mesh per body and per prop part (they move), and the rope as
// a tube rebuilt each frame. Shapes are exactly what the physics collides,
// so what is seen is what the hands touch.
import * as THREE from '/vendor/three.module.js';
import { buildStone } from '/hands/src/stones.js';

export const PALETTE = {
  wood: 0x8A6A4A,
  woodLight: 0xB08A5E,
  console: 0x3A4148,
  cabinet: 0x454D55,
  rung: 0x9A7A55,
  metal: 0x6C737A,
  iron: 0x4A4F55,
  card: 0x2E6F8E,
  ball: 0xD63A26,
  button: 0xF2B705,
  canvas: 0x5E6B4E,
  strap: 0x3D352C,
  handle: 0x9A7348,
  dowel: 0xC8A97E,
  rope: 0xB99A62,
  box: 0xB9A07A,
};

const KIND_COLOUR = { pebble: null, rock: null, ball: PALETTE.ball, handle: PALETTE.handle, dowel: PALETTE.dowel, card: PALETTE.card, box: PALETTE.box, iron: PALETTE.iron, bag: PALETTE.canvas, crate: PALETTE.woodLight };

function material(color, roughness = 0.8, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function shapeGeometry(s, detail = 1) {
  if (s.shape === 'sphere') return new THREE.SphereGeometry(s.r, 20 * detail, 14 * detail);
  if (s.shape === 'capsule') {
    const g = new THREE.CapsuleGeometry(s.r, 2 * s.h, 4 * detail, 14 * detail);
    g.rotateX(Math.PI / 2); // the physics capsule runs along its local Z
    return g;
  }
  return new THREE.BoxGeometry(2 * s.hx, 2 * s.hy, 2 * s.hz);
}

// A static capsule given by its end points (a rung) as a geometry in world space.
function capsuleBetween(a, b, r) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const g = new THREE.CapsuleGeometry(r, d.length(), 4, 14);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  g.applyQuaternion(q);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

function mergeGeometries(list) {
  // Flatten indexed geometries (position and normal) into one.
  let vcount = 0;
  let icount = 0;
  for (const g of list) { vcount += g.attributes.position.count; icount += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const idx = new Uint32Array(icount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; } else { for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = vo + i; io += g.attributes.position.count; }
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

function stoneGeometry(kind, r, seed) {
  const g = buildStone(kind === 'rock' ? 'rock' : 'pebble', seed, r);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  return geo;
}

export function createWorldView(world, { seed = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'world';
  // Statics merged by look.
  const byLook = new Map();
  for (const s of world.statics) {
    const look = s.render || 'wood';
    const g = s.shape === 'capsule' ? capsuleBetween(s.a, s.b, s.r) : (() => {
      const b = new THREE.BoxGeometry(2 * s.hx, 2 * s.hy, 2 * s.hz);
      const q = s.rot || [0, 0, 0, 1];
      b.applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
      b.translate(s.pos[0], s.pos[1], s.pos[2]);
      return b;
    })();
    if (!byLook.has(look)) byLook.set(look, []);
    byLook.get(look).push(g);
  }
  for (const [look, list] of byLook) {
    const colour = { wood: PALETTE.wood, console: PALETTE.console, rung: PALETTE.rung }[look] ?? PALETTE.wood;
    const mesh = new THREE.Mesh(mergeGeometries(list), material(colour, look === 'console' ? 0.6 : 0.9));
    mesh.name = `static-${look}`;
    group.add(mesh);
  }

  // Bodies: stones are procedural rocks, the rest the shapes the physics uses.
  const bodies = [];
  let stoneSeed = seed * 7 + 3;
  for (const b of world.bodies) {
    const node = new THREE.Group();
    node.name = b.name;
    let main;
    if (b.kind === 'pebble' || b.kind === 'rock') {
      main = new THREE.Mesh(stoneGeometry(b.kind, b.r, stoneSeed++), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    } else {
      const metal = b.kind === 'iron';
      main = new THREE.Mesh(shapeGeometry(b), material(KIND_COLOUR[b.kind] ?? PALETTE.box, metal ? 0.45 : 0.75, metal ? 0.55 : 0));
    }
    node.add(main);
    for (const p of b.parts) {
      const m = new THREE.Mesh(shapeGeometry(p), material(b.kind === 'bag' ? PALETTE.strap : PALETTE.handle, 0.7));
      m.position.set(p.pos[0], p.pos[1], p.pos[2]);
      m.quaternion.set(p.rot[0], p.rot[1], p.rot[2], p.rot[3]);
      node.add(m);
    }
    group.add(node);
    bodies.push({ body: b, node });
  }

  // Props: every part is its own mesh, placed from the prop's coordinate.
  const props = [];
  for (const p of world.props) {
    for (const part of p.parts) {
      const colour = p.name === 'button' ? PALETTE.button : p.name === 'drawer' ? (part.name === 'handle' ? PALETTE.metal : PALETTE.cabinet) : part.name === 'grip' ? PALETTE.ball : PALETTE.metal;
      const mesh = new THREE.Mesh(shapeGeometry(part), material(colour, part.name === 'grip' || p.name === 'button' ? 0.5 : 0.55, part.name === 'arm' || part.name === 'toggle' || part.name === 'handle' ? 0.5 : 0));
      mesh.name = `${p.name}-${part.name}`;
      group.add(mesh);
      props.push({ prop: p, part, mesh });
    }
  }

  // Ropes: a tube along the chain, rebuilt each frame.
  const ropes = world.ropes.map((r) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material(PALETTE.rope, 0.95));
    mesh.name = r.name;
    mesh.frustumCulled = false;
    group.add(mesh);
    return { rope: r, mesh };
  });

  function update() {
    for (const { body, node } of bodies) {
      node.position.set(body.pos[0], body.pos[1], body.pos[2]);
      node.quaternion.set(body.rot[0], body.rot[1], body.rot[2], body.rot[3]);
    }
    for (const { prop, part, mesh } of props) {
      const w = prop.partWorld(part);
      mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
      mesh.quaternion.set(w.rot[0], w.rot[1], w.rot[2], w.rot[3]);
    }
    for (const r of ropes) {
      const pts = r.rope.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const curve = new THREE.CatmullRomCurve3(pts);
      r.mesh.geometry.dispose();
      r.mesh.geometry = new THREE.TubeGeometry(curve, pts.length * 2, r.rope.r, 8, false);
    }
  }
  update();

  return {
    group,
    update,
    get triangles() {
      let t = 0;
      group.traverse((o) => { if (o.isMesh && o.geometry.index) t += o.geometry.index.count / 3; });
      return t;
    },
    get meshes() { let n = 0; group.traverse((o) => { if (o.isMesh) n++; }); return n; },
  };
}
