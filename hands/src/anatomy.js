// Anatomy data with sources. Solver and mesh code read from here and carry no
// magic numbers of their own. Lengths are metres unless the name says MM.
// Full citations and the derivations are in docs/HANDS.md.

export const MM = 0.001;

// Buryanov A, Kotiuk V. Proportions of hand segments. Int J Morphol 2010;
// 28(3):755-758. Table I: interarticular bone lengths and fingertip soft
// tissue, right hands of 66 adults, arithmetic means in mm.
export const BONES_MM = {
  thumb: { metacarpal: 46.22, proximal: 31.57, distal: 21.67, tip: 5.67 },
  index: { metacarpal: 68.12, proximal: 39.78, middle: 22.38, distal: 15.82, tip: 3.84 },
  middle: { metacarpal: 64.60, proximal: 44.63, middle: 26.33, distal: 17.40, tip: 3.95 },
  ring: { metacarpal: 58.00, proximal: 41.37, middle: 25.65, distal: 17.30, tip: 3.95 },
  little: { metacarpal: 53.69, proximal: 32.74, middle: 18.11, distal: 15.96, tip: 3.73 },
};

// Same paper, Table III: web height from the metacarpophalangeal joint as a
// percentage of the external finger length (web to tip).
export const WEB_PERCENT = { index: 15.52, middle: 15.33, ring: 18.49, little: 24.72 };

// ANSUR II (2012 Anthropometric Survey of US Army Personnel), combined male
// and female sample, N = 6068, means in mm as summarised by sota2.com.
export const HAND_MM = { length: 189.3, breadth: 85.0, palmLength: 113.9, circumference: 203.9, wristCircumference: 169.0 };

// Segment lengths as a fraction of stature H: Drillis R, Contini R. Body
// segment parameters. New York University, 1966 (as reproduced in Winter DA,
// Biomechanics and Motor Control of Human Movement, Fig 4.1): upper arm
// 0.186 H, forearm 0.146 H, hand 0.108 H. Stature is implied by the ANSUR II
// hand length so every segment scales from one measured value.
export const SEGMENT_FRACTION = { upperArm: 0.186, forearm: 0.146, hand: 0.108 };
export const STATURE_MM = HAND_MM.length / SEGMENT_FRACTION.hand;
export const ARM_MM = {
  upperArm: SEGMENT_FRACTION.upperArm * STATURE_MM,
  forearm: SEGMENT_FRACTION.forearm * STATURE_MM,
};

// Wrist joint centre to the base of the third metacarpal, derived: hand
// length minus (third metacarpal + third finger skeleton + tip soft tissue).
export const CARPUS_MM = HAND_MM.length - (BONES_MM.middle.metacarpal + BONES_MM.middle.proximal + BONES_MM.middle.middle + BONES_MM.middle.distal + BONES_MM.middle.tip);

// External finger length (web to tip) and web height from the MCP joint,
// derived from Table I and Table III of Buryanov and Kotiuk:
//   de = (tip + d) / (1 + web%/100),  web = tip + d - de
export function fingerExternal(finger) {
  const b = BONES_MM[finger];
  const tipPlusD = b.tip + b.distal + (b.middle || 0) + b.proximal;
  const de = tipPlusD / (1 + WEB_PERCENT[finger] / 100);
  return { external: de, web: tipPlusD - de };
}

// Layout of the metacarpals on the carpus, right hand, hand space: origin at
// the wrist joint centre, +X ulnar, +Y dorsal, -Z distal. Bases sit on the
// distal carpal row; heads follow the sourced metacarpal lengths, with the
// head x and y set so the four knuckles span the ANSUR II hand breadth (85 mm
// including soft tissue) and the palm carries its transverse arch (the ring
// and little heads drop palmarward). The z of each head is solved from the
// bone length, not typed in.
export const LAYOUT_MM = {
  cmc: { index: [-14, 1.5, -30], middle: [-4, 2.5, -32], ring: [7, 1.5, -30.5], little: [17, -1.5, -27.5] },
  head: { index: [-32, 1.5], middle: [-10.5, 2.0], ring: [11, -1.5], little: [31.5, -6.0] },
  // Trapezium: radial, palmar and about two thirds of the carpus distal.
  thumbCmc: [-24, -9, -21],
  // Thumb metacarpal direction at rest (relaxed abduction) and its dorsal
  // (nail) direction hint; both in hand space, normalised in code.
  thumbDir: [-0.62, -0.40, -0.67],
  thumbDorsal: [-0.70, 0.71, 0],
  // Fraction by which the extended phalanges turn from the metacarpal fan toward the hand axis.
  phalanxConverge: 0.6,
  // Ring and little metacarpal bases flex a little at their CMC joints so the
  // palm can cup (El-Shennawy et al 2001 report the 4th and 5th CMC joints
  // as the mobile ones); the second and third are fixed.
};

