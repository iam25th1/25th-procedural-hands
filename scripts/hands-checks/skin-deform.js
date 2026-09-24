// The skinned surface itself, not the bones: linear blend skinning as three.js
// does it, run in Node over the generated arm mesh, then measured ring by
// ring along the limb. The bone checks cannot see a ring of skin weighted
// against its neighbours; these can.
import { Skeleton } from '../../hands/src/skeleton.js';
import { buildArmMesh, REGION } from '../../hands/src/mesh.js';
import { v3, quat } from '../../hands/src/math.js';
import { ARM_MM, MM, KULESH_SKIN_SHARE } from '../../hands/src/anatomy.js';

// Skinned vertex positions for the skeleton's current pose.
export function skinned(skel, mesh, side = 'right') {
  const J = skel.sides[side].joints;
  const n = mesh.positions.length / 3;
  const out = new Float64Array(n * 3);
  const inv = J.map((j) => quat.conjugate([0, 0, 0, 1], j.restWorldRot));
  for (let i = 0; i < n; i++) {
    const p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    let x = 0; let y = 0; let z = 0;
    for (let k = 0; k < 4; k++) {
      const w = mesh.skinWeight[i * 4 + k];
      if (!w) continue;
      const bi = mesh.skinIndex[i * 4 + k];
      const j = J[bi];
      const local = quat.rotate([0, 0, 0], inv[bi], v3.sub([0, 0, 0], p, j.restWorldPos));
      const q = v3.add([0, 0, 0], j.worldPos, quat.rotate([0, 0, 0], j.worldRot, local));
      x += w * q[0]; y += w * q[1]; z += w * q[2];
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
  return out;
}

// Skinned normals: each vertex normal turned by the weighted bone rotations.
export function skinnedNormals(skel, mesh, side = 'right') {
  const J = skel.sides[side].joints;
  const n = mesh.normals.length / 3;
  const out = new Float64Array(n * 3);
  const rel = J.map((j) => quat.multiply([0, 0, 0, 1], j.worldRot, quat.conjugate([0, 0, 0, 1], j.restWorldRot)));
  for (let i = 0; i < n; i++) {
    const v = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
    const acc = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = mesh.skinWeight[i * 4 + k];
      if (!w) continue;
      v3.addScaled(acc, acc, quat.rotate([0, 0, 0], rel[mesh.skinIndex[i * 4 + k]], v), w);
    }
    const l = v3.len(acc) || 1;
    out[i * 3] = acc[0] / l; out[i * 3 + 1] = acc[1] / l; out[i * 3 + 2] = acc[2] / l;
  }
  return out;
}

// Rings of skin along the forearm and into the palm: vertices grouped by
// their rest distance from the elbow along the forearm axis, at the mesh's
// station positions (fractions of the forearm length, and past the wrist).
export const RING_AT = [0.04 / (ARM_MM.forearm * MM), 0.28, 0.55, 0.85, 1 - 0.012 / (ARM_MM.forearm * MM), 1.0, 1 + 0.012 / (ARM_MM.forearm * MM), 1 + 0.022 / (ARM_MM.forearm * MM)];
export function forearmRings(skel, mesh, side = 'right') {
  const elbow = skel.joint(side, 'forearm').restWorldPos;
  const wrist = skel.joint(side, 'wrist').restWorldPos;
  const axis = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], wrist, elbow));
  const L = ARM_MM.forearm * MM;
  const rings = RING_AT.map((f) => ({ f, ids: [] }));
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    if (mesh.meta[i].region !== REGION.SKIN) continue;
    const d = v3.sub([0, 0, 0], [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]], elbow);
    const f = v3.dot(d, axis) / L;
    const off = v3.len(v3.reject([0, 0, 0], d, axis));
    if (off > 0.06) continue;
    for (const r of rings) if (Math.abs(f - r.f) < 0.0008 / L) r.ids.push(i);
  }
  return { rings: rings.filter((r) => r.ids.length >= 8), axis };
}

