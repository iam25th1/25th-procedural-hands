// The thumb's skin as a shape: sliced across its bones every 1.5 mm in the
// relaxed pose, from its widest point (where it leaves the thenar) to the IP
// joint. A thumb reads as one digit when its girth falls away steadily; a
// knuckle bump and a crease ring at the MCP, and a thenar that ended
// abruptly, read as a tube with a cuff. No published figure gives the
// thumb's taper: the limits here are a visual judgement, set so that the
// taper may not change by more than 0.75 mm from one slice to the next
// (it changed by 1.0 at the MCP before) and the girth may not grow
// distally by more than 0.3 mm.
import { create } from '../../hands/src/index.js';
import { buildArmMesh, REGION } from '../../hands/src/mesh.js';
import { v3 } from '../../hands/src/math.js';
import { MM } from '../../hands/src/anatomy.js';
import { skinned } from './skin-deform.js';

export const THUMB_SHAPE = { slice: 0.0015, taperChange: 0.75, rise: 0.3 };

export function thumbProfile(side = 'right') {
  const h = create({ seed: 1 });
  h.setPose(side, 'relaxed', { snap: true });
  for (let i = 0; i < 60; i++) h.step();
  const skel = h.skeleton;
  const mesh = buildArmMesh(skel, side, { lod: 'high' });
  const P = skinned(skel, mesh, side);
  const J = (n) => skel.joint(side, n);
  const base = skel.sides[side].joints[0].index;
  const thumbBones = new Set(['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'].map((n) => J(n).index - base));
  const isThumb = (i) => { let w = 0; for (let k = 0; k < 4; k++) if (thumbBones.has(mesh.skinIndex[i * 4 + k])) w += mesh.skinWeight[i * 4 + k]; return w > 0.5; };
  const out = [];
  for (const [name, a, b] of [['metacarpal', J('thumb-metacarpal'), J('thumb-phalanx-proximal')], ['proximal', J('thumb-phalanx-proximal'), J('thumb-phalanx-distal')]]) {
    const A = a.worldPos; const L = v3.dist(A, b.worldPos);
    const ax = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], b.worldPos, A));
    for (let s = 0; s <= L + 1e-9; s += THUMB_SHAPE.slice) {
      const o = v3.addScaled([0, 0, 0], A, ax, s);
      const segs = [];
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        if (ids.some((i) => mesh.meta[i].region !== REGION.SKIN || !isThumb(i))) continue;
        const p = ids.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
        const d = p.map((q) => v3.dot(v3.sub([0, 0, 0], q, o), ax));
        const cut = [];
        for (let k = 0; k < 3; k++) { const u = k; const w = (k + 1) % 3; if ((d[u] > 0) !== (d[w] > 0)) cut.push(v3.addScaled([0, 0, 0], p[u], v3.sub([0, 0, 0], p[w], p[u]), d[u] / (d[u] - d[w]))); }
        if (cut.length === 2 && v3.len(v3.reject([0, 0, 0], v3.sub([0, 0, 0], cut[0], o), ax)) < 0.03) segs.push(cut);
      }
      if (!segs.length) continue;
      const c = [0, 0, 0];
      for (const [p1, p2] of segs) { v3.addScaled(c, c, p1, 0.5 / segs.length); v3.addScaled(c, c, p2, 0.5 / segs.length); }
      let area = 0;
      for (const [p1, p2] of segs) area += Math.abs(v3.dot(v3.cross([0, 0, 0], v3.sub([0, 0, 0], p1, c), v3.sub([0, 0, 0], p2, c)), ax)) / 2;
      out.push({ bone: name, s, dia: 2 * Math.sqrt(area / Math.PI) });
    }
  }
  // From the widest slice on the metacarpal (the thumb clear of the palm) on.
  let i0 = 0;
  out.forEach((r, i) => { if (r.bone === 'metacarpal' && r.dia > out[i0].dia) i0 = i; });
  return out.slice(i0);
}

export const thumbShapeChecks = [
  {
    name: 'thumb: the skin tapers from the thenar to the IP joint without a step, a bulge or a cuff (relaxed pose, sliced every 1.5 mm)',
    async run() {
      let change = 0; let rise = 0; let at = ''; let peak = 0;
      for (const side of ['right', 'left']) {
        const prof = thumbProfile(side);
        peak = Math.max(peak, prof[0].dia);
        for (let k = 1; k < prof.length; k++) {
          const r = prof[k].dia - prof[k - 1].dia;
          if (r > rise) rise = r;
          if (k + 1 < prof.length) {
            const c = Math.abs(prof[k + 1].dia - 2 * prof[k].dia + prof[k - 1].dia);
            if (c > change) { change = c; at = `${side} ${prof[k].bone} ${(prof[k].s / MM).toFixed(1)} mm`; }
          }
        }
      }
      const pass = change / MM <= THUMB_SHAPE.taperChange && rise / MM <= THUMB_SHAPE.rise;
      return { pass, worst: change / MM, limit: THUMB_SHAPE.taperChange, unit: 'mm change of taper per slice', note: `widest ${(peak / MM).toFixed(1)} mm where it leaves the thenar; largest change at ${at}; girth grows distally by at most ${(rise / MM).toFixed(2)} mm (limit ${THUMB_SHAPE.rise})` };
    },
  },
];