// Shoulder anchors relative to the camera (eye) in metres: down and out to
// each side, a touch forward. First person rigs sit the shoulders narrower
// than the ANSUR biacromial breadth so the arms enter the frame naturally.
export const SHOULDER_M = { x: 0.17, y: -0.26, z: 0.0 };

// Cross section sizes in mm used by the mesh generator: width (across the
// hand, X) and thickness (dorsal to palmar, Y) at each station. Derived from
// ANSUR II hand breadth (85 mm over four knuckles gives a 21 mm pitch), wrist
// circumference (169 mm) and hand circumference (204 mm), then proportioned
// down the digits with the classic joint swell (the PIP is the widest part of
// a finger) and Buryanov's tip soft tissue. Documented as derived values.
export const SECTIONS_MM = {
  finger: {
    index: { head: [20, 18], proximal: [18.5, 16], pip: [19, 16.5], middle: [17, 14.5], dip: [16.5, 14], distal: [15.5, 13], pad: [15, 12.5], tip: [11, 9] },
    middle: { head: [20.5, 18.5], proximal: [19, 16.5], pip: [19.5, 17], middle: [17.5, 15], dip: [17, 14.5], distal: [16, 13.5], pad: [15.5, 13], tip: [11.5, 9.5] },
    ring: { head: [19.5, 18], proximal: [18, 15.5], pip: [18.5, 16], middle: [16.5, 14], dip: [16, 13.5], distal: [15, 12.5], pad: [14.5, 12], tip: [10.5, 8.5] },
    little: { head: [17.5, 16], proximal: [16, 14], pip: [16.5, 14.5], middle: [14.5, 12.5], dip: [14, 12], distal: [13, 11], pad: [12.5, 10.5], tip: [9, 7.5] },
  },
  thumb: { base: [40, 28], metacarpal: [30, 25], shaft: [22, 18], mcp: [24, 20], proximal: [21.5, 18], ip: [20.5, 17.5], distal: [19.5, 16], pad: [19, 15.5], tip: [13.5, 11] },
  // Palm stations from the wrist to the knuckle line: width and thickness.
  // Wrist girth from ANSUR II (combined sample, N = 6068, the public data
  // file): wrist circumference 169.0 mm (SD 13.1). The wrist ring is sized
  // to it (it was 157 mm), keeping its width to thickness ratio, and the
  // rings toward the unchanged belly taper into it linearly with distance.
  // Perimeters are of the mesh's own superellipse (n = 2.1). ANSUR II's only
  // forearm girth is taken flexed with the fist clenched (295.0 mm), which
  // is not a relaxed forearm, so the belly (239 mm) is left as it was.
  wrist: [62.5, 43],
  palm: { proximal: [70, 36], mid: [82, 34], distal: [86, 30] },
  forearm: { wrist: [62.5, 43], distal: [63.5, 44], lower: [68, 49], mid: [76, 57.5], belly: [84, 66], elbow: [80, 72] },
  upperArm: { elbow: [82, 78], mid: [94, 90], deltoid: [100, 96], shoulder: [96, 92] },
  sleeve: 9, // clearance over the upper arm surface
};

// Nail plate proportions relative to the distal phalanx: length as a fraction
// of the bone, width as a fraction of the distal section width, free edge
// past the fingertip, and the nail bed inset. Values from the common clinical
// description of the nail unit (the plate covers roughly the distal half of
// the terminal phalanx).
export const NAIL = { length: 0.58, width: 0.66, freeEdge: 1.2 * MM, lift: 0.3 * MM };

