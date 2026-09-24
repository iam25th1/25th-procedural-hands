// Procedural skinned arm and hand mesh. One watertight sheet per arm, lofted
// station by station from anatomical cross sections placed in the rest
// frames of the skeleton: shoulder cap, upper arm, forearm, wrist, palm,
// then the palm loop branches into the thumb tube and splits into four
// finger tubes joined by web membranes. Fingernails are small closed plates
// in the same mesh. The right arm is generated and the left is its mirror.
// Everything is data driven from anatomy.js; no textures, no downloads.
import { skinPalette } from './skin.js';
import { v3, quat, clamp, lerp, smoothstep } from './math.js';
import { SECTIONS_MM, BONES_MM, MM, NAIL, fingerExternal, ARM_MM, FOREARM_TWIST } from './anatomy.js';
import { FINGERS, XR_PREFIX } from './skeleton.js';
import { DEFAULTS } from './defaults.js';

export const LODS = {
  high: { F: 7, reduced: false, nailCells: [4, 5] },
  low: { F: 4, reduced: true, nailCells: [3, 4] },
};

// Vertex regions for colouring.
export const REGION = { SKIN: 0, NAIL: 1, NAIL_EDGE: 2, CLOTH: 3, CLOTH_INNER: 4 };

const TWO_PI = Math.PI * 2;
const S = SECTIONS_MM;

function angDiff(a, b) {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

// Cross section: a superellipse of width w and thickness t (mm), with the
// dorsal and palmar halves scaled separately and optional Gaussian bumps in
// angle. Points are ordered from +X toward +Y, so index 0..N/2-1 is the
// dorsal half (ulnar to radial on the right hand) and the rest is palmar.
export function profile(N, w, t, opts = {}) {
  const n = opts.n ?? 2.3;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = TWO_PI * (i + 0.5) / N;
    const c = Math.cos(th);
    const s = Math.sin(th);
    let x = (w / 2) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    let y = (t / 2) * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    y *= s > 0 ? (opts.dorsalScale ?? 1) : (opts.palmarScale ?? 1);
    let r = 0;
    for (const b of opts.bumps || []) {
      const d = angDiff(th, b.center);
      r += b.amp * Math.exp(-(d * d) / (2 * b.width * b.width));
    }
    if (r) {
      const len = Math.hypot(x, y) || 1;
      x += (x / len) * r;
      y += (y / len) * r;
    }
    pts.push([x * MM, y * MM, th]);
  }
  return pts;
}

function scaleProfile(a, k) {
  return a.map((p) => [p[0] * k, p[1] * k, p[2]]);
}

function lerpProfile(a, b, t) {
  return a.map((p, i) => [lerp(p[0], b[i][0], t), lerp(p[1], b[i][1], t), p[2]]);
}

// Dorsal surface height of a superellipse section at lateral offset x (mm).
function dorsalY(w, t, x, n = 2.3, scale = 1) {
  const u = clamp(Math.abs(x) / (w / 2), 0, 1);
  return (t / 2) * Math.pow(Math.max(0, 1 - Math.pow(u, n)), 1 / n) * scale;
}

function normalizeWeights(list) {
  const merged = new Map();
  for (const [bone, w] of list) if (w > 0) merged.set(bone, (merged.get(bone) || 0) + w);
  const arr = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = arr.reduce((acc, [, w]) => acc + w, 0) || 1;
  return arr.map(([bone, w]) => [bone, w / sum]);
}

class Builder {
  constructor() {
    this.pos = [];
    this.w = [];
    this.meta = [];
    this.tri = [];
  }
  vertex(p, weights, meta) {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.w.push(normalizeWeights(weights));
    this.meta.push(meta);
    return i;
  }
  point(i) { return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]; }
  tri3(a, b, c) { this.tri.push(a, b, c); }
  quad(a, b, c, d) { this.tri3(a, b, c); this.tri3(a, c, d); }
  faceNormal(a, b, c) {
    const pa = this.point(a), pb = this.point(b), pc = this.point(c);
    return v3.cross([0, 0, 0], v3.sub([0, 0, 0], pb, pa), v3.sub([0, 0, 0], pc, pa));
  }
  // Triangle wound so its normal points along `outward`.
  triOut(a, b, c, outward) {
    const n = this.faceNormal(a, b, c);
    if (v3.dot(n, outward) >= 0) this.tri3(a, b, c); else this.tri3(a, c, b);
  }
  quadOut(a, b, c, d, outward) { this.triOut(a, b, c, outward); this.triOut(a, c, d, outward); }
  // Proximal loop A to distal loop B, same length, outward winding for loops
  // ordered +X toward +Y around a -Z axis. skip: set of edge indices (i -> i+1) to leave open.
  bridge(A, B, skip = null) {
    const n = A.length;
    for (let i = 0; i < n; i++) {
      if (skip && skip.has(i)) continue;
      const j = (i + 1) % n;
      this.quad(A[i], B[i], B[j], A[j]);
    }
  }
  fan(loop, centre, outward) {
    const n = loop.length;
    for (let i = 0; i < n; i++) this.triOut(loop[i], loop[(i + 1) % n], centre, outward);
  }
}

// Reorder ring `ring` (array of vertex ids, positions from builder) so that
// ring[i] is nearest to target[i]; tries every rotation and both directions.
function alignRing(builder, target, ring) {
  const n = ring.length;
  let best = null;
  for (const dir of [1, -1]) {
    for (let k = 0; k < n; k++) {
      const cand = [];
      for (let i = 0; i < n; i++) cand.push(ring[((k + dir * i) % n + n) % n]);
      let cost = 0;
      for (let i = 0; i < n; i++) cost += v3.dist(builder.point(target[i]), builder.point(cand[i]));
      if (!best || cost < best.cost) best = { cost, cand };
    }
  }
  return best.cand;
}

// Palmar skin runs from the front to just past the sides, blending over the
// sides so the lighter palm never reads as a hard glove seam.
const palmarness = (th) => smoothstep((-Math.sin(th) + 0.05) / 0.9);

