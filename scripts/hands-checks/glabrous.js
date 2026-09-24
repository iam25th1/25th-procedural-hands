// Palmar (glabrous) skin is the palm's and the digits' volar side alone: its
// melanocyte density is a fifth of other sites' (Yamaguchi Y et al. J Cell
// Biol 2004;165(2):275-285), and glabrous skin ends at the wrist (the
// ventral fingers, palms and soles; Wikipedia, Glabrous skin). The volar
// forearm is ordinary skin: coloured like the rest of the forearm, on every
// tone, within 3 dE76 (the check's tolerance, about one just noticeable
// difference and a half).
import { Skeleton } from '../../hands/src/skeleton.js';
import { buildArmMesh, colorize, REGION } from '../../hands/src/mesh.js';
import { MONK_TONES } from '../../hands/src/skin.js';
import { v3 } from '../../hands/src/math.js';
import { ARM_MM, MM } from '../../hands/src/anatomy.js';

const lab = ([r, g, b]) => {
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
export const FOREARM_TONE_LIMIT = 3;
export const glabrousChecks = [
  {
    name: 'colour: the palm colour stops at the wrist crease; the volar forearm is coloured like the rest of the forearm on every Monk tone',
    async run() {
      const skel = new Skeleton();
      const mesh = buildArmMesh(skel, 'right', { lod: 'high' });
      const elbow = skel.joint('right', 'forearm').restWorldPos;
      const axis = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], skel.joint('right', 'wrist').restWorldPos, elbow));
      const L = ARM_MM.forearm * MM;
      const volar = []; const dorsal = [];
      for (let i = 0; i < mesh.meta.length; i++) {
        const m = mesh.meta[i];
        if (m.region !== REGION.SKIN || m.shade !== 1) continue;
        const d = v3.sub([0, 0, 0], [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]], elbow);
        const f = v3.dot(d, axis) / L;
        if (f < 0.1 || f > 0.9 || v3.len(v3.reject([0, 0, 0], d, axis)) > 0.06) continue;
        if (m.palmar > 0.9) volar.push(i); else if (m.palmar < 0.1) dorsal.push(i);
      }
      let worst = 0; let at = '';
      for (const tone of MONK_TONES) {
        const { color } = colorize(mesh, { skinTone: tone.id });
        const mean = (ids) => { const c = [0, 0, 0]; for (const i of ids) for (let k = 0; k < 3; k++) c[k] += color[i * 3 + k] / ids.length; return lab(c); };
        const a = mean(volar); const b = mean(dorsal);
        const dE = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (dE > worst) { worst = dE; at = tone.label; }
      }
      return { pass: worst <= FOREARM_TONE_LIMIT, worst, limit: FOREARM_TONE_LIMIT, unit: 'dE76', note: `volar against dorsal forearm skin (${volar.length} and ${dorsal.length} vertices, 10 to 90 percent of the forearm), worst ${at}` };
    },
  },
];
