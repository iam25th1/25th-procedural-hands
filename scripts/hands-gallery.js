// Renders the sandbox through its shot mode in a real browser (GPU where
// there is one, SwiftShader otherwise) at phone portrait, phone landscape
// and desktop: the twelve core sheets first, then the full set. Frames go to
// artifacts/gallery/<viewport>/<sheet>/, contact sheets to
// artifacts/gallery/sheets/, and one overview per viewport to docs/assets.
//
//   npm run hands:gallery                 everything
//   npm run hands:gallery -- --core       the twelve core sheets only
//   npm run hands:gallery -- --only=re    sheets whose "<viewport>/<key>" matches
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, serve } from './shoot.js';
import { VIEWPORTS, CORE, fullSet, OVERVIEW } from './hands-gallery/sheets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'gallery');
const SHEET_LONG_EDGE = 2400;
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new RegExp(onlyArg.slice('--only='.length)) : null;
const CORE_ONLY = process.argv.includes('--core');

const q = (params) => new URLSearchParams({ shot: '1', ui: '0', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) }).toString();
const sameRun = (a, b) => JSON.stringify({ ...a, t: 0 }) === JSON.stringify({ ...b, t: 0 });
const slug = (s) => s.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, '');

// Frames of one sheet, grouped into runs of the same scene at rising times:
// one page load per run, advanced frame by frame.
async function renderSheet(context, base, vp, sheet) {
  const dir = path.join(OUT, vp.key, sheet.key);
  fs.mkdirSync(dir, { recursive: true });
  const problems = [];
  const frames = [];
  let i = 0;
  while (i < sheet.frames.length) {
    const run = [sheet.frames[i]];
    while (i + run.length < sheet.frames.length && sameRun(sheet.frames[i + run.length].params, run[0].params) && (sheet.frames[i + run.length].params.t ?? 0) >= (run[run.length - 1].params.t ?? 0)) run.push(sheet.frames[i + run.length]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`));
    });
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`${base}/?${q(run[0].params)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__handsShot && window.__handsShot.ready, null, { timeout: 120000 });
    const first = await page.evaluate(() => window.__handsShot);
    if (first.error) problems.push(`shot: ${first.error.split('\n')[0]}`);
    for (let k = 0; k < run.length; k++) {
      let info = first.info;
      if (k > 0) {
        const r = await page.evaluate((t) => window.__handsShot.advance(t), run[k].params.t ?? 0);
        if (r.error) problems.push(`shot: ${r.error.split('\n')[0]}`);
        info = r.info;
      }
      const file = path.join(dir, `${String(frames.length + 1).padStart(2, '0')}-${slug(run[k].name)}.png`);
      await page.screenshot({ path: file, fullPage: false });
      frames.push({ file, name: run[k].name, info });
    }
    for (const v of await page.evaluate(() => window.__cspViolations)) problems.push(`csp: ${v}`);
    await page.close();
    i += run.length;
  }
  return { frames, problems };
}

// Contact sheet: the frames in a grid with captions, screenshotted.
async function composeSheet(context, vp, key, title, frames) {
  const cols = Math.min(vp.cols, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const cap = 34;
  const rawW = cols * vp.width + (cols + 1) * 12;
  const rawH = rows * (vp.height + cap) + (rows + 1) * 12 + 58;
  const scale = Math.min(1, SHEET_LONG_EDGE / Math.max(rawW, rawH));
  const page = await context.newPage();
  await page.setViewportSize({ width: Math.round(rawW * scale), height: Math.round(rawH * scale) });
  const cells = frames.map((f) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f.file).toString('base64')}"><figcaption>${f.name}</figcaption></figure>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#15171A;color:#F1F0EB;font:600 22px/1.2 'Arial Narrow',Arial,sans-serif}
    .wrap{transform:scale(${scale});transform-origin:0 0;width:${rawW}px}
    h1{margin:0;padding:12px 12px 0;font-size:30px;color:#F2B705;height:46px}
    .grid{display:grid;grid-template-columns:repeat(${cols},${vp.width}px);gap:12px;padding:12px}
    figure{margin:0;background:#1E2126}
    img{display:block;width:${vp.width}px;height:${vp.height}px}
    figcaption{height:${cap}px;line-height:${cap}px;padding:0 10px;white-space:nowrap;overflow:hidden}
  </style></head><body><div class="wrap"><h1>${vp.key}: ${title}</h1><div class="grid">${cells}</div></div></body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  const dir = path.join(OUT, 'sheets');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${vp.key}--${key}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  return file;
}

async function main() {
  const t0 = performance.now();
  const { server, base } = await serve();
  const { browser, renderer } = await launchBrowser();
  console.log(`gallery: WebGL renderer ${renderer}`);
  const sheets = [...CORE.map((s) => ({ ...s, core: true })), ...(CORE_ONLY ? [] : fullSet())];
  const problems = [];
  let count = 0;
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.key.startsWith('phone'), hasTouch: vp.key.startsWith('phone') });
      for (const sheet of sheets) {
        if (ONLY && !ONLY.test(`${vp.key}/${sheet.key}`)) continue;
        const r = await renderSheet(context, base, vp, sheet);
        problems.push(...r.problems.map((p) => `${vp.key}/${sheet.key}: ${p}`));
        const pages = [];
        for (let k = 0; k < r.frames.length; k += vp.perSheet) pages.push(r.frames.slice(k, k + vp.perSheet));
        for (let k = 0; k < pages.length; k++) {
          const file = await composeSheet(context, vp, pages.length > 1 ? `${sheet.key}-${k + 1}` : sheet.key, pages.length > 1 ? `${sheet.title} (${k + 1} of ${pages.length})` : sheet.title, pages[k]);
          console.log(`${sheet.core ? 'core ' : 'sheet'} ${path.relative(ROOT, file)}  ${pages[k].length} frames  max ${Math.max(...pages[k].map((f) => (f.info ? f.info.triangles : 0)))} tris`);
        }
        count += r.frames.length;
      }
      if (!ONLY || ONLY.test(`${vp.key}/overview`)) {
        const r = await renderSheet(context, base, vp, { key: 'overview', frames: OVERVIEW });
        problems.push(...r.problems.map((p) => `${vp.key}/overview: ${p}`));
        const file = await composeSheet(context, vp, 'overview', 'the twelve core sheets, one frame each', r.frames);
        const dest = path.join(ROOT, 'docs', 'assets', `overview-${vp.key}.png`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, dest);
        console.log(`overview ${path.relative(ROOT, dest)}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${count} frames in ${((performance.now() - t0) / 1000).toFixed(0)} s; ${problems.length} problems`);
  for (const p of problems) console.log(`problem: ${p}`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
