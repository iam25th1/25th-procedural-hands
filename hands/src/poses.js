// Named hand poses as per joint data, in degrees. flex positive toward the
// palm; abd positive spreads away from the middle finger (thumb: radial
// abduction). dip null means it follows the PIP through the coupling.
import { deg } from './math.js';
import { FINGERS } from './skeleton.js';
import { emptyHandPose } from './fingers.js';

function hand(spec) {
  const p = emptyHandPose();
  const F = (f, mcp, abd, pip, dip = null) => { p[f].mcp = [deg(mcp), deg(abd)]; p[f].pip = deg(pip); p[f].dip = dip == null ? null : deg(dip); };
  const T = (cmcFlex, cmcAbd, mcp, ip, twist = 0, mcpAbd = 0) => { p.thumb.cmc = [deg(cmcFlex), deg(cmcAbd), deg(twist)]; p.thumb.mcp = [deg(mcp), deg(mcpAbd)]; p.thumb.ip = deg(ip); };
  spec(F, T, p);
  // Fingers authored straight beside folded ones are held straight on
  // purpose, against the pull of their folded neighbours.
  p.effort = {};
  if (FINGERS.some((f) => p[f].pip > deg(45))) for (const f of FINGERS) if (p[f].mcp[0] <= 0 && p[f].pip <= 0) p.effort[f] = 1;
  return p;
}

const fingerSpread = { index: 1, middle: 0, ring: 1, little: 1 };

