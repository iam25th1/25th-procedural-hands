// The sheets the gallery renders: the twelve core sheets first (the ones
// the acceptance rubric reviews), then the full set. Each frame is a set of
// shot mode URL parameters (app/shot.js); a sheet is a strip or grid of them.
import { SCENARIOS } from '../../app/scenes/capabilities.js';
import { ACTION_KEYFRAMES } from '../../app/scenes/slingshot/scenarios.js';
import { GESTURES } from '../../hands/src/gestures.js';

export const VIEWPORTS = [
  { key: 'phone-portrait', width: 390, height: 844, perSheet: 12, cols: 4 },
  { key: 'phone-landscape', width: 844, height: 390, perSheet: 12, cols: 3 },
  { key: 'desktop', width: 1440, height: 900, perSheet: 12, cols: 3 },
];

const hands = (name, p) => ({ name, params: { scene: 'hands', ...p } });
const sand = (cap, t, extra = {}) => ({ name: `${cap} ${t.toFixed(2)} s`, params: { scene: 'sandbox', cap, t, ...extra } });
const strip = (cap, times, extra = {}) => times.map((t) => sand(cap, t, extra));
// Close on the right hand (a grip frame, not part of a moving strip).
const CLOSE = { focus: 'right', dist: 0.3, yaw: -2.5, pitch: 0.2 };

export const CORE = [
  {
    key: '01-anatomy', title: 'Anatomy: palm, back, side, three-quarter',
    frames: ['palm', 'back', 'side', 'three'].map((cam) => hands(`right hand ${cam}`, { hand: 'right', cam, pose: 'relaxed' })),
  },
  {
    key: '02-counting', title: 'Counting 1 to 5 on both hands, index first and thumb first',
    frames: [
      ...[1, 2, 3, 4, 5].map((n) => hands(`${n} index first`, { hand: 'both', count: n, style: 'index', cam: 'front' })),
      ...[1, 2, 3, 4, 5].map((n) => hands(`${n} thumb first`, { hand: 'both', count: n, style: 'thumb', cam: 'front' })),
    ],
  },
  {
    key: '03-gestures', title: 'Gestures: fist, open, spread, point, OK, thumbs up, V, beckon, wave',
    frames: ['fist', 'open', 'spread', 'point', 'ok', 'thumbsUp', 'v', 'beckon', 'wave'].map((g) => hands(g, { hand: 'both', gesture: g, cam: 'front', t: ['beckon', 'wave'].includes(g) ? 0.6 : 0 })),
  },
  {
    key: '04-pinch-tripod', title: 'Pad pinch and tripod on three sizes',
    frames: [
      ...[1.6, 5.5, 9.4].map((t) => sand('padPinch', t, CLOSE)),
      ...[1.6, 5.5, 9.4].map((t) => sand('tripod', t, CLOSE)),
    ],
  },
  {
    key: '05-power-spherical', title: 'Power and spherical grips: handle, rock, ball',
    frames: [sand('powerGrip', 1.6, CLOSE), sand('powerGrip', 2.3, CLOSE), sand('grabCarryPlace', 1.7, CLOSE), sand('sphericalGrip', 1.7, CLOSE)],
  },
  {
    key: '06-two-hand-handover', title: 'Two-hand grip and handover keyframes',
    frames: [...strip('twoHand', [1.3, 2.5, 3.2]), ...strip('handover', [2.0, 3.45, 4.6])],
  },
  { key: '07-grab-carry-place', title: 'Grab, lift, carry, place', frames: strip('grabCarryPlace', [0.5, 1.05, 1.5, 2.1, 2.8, 3.6, 4.1, 4.9]) },
  { key: '08-throw-catch', title: 'Throw and catch', frames: strip('throwCatch', [1.2, 2.0, 2.3, 2.45, 2.6, 2.85, 3.4, 4.4]) },
  { key: '09-push-drag', title: 'Push and drag a crate', frames: [...strip('pushCrate', [1.0, 1.9, 2.7, 3.4]), ...strip('dragCrate', [1.3, 2.1, 2.9, 3.7])] },
  {
    key: '10-props', title: 'Lever, switch, knob and drawer',
    frames: [...strip('pullLever', [1.3, 2.6]), ...strip('flipSwitch', [0.9, 1.7]), ...strip('turnKnob', [1.3, 2.8]), ...strip('drawer', [1.3, 2.8, 4.5]), ...strip('pressButton', [1.5])],
  },
  { key: '11-climb', title: 'Climb hand over hand on rungs', frames: strip('climb', [1.5, 2.3, 3.4, 4.6, 5.3, 6.4, 7.5, 8.2, 9.3, 10.4, 11.0, 11.8]) },
  {
    key: '12-slingshot', title: 'Slingshot draw and release',
    frames: [
      ...[0, 0.5, 1.0, 1.4].map((t) => ({ name: `draw ${t.toFixed(2)} s`, params: { scene: 'slingshot', action: 'draw', t, cam: 'orbit' } })),
      ...[0.05, 0.15, 0.4, 1.0].map((t) => ({ name: `release ${t.toFixed(2)} s`, params: { scene: 'slingshot', action: 'release', t, cam: 'orbit' } })),
      { name: 'full draw, first person', params: { scene: 'slingshot', action: 'fullDrawHold', t: 0.5, cam: 'fp' } },
      { name: 'release, first person', params: { scene: 'slingshot', action: 'release', t: 0.1, cam: 'fp' } },
    ],
  },
];

