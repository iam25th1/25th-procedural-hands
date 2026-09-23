// Defaults for everything that used to come from the game's constants. Every
// one of these is an option a consumer can override; nothing here is a game
// rule. Units are metres and kilograms; colours are sRGB hex.

import { MONK_TONES, DEFAULT_SKIN_TONE } from './skin.js';

// Skin tones: the ten Monk Skin Tone Scale tones, lightest to deepest, by id
// (see skin.js for the source). skinTone also takes a Monk number or a hex.
export const SKIN_TONES = MONK_TONES.map((t) => t.id);

// Short sleeve colours.
export const SLEEVE_COLOURS = ['#F2B705', '#2D6CDF', '#1FA25A', '#F5F5F0', '#2B2B2B'];

// Object presets the grasp solver and the sandbox share. Shapes are the
// signed distance primitives the solver closes on: sphere { r }, cylinder
// { r, h } with h the half length along local Z, box and pillow { hx, hy, hz }.
export const OBJECTS = {
  pebble: { shape: 'sphere', r: 0.0125, mass: 0.02 },
  rock: { shape: 'sphere', r: 0.03, mass: 0.3 },
  ball: { shape: 'sphere', r: 0.035, mass: 0.06 },
  bigBall: { shape: 'sphere', r: 0.11, mass: 0.45 },
  handle: { shape: 'cylinder', r: 0.014, h: 0.0575, mass: 0.18 },
  sachet: { shape: 'pillow', hx: 0.075, hy: 0.045, hz: 0.0175, round: 0.012, mass: 0.5 },
  block: { shape: 'box', hx: 0.025, hy: 0.025, hz: 0.025, mass: 0.1 },
};

export const DEFAULTS = {
  seed: 1,
  skinTone: DEFAULT_SKIN_TONE,
  sleeveColour: SLEEVE_COLOURS[0],
  lod: 'high',
  reducedMotion: false,
};