export function buildArmMesh(skel, side, { lod = 'high' } = {}) {
  const L = LODS[lod] || LODS.high;
  const F = L.F;
  const NF = 2 * F;
  const NP = 8 * F;
  const NA = 10 * F;
  const b = new Builder();
  // Generate in the right arm's frames; mirror at the end for the left.
  const R = skel.sides.right;
  const J = (name) => R.byName.get(name);
  const bi = (name) => J(name).index - R.joints[0].index; // bone index within the side

  const rot = (q, v) => quat.rotate([0, 0, 0], q, v);
  const along = (joint, d) => v3.add([0, 0, 0], joint.restWorldPos, rot(joint.restWorldRot, [0, 0, -d]));

  // Ring of vertices for a profile placed in frame q at centre c.
  function ring(q, c, pts, weights, metaFn) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, y, th] = pts[i];
      const p = v3.add([0, 0, 0], c, rot(q, [x, y, 0]));
      const w = typeof weights === 'function' ? weights(i, th) : weights;
      out.push(b.vertex(p, w, metaFn ? metaFn(i, th) : { region: REGION.SKIN, palmar: palmarness(th), shade: 1 }));
    }
    return out;
  }
  // Creases are one ring flanked 1.5 mm either side by plain rings, so the
  // darkening reads as a line and not a band; the low LOD has no flanking
  // rings, so its creases are lighter. The thenar crease runs along the
  // palm where the thumb's mound meets the hollow.
  const CREASE = L.reduced ? { palmar: 0.9, knuckle: 0.94 } : { palmar: 0.84, knuckle: 0.92 };
  const THENAR_CREASE = 1.37 * Math.PI;
  const skinMeta = (shade = 1, creaseOn = null, flip = false, thenarLine = false) => (i, th) => {
    const p = palmarness(flip ? th + Math.PI : th);
    let s = shade;
    if (creaseOn === 'palmar' && p > 0.55) s = CREASE.palmar;
    if (creaseOn === 'knuckle' && Math.sin(th) > 0.35) s = CREASE.knuckle;
    if (thenarLine && Math.abs(angDiff(th, THENAR_CREASE)) < 0.05) s *= 0.88;
    return { region: REGION.SKIN, palmar: p, shade: s };
  };
  const FLANK = L.reduced ? 0 : 0.0015;

  // ---- Upper arm and forearm tube (NA points) ----
  const ua = J('upper-arm');
  const fa = J('forearm');
  const wr = J('wrist');
  const Lua = ARM_MM.upperArm * MM;
  const Lfa = ARM_MM.forearm * MM;
  // Weights along the forearm shared between the forearm, the twist bones at
  // their stops (anatomy.js) and the wrist.
  const forearmWeights = (f) => {
    const stops = [['forearm', 0], ...FOREARM_TWIST.filter((t) => t.at < 1).map((t) => [t.name, t.at]), ['wrist', 1]];
    for (let i = 0; i < stops.length - 1; i++) {
      const [na, fa0] = stops[i];
      const [nb, fb] = stops[i + 1];
      if (f <= fb) {
        const t = clamp((f - fa0) / (fb - fa0), 0, 1);
        return [[bi(na), 1 - t], [bi(nb), t]];
      }
    }
    return [[bi('wrist'), 1]];
  };
  const armStations = [
    { q: ua.restWorldRot, c: along(ua, 0), pr: S.upperArm.shoulder, w: [[bi('shoulder'), 0.5], [bi('upper-arm'), 0.5]] },
    { q: ua.restWorldRot, c: along(ua, 0.12 * Lua), pr: S.upperArm.deltoid, w: [[bi('upper-arm'), 1]] },
    { q: ua.restWorldRot, c: along(ua, 0.5 * Lua), pr: S.upperArm.mid, w: [[bi('upper-arm'), 1]] },
    { q: ua.restWorldRot, c: along(ua, Lua - 0.04), pr: S.upperArm.elbow, w: [[bi('upper-arm'), 0.85], [bi('forearm'), 0.15]] },
    { q: fa.restWorldRot, c: along(fa, 0), pr: [78, 74], w: [[bi('upper-arm'), 0.5], [bi('forearm'), 0.5]], crease: 'palmar' },
    // Its forearm part is shared along the twist stops like every forearm
    // ring: skin 4 cm below the elbow already turns about a tenth of the
    // hand's turn (Kulesh 2015, levels I and II; anatomy.js).
    { q: fa.restWorldRot, c: along(fa, 0.04), pr: S.forearm.elbow, w: [...forearmWeights(0.04 / Lfa).map(([bone, wt]) => [bone, 0.85 * wt]), [bi('upper-arm'), 0.15]] },
    { q: fa.restWorldRot, c: along(fa, 0.28 * Lfa), pr: S.forearm.belly, w: forearmWeights(0.28) },
    { q: fa.restWorldRot, c: along(fa, 0.55 * Lfa), pr: S.forearm.mid, w: forearmWeights(0.55) },
    { q: fa.restWorldRot, c: along(fa, 0.85 * Lfa), pr: S.forearm.lower, w: forearmWeights(0.85) },
    { q: fa.restWorldRot, c: along(fa, Lfa - 0.012), pr: S.forearm.distal, w: forearmWeights(1 - 0.012 / Lfa) },
    // The wrist ring is in the wrist frame (+Y dorsal), unlike the arm frames (+Y palmar), so its palmar side is not flipped.
    // It follows the wrist bone fully: the wrist's share of the weight only
    // grows toward the hand (0.45 at 85 percent of the forearm, 0.86 at the
    // last forearm ring, 1 here and in the palm), so the skin's turn and its
    // bend never step backward across the crease. (It was 0.5, a ring that
    // turned and bent less than the rings on either side of it.)
    { q: wr.restWorldRot, c: along(wr, 0), pr: S.wrist, w: [[bi('wrist'), 1]], crease: 'palmar', flip: false },
  ];
  if (L.reduced) armStations.splice(7, 1);
  // The skin of the forearm as it lies in the bind pose, which is a full
  // pronation. Pronation turns the radius and the skin over it; the ulna,
  // the elbow and the skin near them stay (Kulesh PN, Fletcher MDA, Solomin
  // LN. SICOT J 2015;1:3: skin moves least against the ulna near the elbow
  // and least against the radius in the distal third). So in pronation the
  // skin is wound: its volar side faces the palm at the wrist and the elbow
  // crease at the elbow, and in supination (the anatomical position) it
  // runs straight. Each ring is laid down turned back by the share of the
  // forearm's rotation it does not carry, (1 - s) of the half turn from full
  // pronation to full supination, where s is the share its skin weights
  // give it (0 on the elbow's and upper arm's bones, 1 on the wrist's). The
  // skinning then unwinds it exactly as the forearm supinates.
  const TURN_SHARE = { shoulder: 0, 'upper-arm': 0, forearm: 0, ...Object.fromEntries(FOREARM_TWIST.map((t) => [t.name, t.share])), wrist: 1 };
  const byBone = new Map(Object.keys(TURN_SHARE).map((n) => [bi(n), TURN_SHARE[n]]));
  const turnShare = (w) => w.reduce((acc, [bone, wt]) => acc + wt * (byBone.get(bone) ?? 1), 0) / w.reduce((acc, [, wt]) => acc + wt, 0);
  // Full pronation to full supination: half a turn about the forearm's
  // axis, negative about the arm frames' +Z (proximal) on the right arm.
  const SUPINATE = -Math.PI;
  const wound = (st) => (st.q === wr.restWorldRot ? st.q : quat.normalize([0, 0, 0, 1], quat.multiply([0, 0, 0, 1], st.q, quat.fromAxisAngle([0, 0, 0, 1], [0, 0, 1], (1 - turnShare(st.w)) * SUPINATE))));
  for (const st of armStations) st.q = wound(st);
  let prev = null;
  let prevQ = null;
  let firstRing = null;
  for (const st of armStations) {
    const pts = profile(NA, st.pr[0], st.pr[1], { n: 2.1 });
    const flank = st.crease ? FLANK : 0;
    const flip = st.flip !== false;
    // Stations in a new frame (the forearm after the upper arm, the wrist
    // after the forearm) can be rolled against the previous ring, since the
    // frames carry the pronation. The previous ring is re-indexed to the
    // nearest correspondence so the bridge never twists across the tube.
    const join = (a, r) => b.bridge(st.q === prevQ ? a : alignRing(b, r, a), r);
    // Arm skin is not palmar skin: the palm's lighter colour stops at the
    // wrist crease (glabrous 0 on the arm, half at the crease; see colorize).
    const glab = st.q === wr.restWorldRot ? [0.5, 0.5, 1] : [0, 0, 0];
    const mark = (ids, g) => { for (const id of ids) b.meta[id].glabrous = g; return ids; };
    if (flank) {
      const r0 = mark(ring(st.q, v3.add([0, 0, 0], st.c, rot(st.q, [0, 0, flank])), pts, st.w, skinMeta(1, null, flip)), glab[0]);
      if (prev) join(prev, r0);
      prev = r0; prevQ = st.q;
    }
    const r = mark(ring(st.q, st.c, pts, st.w, skinMeta(1, st.crease || null, flip)), glab[1]);
    if (!firstRing) firstRing = r;
    if (prev) join(prev, r);
    prev = r; prevQ = st.q;
    if (flank) {
      const r1 = mark(ring(st.q, v3.add([0, 0, 0], st.c, rot(st.q, [0, 0, -flank])), pts, st.w, skinMeta(1, null, flip)), glab[2]);
      b.bridge(prev, r1);
      prev = r1;
    }
  }
  // Shoulder cap: closed inside the sleeve.
  const shoulderCentre = b.vertex(along(ua, -0.03), [[bi('shoulder'), 0.5], [bi('upper-arm'), 0.5]], { region: REGION.SKIN, palmar: 0, shade: 1 });
  b.fan(firstRing, shoulderCentre, [0, 0, 1]);

  // ---- Palm stations in the wrist frame ----
  const palmBumps = (thenar, hypo, web = 0, hollow = 0) => [
    { center: 1.27 * Math.PI, width: 0.45, amp: thenar },
    { center: 1.78 * Math.PI, width: 0.4, amp: hypo },
    { center: Math.PI, width: 0.25, amp: web },
    { center: 1.5 * Math.PI, width: 0.35, amp: hollow },
  ];
  const wq = wr.restWorldRot;
  const wristW = [[bi('wrist'), 1]];
  const thumbMeta = J('thumb-metacarpal');
  // Thumb web tuning: palm vertices near the radial edge share weight with the
  // thumb metacarpal so the first web space stretches with abduction.
  const palmWeights = (thumbShare) => (i, th) => {
    const d = Math.abs(angDiff(th, Math.PI));
    const share = thumbShare * (1 - smoothstep((d - 0.35) / 0.5));
    return [[bi('wrist'), 1 - share], [bi('thumb-metacarpal'), share]];
  };
  const st11 = ring(wq, along(wr, 0.012), profile(NA, 61, 39, { n: 2.4, bumps: palmBumps(1, 1) }), [[bi('wrist'), 1]], skinMeta());
  b.bridge(prev, st11);
  // The thenar eminence: the radial region of the palm loop is displaced
  // palmar and radial, most at the branch station where the thumb leaves and
  // tapering on either side, so the thumb springs from a mound, not an edge.
  const thenar = (pts, amount, radial = 0.3) => pts.map(([x, y, th]) => {
    const d = Math.abs(angDiff(th, Math.PI));
    const w = Math.exp(-(d * d) / (2 * 0.55 * 0.55));
    return [x - radial * amount * w, y - amount * w, th];
  });
  const st12 = ring(wq, along(wr, 0.022), thenar(profile(NA, S.palm.proximal[0], S.palm.proximal[1], { n: 2.5, dorsalScale: 0.92, bumps: palmBumps(3, 2) }), 4 * MM), palmWeights(0.15), skinMeta(1, null, false, true));
  b.bridge(st11, st12);
  // Branch station: 10F loop; the run [4F, 6F) around the radial edge leaves as the thumb.
  const st13 = ring(wq, along(wr, 0.031), thenar(profile(NA, 76, 38, { n: 2.5, dorsalScale: 0.9, bumps: palmBumps(5, 3.5) }), 9 * MM, 0.45), palmWeights(0.3), skinMeta(1, null, false, true));
  b.bridge(st12, st13);
  const runStart = 4 * F;
  const runEnd = 6 * F;
  const thumbRun = st13.slice(runStart, runEnd);
  const palmLoop13 = [...st13.slice(0, runStart), ...st13.slice(runEnd)];
  const palmAngles13 = [];
  for (let i = 0; i < NA; i++) if (i < runStart || i >= runEnd) palmAngles13.push(TWO_PI * (i + 0.5) / NA);
  // Sliver between the thumb ring's closing edge and the palm seam, so the base stays closed.
  // Its exterior is the crotch between the thumb tube and the palm, distal and radial of the station plane.
  b.quadOut(st13[runStart - 1], st13[runStart], st13[runEnd - 1], st13[runEnd], [-0.4, -0.2, -1]);

  // ---- Finger knuckle rings (K0) placed in each metacarpal frame ----
  const fingerData = {};
  for (const f of FINGERS) {
    const p = XR_PREFIX[f];
    const m = J(`${p}-metacarpal`);
    const pp = J(`${p}-phalanx-proximal`);
    const pm = J(`${p}-phalanx-intermediate`);
    const pd = J(`${p}-phalanx-distal`);
    const Lm = m.length;
    fingerData[f] = { m, pp, pm, pd, Lm, Lpp: pp.length, Lpm: pm.length, Lpd: pd.length, sec: S.finger[f], web: fingerExternal(f).web * MM };
  }
  const fingerOrder = ['little', 'ring', 'middle', 'index']; // loop order along the dorsal run (ulnar to radial)
  // Profile at K0 per finger, and its 3D points (virtual 8F loop order).
  const k0Points = []; // 8F entries of [x,y,z] world for the target layout
  const k0Profiles = {};
  for (const f of fingerOrder) {
    const D = fingerData[f];
    k0Profiles[f] = profile(NF, D.sec.head[0], D.sec.head[1], { n: 2.3, dorsalScale: 1.0 });
  }
  const virtualLoop = (perFinger) => {
    // perFinger: f -> ring points [x,y,th] or ids; returns 8F list in palm loop order.
    const out = [];
    for (const f of fingerOrder) for (let i = 0; i < F; i++) out.push(perFinger(f, i));
    for (const f of [...fingerOrder].reverse()) for (let i = F; i < NF; i++) out.push(perFinger(f, i));
    return out;
  };
  const k0World = (f, i, back = 0) => {
    const D = fingerData[f];
    const [x, y] = k0Profiles[f][i];
    return v3.add([0, 0, 0], along(D.m, D.Lm - 0.008 - back), rot(D.m.restWorldRot, [x, y, 0]));
  };
  const k0Target = virtualLoop((f, i) => k0World(f, i, 0));
  const k0Back = virtualLoop((f, i) => k0World(f, i, 0.012));
  const fingerOfSlot = virtualLoop((f) => f);
  const dorsalOfSlot = virtualLoop((f, i) => i < F);

  // Transitional palm stations: ellipse at the station-13 angles, pulled toward the knuckle layout.
  function palmTransition(d, pr, opts, blend, weightsFn, meta) {
    const ell = profile(NP, pr[0], pr[1], opts);
    const ids = [];
    for (let k = 0; k < NP; k++) {
      const th = palmAngles13[k];
      // Re-evaluate the ellipse at the original angle of this slot.
      const c = Math.cos(th), s = Math.sin(th);
      const n = opts.n ?? 2.5;
      let x = (pr[0] / 2) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      let y = (pr[1] / 2) * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      y *= s > 0 ? (opts.dorsalScale ?? 1) : 1;
      let r = 0;
      for (const bump of opts.bumps || []) {
        const dd = angDiff(th, bump.center);
        r += bump.amp * Math.exp(-(dd * dd) / (2 * bump.width * bump.width));
      }
      if (r) { const len = Math.hypot(x, y) || 1; x += (x / len) * r; y += (y / len) * r; }
      const dd = Math.abs(angDiff(th, Math.PI));
      const tw = Math.exp(-(dd * dd) / (2 * 0.55 * 0.55));
      const e = v3.add([0, 0, 0], along(wr, d), rot(wq, [(x - 0.3 * opts.thenar * tw) * MM, (y - opts.thenar * tw) * MM, 0]));
      const p = v3.lerp([0, 0, 0], e, k0Back[k], blend);
      ids.push(b.vertex(p, weightsFn(k, th), meta(k, th)));
    }
    void ell;
    return ids;
  }
  // The distal palmar crease: one darkened transition ring flanked by plain ones.
  const mid14 = (d, meta) => palmTransition(d, S.palm.mid, { n: 2.5, dorsalScale: 0.9, thenar: 6, bumps: palmBumps(4, 4, -2, -1.5) }, 0.22, (k, th) => palmWeights(0.22)(k, th), meta);
  let prevPalm = palmLoop13;
  if (FLANK) { const a = mid14(0.048 - FLANK, skinMeta(1, null, false, true)); b.bridge(prevPalm, a); prevPalm = a; }
  const st14 = mid14(0.048, skinMeta(1, 'palmar', false, true));
  b.bridge(prevPalm, st14);
  prevPalm = st14;
  if (FLANK) { const c = mid14(0.048 + FLANK, skinMeta(1, null, false, true)); b.bridge(prevPalm, c); prevPalm = c; }
  const st15 = palmTransition(0.062, S.palm.distal, { n: 2.6, dorsalScale: 0.9, thenar: 2.5, bumps: palmBumps(2.5, 3.5, -2, -1) }, 0.6,
    (k, th) => {
      const f = fingerOfSlot[k];
      const base = palmWeights(0.12)(k, th);
      return [[bi(`${XR_PREFIX[f]}-metacarpal`), 0.5], [base[0][0], base[0][1] * 0.5], [base[1][0], base[1][1] * 0.5]];
    }, skinMeta(1, null, false, true));
  b.bridge(prevPalm, st15);

  // K0 rings per finger, then the virtual loop bridged from st15.
  const rings = {}; // f -> array of station rings
  for (const f of fingerOrder) {
    const D = fingerData[f];
    const mb = bi(`${XR_PREFIX[f]}-metacarpal`);
    const pb = bi(`${XR_PREFIX[f]}-phalanx-proximal`);
    const r0 = ring(D.m.restWorldRot, along(D.m, D.Lm - 0.008), k0Profiles[f],
      (i, th) => (Math.sin(th) > 0 ? [[mb, 1]] : [[mb, 0.85], [pb, 0.15]]), skinMeta());
    rings[f] = [r0];
  }
  const k0Virtual = virtualLoop((f, i) => rings[f][0][i]);
  b.bridge(st15, k0Virtual);
  void k0Target; void dorsalOfSlot;

  // ---- Finger tubes ----
  // Station schedule: [frameJoint, distance, profileFn, weights, meta, tag]
  const fingerSchedule = (f) => {
    const D = fingerData[f];
    const sec = D.sec;
    const mb = bi(`${XR_PREFIX[f]}-metacarpal`);
    const pb = bi(`${XR_PREFIX[f]}-phalanx-proximal`);
    const ib = bi(`${XR_PREFIX[f]}-phalanx-intermediate`);
    const db = bi(`${XR_PREFIX[f]}-phalanx-distal`);
    const P = (key, o) => profile(NF, sec[key][0], sec[key][1], { n: 2.3, ...o });
    const knuckle = P('head', { bumps: [{ center: Math.PI / 2, width: 0.6, amp: 2.2 }] });
    const Ltip = D.Lpd; // distal bone plus tip soft tissue
    const list = [
      { j: D.pp, d: 0, pr: lerpProfile(knuckle, P('proximal'), 0.5), w: (i, th) => (Math.sin(th) > 0 ? [[mb, 0.6], [pb, 0.4]] : [[mb, 0.4], [pb, 0.6]]), meta: skinMeta(1, 'knuckle'), tag: 'K1' },
      { j: D.pp, d: D.web * 0.5, pr: lerpProfile(knuckle, P('proximal'), 0.8), w: [[pb, 0.75], [mb, 0.25]], meta: skinMeta(), tag: 'K2', reducedSkip: true },
      { j: D.pp, d: D.web, pr: P('proximal'), w: [[pb, 0.92], [mb, 0.08]], meta: skinMeta(), tag: 'W' },
      { j: D.pp, d: 0.55 * D.Lpp, pr: P('proximal', { palmarScale: 1.06 }), w: [[pb, 1]], meta: skinMeta(), tag: 'Pmid', reducedSkip: true },
      { j: D.pp, d: D.Lpp - 0.007, pr: lerpProfile(P('proximal'), P('pip'), 0.5), w: [[pb, 0.88], [ib, 0.12]], meta: skinMeta(), tag: 'PIP-' },
      { j: D.pp, d: D.Lpp - 0.0015, pr: lerpProfile(P('proximal'), P('pip'), 0.9), w: [[pb, 0.7], [ib, 0.3]], meta: skinMeta(), tag: 'PIP-2', reducedSkip: true },
      { j: D.pm, d: 0, pr: P('pip', { bumps: [{ center: Math.PI / 2, width: 0.7, amp: 0.8 }] }), w: [[pb, 0.5], [ib, 0.5]], meta: skinMeta(1, 'palmar'), tag: 'PIP' },
      { j: D.pm, d: 0.0015, pr: lerpProfile(P('pip'), P('middle'), 0.25), w: [[ib, 0.7], [pb, 0.3]], meta: skinMeta(), tag: 'PIP+2', reducedSkip: true },
      { j: D.pm, d: 0.007, pr: lerpProfile(P('pip'), P('middle'), 0.65), w: [[ib, 0.88], [pb, 0.12]], meta: skinMeta(), tag: 'PIP+' },
      { j: D.pm, d: 0.55 * D.Lpm, pr: P('middle', { palmarScale: 1.05 }), w: [[ib, 1]], meta: skinMeta(), tag: 'Mmid', reducedSkip: true },
      { j: D.pm, d: D.Lpm - 0.006, pr: lerpProfile(P('middle'), P('dip'), 0.5), w: [[ib, 0.88], [db, 0.12]], meta: skinMeta(), tag: 'DIP-' },
      { j: D.pm, d: D.Lpm - 0.0015, pr: lerpProfile(P('middle'), P('dip'), 0.9), w: [[ib, 0.7], [db, 0.3]], meta: skinMeta(), tag: 'DIP-2', reducedSkip: true },
      { j: D.pd, d: 0, pr: P('dip', { bumps: [{ center: Math.PI / 2, width: 0.7, amp: 0.5 }] }), w: [[ib, 0.5], [db, 0.5]], meta: skinMeta(1, 'palmar'), tag: 'DIP' },
      { j: D.pd, d: 0.0015, pr: lerpProfile(P('dip'), P('distal'), 0.25), w: [[db, 0.7], [ib, 0.3]], meta: skinMeta(), tag: 'DIP+2', reducedSkip: true },
      { j: D.pd, d: 0.006, pr: lerpProfile(P('dip'), P('distal'), 0.65), w: [[db, 0.88], [ib, 0.12]], meta: skinMeta(), tag: 'DIP+' },
      { j: D.pd, d: 0.5 * Ltip, pr: P('pad', { palmarScale: 1.18, dorsalScale: 0.9 }), w: [[db, 1]], meta: skinMeta(), tag: 'pad' },
      { j: D.pd, d: 0.76 * Ltip, pr: lerpProfile(P('pad', { palmarScale: 1.1, dorsalScale: 0.84 }), P('tip', { dorsalScale: 0.86 }), 0.4), w: [[db, 1]], meta: skinMeta(), tag: 'nail', reducedSkip: true },
      { j: D.pd, d: 0.9 * Ltip, pr: P('tip', { dorsalScale: 0.9, palmarScale: 1.05 }), w: [[db, 1]], meta: skinMeta(), tag: 'tip' },
      { j: D.pd, d: 0.965 * Ltip, pr: scaleProfile(P('tip', { dorsalScale: 0.9, palmarScale: 1.0 }), 0.66), w: [[db, 1]], meta: skinMeta(), tag: 'tip2' },
      { j: D.pd, d: 0.992 * Ltip, pr: scaleProfile(P('tip'), 0.32), w: [[db, 1]], meta: skinMeta(), tag: 'tip3', reducedSkip: true },
    ];
    return { list: list.filter((s) => !(L.reduced && s.reducedSkip)), capAt: along(D.pd, Ltip), capW: [[db, 1]], capDir: rot(D.pd.restWorldRot, [0, 0, -1]) };
  };
  const webTop = {}; // f -> station index of the web top in rings[f]
  const distalProfiles = {}; // f -> [{ d, pts }] for the distal phalanx, for the nail height
  for (const f of fingerOrder) {
    const sched = fingerSchedule(f);
    distalProfiles[f] = [];
    for (const st of sched.list) {
      const r = ring(st.j.restWorldRot, along(st.j, st.d), st.pr, st.w, st.meta);
      rings[f].push(r);
      if (st.tag === 'W') webTop[f] = rings[f].length - 1;
      if (st.j === fingerData[f].pd) distalProfiles[f].push({ d: st.d, pts: st.pr });
    }
    const cap = b.vertex(sched.capAt, sched.capW, { region: REGION.SKIN, palmar: 0.5, shade: 1 });
    rings[f].cap = cap;
    rings[f].capDir = sched.capDir;
  }
  // Bridge finger stations; inside the web membrane (K0 .. W) the facing sides stay open.
  for (let k = 0; k < fingerOrder.length; k++) {
    const f = fingerOrder[k];
    const hasRadial = k < fingerOrder.length - 1; // neighbour toward the index side
    const hasUlnar = k > 0;
    const R_ = rings[f];
    for (let s = 0; s + 1 < R_.length; s++) {
      const skip = new Set();
      if (s < webTop[f]) {
        if (hasRadial) skip.add(F - 1);
        if (hasUlnar) skip.add(NF - 1);
      }
      b.bridge(R_[s], R_[s + 1], skip);
    }
    b.fan(R_[R_.length - 1], R_.cap, R_.capDir);
  }
  // Web membranes between neighbours: dorsal and palmar strips up to the web top, then the free edge.
  for (let k = 0; k + 1 < fingerOrder.length; k++) {
    const fk = fingerOrder[k];
    const fk1 = fingerOrder[k + 1];
    const top = Math.min(webTop[fk], webTop[fk1]);
    for (let s = 0; s < top; s++) {
      const A = rings[fk][s], A1 = rings[fk][s + 1];
      const B = rings[fk1][s], B1 = rings[fk1][s + 1];
      // dorsal gap edge: k[F-1] -> k1[0]
      b.quad(A[F - 1], A1[F - 1], B1[0], B[0]);
      // palmar gap edge: k1[NF-1] -> k[F]
      b.quad(B[NF - 1], B1[NF - 1], A1[F], A[F]);
    }
    const A = rings[fk][top], B = rings[fk1][top];
    const outward = v3.normalize([0, 0, 0], v3.add([0, 0, 0], rings[fk].capDir, rings[fk1].capDir));
    b.quadOut(A[F - 1], B[0], B[NF - 1], A[F], outward);
    // If one finger's web top is higher, its extra membrane stations continue as its own sides:
    // the bridge skip only ran below each finger's own webTop, so close any mismatch here.
    for (const [f, other] of [[fk, fk1], [fk1, fk]]) {
      for (let s = top; s < webTop[f]; s++) {
        const R_ = rings[f];
        const side = f === fk ? F - 1 : NF - 1;
        const i = side, j = (side + 1) % NF;
        b.quad(R_[s][i], R_[s + 1][i], R_[s + 1][j], R_[s][j]);
      }
      void other;
    }
  }

  // ---- Thumb tube ----
  const tm = J('thumb-metacarpal');
  const tp = J('thumb-phalanx-proximal');
  const td = J('thumb-phalanx-distal');
  const tmb = bi('thumb-metacarpal');
  const tpb = bi('thumb-phalanx-proximal');
  const tdb = bi('thumb-phalanx-distal');
  const TS = S.thumb;
  const TP = (key, o) => profile(NF, TS[key][0], TS[key][1], { n: 2.3, ...o });
  // Half frame between the palm plane and the thumb axis for the first thumb station.
  const thumbAxis = rot(tm.restWorldRot, [0, 0, -1]);
  // Frames tilted part way from the palm plane toward the thumb axis, so the
  // thenar bends smoothly out of the palm instead of kinking.
  const tiltFrame = (t) => {
    const dir = v3.normalize([0, 0, 0], v3.lerp([0, 0, 0], rot(wq, [0, 0, -1]), thumbAxis, t));
    const z = v3.negate([0, 0, 0], dir);
    const y = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], rot(tm.restWorldRot, [0, 1, 0]), z));
    const x = v3.cross([0, 0, 0], y, z);
    return quat.fromBasis([0, 0, 0, 1], x, y, z);
  };
  const Ltm = tm.length, Ltp = tp.length, Ltd = td.length;
  const thumbSchedule = [
    // The thenar: a broad flat wedge that narrows into the thumb over the
    // metacarpal, so the thumb rises from a mound rather than a tube.
    { q: tiltFrame(0.5), c: along(tm, 0.52 * Ltm), pr: TP('base', { n: 2.4, palmarScale: 1.2, dorsalScale: 0.9 }), w: [[tmb, 0.7], [bi('wrist'), 0.3]], meta: skinMeta() },
    { q: tiltFrame(0.85), c: along(tm, 0.72 * Ltm), pr: lerpProfile(TP('base', { n: 2.4, palmarScale: 1.1 }), TP('metacarpal'), 0.7), w: [[tmb, 0.9], [bi('wrist'), 0.1]], meta: skinMeta() },
    { q: tm.restWorldRot, c: along(tm, Ltm - 0.007), pr: lerpProfile(TP('metacarpal'), TP('mcp'), 0.5), w: [[tmb, 0.88], [tpb, 0.12]], meta: skinMeta() },
    { q: tm.restWorldRot, c: along(tm, Ltm - 0.0015), pr: lerpProfile(TP('metacarpal'), TP('mcp'), 0.9), w: [[tmb, 0.7], [tpb, 0.3]], meta: skinMeta(), reducedSkip: true },
    { q: tp.restWorldRot, c: along(tp, 0), pr: TP('mcp'), w: [[tmb, 0.5], [tpb, 0.5]], meta: skinMeta() },
    { q: tp.restWorldRot, c: along(tp, 0.0015), pr: lerpProfile(TP('mcp'), TP('proximal'), 0.25), w: [[tpb, 0.7], [tmb, 0.3]], meta: skinMeta(), reducedSkip: true },
    { q: tp.restWorldRot, c: along(tp, 0.007), pr: lerpProfile(TP('mcp'), TP('proximal'), 0.65), w: [[tpb, 0.88], [tmb, 0.12]], meta: skinMeta() },
    { q: tp.restWorldRot, c: along(tp, 0.55 * Ltp), pr: TP('proximal', { palmarScale: 1.06 }), w: [[tpb, 1]], meta: skinMeta(), reducedSkip: true },
    { q: tp.restWorldRot, c: along(tp, Ltp - 0.006), pr: lerpProfile(TP('proximal'), TP('ip'), 0.5), w: [[tpb, 0.88], [tdb, 0.12]], meta: skinMeta() },
    { q: tp.restWorldRot, c: along(tp, Ltp - 0.0015), pr: lerpProfile(TP('proximal'), TP('ip'), 0.9), w: [[tpb, 0.7], [tdb, 0.3]], meta: skinMeta(), reducedSkip: true },
    { q: td.restWorldRot, c: along(td, 0), pr: TP('ip', { bumps: [{ center: Math.PI / 2, width: 0.7, amp: 0.7 }] }), w: [[tpb, 0.5], [tdb, 0.5]], meta: skinMeta(1, 'palmar') },
    { q: td.restWorldRot, c: along(td, 0.0015), pr: lerpProfile(TP('ip'), TP('distal'), 0.25), w: [[tdb, 0.7], [tpb, 0.3]], meta: skinMeta(), reducedSkip: true },
    { q: td.restWorldRot, c: along(td, 0.006), pr: lerpProfile(TP('ip'), TP('distal'), 0.65), w: [[tdb, 0.88], [tpb, 0.12]], meta: skinMeta() },
    { q: td.restWorldRot, c: along(td, 0.5 * Ltd), pr: TP('pad', { palmarScale: 1.18, dorsalScale: 0.9 }), w: [[tdb, 1]], meta: skinMeta() },
    { q: td.restWorldRot, c: along(td, 0.76 * Ltd), pr: lerpProfile(TP('pad', { palmarScale: 1.1, dorsalScale: 0.84 }), TP('tip', { dorsalScale: 0.86 }), 0.4), w: [[tdb, 1]], meta: skinMeta(), reducedSkip: true },
    { q: td.restWorldRot, c: along(td, 0.9 * Ltd), pr: TP('tip', { dorsalScale: 0.9, palmarScale: 1.05 }), w: [[tdb, 1]], meta: skinMeta() },
    { q: td.restWorldRot, c: along(td, 0.965 * Ltd), pr: scaleProfile(TP('tip', { dorsalScale: 0.9 }), 0.66), w: [[tdb, 1]], meta: skinMeta() },
    { q: td.restWorldRot, c: along(td, 0.992 * Ltd), pr: scaleProfile(TP('tip'), 0.32), w: [[tdb, 1]], meta: skinMeta(), reducedSkip: true },
  ].filter((s) => !(L.reduced && s.reducedSkip));
  let prevT = null;
  const thumbDistalProfiles = [];
  for (let s = 0; s < thumbSchedule.length; s++) {
    const st = thumbSchedule[s];
    if (st.q === td.restWorldRot) thumbDistalProfiles.push({ d: v3.dist(st.c, td.restWorldPos), pts: st.pr });
    const r = ring(st.q, st.c, st.pr, st.w, st.meta);
    if (s === 0) {
      const runAligned = alignRing(b, r, thumbRun);
      b.bridge(runAligned, r);
    } else {
      b.bridge(prevT, r);
    }
    prevT = r;
  }
  const thumbCap = b.vertex(along(td, Ltd), [[tdb, 1]], { region: REGION.SKIN, palmar: 0.5, shade: 1 });
  b.fan(prevT, thumbCap, rot(td.restWorldRot, [0, 0, -1]));

  // ---- Fingernails: closed plates on the distal phalanges ----
  const [cellsX, cellsY] = L.nailCells;
  // Dorsal skin height (metres) of a station ring at lateral offset x, from
  // the dorsal half of its profile points (ordered +X toward -X).
  function dorsalOfPts(pts, x) {
    const dorsal = pts.filter((p) => p[2] < Math.PI);
    for (let i = 0; i + 1 < dorsal.length; i++) {
      const a = dorsal[i], b = dorsal[i + 1];
      if ((x <= a[0] && x >= b[0]) || (x >= a[0] && x <= b[0])) {
        const t = Math.abs(b[0] - a[0]) < 1e-12 ? 0 : (x - a[0]) / (b[0] - a[0]);
        return lerp(a[1], b[1], t);
      }
    }
    return Math.max(...dorsal.map((p) => p[1]));
  }
  // Skin height along the distal phalanx at distance u, interpolated between
  // the actual loft stations and continued on the last tangent past the tip.
  // Half width of the dorsal surface at distance u along the distal phalanx.
  function skinHalfWidth(profiles, u) {
    const P = profiles.slice().sort((a, b) => a.d - b.d);
    const hw = (pts) => Math.max(...pts.filter((p) => p[2] < Math.PI).map((p) => Math.abs(p[0])));
    if (u <= P[0].d) return hw(P[0].pts);
    for (let i = 0; i + 1 < P.length; i++) {
      if (u >= P[i].d && u <= P[i + 1].d) return lerp(hw(P[i].pts), hw(P[i + 1].pts), (u - P[i].d) / (P[i + 1].d - P[i].d));
    }
    return hw(P[P.length - 1].pts);
  }
  function skinDorsal(profiles, u, x) {
    const P = profiles.slice().sort((a, b) => a.d - b.d);
    if (u <= P[0].d) return dorsalOfPts(P[0].pts, x);
    for (let i = 0; i + 1 < P.length; i++) {
      if (u >= P[i].d && u <= P[i + 1].d) {
        const t = (u - P[i].d) / (P[i + 1].d - P[i].d);
        return lerp(dorsalOfPts(P[i].pts, x), dorsalOfPts(P[i + 1].pts, x), t);
      }
    }
    const a = P[P.length - 2], b = P[P.length - 1];
    const slope = (dorsalOfPts(b.pts, x) - dorsalOfPts(a.pts, x)) / (b.d - a.d);
    return dorsalOfPts(b.pts, x) + slope * (u - b.d);
  }
  // The skin actually drawn over a distal phalanx, in that joint's frame: the
  // triangles already built whose vertices all ride mostly on its bone.
  // The plate sits on these facets, not on the smooth profile they were
  // lofted from; seated on the profile, the faceted skin rounded over the
  // sides of the tip rose through the plate by up to a millimetre.
  function skinUnder(joint, boneIndex) {
    const inv = quat.conjugate([0, 0, 0, 1], joint.restWorldRot);
    const onBone = (i) => b.meta[i].region === REGION.SKIN && b.w[i].some(([bone, wt]) => bone === boneIndex && wt > 0.5);
    const tris = [];
    for (let t = 0; t < b.tri.length; t += 3) {
      const ids = [b.tri[t], b.tri[t + 1], b.tri[t + 2]];
      if (!ids.every(onBone)) continue;
      tris.push(ids.map((i) => quat.rotate([0, 0, 0], inv, v3.sub([0, 0, 0], b.point(i), joint.restWorldPos))));
    }
    // Highest skin at (x, z) in the joint frame, or -Infinity off the skin.
    return (x, z) => {
      let best = -Infinity;
      for (const [p0, p1, p2] of tris) {
        const d = (p1[2] - p2[2]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[2] - p2[2]);
        if (Math.abs(d) < 1e-14) continue;
        const w1 = ((p1[2] - p2[2]) * (x - p2[0]) + (p2[0] - p1[0]) * (z - p2[2])) / d;
        const w2 = ((p2[2] - p0[2]) * (x - p2[0]) + (p0[0] - p2[0]) * (z - p2[2])) / d;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
        best = Math.max(best, w1 * p0[1] + w2 * p1[1] + w3 * p2[1]);
      }
      return best;
    };
  }
  function nail(joint, boneIndex, sec, Ltip, profiles) {
    const skinAt = skinUnder(joint, boneIndex);
    const w = sec.distal[0] * NAIL.width;
    const u0 = (1 - NAIL.length) * Ltip;
    // The plate ends where the tip starts to round off, plus the free edge.
    const u1 = 0.93 * Ltip + NAIL.freeEdge;
    const q = joint.restWorldRot;
    // First pass: where each grid point sits (u along the bone, xs across,
    // y the skin height under it, all in millimetres).
    const grid = [];
    for (let iy = 0; iy <= cellsY; iy++) {
      const ty = iy / cellsY;
      const u = lerp(u0, u1, ty);
      const row = [];
      for (let ix = 0; ix <= cellsX; ix++) {
        const tx = ix / cellsX;
        const x = lerp(-w / 2, w / 2, tx);
        // Nail width narrows toward the base a little and never exceeds the
        // skin it sits on, so it curves over the rounded tip instead of
        // hanging past it.
        const cap = 0.82 * skinHalfWidth(profiles, Math.min(u, 0.965 * Ltip)) / MM;
        const xs = x * lerp(0.85, 1, ty) * Math.min(1, cap / (w / 2));
        // On the drawn skin where there is skin under the point, on the
        // profile past the end of it (the free edge overhangs the tip).
        const drawn = skinAt(xs * MM, -u);
        const y = Math.max(skinDorsal(profiles, u, xs * MM), Number.isFinite(drawn) ? drawn : -Infinity) / MM;
        row.push({ u, xs, y, ty });
      }
      grid.push(row);
    }
    // Second pass: a flat plate facet spans a curved patch of skin, so the
    // skin can bulge above it between grid points. Sample each cell's
    // interior and edges and lift its corners by any bulge found.
    for (let pass = 0; pass < 2; pass++) {
      for (let iy = 0; iy < cellsY; iy++) {
        for (let ix = 0; ix < cellsX; ix++) {
          const c = [grid[iy][ix], grid[iy][ix + 1], grid[iy + 1][ix + 1], grid[iy + 1][ix]];
          let bulge = 0;
          for (const [s1, s2] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]) {
            const lerp4 = (k) => lerp(lerp(c[0][k], c[1][k], s1), lerp(c[3][k], c[2][k], s1), s2);
            const skin = skinAt(lerp4('xs') * MM, -lerp4('u'));
            if (Number.isFinite(skin)) bulge = Math.max(bulge, skin / MM - lerp4('y'));
          }
          if (bulge > 0) for (const g of c) g.y = Math.max(g.y, g.y + bulge);
        }
      }
    }
    const top = [];
    const bottom = [];
    for (let iy = 0; iy <= cellsY; iy++) {
      const rowTop = [];
      const rowBottom = [];
      for (let ix = 0; ix <= cellsX; ix++) {
        const { u, xs, y, ty } = grid[iy][ix];
        const region = iy === cellsY ? REGION.NAIL_EDGE : REGION.NAIL;
        const meta = { region, palmar: 0, shade: 1, lunula: ty < 0.25 ? 1 - ty / 0.25 : 0, edge: ty };
        const pt = v3.add([0, 0, 0], along(joint, u), rot(q, [xs * MM, y * MM + NAIL.lift, 0]));
        const pb = v3.add([0, 0, 0], along(joint, u), rot(q, [xs * MM, y * MM - 0.5 * MM, 0]));
        rowTop.push(b.vertex(pt, [[boneIndex, 1]], meta));
        rowBottom.push(b.vertex(pb, [[boneIndex, 1]], { ...meta, region: REGION.NAIL }));
      }
      top.push(rowTop);
      bottom.push(rowBottom);
    }
    const up = rot(q, [0, 1, 0]);
    const down = v3.negate([0, 0, 0], up);
    for (let iy = 0; iy < cellsY; iy++) {
      for (let ix = 0; ix < cellsX; ix++) {
        b.quadOut(top[iy][ix], top[iy][ix + 1], top[iy + 1][ix + 1], top[iy + 1][ix], up);
        b.quadOut(bottom[iy][ix], bottom[iy][ix + 1], bottom[iy + 1][ix + 1], bottom[iy + 1][ix], down);
      }
    }
    // Walls around the perimeter.
    const perim = [];
    for (let ix = 0; ix < cellsX; ix++) perim.push([[0, ix], [0, ix + 1]]);
    for (let iy = 0; iy < cellsY; iy++) perim.push([[iy, cellsX], [iy + 1, cellsX]]);
    for (let ix = cellsX; ix > 0; ix--) perim.push([[cellsY, ix], [cellsY, ix - 1]]);
    for (let iy = cellsY; iy > 0; iy--) perim.push([[iy, 0], [iy - 1, 0]]);
    const centre = b.point(top[Math.floor(cellsY / 2)][Math.floor(cellsX / 2)]);
    for (const [[ay, ax], [cy, cx]] of perim) {
      const t0 = top[ay][ax], t1 = top[cy][cx], b0 = bottom[ay][ax], b1 = bottom[cy][cx];
      const mid = v3.scale([0, 0, 0], v3.add([0, 0, 0], b.point(t0), b.point(t1)), 0.5);
      const outward = v3.sub([0, 0, 0], mid, centre);
      b.quadOut(t0, t1, b1, b0, outward);
    }
  }
  for (const f of FINGERS) {
    const D = fingerData[f];
    nail(D.pd, bi(`${XR_PREFIX[f]}-phalanx-distal`), D.sec, D.Lpd, distalProfiles[f]);
  }
  nail(td, tdb, TS, Ltd, thumbDistalProfiles);

  // ---- Short sleeve over the upper arm: a closed cloth shell ----
  const clothMeta = (inner) => () => ({ region: inner ? REGION.CLOTH_INNER : REGION.CLOTH, palmar: 0, shade: 1 });
  const grow = (pr, k) => [pr[0] + 2 * k, pr[1] + 2 * k];
  const sleeveStations = [
    // The dome over the shoulder is weighted as the skin cap under it is
    // (half shoulder, half upper arm): weighted apart, a raised and turned
    // arm pushed the skin out through the dome.
    { d: -0.012, pr: grow(S.upperArm.shoulder, S.sleeve), w: [[bi('shoulder'), 0.5], [bi('upper-arm'), 0.5]], inner: false },
    { d: 0.12 * Lua, pr: grow(S.upperArm.deltoid, S.sleeve + 1), w: [[bi('upper-arm'), 1]], inner: false },
    { d: 0.36 * Lua, pr: grow(S.upperArm.mid, S.sleeve + 2), w: [[bi('upper-arm'), 1]], inner: false },
    { d: 0.6 * Lua, pr: grow(S.upperArm.mid, S.sleeve + 4), w: [[bi('upper-arm'), 1]], inner: false },
    { d: 0.6 * Lua + 0.004, pr: grow(S.upperArm.mid, 3), w: [[bi('upper-arm'), 1]], inner: true },
    { d: 0.45 * Lua, pr: grow(S.upperArm.mid, 2), w: [[bi('upper-arm'), 1]], inner: true },
  ];
  let prevS = null;
  let firstS = null;
  let lastS = null;
  for (const st of sleeveStations) {
    const r = ring(ua.restWorldRot, along(ua, st.d), profile(NA, st.pr[0], st.pr[1], { n: 2.1 }), st.w, clothMeta(st.inner));
    if (!firstS) firstS = r;
    if (prevS) b.bridge(prevS, r);
    prevS = r;
    lastS = r;
  }
  const domeCentre = b.vertex(along(ua, -0.034), [[bi('shoulder'), 0.5], [bi('upper-arm'), 0.5]], { region: REGION.CLOTH, palmar: 0, shade: 1 });
  b.fan(firstS, domeCentre, [0, 0, 1]);
  const innerCentre = b.vertex(along(ua, 0.44 * Lua), [[bi('upper-arm'), 1]], { region: REGION.CLOTH_INNER, palmar: 0, shade: 1 });
  // The inner cap faces the hollow where the arm sits, which is distal of it.
  b.fan(lastS, innerCentre, [0, 0, -1]);

  return finish(b, side);
}

