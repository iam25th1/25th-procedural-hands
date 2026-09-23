// The interactive sandbox in a real browser: Move camera drags with a mouse
// and with touch, read back as the direction the camera actually moved
// (direct mapping: drag right moves it right, drag up moves it up).
import { launchBrowser, serve } from '../shoot.js';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

async function openApp(browser, base, { hasTouch = false, viewport = { width: 844, height: 390 } } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch, isMobile: hasTouch });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__handsApp, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  return { context, page, problems };
}

// One drag from the middle of the 3D view by (dx, dy) CSS pixels.
async function drag(page, dx, dy, touch) {
  const box = await page.evaluate(() => window.__handsApp.layout().canvas);
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  if (!touch) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const pt = (px, py) => [{ x: px, y: py, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + (dx * i) / 10, y + (dy * i) / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

export const uiChecks = [
  {
    name: 'camera: Move camera drags move the camera the way you drag, mouse and touch, inspection and first person',
    async run() {
      const { server, base } = await serve();
      let browser = null;
      const wrong = [];
      const notes = [];
      try {
        ({ browser } = await launchBrowser());
        for (const touch of [false, true]) {
          const { context, page, problems } = await openApp(browser, base, { hasTouch: touch });
          await page.getByRole('button', { name: 'Move camera', exact: true }).click();
          for (const cam of ['Inspect', 'First person']) {
            await page.getByRole('radio', { name: cam, exact: true }).click();
            for (const [label, dx, dy, axis, sign] of [['right', 80, 0, 'right', 1], ['left', -80, 0, 'right', -1], ['up', 0, -60, 'up', 1], ['down', 0, 60, 'up', -1]]) {
              await page.getByRole('radio', { name: cam, exact: true }).click(); // press again: recentre
              const before = await page.evaluate(() => window.__handsApp.camera());
              await drag(page, dx, dy, touch);
              const after = await page.evaluate(() => window.__handsApp.camera());
              // Inspection moves the camera; first person turns it in place,
              // so there the view direction is what moves.
              // The camera looks along -Z: forward is up x right.
              const fwd = (c) => { const [u, r] = [c.up, c.right]; return [u[1] * r[2] - u[2] * r[1], u[2] * r[0] - u[0] * r[2], u[0] * r[1] - u[1] * r[0]]; };
              const moved = cam === 'Inspect' ? sub(after.pos, before.pos) : sub(fwd(after), fwd(before));
              const along = dot(moved, before[axis]) * sign;
              if (!(along > 1e-4)) wrong.push(`${touch ? 'touch' : 'mouse'} ${cam} drag ${label}: moved ${along.toExponential(1)} along its ${axis}`);
            }
          }
          notes.push(`${touch ? 'touch' : 'mouse'}: 8 drags`);
          wrong.push(...problems);
          await context.close();
        }
      } finally {
        if (browser) await browser.close();
        server.close();
      }
      return { pass: wrong.length === 0, worst: wrong.length, limit: 0, unit: 'wrong drags', note: wrong.length ? wrong.slice(0, 4).join('; ') : `${notes.join(', ')}; every drag moved the camera or view its own way` };
    },
  },
];
