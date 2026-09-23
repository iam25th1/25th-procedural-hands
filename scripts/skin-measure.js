// Measure how each skin tone renders: the back of the right hand at the
// anatomy framing, in the real app through shot mode, read back from the
// canvas. Returns, per tone, the median skin colour of the dorsal view and
// of the palm view, and the CIE76 colour difference between the rendered
// dorsal median and the tone's published Monk swatch.
//   node scripts/skin-measure.js            prints the table
// The skin-tone check in hands:check and the calibration of the albedo
// factors in hands/src/skin.js both use this.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, serve } from './shoot.js';
import { MONK_TONES, hexToRgb, rgbToHex } from '../hands/src/skin.js';

// sRGB (0 to 1) to CIE Lab (D65).
export function rgbToLab([r, g, b]) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// CIE Lab (D65) back to sRGB 0 to 1, clamped to the gamut.
export function labToRgb(lab) { return labToLinear(lab).map(encode); }
const encode = (c) => { const v = Math.min(1, Math.max(0, c)); return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; };
export const inGamut = (lab) => labToLinear(lab).every((c) => c >= -1e-4 && c <= 1 + 1e-4);
function labToLinear([L, a, b]) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  return [R, G, B];
}

// In the page: the median colour of the skin pixels (neither backdrop nor
// sleeve), weighted to the lit side: the brightest half by luminance, which
// is the part of the hand a swatch describes.
function skinStats() {
  const src = document.getElementById('view');
  const t = document.createElement('canvas');
  t.width = src.width;
  t.height = src.height;
  const g = t.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, t.width, t.height).data;
  const bg = [d[0], d[1], d[2]];
  const px = [];
  for (let i = 0; i < d.length; i += 4 * 3) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    if (Math.abs(r - bg[0]) + Math.abs(gg - bg[1]) + Math.abs(b - bg[2]) < 24) continue;
    // The sleeve: saturated yellow.
    if (r > 150 && gg > 110 && b < 90 && r - b > 110) continue;
    px.push([r, gg, b, 0.2126 * r + 0.7152 * gg + 0.0722 * b]);
  }
  px.sort((a, b) => a[3] - b[3]);
  const lit = px.slice(Math.floor(px.length * 0.5));
  const med = (k) => { const v = lit.map((p) => p[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] / 255; };
  return { n: px.length, rgb: [med(0), med(1), med(2)] };
}

export async function measureSkin({ viewport = { width: 1440, height: 900 } } = {}) {
  const { server, base } = await serve();
  let browser = null;
  const out = [];
  try {
    ({ browser } = await launchBrowser());
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    for (let i = 0; i < MONK_TONES.length; i++) {
      const row = { tone: MONK_TONES[i] };
      // The palm is also drawn once in the dorsal colour: how the palm-side
      // view renders the same colour, so the real palm is compared fairly.
      for (const [key, cam, extra] of [['back', 'back', ''], ['palm', 'palm', ''], ['palmBase', 'palm', '&palmmatch=1']]) {
        const page = await context.newPage();
        await page.goto(`${base}/?shot=1&ui=0&scene=hands&hand=right&pose=relaxed&cam=${cam}&skin=${i}${extra}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__handsShot && window.__handsShot.ready, null, { timeout: 60000 });
        row[key] = await page.evaluate(skinStats);
        await page.close();
      }
      row.swatchLab = rgbToLab(hexToRgb(row.tone.hex));
      row.backLab = rgbToLab(row.back.rgb);
      row.palmLab = rgbToLab(row.palm.rgb);
      row.palmBaseLab = rgbToLab(row.palmBase.rgb);
      row.dE = deltaE(row.backLab, row.swatchLab);
      out.push(row);
    }
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.close();
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
// Fit each tone's albedo so its rendered back of hand matches the swatch:
// move the albedo in Lab by the rendered error, re-render, repeat. Writes
// the result into hands/src/skin.js between its calibration markers (the
// server serves the file fresh, so each round renders the new values).
async function calibrate(rounds = 8, target = 1.5) {
  const file = new URL('../hands/src/skin.js', import.meta.url);
  const write = (hexes) => {
    const src = fs.readFileSync(file, 'utf8');
    const line = `const ALBEDO = [${hexes.map((h) => `'${h}'`).join(', ')}];`;
    fs.writeFileSync(file, src.replace(/(\/\/ calibrated albedo start\n)[^\n]*\n/, `$1${line}\n`));
  };
  let albedo = MONK_TONES.map((t) => rgbToLab(hexToRgb(t.albedo)));
  for (let r = 0; r < rounds; r++) {
    const rows = await measureSkin();
    const worst = Math.max(...rows.map((x) => x.dE));
    console.log(`round ${r}: worst dE76 ${worst.toFixed(2)}  ${rows.map((x) => x.dE.toFixed(1)).join(' ')}`);
    if (worst <= target) break;
    // Step toward the swatch; where the lightest tones cannot get light
    // enough (a white surface under these lights renders at about L* 89),
    // keep their hue and chroma and take the most lightness the sRGB gamut
    // allows, rather than letting the lightness error bleach them white.
    albedo = albedo.map((lab, i) => {
      const next = lab.map((v, k) => v + 0.9 * (rows[i].swatchLab[k] - rows[i].backLab[k]));
      while (!inGamut(next) && next[0] > 0) next[0] -= 0.25;
      return next;
    });
    write(albedo.map((lab) => rgbToHex(labToRgb(lab))));
  }
}

if (isMain && process.argv.includes('--calibrate')) {
  await calibrate();
} else if (isMain) {
  const rows = await measureSkin();
  const f = (v) => v.toFixed(1).padStart(6);
  console.log('tone     swatch   back L*  swatch L*  dE76 back vs swatch  palm L*  palm in dorsal colour L*');
  for (const r of rows) console.log(`${r.tone.label.padEnd(8)} ${r.tone.hex}  ${f(r.backLab[0])}  ${f(r.swatchLab[0])}   ${f(r.dE)}              ${f(r.palmLab[0])}   ${f(r.palmBaseLab[0])}`);
}
