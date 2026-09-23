// The Nigerian slingshot: a forked branch with natural taper and a slight
// crook, bark and wood tone variation, twine wraps at the prong tips and the
// crotch, two rubber strips cut from inner tube and a leather pouch. The
// fork mesh is static; bands and pouch are rebuilt every frame from the fork
// transform and the pouch position, stretching and thinning with draw and
// ringing with a damped oscillation after release.
//
// Fork frame: origin at the grip centre of the handle, +Y up the handle,
// prongs spread along X, -Z is the aim (away from the player), bands trail
// toward +Z. Units are metres.
import { v3, quat, lerp, clamp, smoothstep } from '../../../hands/src/math.js';
import { Oscillator } from '../../../hands/src/springs.js';
import { mulberry32 } from '../../../hands/src/rng.js';

export const FORK = {
  handleLength: 0.115,
  handleRadius: 0.014,        // 28 mm handle, inside the 25 to 30 mm the spec gives
  prongLength: 0.105,
  prongRadius: 0.0085,
  prongTipRadius: 0.0065,
  spread: 0.10,               // tip to tip
  crook: 0.006,               // lateral wander of the handle
  gripCentre: 0.0,            // y of the grasp centre
  crotchY: 0.055,             // where the prongs leave the handle
};

// The handle as the grasp solver sees it: the fork's own radius and length,
// so the fingers wrap its side and none of them curls around an end.
export const HANDLE_GRIP = { shape: 'cylinder', r: FORK.handleRadius, h: FORK.handleLength };

export const BAND = {
  width: 0.016,
  thickness: 0.003,
  restLength: 0.19,           // each strip, tip to pouch, unstretched
  segments: 12,
};

export const POUCH = {
  length: 0.07,               // along the band axis
  width: 0.035,
  thickness: 0.0025,
  cols: 10,
  rows: 5,
};

// Draw geometry: the pouch is pulled to the cheek anchor; the fork gap
// centre sits on the aim ray from the anchor. Settling target after release.
export const RELEASE_OSC = { hz: 9, zeta: 0.3 };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex) => { const v = parseInt(hex.slice(1), 16); return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)]; };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const BARK = lin('#5A4431');
const BARK_LIGHT = lin('#7C6349');
const BARK_DARK = lin('#3E2E20');
const WOOD = lin('#C9A97C');
const TWINE = lin('#B99A62');
const TWINE_DARK = lin('#8E7546');
const RUBBER = lin('#34353A');
const RUBBER_LIGHT = lin('#5A5B60');
const LEATHER = lin('#6E4A2A');
const LEATHER_DARK = lin('#4D3218');

// Quadratic bezier helpers.
// base + dir * s
const off = (base, dir, s) => v3.addScaled([0, 0, 0], base, dir, s);

function bez(p0, p1, p2, t) {
  const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1], a * p0[2] + b * p1[2] + c * p2[2]];
}
function bezTangent(p0, p1, p2, t) {
  return v3.normalize([0, 0, 0], [2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]), 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]), 2 * (1 - t) * (p1[2] - p0[2]) + 2 * t * (p2[2] - p1[2])]);
}
function frameAlong(tangent, up = [0, 1, 0]) {
  let n = v3.reject([0, 0, 0], Math.abs(v3.dot(tangent, up)) > 0.95 ? [1, 0, 0] : up, tangent);
  n = v3.normalize(n, n);
  const b = v3.cross([0, 0, 0], tangent, n);
  return { n, b };
}

class MeshBuilder {
  constructor() { this.pos = []; this.col = []; this.tri = []; }
  vertex(p, c) { this.pos.push(p[0], p[1], p[2]); this.col.push(c[0], c[1], c[2]); return this.pos.length / 3 - 1; }
  tri3(a, b, c) { this.tri.push(a, b, c); }
  quad(a, b, c, d) { this.tri3(a, b, c); this.tri3(a, c, d); }
  bridge(A, B) { const n = A.length; for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.quad(A[i], B[i], B[j], A[j]); } }
  fan(loop, centre, flip) { const n = loop.length; for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (flip) this.tri3(loop[j], loop[i], centre); else this.tri3(loop[i], loop[j], centre); } }
  finish() {
    const n = this.pos.length / 3;
    const positions = new Float32Array(this.pos);
    const colors = new Float32Array(this.col);
    const indices = new Uint32Array(this.tri);
    const normals = new Float32Array(n * 3);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const fn = v3.cross([0, 0, 0], e1, e2);
      for (const k of [a, b, c]) { normals[k] += fn[0]; normals[k + 1] += fn[1]; normals[k + 2] += fn[2]; }
    }
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
      normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
    }
    return { positions, normals, colors, indices, stats: { vertices: n, triangles: indices.length / 3 } };
  }
}