const centroid = (P, ids) => {
  const c = [0, 0, 0];
  for (const i of ids) { c[0] += P[i * 3]; c[1] += P[i * 3 + 1]; c[2] += P[i * 3 + 2]; }
  return c.map((v) => v / ids.length);
};

// A ring's rigid rotation from rest to now (best fit of its points about
// their centroid), as a quaternion: a unit rotation whatever the skinning did.
// The ring is flat, so its points alone leave the fit ill conditioned; its
// normals (rest n0, now n1, scaled to the ring's size) make it full rank.
export function ringRotation(rest, P, ids, n0 = null, n1 = null) {
  const c0 = centroid(rest, ids);
  const c1 = centroid(P, ids);
  // Horn's method: the cross-covariance and its 4x4 symmetric matrix, the
  // eigenvector of the largest eigenvalue by power iteration.
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of ids) {
    const a = [rest[i * 3] - c0[0], rest[i * 3 + 1] - c0[1], rest[i * 3 + 2] - c0[2]];
    const b = [P[i * 3] - c1[0], P[i * 3 + 1] - c1[1], P[i * 3 + 2] - c1[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c];
    if (n0 && n1) {
      const k = 0.03; // metres: about the ring's radius, so normals weigh like points
      const na = [n0[i * 3] * k, n0[i * 3 + 1] * k, n0[i * 3 + 2] * k];
      const nb = [n1[i * 3] * k, n1[i * 3 + 1] * k, n1[i * 3 + 2] * k];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += na[r] * nb[c];
    }
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  // Largest eigenvector of the symmetric 4x4 by Jacobi rotations (robust
  // where eigenvalues sit close, unlike power iteration).
  const A = N.map((row) => row.slice());
  const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < 4; k++) { const akp = A[k][p]; const akq = A[k][q]; A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq; }
        for (let k = 0; k < 4; k++) { const apk = A[p][k]; const aqk = A[q][k]; A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk; }
        for (let k = 0; k < 4; k++) { const vkp = V[k][p]; const vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
      }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (A[k][k] > A[best][best]) best = k;
  let v = [V[0][best], V[1][best], V[2][best], V[3][best]];
  if (v[0] < 0) v = v.map((x) => -x);
  return [v[1], v[2], v[3], v[0]];
}

// Mean distance of a ring's points from their centroid, now over rest.
export function ringScale(rest, P, ids) {
  const c0 = centroid(rest, ids);
  const c1 = centroid(P, ids);
  let r0 = 0; let r1 = 0;
  for (const i of ids) {
    r0 += Math.hypot(rest[i * 3] - c0[0], rest[i * 3 + 1] - c0[1], rest[i * 3 + 2] - c0[2]);
    r1 += Math.hypot(P[i * 3] - c1[0], P[i * 3 + 1] - c1[1], P[i * 3 + 2] - c1[2]);
  }
  return r1 / r0;
}

const toDeg = (r) => (r * 180) / Math.PI;

// The direction a ring's volar (palmar) side faces: the palmar-weighted mean
// of its points about their centroid, perpendicular to the forearm axis.
export function volarDirection(P, mesh, ids, axis) {
  const c = centroid(P, ids);
  const d = [0, 0, 0];
  for (const i of ids) {
    const w = mesh.meta[i].palmar - 0.5;
    d[0] += w * (P[i * 3] - c[0]); d[1] += w * (P[i * 3 + 1] - c[1]); d[2] += w * (P[i * 3 + 2] - c[2]);
  }
  return v3.normalize([0, 0, 0], v3.reject([0, 0, 0], d, axis));
}
const angleDeg = (a, b) => toDeg(Math.acos(Math.max(-1, Math.min(1, v3.dot(a, b)))));