export const POSES = {
  // Relaxed hand: fingers gently curled, thumb resting beside the index.
  relaxed: hand((F, T) => {
    F('index', 18, 3, 24); F('middle', 22, 0, 30); F('ring', 26, 2, 34); F('little', 28, 6, 36);
    T(12, 8, 12, 12);
  }),
  open: hand((F, T) => {
    for (const f of FINGERS) F(f, 0, 0, 0, 0);
    // Flat hand: the thumb lies close to the palm plane, swept out radially.
    T(-12, -12, 0, 0);
  }),
  spread: hand((F, T) => {
    F('index', 0, 18, 0, 0); F('middle', 0, 0, 0, 0); F('ring', 0, 12, 0, 0); F('little', 0, 24, 0, 0);
    T(-29, -10, 0, 0);
  }),
  // Fist with the thumb outside, wrapped across the index and middle.
  fist: hand((F, T) => {
    F('index', 88, 0, 100, 68); F('middle', 90, 0, 100, 70); F('ring', 90, 0, 100, 70); F('little', 88, 0, 98, 68);
    T(48, 8, 40, 55);
  }),
  point: hand((F, T) => {
    F('index', 0, 0, 0, 0); F('middle', 85, 0, 100, 68); F('ring', 90, 0, 100, 70); F('little', 88, 0, 98, 68);
    T(38, 6, 34, 45);
  }),
  // Thumb and index tips meet; the other three stay open and a little spread.
  ok: hand((F, T) => {
    F('index', 48, 4, 62, 45); F('middle', 8, 0, 12); F('ring', 6, 4, 10); F('little', 4, 10, 8);
    T(40, 38, 26, 22);
  }),
  thumbsUp: hand((F, T) => {
    F('index', 88, 0, 100, 68); F('middle', 90, 0, 100, 70); F('ring', 90, 0, 100, 70); F('little', 88, 0, 98, 68);
    T(-29, 4, -5, -5);
  }),
  v: hand((F, T) => {
    F('index', 0, 16, 0, 0); F('middle', 0, -14, 0, 0); F('ring', 90, 0, 100, 70); F('little', 88, 0, 98, 68);
    T(44, 8, 38, 45);
  }),
  count1: hand((F, T) => {
    F('index', 0, 0, 0, 0); F('middle', 88, 0, 100, 68); F('ring', 90, 0, 100, 70); F('little', 88, 0, 98, 68);
    T(44, 8, 38, 45);
  }),
  count2: hand((F, T) => {
    F('index', 0, 10, 0, 0); F('middle', 0, -8, 0, 0); F('ring', 90, 0, 100, 70); F('little', 88, 0, 98, 68);
    T(44, 8, 38, 45);
  }),
  count3: hand((F, T) => {
    F('index', 0, 12, 0, 0); F('middle', 0, 0, 0, 0); F('ring', 0, 10, 0, 0); F('little', 88, 0, 98, 68);
    T(44, 8, 38, 45);
  }),
  count4: hand((F, T) => {
    F('index', 0, 12, 0, 0); F('middle', 0, 0, 0, 0); F('ring', 0, 8, 0, 0); F('little', 0, 16, 0, 0);
    T(52, 0, 45, 50);
  }),
  count5: hand((F, T) => {
    F('index', 0, 16, 0, 0); F('middle', 0, 0, 0, 0); F('ring', 0, 10, 0, 0); F('little', 0, 22, 0, 0);
    T(-29, -10, 0, 0);
  }),
  // Hook: fingers curled at PIP and DIP, MCP nearly straight (carrying a bag handle).
  hook: hand((F, T) => {
    F('index', 12, 0, 82, 55); F('middle', 14, 0, 86, 58); F('ring', 14, 0, 86, 58); F('little', 12, 2, 80, 54);
    T(20, 5, 25, 20);
  }),
  // Lateral pinch: thumb pad presses the side of the index middle phalanx.
  lateral: hand((F, T) => {
    F('index', 42, 0, 62, 42); F('middle', 55, 0, 78, 52); F('ring', 62, 0, 84, 56); F('little', 64, 2, 84, 56);
    T(22, 6, 30, 42);
  }),
  // Pre-shapes for the grasp solver (the solver curls from here to contact).
  preCylinder: hand((F, T) => {
    F('index', 30, 2, 30); F('middle', 30, 0, 32); F('ring', 32, 1, 34); F('little', 34, 3, 36);
    T(10, 40, 5, 5);
  }),
  preSphere: hand((F, T) => {
    F('index', 20, 10, 25); F('middle', 22, 0, 28); F('ring', 24, 8, 30); F('little', 26, 16, 32);
    T(15, 50, 10, 10);
  }),
  // Fingers that take no part in a pinch fold in tight, so they stay clear
  // of the surface a small object is picked from.
  prePinch: hand((F, T) => {
    F('index', 30, 2, 28); F('middle', 80, 0, 98, 66); F('ring', 86, 2, 100, 68); F('little', 86, 4, 98, 66);
    T(28, 36, 12, 8);
  }),
  // Index and middle pads side by side (index adducted, middle toward the index, middle flexed a little more so the pads line up).
  // Index and middle curled enough that the object sits in front of the
  // palm at the thumb's reach; the thumb starts opposed and nearly straight.
  // Open hand with the thumb raised out of the palm plane, so a flat sachet
  // can slide across the palm under it before the thumb comes down on top.
  preSachet: hand((F, T) => {
    for (const f of FINGERS) F(f, 4, 0, 6, 4);
    T(10, 35, 10, 10);
  }),
  preTripod: hand((F, T) => {
    F('index', 30, -3, 18, 8); F('middle', 34, 3, 20, 10); F('ring', 86, 2, 100, 68); F('little', 86, 4, 98, 66);
    T(40, 10, 20, 20);
  }),
  // Just let go of the pouch: thumb and index sprung open, others loose.
  released: hand((F, T) => {
    F('index', 6, 8, 14, 6); F('middle', 30, 0, 38); F('ring', 36, 2, 44); F('little', 38, 6, 46);
    T(-18, 20, -4, -6);
  }),
  // Fingertips resting on a surface for drumming: knuckles raised, fingers
  // arched down, the thumb alongside.
  drum: hand((F, T) => {
    F('index', 28, 4, 48); F('middle', 30, 0, 50); F('ring', 30, 3, 48); F('little', 28, 8, 44);
    T(8, 10, 10, 10);
  }),
  // Flat hand for pressing on a face: fingers almost straight, the thumb
  // alongside the index.
  press: hand((F, T) => {
    F('index', 4, 2, 6); F('middle', 4, 0, 6); F('ring', 4, 1, 6); F('little', 4, 4, 6);
    T(-20, -42, 2, 2);
  }),
  // Flat fingers with the thumb tucked alongside: reaching over a handle to
  // hook it.
  flat: hand((F, T) => {
    F('index', 12, 0, 4, 2); F('middle', 14, 0, 4, 2); F('ring', 14, 0, 4, 2); F('little', 12, 2, 4, 2);
    T(-8, -12, 4, 4);
  }),
  // Open, ready to receive: used at the start of grabs (anticipation).
  ready: hand((F, T) => {
    F('index', 5, 8, 8); F('middle', 6, 0, 10); F('ring', 8, 6, 12); F('little', 10, 12, 14);
    T(-15, 12, 0, 0);
  }),
};