// Tube along a curve: stations sampled at t in [0, 1], radius(t), colour(t, angle).
function tube(b, curve, tangentAt, radiusAt, colourAt, stations, sides, rng, barkAmp, capStart, capEnd) {
  let prev = null;
  let first = null;
  let last = null;
  for (let s = 0; s <= stations; s++) {
    const t = s / stations;
    const c = curve(t);
    const tan = tangentAt(t);
    const { n, b: bn } = frameAlong(tan);
    const r = radiusAt(t);
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const bark = 1 + barkAmp * (rng() - 0.5);
      const p = off(off(c, n, Math.cos(a) * r * bark), bn, Math.sin(a) * r * bark);
      ring.push(b.vertex(p, colourAt(t, a, bark)));
    }
    if (prev) b.bridge(prev, ring);
    if (!first) first = ring;
    prev = ring;
    last = ring;
  }
  if (capStart) b.fan(first, b.vertex(curve(0), capStart), true);
  if (capEnd) b.fan(last, b.vertex(curve(1), capEnd), false);
  return { first, last };
}

// Helical twine ribbon around a curve between t0 and t1.
function twine(b, curve, tangentAt, radiusAt, t0, t1, turns, colour) {
  const steps = Math.max(8, Math.round(turns * 10));
  let prev = null;
  const ribbonHalf = 0.0012;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const t = lerp(t0, t1, u);
    const c = curve(t);
    const tan = tangentAt(t);
    const { n, b: bn } = frameAlong(tan);
    const a = u * turns * Math.PI * 2;
    const r = radiusAt(t) + 0.0015;
    const centre = off(off(c, n, Math.cos(a) * r), bn, Math.sin(a) * r);
    const outward = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], centre, c));
    const along = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], tan, outward));
    void along;
    const p0 = off(centre, tan, -ribbonHalf);
    const p1 = off(centre, tan, ribbonHalf);
    const q0 = off(p0, outward, 0.0012);
    const q1 = off(p1, outward, 0.0012);
    const shade = mix3(colour, TWINE_DARK, 0.5 + 0.5 * Math.sin(a * 3));
    const ids = [b.vertex(q0, shade), b.vertex(q1, shade)];
    if (prev) { b.quad(prev[0], prev[1], ids[1], ids[0]); b.quad(prev[1], prev[0], ids[0], ids[1]); }
    prev = ids;
  }
}

// Static fork mesh in the fork frame. Returns geometry plus the tip
// attachment points and the crotch.
export function buildFork(seed = 5, { lod = 'high' } = {}) {
  const rng = mulberry32(seed);
  const b = new MeshBuilder();
  const F = FORK;
  const low = lod === 'low';
  const sides = low ? 10 : 14;
  const stations = low ? 7 : 12;
  const turns = low ? 4 : 7;
  // Handle: from the butt (below the grip) up to the crotch, with a crook.
  const h0 = [0, -F.handleLength * 0.55, 0];
  const h1 = [F.crook, F.handleLength * 0.05, -F.crook * 0.6];
  const h2 = [0, F.crotchY, 0];
  const handleCurve = (t) => bez(h0, h1, h2, t);
  const handleTan = (t) => bezTangent(h0, h1, h2, t);
  const handleRadius = (t) => F.handleRadius * (1.05 - 0.12 * t) * (1 + 0.04 * Math.sin(t * 9));
  const barkColour = (t, a, bark) => {
    const grain = 0.5 + 0.5 * Math.sin(a * 5 + t * 30);
    let c = mix3(BARK, BARK_LIGHT, grain * 0.6);
    c = mix3(c, BARK_DARK, clamp((bark - 1) * -6, 0, 1) * 0.6);
    return c;
  };
  tube(b, handleCurve, handleTan, handleRadius, barkColour, stations, sides, rng, 0.06, WOOD, null);
  // Prongs: from the crotch, diverging and curving a little forward.
  const tips = [];
  for (const side of [-1, 1]) {
    const p0 = [side * F.handleRadius * 0.35, F.crotchY - 0.004, 0];
    const p1 = [side * F.spread * 0.28, F.crotchY + F.prongLength * 0.55, -0.004];
    const p2 = [side * F.spread / 2, F.crotchY + F.prongLength * 0.92, -0.008];
    const curve = (t) => bez(p0, p1, p2, t);
    const tan = (t) => bezTangent(p0, p1, p2, t);
    const radius = (t) => lerp(F.prongRadius * 1.25, F.prongTipRadius, smoothstep(t)) * (1 + 0.05 * Math.sin(t * 11 + side));
    tube(b, curve, tan, radius, barkColour, stations, sides, rng, 0.06, null, WOOD);
    // Twine wrap near the tip where the band is bound on.
    twine(b, curve, tan, radius, 0.78, 0.9, turns, TWINE);
    tips.push({ side, point: off(curve(0.84), [0, 0, 1], 0.004), radius: radius(0.84) });
  }
  // Twine at the crotch, on the handle.
  twine(b, handleCurve, handleTan, handleRadius, 0.86, 0.98, low ? 3 : 4, TWINE);
  const geo = b.finish();
  return { ...geo, tips: tips.map((t) => t.point), tipRadius: tips[0].radius, crotch: [0, F.crotchY, 0], gapCentre: [0, F.crotchY + F.prongLength * 0.72, 0] };
}

