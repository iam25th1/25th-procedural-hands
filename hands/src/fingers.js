// Per joint finger and thumb control with natural coupling: the DIP follows
// the PIP unless a pose says otherwise, neighbouring fingers pull each other
// along a little (enslaving), and the thumb pronates as it abducts so it
// opposes the fingertips. Everything is clamped to the limit table by
// Skeleton.setChannels.
import { COUPLING, THUMB_OPPOSITION_TWIST, LIMITS_DEG } from './anatomy.js';
import { FINGERS, XR_PREFIX } from './skeleton.js';
import { deg } from './math.js';

// A hand pose in radians:
// { thumb: { cmc: [flex, abd, twist?], mcp: [flex, abd?], ip: flex },
//   index: { mcp: [flex, abd], pip: flex, dip?: flex }, ... , metacarpal?: { ring, little } }
// Missing digits are left untouched.

export function emptyHandPose() {
  const pose = { thumb: { cmc: [0, 0, 0], mcp: [0, 0], ip: 0 } };
  for (const f of FINGERS) pose[f] = { mcp: [0, 0], pip: 0, dip: null };
  pose.metacarpal = { ring: 0, little: 0 };
  return pose;
}

// Copy with numbers, so poses can be blended without aliasing.
export function clonePose(p) {
  const out = { thumb: { cmc: p.thumb.cmc.slice(), mcp: p.thumb.mcp.slice(), ip: p.thumb.ip } };
  for (const f of FINGERS) out[f] = { mcp: p[f].mcp.slice(), pip: p[f].pip, dip: p[f].dip ?? null };
  out.metacarpal = { ring: p.metacarpal ? p.metacarpal.ring : 0, little: p.metacarpal ? p.metacarpal.little : 0 };
  if (p.effort) out.effort = { ...p.effort };
  return out;
}

// Active extension resists passive coupling: a finger held straight on
// purpose (pose.effort[f] = 1) takes only this share of the enslaving pull.
export const EFFORT_KEEP = 0.3;

// Flatten a pose into named channels, resolving coupling.
export function poseChannels(pose) {
  const out = {};
  const own = {};
  for (const f of FINGERS) own[f] = { mcp: pose[f].mcp[0], pip: pose[f].pip };
  for (const f of FINGERS) {
    const e = COUPLING.enslave[f] || {};
    const keep = 1 - (1 - EFFORT_KEEP) * ((pose.effort && pose.effort[f]) || 0);
    let mcp = own[f].mcp;
    let pip = own[f].pip;
    for (const [n, k] of Object.entries(e)) {
      mcp += keep * k * Math.max(0, own[n].mcp - own[f].mcp);
      pip += keep * k * Math.max(0, own[n].pip - own[f].pip);
    }
    const dip = pose[f].dip == null ? COUPLING.dipFromPip * pip : pose[f].dip;
    const p = XR_PREFIX[f];
    out[`${p}-phalanx-proximal`] = { flex: mcp, abd: pose[f].mcp[1] };
    out[`${p}-phalanx-intermediate`] = { flex: pip };
    out[`${p}-phalanx-distal`] = { flex: dip };
  }
  const t = pose.thumb;
  const cmcTwist = (t.cmc[2] || 0) + THUMB_OPPOSITION_TWIST * Math.max(0, t.cmc[1]);
  out['thumb-metacarpal'] = { flex: t.cmc[0], abd: t.cmc[1], twist: cmcTwist };
  out['thumb-phalanx-proximal'] = { flex: t.mcp[0], abd: t.mcp[1] || 0 };
  out['thumb-phalanx-distal'] = { flex: t.ip };
  out['ring-finger-metacarpal'] = { flex: pose.metacarpal ? pose.metacarpal.ring : 0 };
  out['pinky-finger-metacarpal'] = { flex: pose.metacarpal ? pose.metacarpal.little : 0 };
  return out;
}

// Apply resolved channels to one side of the skeleton (no springs; the rig
// puts springs in front of this).
export function applyChannels(skel, side, channels) {
  for (const [name, c] of Object.entries(channels)) {
    const j = skel.joint(side, name);
    if (!j) continue;
    skel.setChannels(j, c.flex || 0, c.abd || 0, c.twist || 0);
  }
}

// Channel names of a digit, for masks.
export function digitJoints(digit) {
  if (digit === 'thumb') return ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'];
  const p = XR_PREFIX[digit];
  return [`${p}-phalanx-proximal`, `${p}-phalanx-intermediate`, `${p}-phalanx-distal`, `${p}-metacarpal`];
}

