// The short sleeve covers the upper arm and the shoulder under it in every
// pose the shoulder can take: skinned in Node as three.js skins it, no skin
// vertex the sleeve covers may come out through the cloth. The shoulder's
// skin cap and the sleeve's dome over it were weighted differently (0.5 and
// 0.6 to the shoulder), so a raised, turned arm pushed the skin through the
// dome: a dark saw-toothed crescent at the sleeve's shoulder end.
import { Skeleton } from '../../hands/src/skeleton.js';
import { buildArmMesh, REGION } from '../../hands/src/mesh.js';
import { v3, quat } from '../../hands/src/math.js';
import { ARM_MM, MM } from '../../hands/src/anatomy.js';
import { skinned } from './skin-deform.js';

// Distance (m) a point lies outside a closed triangle shell, by the nearest
// triangle's outward normal (negative inside).
function outside(P, tris, p) {
  let best = Infinity;
  let sign = -1;
  for (const [a, b, c] of tris) {
    const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const B = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
    const C = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    const cen = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    const d = v3.dist(p, cen);
    if (d < best) {
      best = d;
      const n = v3.cross([0, 0, 0], v3.sub([0, 0, 0], B, A), v3.sub([0, 0, 0], C, A));
      sign = v3.dot(n, v3.sub([0, 0, 0], p, cen)) > 0 ? 1 : -1;
    }
  }
  return sign * best;
}

export const SLEEVE_POSES = [];
for (const flex of [0, 40, 80, 120, 160]) for (const twist of [-90, -45, 0, 45, 90]) SLEEVE_POSES.push({ flex, twist });

export function sleeveReport(side = 'right') {
  const skel = new Skeleton();
  const mesh = buildArmMesh(skel, side, { lod: 'high' });
  const ua = skel.joint(side, 'upper-arm');
  const axis = quat.rotate([0, 0, 0], ua.restWorldRot, [0, 0, -1]);
  const Lua = ARM_MM.upperArm * MM;
  // The cloth's outer shell (the dome and the outside of the sleeve).
  const tris = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    if (ids.every((i) => mesh.meta[i].region === REGION.CLOTH)) tris.push(ids);
  }
  // Skin the sleeve covers: from the shoulder cap to half way down the arm.
  const covered = [];
  for (let i = 0; i < mesh.meta.length; i++) {
    if (mesh.meta[i].region !== REGION.SKIN) continue;
    const d = v3.dot(v3.sub([0, 0, 0], [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]], ua.restWorldPos), axis);
    if (d < 0.5 * Lua) covered.push(i);
  }
  let worst = -Infinity;
  let at = '';
  for (const { flex, twist } of SLEEVE_POSES) {
    skel.reset();
    skel.setChannels(ua, (flex * Math.PI) / 180, 0, (twist * Math.PI) / 180);
    skel.update();
    const P = skinned(skel, mesh, side);
    for (const i of covered) {
      const o = outside(P, tris, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      if (o > worst) { worst = o; at = `flex ${flex} twist ${twist}`; }
    }
  }
  return { worst, at, covered: covered.length, poses: SLEEVE_POSES.length };
}

export const sleeveChecks = [
  {
    name: 'sleeve: no skin the sleeve covers comes out through the cloth, in any shoulder pose (flex 0 to 160, twist -90 to 90)',
    async run() {
      const r = sleeveReport('right');
      const l = sleeveReport('left');
      const worst = Math.max(r.worst, l.worst);
      const at = r.worst >= l.worst ? `right ${r.at}` : `left ${l.at}`;
      return { pass: worst <= 0, worst: worst / MM, limit: 0, unit: 'mm outside the cloth', note: `${r.covered} covered skin vertices per arm, ${r.poses} shoulder poses; worst ${at}` };
    },
  },
];