// Every sheet beyond the core: fingers, sets, all gestures, every capability
// scenario across its run, every slingshot action, the skin tones.
export function fullSet() {
  const out = [];
  out.push({
    key: 'fingers-control', title: 'Per-finger and per-joint control',
    frames: [
      hands('index only curled', { hand: 'right', set: 'thumb+middle+ring+little', cam: 'back' }),
      hands('middle only', { hand: 'right', set: 'middle', cam: 'front' }),
      hands('index and little', { hand: 'right', set: 'index+little', cam: 'front' }),
      hands('spread', { hand: 'right', pose: 'spread', cam: 'palm' }),
      hands('fist, back', { hand: 'right', pose: 'fist', cam: 'back' }),
      hands('fist, side', { hand: 'right', pose: 'fist', cam: 'side' }),
    ],
  });
  out.push({
    key: 'fingers-sets', title: 'Finger sets from a mask',
    frames: ['none', 'thumb', 'index', 'middle', 'ring', 'little', 'index+middle', 'index+little', 'thumb+index+middle', 'middle+ring+little', 'thumb+little', 'index+middle+ring+little'].map((s) => hands(s, { hand: 'both', set: s, cam: 'front' })),
  });
  out.push({
    key: 'gestures-all', title: 'Every gesture in the registry',
    frames: Object.keys(GESTURES).flatMap((g) => (['wave', 'beckon', 'drum', 'pebbleRoll'].includes(g) ? [0.3, 0.8] : [0]).map((t) => hands(`${g}${t ? ` ${t} s` : ''}`, { hand: g === 'pebbleRoll' || g === 'drum' ? 'right' : 'both', gesture: g, cam: g === 'pebbleRoll' || g === 'drum' ? 'palm' : 'front', t }))),
  });
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    const n = 8;
    const times = Array.from({ length: n }, (_, i) => +((sc.duration * (i + 0.5)) / n).toFixed(2));
    out.push({ key: `cap-${id}`, title: sc.label, frames: strip(id, times) });
  }
  for (const [action, times] of Object.entries(ACTION_KEYFRAMES)) {
    out.push({ key: `slingshot-${action}`, title: `Slingshot: ${action}`, frames: times.map((t) => ({ name: `${action} ${t.toFixed(2)} s`, params: { scene: 'slingshot', action, t, cam: 'orbit' } })) });
  }
  out.push({
    key: 'skin-tones', title: 'Skin tones and sleeves',
    frames: [0, 1, 2, 3, 4].flatMap((i) => [hands(`tone ${i} back`, { hand: 'right', pose: 'relaxed', cam: 'back', skin: i, sleeve: i }), hands(`tone ${i} palm`, { hand: 'right', pose: 'relaxed', cam: 'palm', skin: i, sleeve: i })]),
  });
  out.push({
    key: 'grips-hands-scene', title: 'Every grip on its object, palm and side',
    frames: ['powerCylinder', 'spherical', 'padPinch', 'tipPinch', 'tripod', 'lateral', 'hook'].flatMap((g) => ['palm', 'side'].map((cam) => hands(`${g} ${cam}`, { hand: 'right', grip: g, cam }))),
  });
  return out;
}

// One frame from each core sheet: the overview committed to docs/assets.
export const OVERVIEW = CORE.map((s) => ({ ...s.frames[Math.floor(s.frames.length / 2)], name: s.title.split(':')[0] }));
