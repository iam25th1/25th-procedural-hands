// The skinned surface itself, not the bones: linear blend skinning as three.js
// does it, run in Node over the generated arm mesh, then measured ring by
// ring along the limb. The bone checks cannot see a ring of skin weighted
// against its neighbours; these can.
import { Skeleton } from '../../hands/src/skeleton.js';
import { buildArmMesh, REGION } from '../../hands/src/mesh.js';
import { v3, quat } from '../../hands/src/math.js';
import { ARM_MM, MM } from '../../hands/src/anatomy.js';

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
export const RING_AT = [0.28, 0.55, 0.85, 1 - 0.012 / (ARM_MM.forearm * MM), 1.0, 1 + 0.012 / (ARM_MM.forearm * MM), 1 + 0.022 / (ARM_MM.forearm * MM)];
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

export const skinDeformChecks = [
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
      for (const nm of ['forearm-twist-1', 'forearm-twist-2', 'wrist']) skel.setChannels(skel.joint('right', nm), 0, 0, 0);
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
