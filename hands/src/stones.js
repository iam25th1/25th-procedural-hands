// Procedural stones and the pure water sachet. Pebbles are smooth, a little
// oblate river stones 2 to 3 cm across; rocks are 5 to 7 cm and angular.
// The grasp solver and the sim use spheres; these meshes are the look.
// Geometry is a subdivided icosahedron displaced by seeded value noise, so
// the same seed always gives the same stone.
import { v3 } from './math.js';
import { mulberry32 } from './rng.js';
import * as dmath from './dmath.js';

// Deterministic 3D value noise from a seeded lattice.
function makeNoise(seed) {
  const rng = mulberry32(seed);
  const N = 32;
  const lattice = new Float32Array(N * N * N);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const at = (x, y, z) => lattice[(((x % N) + N) % N) * N * N + (((y % N) + N) % N) * N + (((z % N) + N) % N)];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi);
    const c = (dx, dy, dz) => at(xi + dx, yi + dy, zi + dz);
    const lx = (a, b) => a + (b - a) * fx;
    const ly = (a, b) => a + (b - a) * fy;
    const lz = (a, b) => a + (b - a) * fz;
    return lz(ly(lx(c(0, 0, 0), c(1, 0, 0)), lx(c(0, 1, 0), c(1, 1, 0))), ly(lx(c(0, 0, 1), c(1, 0, 1)), lx(c(0, 1, 1), c(1, 1, 1)))) * 2 - 1;
  };
}

// Icosphere: returns { positions: [[x,y,z]...] on the unit sphere, indices }.
export function icosphere(subdivisions) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => v3.normalize([0, 0, 0], v));
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (cache.has(key)) return cache.get(key);
      const p = v3.normalize([0, 0, 0], v3.add([0, 0, 0], verts[a], verts[b]));
      verts.push(p);
      cache.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { positions: verts, indices: faces.flat() };
}

function finish(points, indices, colorFn) {
  const n = points.length;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions.set(points[i], i * 3);
  const idx = new Uint32Array(indices);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const pa = points[a], pb = points[b], pc = points[c];
    const fn = v3.cross([0, 0, 0], v3.sub([0, 0, 0], pb, pa), v3.sub([0, 0, 0], pc, pa));
    for (const k of [a, b, c]) { normals[k * 3] += fn[0]; normals[k * 3 + 1] += fn[1]; normals[k * 3 + 2] += fn[2]; }
  }
  for (let i = 0; i < n; i++) {
    const l = dmath.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
    const c = colorFn(points[i], i);
    colors.set(c, i * 3);
  }
  return { positions, normals, colors, indices: idx, stats: { vertices: n, triangles: idx.length / 3 } };
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : dmath.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex) => { const v = parseInt(hex.slice(1), 16); return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)]; };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// kind: 'pebble' (r about 12 mm, smooth, oblate) or 'rock' (r about 30 mm, angular).
export function buildStone(kind, seed = 1, radius = kind === 'rock' ? 0.03 : 0.012, { lod = 'high' } = {}) {
  const noise = makeNoise(seed);
  const base = icosphere(lod === 'low' ? 1 : 2);
  const rock = kind === 'rock';
  const points = base.positions.map((p) => {
    const f = rock ? 2.2 : 1.6;
    let n1 = noise(p[0] * f + 10, p[1] * f + 10, p[2] * f + 10);
    let n2 = noise(p[0] * f * 2.7 + 30, p[1] * f * 2.7 + 30, p[2] * f * 2.7 + 30);
    if (rock) {
      // Angular: quantise the low frequency so faces form, keep fine grain.
      n1 = Math.round(n1 * 3) / 3;
    }
    const r = radius * (1 + (rock ? 0.16 : 0.09) * n1 + (rock ? 0.05 : 0.03) * n2);
    const q = v3.scale([0, 0, 0], p, r);
    // Oblate pebbles, slightly flattened rocks.
    q[1] *= rock ? 0.86 : 0.72;
    q[0] *= rock ? 1.05 : 1.1;
    return q;
  });
  const dark = lin(rock ? '#57534C' : '#6E665C');
  const light = lin(rock ? '#8C857B' : '#9A9186');
  const warm = lin('#7A6A55');
  return finish(points, base.indices, (p) => {
    const g = noise(p[0] * 90 + 50, p[1] * 90 + 50, p[2] * 90 + 50);
    const w = noise(p[0] * 25 + 80, p[1] * 25 + 80, p[2] * 25 + 80);
    let c = mix3(dark, light, 0.5 + 0.5 * g);
    c = mix3(c, warm, 0.25 * (w + 1) / 2);
    return c;
  });
}

// Pure water sachet: a full, soft pillow about 15 by 9 cm and 3.5 cm thick,
// clear film over water with a printed band. Built on a rounded box.
export function buildSachet(seed = 3) {
  const hx = 0.075, hy = 0.045, hz = 0.0175;
  const nx = 18, ny = 12;
  const points = [];
  const indices = [];
  const noise = makeNoise(seed);
  // Two faces (top and bottom) as inflated grids, joined by their rims.
  const faceIndex = [];
  for (const sign of [1, -1]) {
    const grid = [];
    for (let iy = 0; iy <= ny; iy++) {
      const row = [];
      for (let ix = 0; ix <= nx; ix++) {
        const u = ix / nx * 2 - 1;
        const v = iy / ny * 2 - 1;
        // Inflation: a pillow profile that goes to zero thickness at the sealed edges.
        const edge = Math.max(Math.abs(u), Math.abs(v));
        const puff = dmath.pow(Math.max(0, 1 - dmath.pow(edge, 4)), 0.5);
        const wrinkle = 1 + 0.05 * noise(u * 3 + 7, v * 3 + 7, sign);
        row.push(points.push([u * hx, v * hy, sign * hz * puff * wrinkle]) - 1);
      }
      grid.push(row);
    }
    faceIndex.push(grid);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = grid[iy][ix], b = grid[iy][ix + 1], c = grid[iy + 1][ix + 1], d = grid[iy + 1][ix];
        if (sign > 0) indices.push(a, b, c, a, c, d); else indices.push(a, c, b, a, d, c);
      }
    }
  }
  // Rim: sew the two faces along the perimeter.
  const rim = (grid) => {
    const out = [];
    for (let ix = 0; ix < nx; ix++) out.push(grid[0][ix]);
    for (let iy = 0; iy < ny; iy++) out.push(grid[iy][nx]);
    for (let ix = nx; ix > 0; ix--) out.push(grid[ny][ix]);
    for (let iy = ny; iy > 0; iy--) out.push(grid[iy][0]);
    return out;
  };
  const top = rim(faceIndex[0]);
  const bottom = rim(faceIndex[1]);
  for (let i = 0; i < top.length; i++) {
    const j = (i + 1) % top.length;
    indices.push(top[i], bottom[i], bottom[j], top[i], bottom[j], top[j]);
  }
  const film = lin('#DCE9F0');
  const water = lin('#BFD6E4');
  const print = lin('#1F5FA6');
  return finish(points, indices, (p) => {
    // A printed band across the middle, film elsewhere, bluer where thick.
    const band = Math.abs(p[1]) < 0.012 && Math.abs(p[0]) < 0.05 ? 1 : 0;
    const thick = Math.min(1, Math.abs(p[2]) / hz);
    let c = mix3(film, water, thick * 0.6);
    if (band) c = mix3(c, print, 0.85);
    return c;
  });
}
