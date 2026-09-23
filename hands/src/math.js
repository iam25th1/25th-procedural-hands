// Dependency free vector, quaternion and matrix math on plain arrays, shared
// by the browser lab and the Node checks. Vectors are [x, y, z], quaternions
// [x, y, z, w], matrices 16 numbers column major (the three.js layout, so a
// matrix can be handed to Matrix4.fromArray unchanged).

export const DEG = Math.PI / 180;
export const deg = (d) => d * DEG;
export const toDeg = (r) => r / DEG;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

export const v3 = {
  of: (x = 0, y = 0, z = 0) => [x, y, z],
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  addScaled: (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (o, a, b) => {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    o[0] = x; o[1] = y; o[2] = z;
    return o;
  },
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-12) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l;
    return o;
  },
  lerp: (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; },
  negate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; return o; },
  // Component of a perpendicular to unit vector n.
  reject: (o, a, n) => { const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2]; o[0] = a[0] - n[0] * d; o[1] = a[1] - n[1] * d; o[2] = a[2] - n[2] * d; return o; },
  mirrorX: (o, a) => { o[0] = -a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
};

export const quat = {
  of: (x = 0, y = 0, z = 0, w = 1) => [x, y, z, w],
  identity: (o) => { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  fromAxisAngle: (o, axis, angle) => {
    const h = angle / 2;
    const s = Math.sin(h);
    o[0] = axis[0] * s; o[1] = axis[1] * s; o[2] = axis[2] * s; o[3] = Math.cos(h);
    return o;
  },
  // Rotation about a unit axis stored as a scaled axis (Rodrigues vector).
  fromRotationVector: (o, r) => {
    const a = Math.hypot(r[0], r[1], r[2]);
    if (a < 1e-12) return quat.identity(o);
    return quat.fromAxisAngle(o, [r[0] / a, r[1] / a, r[2] / a], a);
  },
  multiply: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    o[0] = ax * bw + aw * bx + ay * bz - az * by;
    o[1] = ay * bw + aw * by + az * bx - ax * bz;
    o[2] = az * bw + aw * bz + ax * by - ay * bx;
    o[3] = aw * bw - ax * bx - ay * by - az * bz;
    return o;
  },
  conjugate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = a[3]; return o; },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; o[3] = a[3] / l;
    return o;
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
  // Rotate vector v by q.
  rotate: (o, q, v) => {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    o[0] = vx + qw * tx + (qy * tz - qz * ty);
    o[1] = vy + qw * ty + (qz * tx - qx * tz);
    o[2] = vz + qw * tz + (qx * ty - qy * tx);
    return o;
  },
  slerp: (o, a, b, t) => {
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let wa;
    let wb;
    if (cos > 0.9995) {
      wa = 1 - t;
      wb = t;
    } else {
      const th = Math.acos(cos);
      const s = Math.sin(th);
      wa = Math.sin((1 - t) * th) / s;
      wb = Math.sin(t * th) / s;
    }
    o[0] = a[0] * wa + bx * wb; o[1] = a[1] * wa + by * wb; o[2] = a[2] * wa + bz * wb; o[3] = a[3] * wa + bw * wb;
    return quat.normalize(o, o);
  },
  // Shortest rotation taking unit vector a onto unit vector b.
  fromTo: (o, a, b) => {
    const d = v3.dot(a, b);
    if (d > 1 - 1e-9) return quat.identity(o);
    if (d < -1 + 1e-9) {
      // Opposite vectors: rotate 180 degrees about any perpendicular axis.
      const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const p = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], a, ax));
      return quat.fromAxisAngle(o, p, Math.PI);
    }
    const c = v3.cross([0, 0, 0], a, b);
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = 1 + d;
    return quat.normalize(o, o);
  },
  // Frame from orthonormal basis columns x, y, z (right handed).
  fromBasis: (o, x, y, z) => {
    const m00 = x[0], m01 = y[0], m02 = z[0];
    const m10 = x[1], m11 = y[1], m12 = z[1];
    const m20 = x[2], m21 = y[2], m22 = z[2];
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      o[3] = 0.25 / s; o[0] = (m21 - m12) * s; o[1] = (m02 - m20) * s; o[2] = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      o[3] = (m21 - m12) / s; o[0] = 0.25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = 0.25 * s; o[2] = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = 0.25 * s;
    }
    return quat.normalize(o, o);
  },
  // Angle of rotation in radians, 0..pi.
  angle: (q) => 2 * Math.acos(clamp(Math.abs(q[3]), 0, 1)),
  // Angle between two orientations.
  angleBetween: (a, b) => 2 * Math.acos(clamp(Math.abs(quat.dot(a, b)), 0, 1)),
  // Split q into twist about unit axis and the remaining swing: q = swing * twist.
  swingTwist: (q, axis) => {
    const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
    const twist = quat.normalize([0, 0, 0, 1], [axis[0] * d, axis[1] * d, axis[2] * d, q[3]]);
    if (Math.hypot(twist[0], twist[1], twist[2], twist[3]) < 1e-9) quat.identity(twist);
    const swing = quat.multiply([0, 0, 0, 1], q, quat.conjugate([0, 0, 0, 1], twist));
    return { swing, twist };
  },
  // Split q into a twist about unit axis applied first (in the parent frame)
  // followed by a swing: q = R_axis(twist) * swing.
  twistSwing: (q, axis) => {
    const qc = quat.conjugate([0, 0, 0, 1], q);
    const { swing: sc, twist: tc } = quat.swingTwist(qc, axis);
    return { twist: -quat.twistAngle(tc, axis), swing: quat.conjugate([0, 0, 0, 1], sc) };
  },
  // Signed twist angle about unit axis, -pi..pi.
  twistAngle: (q, axis) => {
    const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
    let a = 2 * Math.atan2(d, q[3]);
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a < -Math.PI) a += 2 * Math.PI;
    return a;
  },
  axisX: (o, q) => quat.rotate(o, q, [1, 0, 0]),
  axisY: (o, q) => quat.rotate(o, q, [0, 1, 0]),
  axisZ: (o, q) => quat.rotate(o, q, [0, 0, 1]),
};