export const DIGIT_OF_JOINT = (() => {
  const m = {};
  for (const d of ['thumb', ...FINGERS]) for (const j of digitJoints(d)) m[j] = d;
  return m;
})();

// Per-finger control. curl 0 to 1 per finger and per joint maps onto the
// anatomical flexion range of each joint (0 is straight, 1 is the joint's
// full flexion); spread -1 to 1 maps onto MCP abduction (positive spreads
// away from the middle finger). For the thumb, curl folds it across the palm
// (CMC sweep, MCP and IP), spread swings it radially out of the palm plane
// and opposition turns it to face the fingertips (palmar abduction, with the
// pronation twist that coupling adds). Everything is clamped to LIMITS_DEG.
const FINGER_JOINT_NAMES = { mcp: 'phalanx-proximal', pip: 'phalanx-intermediate', dip: 'phalanx-distal' };
export const CONTROL_JOINTS = { finger: ['mcp', 'pip', 'dip'], thumb: ['cmc', 'mcp', 'ip'] };

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clampPm1 = (v) => Math.min(1, Math.max(-1, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function fingerControlChannels(digit, ctl) {
  const out = {};
  if (digit === 'thumb') {
    const L = LIMITS_DEG.thumb;
    const c = (j) => clamp01(ctl.joints[j] ?? ctl.curl);
    const opp = clamp01(ctl.opposition || 0);
    const spread = clamp01(Math.max(0, ctl.spread || 0));
    // Straight thumb in the palm plane at 0, folded across the palm at 1.
    let cmcFlex = lerp(-12, 48, c('cmc')) - 17 * spread + 22 * opp;
    let cmcAbd = lerp(-12, 10, c('cmc')) + 8 * spread + 45 * opp;
    cmcFlex = Math.min(L.cmc.flex[1], Math.max(L.cmc.flex[0], cmcFlex));
    cmcAbd = Math.min(L.cmc.abd[1], Math.max(L.cmc.abd[0], cmcAbd));
    out['thumb-metacarpal'] = { flex: deg(cmcFlex), abd: deg(cmcAbd), twist: THUMB_OPPOSITION_TWIST * Math.max(0, deg(cmcAbd)) };
    out['thumb-phalanx-proximal'] = { flex: deg(L.mcp.flex[1] * c('mcp')), abd: 0 };
    out['thumb-phalanx-distal'] = { flex: deg(L.ip.flex[1] * c('ip')) };
    return out;
  }
  const L = LIMITS_DEG.finger;
  const p = XR_PREFIX[digit];
  const cm = clamp01(ctl.joints.mcp ?? ctl.curl);
  const cp = clamp01(ctl.joints.pip ?? ctl.curl);
  const pip = deg(L.pip.flex[1] * cp);
  const dip = ctl.joints.dip == null ? Math.min(deg(L.dip.flex[1]), COUPLING.dipFromPip * pip) : deg(L.dip.flex[1] * clamp01(ctl.joints.dip));
  const spread = clampPm1(ctl.spread || 0);
  out[`${p}-${FINGER_JOINT_NAMES.mcp}`] = { flex: deg(L.mcp.flex[1] * cm), abd: deg(L.mcp.abd[1] * spread) };
  out[`${p}-${FINGER_JOINT_NAMES.pip}`] = { flex: pip };
  out[`${p}-${FINGER_JOINT_NAMES.dip}`] = { flex: dip };
  return out;
}

// Natural coupling for fingers that are not under control themselves: a
// controlled neighbour's extra flexion leaks in at the COUPLING.enslave
// fraction, scaled by how much control that neighbour has.
export function enslaveNeighbours(channels, weights) {
  for (const f of FINGERS) {
    if ((weights[f] || 0) > 0.999) continue;
    const e = COUPLING.enslave[f] || {};
    const p = XR_PREFIX[f];
    for (const [n, k] of Object.entries(e)) {
      const w = weights[n] || 0;
      if (w <= 0) continue;
      const q = XR_PREFIX[n];
      for (const seg of ['phalanx-proximal', 'phalanx-intermediate']) {
        const mine = channels[`${p}-${seg}`];
        const theirs = channels[`${q}-${seg}`];
        mine.flex += k * w * (1 - (weights[f] || 0)) * Math.max(0, theirs.flex - mine.flex);
      }
    }
  }
  return channels;
}