// Joint limits in degrees. flex: [min, max] where positive flexes toward the
// palm and negative is extension past neutral. abd: [min, max] where positive
// spreads away from the middle finger (fingers) or abducts (thumb, shoulder).
// twist: rotation about the bone axis.
export const LIMITS_DEG = {
  // Fingers: AAOS normal values as listed by goniometer.io (MCP 90, PIP 100,
  // DIP 90), active hyperextension from B K et al, Indian J Plast Surg 2024
  // (little MCP 26.3 mean), MCP abduction 25 from Physiopedia goniometry.
  finger: {
    mcp: { flex: [-25, 90], abd: [-25, 25] },
    pip: { flex: [-5, 100] },
    dip: { flex: [-15, 90] },
  },
  // Thumb: Barakat MJ, Field J, Taylor J. The range of movement of the thumb.
  // Hand (NY) 2013;8(2):179-182. CMC anteposition 61, retroposition 31,
  // radial abduction 63, adduction 10; MCP flexion 60, extension 8; IP
  // flexion 88, extension 12.
  // The CMC is modelled as a saddle joint in the hand frame: flex sweeps the
  // thumb across the palm about the palm normal (negative is radial
  // abduction beyond the rest fan of about 34 degrees, so 63 - 34 = 29),
  // abd is palmar abduction about an in-plane axis (rest already sits about
  // 24 degrees palmar, so anteposition 61 leaves 37 and retroposition 31
  // gives -55, capped at -45 for the skin), twist is pronation about the
  // metacarpal, which opposition adds to automatically.
  thumb: {
    cmc: { flex: [-29, 62], abd: [-45, 37], twist: [-35, 35] },
    mcp: { flex: [-8, 60], abd: [-10, 10] },
    ip: { flex: [-12, 88] },
  },
  // Wrist: Ryu JY et al. Functional ranges of motion of the wrist joint.
  // J Hand Surg Am 1991;16(3):409-419: flexion 73, extension 71, radial 19,
  // ulnar 33. dev positive is ulnar.
  wrist: { flex: [-71, 73], dev: [-19, 33] },
  // Forearm rotation and elbow: Wheeless' Textbook of Orthopaedics, elbow
  // joint: flexion 0 to 150, pronation and supination 80 each. The rig's
  // bind pose (arm forward, palm down) is a full pronation from the thumb up
  // neutral, so the range is taken as 90 each way to include that pose.
  forearm: { twist: [-90, 90], bindPronation: 90 },
  elbow: { flex: [0, 150] },
  // Shoulder: AAOS normal values (goniometer.io): flexion 180, extension 60,
  // abduction 180, external rotation 90, internal rotation 70. The rig
  // treats the glenohumeral joint as a swing cone plus a twist about the
  // humerus: the cone half angle is the smaller of flexion and abduction,
  // the twist limit is symmetric at the larger of the two rotations.
  shoulder: { cone: 170, twist: [-90, 90] },
  // Ring and little CMC flexion for palm cupping (El-Shennawy et al 2001).
  metacarpal: { ring: { flex: [0, 10] }, little: { flex: [0, 20] } },
};

// Coupling. DIP follows PIP at two thirds in free motion (Roda-Sales A,
// Sancho-Bru JL, Vergara M. PeerJ 2022;10:e14051, linear DIP from PIP).
// Enslaving: a fraction of a neighbour's flexion leaks into a finger; the
// ring and little fingers are the least independent (Lang CE, Schieber MH.
// J Neurophysiol 2004;92:2802-2810; van den Noort JC et al. PLoS ONE
// 2016;11(12):e0168636). The fractions are design values inside the ranges
// those papers report.
export const COUPLING = {
  dipFromPip: 2 / 3,
  enslave: {
    index: { middle: 0.05 },
    middle: { index: 0.08, ring: 0.12 },
    ring: { middle: 0.20, little: 0.20 },
    little: { ring: 0.30 },
  },
};

// Thumb opposition: the CMC pronates as it abducts (Kapandji), modelled as a
// twist proportional to palmar abduction. Design value within the CMC twist
// limit above.
export const THUMB_OPPOSITION_TWIST = 0.45;
