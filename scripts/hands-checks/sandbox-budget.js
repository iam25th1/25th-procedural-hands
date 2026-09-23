// Budgets with the sandbox scene loaded, measured where they are spent: the
// real app in a real browser (headless Chromium, GPU where there is one),
// through shot mode, at every station. Also fails on any console error,
// page error, failed request or CSP violation while loading.
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, serve, capture } from '../shoot.js';
import { Skeleton } from '../../hands/src/skeleton.js';

export const SANDBOX_BUDGET = { triangles: 30000, calls: 45, bones: 80, liveStepMs: 3.0 }; // docs/HANDS_SANDBOX_SPEC.md, BUDGETS
const SHOTS = [
  'scene=sandbox&cap=grabCarryPlace&t=2',
  'scene=sandbox&cap=drawer&t=2.5',
  'scene=sandbox&cap=pushCrate&t=2',
  'scene=sandbox&cap=climb&t=4',
  'scene=sandbox&cap=rope&t=2',
  'scene=sandbox&cap=twoHand&t=2.5',
];

export const sandboxBudgetChecks = [
  {
    name: 'budget: triangles, draw calls and bones with the sandbox scene loaded, every station, in a browser',
    async run() {
      const { server, base } = await serve();
      let browser = null;
      try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
        let tris = 0;
        let calls = 0;
        const problems = [];
        for (const q of SHOTS) {
          const r = await capture(context, base, q, path.join(os.tmpdir(), 'hands-budget.png'));
          problems.push(...r.problems.map((p) => `${q}: ${p}`));
          if (r.info) { tris = Math.max(tris, r.info.triangles); calls = Math.max(calls, r.info.calls); }
        }
        const bones = new Skeleton().joints.length;
        const pass = problems.length === 0 && tris <= SANDBOX_BUDGET.triangles && calls <= SANDBOX_BUDGET.calls && bones <= SANDBOX_BUDGET.bones;
        return { pass, worst: tris, limit: SANDBOX_BUDGET.triangles, unit: 'tris', note: `${calls} draw calls (limit ${SANDBOX_BUDGET.calls}), ${bones} bones (limit ${SANDBOX_BUDGET.bones}); ${SHOTS.length} stations; renderer ${launched.renderer}${problems.length ? `; ${problems.slice(0, 3).join(' | ')}` : ''}` };
      } finally {
        if (browser) await browser.close();
        server.close();
      }
    },
  },
  {
    // The figure that matters on a device: sim step ms as the perf overlay
    // measures it, live, while scripted actions play (from the plan table,
    // as a user gets them). Measured in headless Chromium on the machine
    // running the check; the on-device figure is read off the overlay.
    name: 'budget: sim step ms, median, sandbox loaded live in a browser (the perf overlay figure)',
    async run() {
      const { server, base } = await serve();
      let browser = null;
      try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.goto(`${base}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__handsApp && window.__handsApp.plansLoaded, null, { timeout: 30000 });
        await page.keyboard.press('c');
        const rows = [];
        for (const label of ['Grab, lift, carry, place', 'Pull a lever', 'Climb hand over hand']) {
          await page.getByRole('button', { name: label, exact: true }).click();
          await page.evaluate(() => window.__handsApp.resetPerf());
          await page.waitForTimeout(3000);
          rows.push({ label, ...(await page.evaluate(() => window.__handsApp.perf())) });
        }
        const worst = Math.max(...rows.map((r) => r.stepMedian));
        const note = rows.map((r) => `${r.label}: step ${r.stepMedian.toFixed(2)} ms (max ${r.stepMax.toFixed(1)}) over ${r.steps} steps, frame ${r.frameMedian.toFixed(2)} ms`).join('; ');
        return { pass: worst <= SANDBOX_BUDGET.liveStepMs, worst, limit: SANDBOX_BUDGET.liveStepMs, unit: 'ms median', note: `${note}; renderer ${launched.renderer}` };
      } finally {
        if (browser) await browser.close();
        server.close();
      }
    },
  },
];
