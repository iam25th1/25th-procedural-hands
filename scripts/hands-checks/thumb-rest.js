// The thumb column at rest, measured the way the published value was:
// Cheema TA, Cheema NI, Tayyab R, Firoozbakhsh K. Measurement of rotation of
// the first metacarpal during opposition using computed tomography. J Hand
// Surg Am 2006;31(1):76-79. On an axial slice, the angle between the dorsal
// tangent of the second and third metacarpals and the line through the first
// metacarpal head at the sesamoids: 74 +/- 10 degrees at rest.
import { create, quat } from '../../hands/src/index.js';

export const THUMB_REST = { mean: 74, sd: 10 };

export function thumbRestAngle(side = 'right') {
  const h = create({ seed: 1 });
  h.setPose('both', 'relaxed', { snap: true });
  for (let i = 0; i < 60; i++) h.step();
  const s = h.skeleton;
  const inv = quat.conjugate([0, 0, 0, 1], s.joint(side, 'wrist').worldRot);
  // The first metacarpal head's transverse line is the thumb frame's X axis;
  // the hand's axial plane is its X (across the palm) and Y (dorsal).
  const x = quat.rotate([0, 0, 0], inv, quat.rotate([0, 0, 0], s.joint(side, 'thumb-metacarpal').worldRot, [1, 0, 0]));
  // The left hand is the mirror image: its frame X points the other way.
  const sgn = side === 'right' ? 1 : -1;
  const v = [sgn * x[0], sgn * x[1]];
  return (Math.atan2(v[1], sgn * v[0]) * 180) / Math.PI;
}

export const thumbRestChecks = [
  {
    name: 'anatomy: first metacarpal rotation at rest within one SD of Cheema 2006 (74 +/- 10 deg, measured as they measured it)',
    async run() {
      const r = thumbRestAngle('right');
      const l = thumbRestAngle('left');
      const worst = Math.max(Math.abs(r - THUMB_REST.mean), Math.abs(l - THUMB_REST.mean));
      return { pass: worst <= THUMB_REST.sd, worst, limit: THUMB_REST.sd, unit: 'deg off the mean', note: `relaxed pose: right ${r.toFixed(1)} deg, left ${l.toFixed(1)} deg against 74 +/- 10` };
    },
  },
];