// Forearm skin in the bind pose (full pronation) and in full supination.
export const VOLAR_LIMIT_DEG = 20;
export function volarReport() {
  const skel = new Skeleton();
  const mesh = buildArmMesh(skel, 'right', { lod: 'high' });
  const { rings, axis } = forearmRings(skel, mesh);
  const forearmRings2 = rings.filter((r) => r.f < 0.99);
  skel.reset();
  // The elbow's flexion side (anterior): the arm frames' -Y.
  const fa = skel.joint('right', 'forearm');
  const anterior = quat.rotate([0, 0, 0], fa.worldRot, [0, -1, 0]);
  const palmOut = (sk) => quat.rotate([0, 0, 0], sk.joint('right', 'wrist').worldRot, [0, -1, 0]);
  const bind = skinned(skel, mesh);
  const elbowRing = forearmRings2[0];
  // In full pronation a ring whose skin carries a share s of the hand's
  // turn lies wound s of the half turn from the elbow crease, (1 - s) from
  // the palm; s is Kulesh's (kuleshShare). Each figure is how far the ring
  // is from where that puts it.
  const atElbow = Math.abs(angleDeg(volarDirection(bind, mesh, elbowRing.ids, axis), anterior) - kuleshShare(elbowRing.f) * 180);
  const lastRing = forearmRings2[forearmRings2.length - 1];
  const atWristBind = Math.abs(angleDeg(volarDirection(bind, mesh, lastRing.ids, axis), v3.normalize([0, 0, 0], v3.reject([0, 0, 0], palmOut(skel), axis))) - (1 - kuleshShare(lastRing.f)) * 180);
  // Full supination (the anatomical position): -90 degrees from thumb up,
  // shared among the twist bones as the bind pronation is shared.
  const chain = skel.sides.right.joints.filter((j) => j.twistOffset);
  const offs = chain.reduce((a, j) => a + (j.twistOffset || 0), 0);
  for (const j of chain) skel.setChannels(j, 0, 0, (-Math.PI / 2) * ((j.twistOffset || 0) / offs));
  skel.update();
  const sup = skinned(skel, mesh);
  const palm = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], palmOut(skel), axis));
  const straight = forearmRings2.map((r) => ({ f: r.f, deg: angleDeg(volarDirection(sup, mesh, r.ids, axis), palm) }));
  return { atElbow, atWristBind, straight };
}

// ANSUR II, combined sample (N = 6068, the public data file): mean and
// standard deviation in mm. The check allows half a standard deviation.
export const ANSUR = { wrist: [169.0, 13.1], radialeStylion: [259.2, 19.8] };
function ringPerimeter(P, ids, axis) {
  // Order the ring's points by angle about its centroid, then sum the edges.
  const c = centroid(P, ids);
  const u = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], [P[ids[0] * 3] - c[0], P[ids[0] * 3 + 1] - c[1], P[ids[0] * 3 + 2] - c[2]], axis));
  const w = v3.cross([0, 0, 0], axis, u);
  const pts = ids.map((i) => { const d = [P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]]; return { a: Math.atan2(v3.dot(d, w), v3.dot(d, u)), p: [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]] }; }).sort((x, y) => x.a - y.a);
  let s = 0;
  for (let k = 0; k < pts.length; k++) s += v3.dist(pts[k].p, pts[(k + 1) % pts.length].p);
  return s;
}

