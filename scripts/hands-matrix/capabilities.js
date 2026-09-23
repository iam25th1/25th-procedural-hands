// The capability matrix: one row per capability the spec asks for, with the
// named checks (from npm run hands:check) that prove it and the gallery
// sheet that shows it. Rows are added in the same commit as the capability.
const C = {
  fullRange: 'fingers: each finger reaches its full range on every joint independently, neighbours inside natural coupling',
  thumb: 'fingers: thumb curl, spread and opposition reach their range inside the limits on both hands',
  spread: 'fingers: spread -1 to 1 reaches MCP abduction both ways on every finger, both hands',
  blend: 'fingers: control blends over the active pose, on either hand, at any time',
  countIndex: 'counting: 1 to 5 index first on both hands, right digits up, no self-penetration',
  countThumb: 'counting: 1 to 5 thumb first on both hands, right digits up, no self-penetration',
  sets: 'finger sets: all 32 combinations extend exactly the chosen digits, inside limits, no self-penetration',
  gestures: 'gestures: every registry gesture reachable, inside limits, no self-penetration, continuous at 60 fps, both hands',
  limits: 'limits: no joint passes its limit (poses and 10000 seeded blends)',
};

export const CAPABILITIES = [
  { group: 'fingers', name: 'Curl 0 to 1 per finger', checks: [C.fullRange], sheet: 'fingers-control' },
  { group: 'fingers', name: 'Curl 0 to 1 per joint', checks: [C.fullRange], sheet: 'fingers-control' },
  { group: 'fingers', name: 'Spread', checks: [C.spread], sheet: 'fingers-control' },
  { group: 'fingers', name: 'Thumb opposition', checks: [C.thumb], sheet: 'fingers-control' },
  { group: 'fingers', name: 'Anatomically clamped', checks: [C.limits, C.fullRange, C.thumb], sheet: 'fingers-control' },
  { group: 'fingers', name: 'Either hand, independently, any time, over the active pose', checks: [C.blend], sheet: 'fingers-control' },
  { group: 'counting', name: 'Counting 1 to 5, index first', checks: [C.countIndex], sheet: '02-counting' },
  { group: 'counting', name: 'Counting 1 to 5, thumb first', checks: [C.countThumb], sheet: '02-counting' },
  { group: 'counting', name: 'Finger set: middle only', checks: [C.sets], sheet: 'fingers-sets' },
  { group: 'counting', name: 'Finger set: index and little', checks: [C.sets], sheet: 'fingers-sets' },
  { group: 'counting', name: 'Any combination from a set or mask', checks: [C.sets], sheet: 'fingers-sets' },
  ...[
    ['Relaxed', 'gestures-all'], ['Open palm', '03-gestures'], ['Spread', '03-gestures'], ['Fist, thumb outside', '03-gestures'],
    ['Point', '03-gestures'], ['OK', '03-gestures'], ['Thumbs up', '03-gestures'], ['V', '03-gestures'], ['Beckon', '03-gestures'],
    ['Wave', '03-gestures'], ['Finger drum', 'gestures-all'], ['Pebble roll', 'gestures-all'],
  ].map(([name, sheet]) => ({ group: 'gestures', name, checks: [C.gestures], sheet })),
];