export const POSE_NAMES = Object.keys(POSES);
export { fingerSpread };

// Finger sets: any combination of extended digits, as a pose. Extended
// fingers are straight with a natural spread, folded fingers curl as in a
// fist, an extended thumb swings out of the palm and a folded one rests
// across the folded fingers nearest to it. So "middle only" and "index and
// little" are data, not code: fingerSetPose(['middle']) and
// fingerSetPose(['index', 'little']).
const EXTENDED_SPREAD = { index: 10, middle: 0, ring: 8, little: 16 };
const FOLDED = { index: [88, 0, 100, 68], middle: [90, 0, 100, 70], ring: [90, 0, 100, 70], little: [88, 0, 98, 68] };

export function setPoseName(set) {
  const on = new Set(set);
  for (const d of on) if (!['thumb', ...FINGERS].includes(d)) throw new Error(`unknown digit ${d}`);
  return `set:${['thumb', ...FINGERS].filter((d) => on.has(d)).join('+') || 'none'}`;
}

export function fingerSetPose(set) {
  const on = new Set(set);
  const folded = FINGERS.filter((f) => !on.has(f));
  const pose = hand((F, T) => {
    for (const f of FINGERS) {
      if (on.has(f)) F(f, 0, EXTENDED_SPREAD[f], 0, 0);
      else F(f, ...FOLDED[f]);
    }
    if (on.has('thumb')) {
      // All fingers folded: the thumb stands up (thumbs up); otherwise it
      // swings out in the palm plane.
      if (folded.length === FINGERS.length) T(-29, 4, -5, -5);
      else T(-29, -10, 0, 0);
    } else if (folded.length === 0) {
      T(52, 0, 45, 50);
    } else {
      T(44, 8, 38, 45);
    }
  });
  // Extended fingers are held straight on purpose against their folded
  // neighbours.
  pose.effort = {};
  for (const f of FINGERS) if (on.has(f)) pose.effort[f] = 1;
  // The thumb rests on the folded fingers nearest to it: the first run of
  // folded fingers from the index side, at most two.
  const rest = [];
  if (!on.has('thumb')) {
    for (const f of FINGERS) {
      if (on.has(f)) { if (rest.length) break; continue; }
      rest.push(f);
      if (rest.length === 2) break;
    }
  }
  return { pose, thumbRest: rest };
}

// Counting 1 to 5 in both common styles.
export const COUNTING = {
  index: [['index'], ['index', 'middle'], ['index', 'middle', 'ring'], ['index', 'middle', 'ring', 'little'], ['thumb', 'index', 'middle', 'ring', 'little']],
  thumb: [['thumb'], ['thumb', 'index'], ['thumb', 'index', 'middle'], ['thumb', 'index', 'middle', 'ring'], ['thumb', 'index', 'middle', 'ring', 'little']],
};

export function countPoseName(n, style = 'index') {
  if (!COUNTING[style]) throw new Error(`counting style is 'index' or 'thumb', got ${style}`);
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error(`count must be 0 to 5, got ${n}`);
  return n === 0 ? setPoseName([]) : setPoseName(COUNTING[style][n - 1]);
}