export const skinDeformChecks = [
  {
    name: 'proportion: forearm length and wrist girth within half a standard deviation of the ANSUR II means',
    async run() {
      const skel = new Skeleton();
      const mesh = buildArmMesh(skel, 'right', { lod: 'high' });
      const { rings, axis } = forearmRings(skel, mesh);
      const byF = (f) => rings.reduce((a, r) => (Math.abs(r.f - f) < Math.abs(a.f - f) ? r : a));
      const wrist = ringPerimeter(mesh.positions, byF(1.0).ids, axis) / MM;
      const belly = ringPerimeter(mesh.positions, byF(0.28).ids, axis) / MM;
      const length = v3.dist(skel.joint('right', 'forearm').restWorldPos, skel.joint('right', 'wrist').restWorldPos) / MM;
      const rows = [['wrist girth', wrist, ANSUR.wrist], ['forearm length', length, ANSUR.radialeStylion]];
      let worst = 0;
      const bad = [];
      for (const [n, v, [m, sd]] of rows) { const z = Math.abs(v - m) / sd; worst = Math.max(worst, z); if (z > 0.5) bad.push(n); }
      return { pass: bad.length === 0, worst, limit: 0.5, unit: 'SD', note: `${rows.map(([n, v, [m, sd]]) => `${n} ${v.toFixed(1)} mm (ANSUR II ${m} +/- ${sd})`).join('; ')}${bad.length ? `; outside: ${bad.join(', ')}` : ''}; largest forearm girth ${belly.toFixed(1)} mm, not checked: ANSUR II measures it flexed with the fist clenched (295.0), not relaxed` };
    },
  },
  {
    // Corrected from "facing ... the palm at the wrist in pronation" (the last
    // forearm ring within 20 deg of the palm, which needs skin at 95 percent
    // of the forearm to turn nearly with the hand; Kulesh 2015 level VIII
    // turns 0.728): each end ring is now held to its Kulesh wind.
    name: 'skinning: forearm skin wound as the forearm is, in pronation lying as far from the elbow crease and the palm as Kulesh 2015 puts it, straight in supination',
    async run() {
      const r = volarReport();
      const worstStraight = r.straight.reduce((a, x) => Math.max(a, x.deg), 0);
      const worst = Math.max(r.atElbow, r.atWristBind, worstStraight);
      return { pass: worst <= VOLAR_LIMIT_DEG, worst, limit: VOLAR_LIMIT_DEG, unit: 'deg', note: `pronation: volar side ${r.atElbow.toFixed(0)} deg off its Kulesh wind at the elbow, ${r.atWristBind.toFixed(0)} deg off it at the wrist; supination: volar side off the palm by ${r.straight.map((x) => `${x.deg.toFixed(0)} at ${x.f.toFixed(2)}`).join(', ')}` };
    },
  },
  {
    name: 'skinning: forearm and wrist skin turn and bend toward the hand in order, ring by ring, under 90 deg of forearm rotation and 73 deg of wrist flexion',
    async run() {
      const skel = new Skeleton();
      const mesh = buildArmMesh(skel, 'right', { lod: 'high' });
      const { rings, axis } = forearmRings(skel, mesh);
      const rest = mesh.positions;
      const notes = [];
      let worst = 0;
      // Forearm rotation 90 degrees from the bind pose (palm down) to thumb
      // up, the twist channels set to 0 as the rig shares a rotation.
      skel.reset();
      for (const j of skel.sides.right.joints.filter((jt) => jt.twistOffset || jt.name === 'wrist')) skel.setChannels(j, 0, 0, 0);
      skel.update();
      let P = skinned(skel, mesh);
      let N = skinnedNormals(skel, mesh);
      const turn = rings.map((r) => Math.abs(quat.twistAngle(ringRotation(rest, P, r.ids, mesh.normals, N), axis)));
      const handTurn = Math.PI / 2;
      // Wrist flexion 73 degrees (its limit), the forearm at the bind pose.
      skel.reset();
      const wj = skel.joint('right', 'wrist');
      skel.setChannels(wj, (73 * Math.PI) / 180, 0, wj.channels.twist);
      skel.update();
      P = skinned(skel, mesh);
      N = skinnedNormals(skel, mesh);
      const bend = rings.map((r) => quat.angle(ringRotation(rest, P, r.ids, mesh.normals, N)));
      const handBend = (73 * Math.PI) / 180;
      // In order toward the hand: no ring may turn or bend less than the ring
      // before it (0.5 percent of the motion allowed for fitting noise).
      const tol = 0.005;
      for (let i = 1; i < rings.length; i++) {
        const dt = turn[i - 1] / handTurn - turn[i] / handTurn;
        const db = bend[i - 1] / handBend - bend[i] / handBend;
        worst = Math.max(worst, dt * 100, db * 100);
        if (dt > tol) notes.push(`turn steps back ${(dt * 100).toFixed(1)} percent at ${rings[i].f.toFixed(3)}`);
        if (db > tol) notes.push(`bend steps back ${(db * 100).toFixed(1)} percent at ${rings[i].f.toFixed(3)}`);
      }
      const row = rings.map((r, i) => `${r.f.toFixed(3)}: turn ${toDeg(turn[i]).toFixed(0)}, bend ${toDeg(bend[i]).toFixed(0)}`).join('; ');
      return { pass: notes.length === 0, worst: Math.max(0, worst), limit: tol * 100, unit: 'percent step back', note: `${notes.length ? `${notes.join(', ')}; ` : ''}rings (fraction of the forearm from the elbow): ${row}` };
    },
  },
];

