// Planning off the main thread, in a real browser: switching actions (the
// recorded plans) and moving a joint slider mid action (every later plan
// solved cold) must never hold a frame, and every solve the page needs must
// come from the planning worker with the page's copy in step with it.
import { launchBrowser, serve } from '../shoot.js';

// A frame held longer than this is a hitch: three frames at 60 Hz.
export const PLANNING_LIMIT = { frameMs: 50 };
// Actions whose plans after a slider move include the costliest cold solves
// measured (pad pinch 1 s, climb and lever 0.25 to 0.4 s on the main thread).
const RUNS = ['Pad pinch on three sizes', 'Pull a lever', 'Climb hand over hand'];

export const planningChecks = [
  {
    name: 'planning: switching actions and cold solves after a slider move never hold a frame; the worker answers every solve',
    device: 'a wall-clock frame time in a browser, with the GPU, CPU and scheduler of the machine it runs on',
    async run() {
      const { server, base } = await serve();
      let browser = null;
      try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
        await page.goto(`${base}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__handsApp && window.__handsApp.plansLoaded, null, { timeout: 60000 });
        const planning = await page.evaluate(() => window.__handsApp.planning());
        if (!planning.worker || !planning.active) problems.push('the planning worker is not running');
        await page.evaluate(() => {
          window.__ft = [];
          window.__planningSeen = 0;
          let last = performance.now();
          const tick = (t) => { window.__ft.push([t, t - last]); if (/planning the next move/.test(document.getElementById('status').textContent)) window.__planningSeen++; last = t; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
        await page.keyboard.press('c');
        await page.waitForTimeout(400);
        const frames = async (t0, ms) => page.evaluate(([t, span]) => window.__ft.filter(([ts]) => ts >= t - 20 && ts <= t + span).map(([, d]) => d), [t0, ms]);
        const notes = [];
        let worst = 0;
        for (const label of RUNS) {
          const t0 = await page.evaluate(() => performance.now());
          await page.getByRole('button', { name: label, exact: true }).first().click();
          await page.waitForTimeout(600);
          const t1 = await page.evaluate(() => performance.now());
          await page.getByRole('button', { name: 'Joints', exact: true }).first().click();
          await page.locator('input.slider').first().evaluate((n) => { n.value = '0.55'; n.dispatchEvent(new Event('input', { bubbles: true })); });
          await page.getByRole('button', { name: 'Actions', exact: true }).first().click();
          await page.waitForTimeout(5000);
          const sw = Math.max(...(await frames(t0, 600)));
          const cold = Math.max(...(await frames(t1, 5000)));
          worst = Math.max(worst, sw, cold);
          notes.push(`${label}: switch ${sw.toFixed(0)} ms, after the slider ${cold.toFixed(0)} ms`);
        }
        const stats = await page.evaluate(() => window.__handsApp.planStats());
        const seen = await page.evaluate(() => window.__planningSeen);
        if (!stats || stats.live !== 0 || stats.miss) problems.push(`page solved ${stats ? stats.live : '?'} itself${stats && stats.miss ? `, parted at answer ${stats.miss.at} (${stats.miss.kind})` : ''}`);
        const pass = problems.length === 0 && worst <= PLANNING_LIMIT.frameMs;
        return { pass, worst, limit: PLANNING_LIMIT.frameMs, unit: 'ms worst frame', note: `${notes.join('; ')}; ${stats ? `${stats.used} of ${stats.of} answers from the worker, ${stats.live} solved on the page` : 'no stats'}; "planning" shown on ${seen} frames${problems.length ? `; ${problems.slice(0, 3).join(' | ')}` : ''}; renderer ${launched.renderer}` };
      } finally {
        if (browser) await browser.close();
        server.close();
      }
    },
  },
];
