import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton } from '../src/skeleton.js';
import { buildArmMesh, colorize, manifoldReport, LODS } from '../src/mesh.js';
import { SKIN_TONES, SLEEVE_COLOURS as PLAYER_COLORS } from '../src/defaults.js';

const skel = new Skeleton();

for (const lod of Object.keys(LODS)) {
  for (const side of ['right', 'left']) {
    test(`${lod} ${side} arm mesh is closed, finite, and every vertex has valid skin weights`, () => {
      const mesh = buildArmMesh(skel, side, { lod });
      assert.ok(mesh.stats.triangles > 500, 'has triangles');
      for (let i = 0; i < mesh.positions.length; i++) assert.ok(Number.isFinite(mesh.positions[i]), `position ${i}`);
      for (let i = 0; i < mesh.normals.length; i++) assert.ok(Number.isFinite(mesh.normals[i]), `normal ${i}`);
      const report = manifoldReport(mesh);
      assert.equal(report.openEdges, 0, `open edges: ${report.openEdges}`);
      assert.equal(report.badEdges, 0, `non manifold edges: ${report.badEdges}`);
      const bones = skel.sides[side].joints.length;
      for (let v = 0; v < mesh.stats.vertices; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const w = mesh.skinWeight[v * 4 + k];
          const b = mesh.skinIndex[v * 4 + k];
          assert.ok(w >= 0 && w <= 1, `weight ${v}`);
          assert.ok(b >= 0 && b < bones, `bone index ${v}`);
          sum += w;
        }
        assert.ok(Math.abs(sum - 1) < 1e-5, `weights sum ${sum} at ${v}`);
      }
      // Consistent outward winding on a closed mesh gives a positive signed
      // volume (divergence theorem); an arm plus sleeve is a few litres.
      let vol = 0;
      const P = mesh.positions;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const a = mesh.indices[t] * 3, c = mesh.indices[t + 1] * 3, d = mesh.indices[t + 2] * 3;
        vol += (P[a] * (P[c + 1] * P[d + 2] - P[c + 2] * P[d + 1]) - P[a + 1] * (P[c] * P[d + 2] - P[c + 2] * P[d]) + P[a + 2] * (P[c] * P[d + 1] - P[c + 1] * P[d])) / 6;
      }
      assert.ok(vol > 0.0012 && vol < 0.008, `signed volume ${vol} m3`);
    });
  }
}

test('mirror: left mesh is the x mirror of the right mesh', () => {
  const r = buildArmMesh(skel, 'right', { lod: 'high' });
  const l = buildArmMesh(skel, 'left', { lod: 'high' });
  assert.equal(r.stats.vertices, l.stats.vertices);
  let worst = 0;
  for (let i = 0; i < r.stats.vertices; i++) {
    worst = Math.max(worst, Math.abs(r.positions[i * 3] + l.positions[i * 3]), Math.abs(r.positions[i * 3 + 1] - l.positions[i * 3 + 1]), Math.abs(r.positions[i * 3 + 2] - l.positions[i * 3 + 2]));
  }
  assert.ok(worst < 1e-9, `mirror error ${worst}`);
});

test('triangle budget: both arms fit the high and low budgets with room for the slingshot', () => {
  const high = buildArmMesh(skel, 'right', { lod: 'high' }).stats.triangles * 2;
  const low = buildArmMesh(skel, 'right', { lod: 'low' }).stats.triangles * 2;
  assert.ok(high <= 15000, `high ${high}`);
  assert.ok(low <= 6000, `low ${low}`);
});

test('colorize: palms lighter than the back, nails lighter still, cloth is the shirt', () => {
  const mesh = buildArmMesh(skel, 'right', { lod: 'low' });
  const { color, roughness } = colorize(mesh, { skinTone: SKIN_TONES[0], shirt: PLAYER_COLORS[1] });
  const lum = (i) => 0.2126 * color[i * 3] + 0.7152 * color[i * 3 + 1] + 0.0722 * color[i * 3 + 2];
  let dorsal = 0, dorsalN = 0, palm = 0, palmN = 0, nail = 0, nailN = 0, cloth = 0, clothN = 0;
  mesh.meta.forEach((m, i) => {
    if (m.region === 0 && m.palmar < 0.05) { dorsal += lum(i); dorsalN++; }
    if (m.region === 0 && m.palmar > 0.95) { palm += lum(i); palmN++; }
    if (m.region === 1) { nail += lum(i); nailN++; assert.ok(roughness[i] < 0.65); }
    if (m.region === 3) { cloth += lum(i); clothN++; assert.ok(roughness[i] > 0.85); }
  });
  assert.ok(dorsalN > 0 && palmN > 0 && nailN > 0 && clothN > 0);
  assert.ok(palm / palmN > (dorsal / dorsalN) * 1.5, 'palm lighter');
  assert.ok(nail / nailN > palm / palmN, 'nail lighter than palm');
});
