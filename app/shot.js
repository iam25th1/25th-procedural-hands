// Shot mode: URL parameters pick a scene, a capability or pose, a time, a
// camera and the settings; the clock steps there in fixed steps, one frame
// is rendered and window.__handsShot reports it. The gallery drives this.

const SCENES = new Set(['hands', 'sandbox', 'arm']);
const CAMS = new Set(['fp', 'view', 'palm', 'back', 'side', 'ulnar', 'three', 'front', 'orbit']);

function num(v, fallback, lo, hi) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9_+:-]{1,48}$/.test(v) ? v : '');

export function parseShot(search) {
  const q = new URLSearchParams(search);
  const scene = SCENES.has(q.get('scene')) ? q.get('scene') : 'sandbox';
  return {
    shot: q.get('shot') === '1',
    scene,
    cap: word(q.get('cap')),
    pose: word(q.get('pose')),
    gesture: word(q.get('gesture')),
    count: q.get('count') ? Math.floor(num(q.get('count'), 0, 0, 5)) : null,
    style: q.get('style') === 'thumb' ? 'thumb' : 'index',
    set: word(q.get('set')),
    grip: word(q.get('grip')),
    action: word(q.get('action')),
    hand: ['left', 'right', 'both'].includes(q.get('hand')) ? q.get('hand') : 'both',
    t: num(q.get('t'), 0, 0, 120),
    seed: Math.floor(num(q.get('seed'), 1, 0, 2 ** 32 - 1)),
    cam: CAMS.has(q.get('cam')) ? q.get('cam') : null,
    yaw: q.has('yaw') ? num(q.get('yaw'), 0, -7, 7) : null,
    pitch: q.has('pitch') ? num(q.get('pitch'), 0, -1.5, 1.5) : null,
    dist: q.has('dist') ? num(q.get('dist'), 0.5, 0.05, 6) : null,
    zoom: num(q.get('zoom'), 1, 0.2, 5),
    focus: ['left', 'right', 'both', 'thumb'].includes(q.get('focus')) ? q.get('focus') : null,
    skin: Math.floor(num(q.get('skin'), 7, 0, 9)),
    palmMatch: q.get('palmmatch') === '1',
    palmKey: q.get('palmkey') === '1',
    sleeve: Math.floor(num(q.get('sleeve'), 0, 0, 9)),
    lod: q.get('lod') === 'low' ? 'low' : 'high',
    // scene=arm: forearm rotation in degrees from thumb-up neutral (positive
    // pronation); the bind pose, palm down, is 90.
    pron: q.has('pron') ? num(q.get('pron'), 90, -90, 90) : 90,
    reduced: q.get('reduced') === '1',
    ui: q.get('ui') !== '0',
  };
}

export function buildShotUrl(state) {
  const q = new URLSearchParams();
  q.set('shot', '1');
  for (const [k, v] of Object.entries(state)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  q.set('ui', '0');
  return `${location.origin}/?${q.toString()}`;
}