// Turn the forearm from the bind pose (full pronation) toward supination by
// deg, shared over the joints that carry the bind pronation as they carry it.
function rotateForearm(skel, deg) {
  skel.reset();
  const chain = skel.sides.right.joints.filter((j) => j.twistOffset);
  const offs = chain.reduce((a, j) => a + j.twistOffset, 0);
  for (const j of chain) skel.setChannels(j, 0, 0, j.twistOffset - ((deg * Math.PI) / 180) * (j.twistOffset / offs));
  skel.update();
}

// The skin's share of the hand's turn along the forearm, from Kulesh PN et
// al. SICOT J 2015;1:3 (anatomy.js KULESH_SKIN_SHARE: eight levels, share
// d_u / (d_u + d_r)), with the elbow at 0 and the wrist crease turning with
// the hand; linear between.
export function kuleshShare(f) {
  const pts = [[0, 0], ...KULESH_SKIN_SHARE, [1, 1]];
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i][0]) { const [f0, s0] = pts[i - 1]; const [f1, s1] = pts[i]; return s0 + ((f - f0) / (f1 - f0)) * (s1 - s0); }
  }
  return 1;
}
// Tolerance on a ring's share: 0.05 of the hand's turn, twice the largest
// gap between the table and the rig's piecewise fit (0.025, level I), for
// the ring fit's own noise.
export const KULESH_TOLERANCE = 0.05;

