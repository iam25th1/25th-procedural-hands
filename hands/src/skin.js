// Skin tones: the ten tones of the Monk Skin Tone Scale (Monk, E. 2023,
// "The Monk Skin Tone Scale", SocArXiv, doi:10.31235/osf.io/pdf4c), with the
// values Google publishes for it at skintone.google (the site's
// --monk-scale-color-1 to -10, given there in HSL; the hex below is that HSL
// converted). The Monk scale is used rather than Fitzpatrick because it is a
// colour scale designed to represent the whole range of human skin
// evenly, with published colour values; Fitzpatrick classifies how skin
// burns and tans under UV, has no official colour values and is weighted
// toward lighter skin.
//
// A tone is more than one colour. Each carries:
// - dorsal: the back of the hand, painted with the albedo that renders as
//   the published scale value (see ALBEDO below);
// - undertone: read from the published hue (golden at hue 36 and up, red at
//   24 and below, neutral between), which tints the palm;
// - palm: lighter and pinker than the dorsal side on every tone, the gap
//   widening with depth (palmar skin carries much less melanin than
//   dorsal skin, so on deep tones the palm is far lighter than the back);
// - nail bed, lunula and free edge: a pink bed seen through the plate,
//   carried toward the palm tone so it reads as part of the same hand, a
//   paler lunula, and a near-white free edge.
// Everything here is plain data and arithmetic: no DOM, no three.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

// [hue degrees, saturation percent, lightness percent], as published.
const MONK_HSL = [
  [30, 50, 92.9], [30, 50, 90.6], [40, 70.9, 89.2], [40, 53.3, 82.4], [36, 44.8, 71.6],
  [32.4, 30.1, 48.2], [23.8, 32, 38.6], [17.7, 29.7, 29], [26.3, 16, 19.6], [26.7, 12.3, 14.3],
];

export function hslToRgb([h, s, l]) {
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => { const k = (n + h / 30) % 12; return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

export function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

export const rgbToHex = (rgb) => `#${rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
export function hexToRgb(hex) {
  const v = parseInt(String(hex).replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const undertoneOf = (hue) => (hue >= 36 ? 'golden' : hue <= 24 ? 'red' : 'neutral');
// The hue the palm leans toward for each undertone.
const PALM_HUE = { golden: 28, neutral: 22, red: 16 };

// The Monk swatches are skin as it appears, not a surface albedo: drawn as
// albedo under the sandbox's lights and filmic tone mapping, the light tones
// lose their colour and read grey-white. So each tone also carries the
// albedo that renders as its swatch: fitted by scripts/skin-measure.js
// --calibrate, which renders the back of the hand at the anatomy framing,
// reads the lit skin back from the canvas and moves the albedo in CIE Lab
// until the rendered colour matches the published swatch. hands:check keeps
// every tone within its tolerance. The published value stays the tone's
// identity (hex); the albedo is only what the mesh is painted with.
// calibrated albedo start
const ALBEDO = ['#fffaf4', '#f8efe7', '#fef4dc', '#e2d6bc', '#cdb898', '#9b7f5f', '#806150', '#634c45', '#443f3e', '#373535'];
// calibrated albedo end

// The ten Monk tones: { id, label, monk, hsl, hex, albedo, undertone }.
export const MONK_TONES = MONK_HSL.map((hsl, i) => ({
  id: `monk-${i + 1}`,
  label: `Monk ${i + 1}`,
  monk: i + 1,
  hsl,
  hex: rgbToHex(hslToRgb(hsl)),
  albedo: ALBEDO[i],
  undertone: undertoneOf(hsl[0]),
}));

export const DEFAULT_SKIN_TONE = 'monk-8';

// A tone from an id ('monk-7'), a Monk number (1 to 10) or any sRGB hex
// (a custom tone, derived by the same rules).
export function skinTone(value = DEFAULT_SKIN_TONE) {
  if (value && typeof value === 'object' && value.hsl) return value;
  if (typeof value === 'number' && value >= 1 && value <= 10) return MONK_TONES[Math.round(value) - 1];
  const byId = MONK_TONES.find((t) => t.id === value);
  if (byId) return byId;
  if (typeof value === 'string' && /^#?[0-9a-fA-F]{6}$/.test(value)) {
    const hsl = rgbToHsl(hexToRgb(value));
    const hex = `#${value.replace('#', '').toLowerCase()}`;
    return { id: 'custom', label: 'Custom', monk: null, hsl, hex, albedo: hex, undertone: undertoneOf(hsl[0]) };
  }
  throw new Error(`unknown skin tone ${value}; use monk-1 to monk-10, 1 to 10 or a hex colour`);
}

// Every colour the mesh needs for a tone, as sRGB triples 0 to 1.
export function skinPalette(value) {
  const tone = skinTone(value);
  // Depth and undertone come from the published tone; the colours are built
  // on its rendered albedo.
  const depth = clamp(1 - tone.hsl[2] / 93, 0, 1);
  const [h, s, l] = rgbToHsl(hexToRgb(tone.albedo));
  // Depth: 0 for the lightest Monk tone, about 0.85 for the deepest. The
  // palm is lighter on every tone: a little on the lightest, far lighter on
  // the deepest.
  const palmHsl = [
    PALM_HUE[tone.undertone],
    lerp(s, 30, depth),
    Math.max(l, Math.min(99.5, l + Math.max(4, (80 - l) * 0.55 * depth))),
  ];
  // palmMatchesDorsal paints the palm the dorsal colour: only for measuring
  // how the palm-side view is lit, so the real palm can be compared fairly.
  // palmKey paints it pure green: only for measuring, to find which pixels
  // of a render are palm (glabrous) skin.
  const palm = tone.palmKey ? [0, 1, 0] : tone.palmMatchesDorsal ? hslToRgb([h, s, l]) : hslToRgb(palmHsl);
  // The nail bed: a pink bed seen through the plate, drawn toward the palm
  // so it belongs to the same hand; a little deeper on the lightest tones so
  // the nail still reads against pale skin.
  const pinkBed = hslToRgb([6, 52, lerp(71, 64, depth)]);
  const bed = pinkBed.map((c, i) => lerp(c, palm[i], lerp(0.2, 0.35, depth)));
  const edge = hslToRgb([30, 25, 93]);
  return {
    tone,
    dorsal: hslToRgb([h, s, l]),
    palm,
    nailBed: bed,
    lunula: bed.map((c, i) => lerp(c, edge[i], 0.45)),
    nailEdge: bed.map((c, i) => lerp(c, edge[i], 0.65)),
  };
}