// Pack the builder into typed arrays, compute smooth normals, mirror for the left.
function finish(b, side) {
  const n = b.pos.length / 3;
  const positions = new Float32Array(b.pos);
  const indices = new Uint32Array(b.tri);
  if (side === 'left') {
    for (let i = 0; i < n; i++) positions[i * 3] = -positions[i * 3];
    for (let t = 0; t < indices.length; t += 3) {
      const tmp = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = tmp;
    }
  }
  const normals = new Float32Array(n * 3);
  const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], c = indices[t + 1], d = indices[t + 2];
    v3.set(p, positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
    v3.set(q, positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]);
    v3.set(r, positions[d * 3], positions[d * 3 + 1], positions[d * 3 + 2]);
    const fn = v3.cross([0, 0, 0], v3.sub([0, 0, 0], q, p), v3.sub([0, 0, 0], r, p));
    for (const idx of [a, c, d]) {
      normals[idx * 3] += fn[0]; normals[idx * 3 + 1] += fn[1]; normals[idx * 3 + 2] += fn[2];
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
  }
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const w = b.w[i];
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = k < w.length ? w[k][0] : 0;
      skinWeight[i * 4 + k] = k < w.length ? w[k][1] : 0;
    }
  }
  return {
    side,
    positions,
    normals,
    indices,
    skinIndex,
    skinWeight,
    meta: b.meta,
    stats: { vertices: n, triangles: indices.length / 3 },
  };
}