// The skinned surface's cross section across the forearm axis at fraction f
// of the forearm: its area, from the skin triangles the plane cuts.
function sectionArea(mesh, P, elbow, axis, f) {
  const o = v3.addScaled([0, 0, 0], elbow, axis, f * ARM_MM.forearm * MM);
  const segs = [];
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const ids = [idx[t], idx[t + 1], idx[t + 2]];
    if (ids.some((i) => mesh.meta[i].region !== REGION.SKIN)) continue;
    const p = ids.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const d = p.map((q) => v3.dot(v3.sub([0, 0, 0], q, o), axis));
    const cut = [];
    for (let k = 0; k < 3; k++) {
      const a = k; const b = (k + 1) % 3;
      if ((d[a] > 0) !== (d[b] > 0)) cut.push(v3.addScaled([0, 0, 0], p[a], v3.sub([0, 0, 0], p[b], p[a]), d[a] / (d[a] - d[b])));
    }
    if (cut.length === 2 && v3.len(v3.reject([0, 0, 0], v3.sub([0, 0, 0], cut[0], o), axis)) < 0.07) segs.push(cut);
  }
  const c = [0, 0, 0];
  for (const [a, b] of segs) { v3.addScaled(c, c, a, 0.5 / segs.length); v3.addScaled(c, c, b, 0.5 / segs.length); }
  let A = 0;
  for (const [a, b] of segs) A += Math.abs(v3.dot(v3.cross([0, 0, 0], v3.sub([0, 0, 0], a, c), v3.sub([0, 0, 0], b, c)), axis)) / 2;
  return A;
}
// Candy wrap: the forearm's narrowest cross section under a rotation, as the
// radius of equal area over its radius at rest, sampled every 1 percent of
// the forearm on the rendered surface (ring vertices and the facets between
// them alike).
export function forearmGirthUnderRotation(deg) {
  const skel = new Skeleton();
  const mesh = buildArmMesh(skel, 'right', { lod: 'high' });
  skel.reset();
  const elbow = skel.joint('right', 'forearm').restWorldPos;
  const axis = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], skel.joint('right', 'wrist').restWorldPos, elbow));
  rotateForearm(skel, deg);
  const P = skinned(skel, mesh);
  let worst = Infinity; let at = 0;
  for (let k = 2; k <= 100; k++) {
    const f = k / 100;
    const r = Math.sqrt(sectionArea(mesh, P, elbow, axis, f) / sectionArea(mesh, mesh.positions, elbow, axis, f));
    if (r < worst) { worst = r; at = f; }
  }
  return { worst, at };
}
// The equal-thirds rig this replaced kept 0.792 of the forearm's radius at
// its narrowest under 180 deg (full pronation to full supination), at 72
// percent of the forearm. The sourced distribution may not wrap it further.
export const CANDY_WRAP_MIN = 0.79;

export const pronationChecks = [
  {
    name: 'skinning: forearm skin turns along the forearm as Kulesh 2015 measured it (a share of the hand\'s turn rising from the elbow to the wrist), under 90 deg of forearm rotation',
    async run() {
      const skel = new Skeleton();
      const mesh = buildArmMesh(skel, 'right', { lod: 'high' });
      const { rings, axis } = forearmRings(skel, mesh);
      rotateForearm(skel, 90);
      const hand = skel.joint('right', 'wrist');
      const handTurn = Math.abs(quat.twistAngle(quat.multiply([0, 0, 0, 1], hand.worldRot, quat.conjugate([0, 0, 0, 1], hand.restWorldRot)), axis));
      const P = skinned(skel, mesh);
      const N = skinnedNormals(skel, mesh);
      const rows = rings.filter((r) => r.f > 0.1 && r.f < 0.99).map((r) => {
        const share = Math.abs(quat.twistAngle(ringRotation(mesh.positions, P, r.ids, mesh.normals, N), axis)) / handTurn;
        return { f: r.f, share, want: kuleshShare(r.f) };
      });
      const worst = Math.max(...rows.map((x) => Math.abs(x.share - x.want)));
      return { pass: worst <= KULESH_TOLERANCE, worst, limit: KULESH_TOLERANCE, unit: 'of the hand turn', note: `hand turned ${toDeg(handTurn).toFixed(0)} deg; rings: ${rows.map((x) => `${x.f.toFixed(2)} turns ${x.share.toFixed(3)} (Kulesh ${x.want.toFixed(3)})`).join(', ')}` };
    },
  },
  {
    name: 'skinning: the forearm keeps its girth from full pronation to full supination (no deeper candy wrap than the equal-thirds rig it replaced)',
    async run() {
      const full = forearmGirthUnderRotation(180);
      const half = forearmGirthUnderRotation(90);
      return { pass: full.worst >= CANDY_WRAP_MIN, worst: full.worst * 100, limit: CANDY_WRAP_MIN * 100, unit: 'percent of the rest radius', note: `narrowest at ${(full.at * 100).toFixed(0)} percent of the forearm under 180 deg; ${(half.worst * 100).toFixed(1)} percent at ${(half.at * 100).toFixed(0)} under 90 deg; the equal-thirds rig kept 79.2 under 180` };
    },
  },
];