// Dynamic band and pouch geometry for a given world state. Returns geometry
// in world space, plus band lengths.
export function buildBandsAndPouch(state, { lod = 'high' } = {}) {
  const { tips, pouch, stone } = state; // tips: [world, world]; pouch: { centre, axisX (band axis), normal (toward the player), up }
  const segments = lod === 'low' ? 7 : BAND.segments;
  const cols = lod === 'low' ? 6 : POUCH.cols;
  const rows = lod === 'low' ? 3 : POUCH.rows;
  const b = new MeshBuilder();
  const lengths = [];
  const ends = [];
  for (let k = 0; k < 2; k++) {
    const tip = tips[k];
    const end = off(pouch.centre, pouch.axisX, (k === 0 ? -1 : 1) * POUCH.length / 2);
    ends.push(end);
    const straight = v3.dist(tip, end);
    const stretch = Math.max(1, straight / BAND.restLength);
    // Stretched length: a slack band is not stretched, so it reports its rest length.
    lengths.push(Math.max(BAND.restLength, straight));
    // Slack bands sag; taut bands run straight.
    const slack = Math.max(0, BAND.restLength - straight);
    const sagDir = v3.normalize([0, 0, 0], v3.add([0, 0, 0], [0, -1, 0], v3.scale([0, 0, 0], pouch.normal, 0.3)));
    const mid = off(v3.lerp([0, 0, 0], tip, end, 0.5), sagDir, slack * 0.45);
    const curve = (t) => bez(tip, mid, end, t);
    const tan = (t) => bezTangent(tip, mid, end, t);
    // Rectangular section, thinning with stretch (constant volume).
    const w = BAND.width / Math.sqrt(stretch);
    const th = BAND.thickness / Math.sqrt(stretch);
    let prev = null;
    let first = null;
    let last = null;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const c = curve(t);
      const tg = tan(t);
      // The strip's flat face turns toward the player as far as the tangent
      // allows (it hangs face on at rest); once the band runs at the player,
      // at full draw, the face settles on the fork's up axis instead. Both
      // strips take the same rule, so they always read as a matching pair.
      let face = v3.reject([0, 0, 0], pouch.normal, tg);
      const toward = v3.len(face);
      const upFace = v3.reject([0, 0, 0], pouch.up, tg);
      v3.addScaled(face, face, upFace, Math.max(0, 0.35 - toward) / 0.35);
      if (v3.len(face) < 1e-6) face = v3.cross([0, 0, 0], tg, [1, 0, 0]);
      v3.normalize(face, face);
      const wide = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], face, tg));
      const thin = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], wide, tg));
      const ring = [];
      const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
      for (const [cw, ct] of corners) {
        const p = off(off(c, wide, cw * w / 2), thin, ct * th / 2);
        // Cut inner tube: matte black faces, a lighter worn edge where it was cut.
        const shade = mix3(mix3(RUBBER, RUBBER_LIGHT, 0.5 + 0.5 * ct), RUBBER_LIGHT, Math.abs(cw) > 0 ? 0.35 : 0);
        ring.push(b.vertex(p, shade));
      }
      if (prev) b.bridge(prev, ring);
      if (!first) first = ring;
      prev = ring;
      last = ring;
    }
    b.fan(first, b.vertex(curve(0), RUBBER), true);
    b.fan(last, b.vertex(curve(1), RUBBER), false);
  }
  // Pouch: a leather rectangle with rounded ends. Flat (a gentle curl) when
  // empty; cupped around the stone when loaded.
  const grid = [];
  const gridBack = [];
  for (let iy = 0; iy <= rows; iy++) {
    const row = [];
    const rowB = [];
    for (let ix = 0; ix <= cols; ix++) {
      const u = (ix / cols) * 2 - 1;
      const v = (iy / rows) * 2 - 1;
      // Rounded ends: shrink v toward the ends.
      const endShrink = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, Math.abs(u) - 0.55) / 0.45, 2)));
      const x = u * POUCH.length / 2;
      const y = v * POUCH.width / 2 * endShrink;
      let p;
      let nrm;
      if (stone) {
        // Cup: wrap the flat coordinates onto a sphere of the stone's radius
        // plus leather, centred on the stone, from the pouch's player side.
        const R = stone.r + POUCH.thickness;
        // The leather cups the back of the stone and stops short of its
        // equator (1.35 rad), so the pouch ends never reach the pinching
        // fingers on the far side; the spare leather pleats and is not drawn.
        const ax = x / R;
        const ay = y / R;
        const raw = Math.hypot(ax, ay);
        const ang = Math.min(raw, 1.35);
        const dir = raw < 1e-9 ? [0, 0] : [ax / raw, ay / raw];
        const s = Math.sin(ang), c = Math.cos(ang);
        // Sphere point: normal points from the centre out through the leather.
        p = off(off(off(stone.centre, pouch.normal, R * c), pouch.axisX, R * s * dir[0]), pouch.up, R * s * dir[1]);
        nrm = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], p, stone.centre));
      } else {
        const curl = 0.004 * (1 - v * v) * (1 - u * u);
        p = off(off(off(pouch.centre, pouch.axisX, x), pouch.up, y), pouch.normal, -curl);
        nrm = pouch.normal;
      }
      const shade = mix3(LEATHER, LEATHER_DARK, 0.5 + 0.5 * Math.sin(u * 9) * 0.4 + 0.2 * v);
      row.push(b.vertex(p, shade));
      rowB.push(b.vertex(off(p, nrm, -POUCH.thickness), mix3(LEATHER_DARK, LEATHER, 0.3)));
    }
    grid.push(row);
    gridBack.push(rowB);
  }
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      b.quad(grid[iy][ix], grid[iy][ix + 1], grid[iy + 1][ix + 1], grid[iy + 1][ix]);
      b.quad(gridBack[iy][ix], gridBack[iy + 1][ix], gridBack[iy + 1][ix + 1], gridBack[iy][ix + 1]);
    }
  }
  // Rim between front and back.
  const rim = (g) => {
    const out = [];
    for (let ix = 0; ix < cols; ix++) out.push(g[0][ix]);
    for (let iy = 0; iy < rows; iy++) out.push(g[iy][cols]);
    for (let ix = cols; ix > 0; ix--) out.push(g[rows][ix]);
    for (let iy = rows; iy > 0; iy--) out.push(g[iy][0]);
    return out;
  };
  const rf = rim(grid), rb = rim(gridBack);
  for (let i = 0; i < rf.length; i++) { const j = (i + 1) % rf.length; b.quad(rf[i], rf[j], rb[j], rb[i]); }
  const geo = b.finish();
  return { ...geo, lengths, ends };
}

