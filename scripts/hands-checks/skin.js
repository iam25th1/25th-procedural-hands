// Skin tones as rendered: every Monk Skin Tone Scale tone drawn in the real
// app at the anatomy framing, read back from the canvas. The back of the
// hand must render as the published swatch, and the palm must render
// lighter than the same palm drawn in the dorsal colour from the same view
// (a fair comparison: the palm-side view is lit a little differently).
import { measureSkin } from '../skin-measure.js';

export const SKIN_LIMITS = { dE: 2.5, palmLift: 0.3 };

export const skinChecks = [
  {
    name: 'skin tones: every Monk tone renders as its published swatch on the back of the hand, and its palm renders lighter than the back',
    async run() {
      const rows = await measureSkin();
      const bad = [];
      let worst = 0;
      for (const r of rows) {
        worst = Math.max(worst, r.dE);
        if (r.dE > SKIN_LIMITS.dE) bad.push(`${r.tone.label} back dE ${r.dE.toFixed(1)}`);
        const lift = r.palmLab[0] - r.palmBaseLab[0];
        if (lift < SKIN_LIMITS.palmLift) bad.push(`${r.tone.label} palm only ${lift.toFixed(1)} L* over the dorsal colour`);
      }
      const lifts = rows.map((r) => (r.palmLab[0] - r.palmBaseLab[0]).toFixed(1));
      return { pass: bad.length === 0, worst, limit: SKIN_LIMITS.dE, unit: 'dE76', note: bad.length ? bad.join('; ') : `10 tones; palm lighter by ${lifts.join(', ')} L* (Monk 1 to 10)` };
    },
  },
];
