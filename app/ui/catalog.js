// What the sandbox can play, as data: the action palette for each scene,
// grouped by capability, and the capability matrix (one row per capability,
// each row naming its scene and the action that plays it). Built from the
// module's own registries so a new gesture or scenario shows up by itself.
import { GESTURES, GRIPS, DIGITS } from '/hands/src/index.js';
import { SCENARIOS } from '/scenes/capabilities.js';
import { STATIONS } from '/scenes/sandbox-world.js';
import { GRIP_OBJECTS } from '/scenes/hands-scene.js';
import { SEQUENCES, objectLabel } from './controllers.js';
import { humanize } from './dom.js';

const gestureLabel = (name) => GESTURES[name].label || humanize(name);

// Every grip the module knows, and the objects the Hands scene offers them.
export const GRIP_LIST = Object.keys(GRIPS);
export const OBJECT_LIST = Object.keys(GRIP_OBJECTS);

export const gripLabel = (key) => (key === 'auto' ? 'Auto' : humanize(key));

// Palette groups: [{ title, items: [{ label, action }] }]. Actions that
// take a hand get it from the hand picker when pressed.
export function paletteFor(scene) {
  if (scene === 'hands') {
    return [
      { title: 'Gestures', items: [...Object.keys(GESTURES).map((name) => ({ label: gestureLabel(name), action: { type: 'gesture', name } })), { label: 'Stop gesture', action: { type: 'stopGesture' } }] },
      { title: 'Counting, index first', items: [1, 2, 3, 4, 5].map((n) => ({ label: String(n), action: { type: 'count', n, style: 'index' } })).concat([{ label: 'Closed', action: { type: 'count', n: 0, style: 'index' } }, { label: 'Count 1 to 5', action: { type: 'sequence', id: 'countIndex' } }]) },
      { title: 'Counting, thumb first', items: [1, 2, 3, 4, 5].map((n) => ({ label: String(n), action: { type: 'count', n, style: 'thumb' } })).concat([{ label: 'Count 1 to 5', action: { type: 'sequence', id: 'countThumb' } }]) },
      { title: 'Finger sets', sets: true, items: [{ label: 'Sets in turn', action: { type: 'sequence', id: 'fingerSets' } }] },
      { title: 'Fingers', items: [{ label: 'Curl each digit', action: { type: 'sequence', id: 'curlEach' } }, { label: 'Release fingers', action: { type: 'releaseFingers' } }] },
      { title: 'Grips', items: GRIP_LIST.map((grip) => ({ label: gripLabel(grip), action: { type: 'grasp', object: grip, grip, size: 1 } })).concat([{ label: 'Let go', action: { type: 'release' } }]) },
      { title: 'Presentation', items: [['raised', 'Raised'], ['rest', 'At rest'], ['offer', 'Offered']].map(([kind, label]) => ({ label, action: { type: 'present', kind } })) },
    ];
  }
  const groups = new Map();
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (!groups.has(sc.group)) groups.set(sc.group, []);
    groups.get(sc.group).push({ label: sc.label, action: { type: 'scenario', id } });
  }
  return [
    { title: 'Stations', items: Object.entries(STATIONS).map(([station, s]) => ({ label: humanize(station), hint: s.label, action: { type: 'station', station } })) },
    ...[...groups].map(([group, items]) => ({ title: humanize(group), items })),
    { title: 'Fingers', items: [{ label: 'Curl each digit', action: { type: 'sequence', id: 'curlEach' } }, { label: 'Release fingers', action: { type: 'releaseFingers' } }] },
  ];
}

// Every capability as a row: { group, label, scene, action }.
export function matrixRows() {
  const rows = [];
  rows.push({ group: 'Fingers', label: 'Per-joint control of every digit', scene: 'hands', action: { type: 'sequence', id: 'curlEach' } });
  rows.push({ group: 'Counting', label: SEQUENCES.countIndex.label, scene: 'hands', action: { type: 'sequence', id: 'countIndex' } });
  rows.push({ group: 'Counting', label: SEQUENCES.countThumb.label, scene: 'hands', action: { type: 'sequence', id: 'countThumb' } });
  rows.push({ group: 'Finger sets', label: 'Any set of extended digits', scene: 'hands', action: { type: 'sequence', id: 'fingerSets' } });
  for (const name of Object.keys(GESTURES)) rows.push({ group: 'Gestures', label: gestureLabel(name), scene: 'hands', action: { type: 'gesture', name } });
  for (const grip of GRIP_LIST) rows.push({ group: 'Grips in the hand', label: `${gripLabel(grip)} on a ${objectLabel(grip).toLowerCase()}`, scene: 'hands', action: { type: 'grasp', object: grip, grip, size: 1 } });
  for (const [id, sc] of Object.entries(SCENARIOS)) rows.push({ group: humanize(sc.group), label: sc.label, scene: 'sandbox', action: { type: 'scenario', id } });
  return rows;
}

export { DIGITS, objectLabel };