// ---- Colour ----
function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];


export function colorize(mesh, { skinTone = DEFAULTS.skinTone, shirt = DEFAULTS.sleeveColour } = {}) {
  // The tone's own palette (skin.js): the dorsal colour from the Monk scale,
  // a lighter palm, and nail bed, lunula and free edge for that tone.
  const { dorsal, palm, nailBed, nailEdge, lunula } = skinPalette(skinTone);
  const cloth = hexToRgb(shirt);
  const clothInner = mul(cloth, 0.5);
  const n = mesh.stats.vertices;
  const color = new Float32Array(n * 3);
  const roughness = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = mesh.meta[i];
    let c;
    let r;
    switch (m.region) {
      case REGION.NAIL:
        c = mix(nailBed, lunula, 0.6 * (m.lunula || 0));
        r = 0.55;
        break;
      case REGION.NAIL_EDGE:
        c = nailEdge;
        r = 0.55;
        break;
      case REGION.CLOTH:
        c = cloth;
        r = 0.92;
        break;
      case REGION.CLOTH_INNER:
        c = clothInner;
        r = 0.95;
        break;
      default: {
        // The palm's lighter colour is palmar (glabrous) skin's alone: its
        // melanocyte density is a fifth of other sites' (Yamaguchi Y et al.
        // J Cell Biol 2004;165(2):275-285). The volar forearm is not
        // glabrous, so it keeps the dorsal colour; the change sits at the
        // wrist crease. Vertices with no glabrous mark are the hand's.
        c = mix(dorsal, palm, m.palmar * (m.glabrous ?? 1));
        // Gentle mottling from the rest position (about 3 cm wavelength, plus
        // or minus 4 percent) so large flat areas do not read as plastic.
        const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
        const mottle = 1 + 0.04 * (Math.sin(210 * x + 1.7) * Math.sin(180 * y + 0.4) + 0.6 * Math.sin(150 * z + 240 * x));
        c = mul(c, m.shade * mottle);
        r = lerp(0.72, 0.78, m.palmar);
      }
    }
    color[i * 3] = srgbToLinear(c[0]);
    color[i * 3 + 1] = srgbToLinear(c[1]);
    color[i * 3 + 2] = srgbToLinear(c[2]);
    roughness[i] = r;
  }
  return { color, roughness };
}

// Manifold check: every edge shared by exactly two triangles with opposite
// direction. Returns { ok, openEdges, badEdges }.
export function manifoldReport(mesh) {
  const edges = new Map();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k], c = tri[(k + 1) % 3];
      const key = a < c ? `${a}-${c}` : `${c}-${a}`;
      const dir = a < c ? 1 : -1;
      const e = edges.get(key) || { count: 0, dirSum: 0 };
      e.count++;
      e.dirSum += dir;
      edges.set(key, e);
    }
  }
  let openEdges = 0;
  let badEdges = 0;
  for (const e of edges.values()) {
    if (e.count === 1) openEdges++;
    else if (e.count !== 2 || e.dirSum !== 0) badEdges++;
  }
  return { ok: openEdges === 0 && badEdges === 0, openEdges, badEdges, edges: edges.size };
}
