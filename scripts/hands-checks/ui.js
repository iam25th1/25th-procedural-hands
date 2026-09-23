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

const inside = (p, r) => p.x >= r.x - 0.5 && p.x <= r.x + r.w + 0.5 && p.y >= r.y - 0.5 && p.y <= r.y + r.h + 0.5;
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

uiChecks.push({
  name: 'control centre: collapsed by default, C and the button toggle it, it docks beside the view (never over the hands, in either camera), 44 px targets, remembered',
  async run() {
    const { server, base } = await serve();
    let browser = null;
    const bad = [];
    let smallest = Infinity;
    try {
      ({ browser } = await launchBrowser());
      for (const [w, h] of [[390, 844], [844, 390], [1440, 900]]) {
        const vp = `${w}x${h}`;
        const touch = w < 900;
        const { context, page, problems } = await openApp(browser, base, { hasTouch: touch, viewport: { width: w, height: h } });
        page.setDefaultTimeout(8000);
        try {
        const layout = () => page.evaluate(() => window.__handsApp.layout());
        let L = await layout();
        if (L.open) bad.push(`${vp}: open on first load`);
        const camBefore = await page.evaluate(() => window.__handsApp.camera());
        if (overlap(L.canvas, L.bar) > 0) bad.push(`${vp}: the bar overlaps the view`);
        // Open with the keyboard (desktop) or the on-screen control (touch).
        if (touch) await page.getByRole('button', { name: /Controls/ }).click(); else await page.keyboard.press('c');
        await page.waitForTimeout(450);
        // Opening the centre must not move the camera or change the field of view.
        const camOpen = await page.evaluate(() => window.__handsApp.camera());
        if (camOpen.fov !== camBefore.fov) bad.push(`${vp}: field of view changed ${camBefore.fov} to ${camOpen.fov} on opening`);
        if (camOpen.pos.some((v, i) => Math.abs(v - camBefore.pos[i]) > 1e-9)) bad.push(`${vp}: the camera moved on opening`);
        for (const cam of ['Inspect', 'First person']) {
          await page.getByRole('radio', { name: cam, exact: true }).click();
          await page.waitForTimeout(300);
          L = await layout();
          if (!L.open) bad.push(`${vp}: did not open`);
          if (overlap(L.canvas, L.centre) > 0) bad.push(`${vp} ${cam}: the centre overlaps the view by ${overlap(L.canvas, L.centre).toFixed(0)} px2`);
          if (overlap(L.canvas, L.bar) > 0) bad.push(`${vp} ${cam}: the bar overlaps the view`);
          // The hands are in the part of the view nothing covers: below the
          // top bar and inside the canvas.
          const band = { x: L.canvas.x, y: L.topbar.y + L.topbar.h, w: L.canvas.w, h: L.canvas.y + L.canvas.h - (L.topbar.y + L.topbar.h) };
          const pts = await page.evaluate(() => window.__handsApp.handsOnScreen());
          const off = pts.filter((p) => !p.inFront || !inside(p, band));
          if (off.length > 1) bad.push(`${vp} ${cam}: ${off.map((p) => `${p.side} ${p.joint}`).join(', ')} outside the clear view`);
          if (inside({ x: pts[0].x, y: pts[0].y }, L.centre)) bad.push(`${vp} ${cam}: a hand under the centre`);
        }
        // Every control in the bar and the open centre is a 44 px target.
        for (const tab of ['Actions', 'Matrix', 'Joints', 'Objects', 'Capture', 'Settings']) {
          await page.locator('.tabs').getByRole('button', { name: tab, exact: true }).click();
          await page.waitForTimeout(250);
          const sizes = await page.evaluate(() => [...document.querySelectorAll('.bar button, .centre button, .centre input')]
            .filter((n) => n.offsetParent !== null).map((n) => { const r = n.getBoundingClientRect(); return { t: n.textContent.trim() || n.type, w: r.width, h: r.height }; }));
          for (const s of sizes) {
            smallest = Math.min(smallest, s.w, s.h);
            if (s.w < 44 || s.h < 44) bad.push(`${vp} ${tab}: "${s.t}" is ${s.w.toFixed(0)}x${s.h.toFixed(0)}`);
          }
        }
        // Remembered: reload and it is still open on the tab left open.
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.__handsApp);
        await page.waitForTimeout(400);
        L = await layout();
        if (!L.open || L.tab !== 'settings') bad.push(`${vp}: not remembered after reload (open ${L.open}, tab ${L.tab})`);
        // Close with the keyboard or the Close button.
        if (touch) await page.getByRole('button', { name: 'Close', exact: true }).click(); else await page.keyboard.press('c');
        await page.waitForTimeout(450);
        L = await layout();
        if (L.open) bad.push(`${vp}: did not close`);
        } catch (e) {
          bad.push(`${vp}: ${String(e.message || e).split('\n')[0]}`);
        }
        bad.push(...problems.map((p) => `${vp}: ${p}`));
        await context.close();
      }
    } finally {
      if (browser) await browser.close();
      server.close();
    }
    return { pass: bad.length === 0, worst: bad.length, limit: 0, unit: 'faults', note: bad.length ? bad.slice(0, 4).join('; ') : `390x844, 844x390 and 1440x900; smallest control ${smallest.toFixed(0)} px` };
  },
});