export const m4 = {
  identity: (o) => { for (let i = 0; i < 16; i++) o[i] = i % 5 === 0 ? 1 : 0; return o; },
  // Rigid transform from position and quaternion (no scale).
  compose: (o, p, q) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0;
    o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0;
    o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0;
    o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1;
    return o;
  },
  multiply: (o, a, b) => {
    const r = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let rr = 0; rr < 4; rr++) {
        r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
      }
    }
    for (let i = 0; i < 16; i++) o[i] = r[i];
    return o;
  },
  // Inverse of a rigid transform (rotation + translation only).
  invertRigid: (o, a) => {
    const r = new Array(16);
    r[0] = a[0]; r[1] = a[4]; r[2] = a[8]; r[3] = 0;
    r[4] = a[1]; r[5] = a[5]; r[6] = a[9]; r[7] = 0;
    r[8] = a[2]; r[9] = a[6]; r[10] = a[10]; r[11] = 0;
    const tx = a[12], ty = a[13], tz = a[14];
    r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
    r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
    r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
    r[15] = 1;
    for (let i = 0; i < 16; i++) o[i] = r[i];
    return o;
  },
  transformPoint: (o, m, p) => {
    const x = p[0], y = p[1], z = p[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return o;
  },
  transformDir: (o, m, d) => {
    const x = d[0], y = d[1], z = d[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  },
  getTranslation: (o, m) => { o[0] = m[12]; o[1] = m[13]; o[2] = m[14]; return o; },
  getQuat: (o, m) => quat.fromBasis(o, [m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]),
  axisX: (o, m) => { o[0] = m[0]; o[1] = m[1]; o[2] = m[2]; return o; },
  axisY: (o, m) => { o[0] = m[4]; o[1] = m[5]; o[2] = m[6]; return o; },
  axisZ: (o, m) => { o[0] = m[8]; o[1] = m[9]; o[2] = m[10]; return o; },
};

// Distance between two segments (a0-a1, b0-b1); returns { d, s, t } with the
// closest parameters. Used for capsule to capsule checks.
export function segmentDistance(a0, a1, b0, b1) {
  const u = v3.sub([0, 0, 0], a1, a0);
  const v = v3.sub([0, 0, 0], b1, b0);
  const w = v3.sub([0, 0, 0], a0, b0);
  const a = v3.dot(u, u);
  const b = v3.dot(u, v);
  const c = v3.dot(v, v);
  const d = v3.dot(u, w);
  const e = v3.dot(v, w);
  const D = a * c - b * b;
  let sN, sD = D, tN, tD = D;
  if (D < 1e-12) { sN = 0; sD = 1; tN = e; tD = c; } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) { sN = 0; tN = e; tD = c; } else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
  }
  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a; }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) sN = 0; else if (-d + b > a) sN = sD; else { sN = -d + b; sD = a; }
  }
  const s = Math.abs(sN) < 1e-12 ? 0 : sN / sD;
  const t = Math.abs(tN) < 1e-12 ? 0 : tN / tD;
  const pa = v3.addScaled([0, 0, 0], a0, u, s);
  const pb = v3.addScaled([0, 0, 0], b0, v, t);
  return { d: v3.dist(pa, pb), s, t, pa, pb };
}

// Closest point on segment a0-a1 to p; returns { d, t, q }.
export function pointSegmentDistance(p, a0, a1) {
  const u = v3.sub([0, 0, 0], a1, a0);
  const l2 = v3.len2(u);
  let t = l2 < 1e-12 ? 0 : v3.dot(v3.sub([0, 0, 0], p, a0), u) / l2;
  t = clamp(t, 0, 1);
  const q = v3.addScaled([0, 0, 0], a0, u, t);
  return { d: v3.dist(p, q), t, q };
}

// FNV-1a over quantized numbers, for determinism hashes.
export function hashNumbers(values, quantum = 1e-6) {
  let h = 0x811c9dc5;
  for (const v of values) {
    const q = Math.round(v / quantum);
    const bytes = [q & 0xff, (q >> 8) & 0xff, (q >> 16) & 0xff, (q >> 24) & 0xff];
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}