// Runtime state of the slingshot: fork transform (from the fork hand), pouch
// position (pinched, or free and oscillating), loaded stone, launch.
export class Slingshot {
  constructor({ lod = 'high' } = {}) {
    this.lod = lod;
    this.fork = buildFork(5, { lod });
    this.forkPos = [0, 0, 0];
    this.forkRot = [0, 0, 0, 1];
    this.loaded = null; // { kind, r }
    this.pinched = false; // pouch held by the pinch hand
    this.pinchPoint = [0, 0, 0];
    this.pouchCentre = [0, 0, 0];
    this.osc = [new Oscillator(2 * Math.PI * RELEASE_OSC.hz, RELEASE_OSC.zeta), new Oscillator(2 * Math.PI * RELEASE_OSC.hz, RELEASE_OSC.zeta), new Oscillator(2 * Math.PI * RELEASE_OSC.hz, RELEASE_OSC.zeta)];
    this.projectiles = [];
    this.lastRelease = null;
  }

  tipsWorld() {
    return this.fork.tips.map((t) => v3.add([0, 0, 0], this.forkPos, quat.rotate([0, 0, 0], this.forkRot, t)));
  }
  gapWorld() {
    return v3.add([0, 0, 0], this.forkPos, quat.rotate([0, 0, 0], this.forkRot, this.fork.gapCentre));
  }
  aimDir() {
    return quat.rotate([0, 0, 0], this.forkRot, [0, 0, -1]);
  }
  // Where the pouch settles when nobody holds it. With a player at the
  // fork it is the hold point the pinch hand keeps near the fork (set by the
  // actions each step); otherwise it hangs from the tips.
  restPouch() {
    if (this.holdPoint) return this.holdPoint;
    return this.restPouchAt(this.forkPos, this.forkRot);
  }
  restPouchAt(forkPos, forkRot) {
    const tips = this.fork.tips.map((t) => v3.add([0, 0, 0], forkPos, quat.rotate([0, 0, 0], forkRot, t)));
    const mid = v3.lerp([0, 0, 0], tips[0], tips[1], 0.5);
    const half = v3.dist(tips[0], tips[1]) / 2;
    const L = BAND.restLength + POUCH.length / 2;
    const drop = Math.sqrt(Math.max(0, L * L - half * half)) * 0.92;
    return off(v3.add([0, 0, 0], mid, [0, -drop, 0]), quat.rotate([0, 0, 0], forkRot, [0, 0, 1]), 0.02);
  }
  setFork(pos, rot) {
    v3.copy(this.forkPos, pos);
    quat.copy(this.forkRot, rot);
  }
  pinch(point) {
    this.pinched = true;
    v3.copy(this.pinchPoint, point);
  }
  // Let go: the pouch springs toward its rest and rings.
  release(launchStone = true) {
    const rest = this.restPouch();
    const from = this.pouchCentre.slice();
    const aim = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], this.gapWorld(), from));
    for (let i = 0; i < 3; i++) {
      this.osc[i].target = rest[i];
      this.osc[i].snap(from[i]);
      this.osc[i].target = rest[i];
    }
    this.pinched = false;
    const draw = v3.dist(from, rest);
    let stone = null;
    if (launchStone && this.loaded) {
      stone = { kind: this.loaded.kind, r: this.loaded.r, pos: from.slice(), vel: v3.scale([0, 0, 0], aim, 12 + 30 * clamp(draw / 0.3, 0, 1)), age: 0 };
      this.projectiles.push(stone);
      this.loaded = null;
    }
    this.lastRelease = { aim, from, draw, launched: !!stone, launchDir: stone ? v3.normalize([0, 0, 0], stone.vel) : null };
    return this.lastRelease;
  }
  step(dt) {
    if (this.pinched) {
      v3.copy(this.pouchCentre, this.pinchPoint);
      const rest = this.restPouch();
      for (let i = 0; i < 3; i++) { this.osc[i].snap(this.pouchCentre[i]); this.osc[i].target = rest[i]; }
    } else {
      const rest = this.restPouch();
      for (let i = 0; i < 3; i++) { this.osc[i].target = rest[i]; this.pouchCentre[i] = this.osc[i].step(dt); }
    }
    for (const p of this.projectiles) {
      p.age += dt;
      p.vel[1] -= 9.81 * dt;
      v3.addScaled(p.pos, p.pos, p.vel, dt);
    }
    this.projectiles = this.projectiles.filter((p) => p.age < 1.5 && p.pos[1] > -1.6);
  }
  // Oscillation amplitude relative to rest, for the settle check.
  ringAmplitude() {
    return v3.dist(this.pouchCentre, this.restPouch());
  }
  // Band and pouch geometry for rendering and checks.
  geometry() {
    const tips = this.tipsWorld();
    const axisX = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], tips[1], tips[0]));
    const toward = quat.rotate([0, 0, 0], this.forkRot, [0, 0, 1]);
    let normal = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], toward, axisX));
    if (v3.len(normal) < 1e-6) normal = [0, 0, 1];
    const up = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], axisX, normal));
    // Cup the stone slightly behind the pouch centre (toward the player side is the leather).
    const stone = this.loaded ? { r: this.loaded.r, centre: v3.addScaled([0, 0, 0], this.pouchCentre, normal, -(this.loaded.r + POUCH.thickness) * 0.35) } : null;
    return buildBandsAndPouch({ tips, pouch: { centre: this.pouchCentre, axisX, normal, up }, stone }, { lod: this.lod });
  }
  stoneWorld() {
    if (!this.loaded) return null;
    const g = this.geometry();
    void g;
    const toward = quat.rotate([0, 0, 0], this.forkRot, [0, 0, 1]);
    const tips = this.tipsWorld();
    const axisX = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], tips[1], tips[0]));
    const normal = v3.normalize([0, 0, 0], v3.reject([0, 0, 0], toward, axisX));
    return { kind: this.loaded.kind, r: this.loaded.r, pos: v3.addScaled([0, 0, 0], this.pouchCentre, normal, -(this.loaded.r + POUCH.thickness) * 0.35) };
  }
}
