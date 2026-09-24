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

test('triangle budget: both arms fit the high and low budgets with room for the objects they hold', () => {
  const high = buildArmMesh(skel, 'right', { lod: 'high' }).stats.triangles * 2;
  const low = buildArmMesh(skel, 'right', { lod: 'low' }).stats.triangles * 2;
  assert.ok(high <= 15000, `high ${high}`);
  assert.ok(low <= 6000, `low ${low}`);
});

test('colorize: on every Monk tone the palm is lighter than the back, more so the deeper the tone; nail beds stand apart from the skin; cloth is the shirt', () => {
  const mesh = buildArmMesh(skel, 'right', { lod: 'low' });
  const lab = ([r, g, b]) => {
    // Linear RGB (what colorize writes) to CIE Lab, D65.
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const ratios = [];
  SKIN_TONES.forEach((tone, t) => {
    const { color, roughness } = colorize(mesh, { skinTone: tone, shirt: PLAYER_COLORS[1] });
    const at = (i) => [color[i * 3], color[i * 3 + 1], color[i * 3 + 2]];
    const mean = (pred) => { const acc = [0, 0, 0]; let n = 0; mesh.meta.forEach((m, i) => { if (pred(m)) { const c = at(i); acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++; } }); return { c: acc.map((v) => v / n), n }; };
    // Unshaded skin only: creases are darkened on purpose, and the palm has
    // many more of them than the back.
    const dorsal = mean((m) => m.region === 0 && m.palmar < 0.05 && m.shade === 1);
    // The palm is glabrous skin: palm and volar digits, ending at the wrist
    // crease, with a fifth of the melanocytes of other sites (Yamaguchi Y et
    // al. J Cell Biol 2004;165(2):275-285). The volar forearm faces the same
    // way but is not glabrous, so it is not the palm.
    const palm = mean((m) => m.region === 0 && m.palmar > 0.95 && (m.glabrous ?? 1) === 1 && m.shade === 1);
    const nail = mean((m) => m.region === 1);
    const cloth = mean((m) => m.region === 3);
    assert.ok(dorsal.n > 0 && palm.n > 0 && nail.n > 0 && cloth.n > 0);
    const [Ld, Lp, Ln] = [lab(dorsal.c), lab(palm.c), lab(nail.c)];
    assert.ok(Lp[0] > Ld[0], `${tone}: palm lighter than the back (L* ${Lp[0].toFixed(1)} vs ${Ld[0].toFixed(1)})`);
    const dE = Math.hypot(Ln[0] - Ld[0], Ln[1] - Ld[1], Ln[2] - Ld[2]);
    assert.ok(dE > 15, `${tone}: nail bed apart from the skin (dE ${dE.toFixed(1)})`);
    mesh.meta.forEach((m, i) => { if (m.region === 1) assert.ok(roughness[i] < 0.65); if (m.region === 3) assert.ok(roughness[i] > 0.85); });
    ratios.push(Lp[0] / Ld[0]);
    if (t >= 7) assert.ok(Lp[0] > Ld[0] * 1.5, `${tone}: a deep tone's palm is far lighter than its back`);
  });
  // The gap widens with depth: on the five lightest tones the palm is only a
  // little lighter; from Monk 5 on the palm-to-back ratio rises tone by
  // tone, and every deep tone's ratio is above every light tone's.
  for (let t = 5; t < ratios.length; t++) assert.ok(ratios[t] > ratios[t - 1], `palm ratio rises with depth at Monk ${t + 1}: ${ratios.map((r) => r.toFixed(3)).join(' ')}`);
  assert.ok(Math.min(...ratios.slice(5)) > Math.max(...ratios.slice(0, 5)), `deep tones' palms proportionally lighter: ${ratios.map((r) => r.toFixed(3)).join(' ')}`);
});
