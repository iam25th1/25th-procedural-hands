// Renders shot URLs to PNG files through the sandbox's shot mode, for quick
// looks while working: node scripts/shoot.js out.png "scene=sandbox&cap=x&t=1" ...
// The gallery (scripts/hands-gallery.js) uses the same capture path.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../server/index.js';

export const GPU_ARGS = ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
export const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

export async function launchBrowser() {
  for (const args of [GPU_ARGS, SWIFTSHADER_ARGS]) {
    const browser = await chromium.launch({ headless: true, args });
    const page = await browser.newPage();
    const renderer = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    await page.close();
    if (renderer) return { browser, renderer };
    await browser.close();
  }
  throw new Error('no WebGL renderer available');
}

export async function serve() {
  return new Promise((resolve, reject) => {
    const server = startServer({ port: 0, host: '127.0.0.1', log: () => {}, onTaken: reject });
    server.on('listening', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// One frame: returns { file, problems, info }.
export async function capture(context, base, query, file) {
  const page = await context.newPage();
  const problems = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`));
  });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(`${base}/?shot=1&ui=0&${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__handsShot && window.__handsShot.ready, null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__handsShot);
  for (const v of await page.evaluate(() => window.__cspViolations)) problems.push(`csp: ${v}`);
  if (result.error) problems.push(`shot: ${result.error.split('\n')[0]}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  return { file, problems, info: result.info };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [out, ...queries] = process.argv.slice(2);
  const vp = (process.env.VIEWPORT || '844x390').split('x').map(Number);
  const { server, base } = await serve();
  const { browser, renderer } = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, deviceScaleFactor: 1 });
  let i = 0;
  for (const q of queries) {
    const file = queries.length === 1 ? out : out.replace(/\.png$/, `-${i++}.png`);
    const r = await capture(context, base, q, file);
    console.log(file, JSON.stringify(r.info), r.problems.join(' | '));
  }
  console.log('renderer', renderer);
  await browser.close();
  server.close();
}
