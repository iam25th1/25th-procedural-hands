// Budgets with the sandbox scene loaded, measured where they are spent: the
// real app in a real browser (headless Chromium, GPU where there is one),
// through shot mode, at every station. Also fails on any console error,
// page error, failed request or CSP violation while loading.
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, serve, capture } from '../shoot.js';
import { Skeleton } from '../../hands/src/skeleton.js';

// docs/HANDS_SANDBOX_SPEC.md, BUDGETS. The live sim step is held to its
// median, its 95th percentile and its worst step: no single step may take a
// whole 60 Hz frame (16.7 ms). The page's own per-frame simulation budget
// (8 ms, app/ui/app.js) is a target the first steps of a freshly built
// scene do not meet in the slow CPU mode; the spec says so.
export const SANDBOX_BUDGET = { triangles: 30000, calls: 45, bones: 80, liveStepMs: 3.0, liveStepP95Ms: 4.5, liveStepWorstMs: 16.7 };
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
  ...liveStepChecks(),
];

// The figure that matters on a device: sim step ms as the perf overlay
// measures it, live, while scripted actions play (from the planning worker
// and the plan table, as a user gets them). Measured once in headless
// Chromium on the machine running the check and read three ways; the
// on-device figures are read off the overlay.
const LIVE_ACTIONS = ['Grab, lift, carry, place', 'Pull a lever', 'Climb hand over hand'];
let liveRun = null;
function measureLive() {
  liveRun = liveRun || (async () => {
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
      for (const label of LIVE_ACTIONS) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.evaluate(() => window.__handsApp.resetPerf());
        await page.waitForTimeout(3000);
        rows.push({ label, ...(await page.evaluate(() => window.__handsApp.perf())) });
      }
      return { rows, renderer: launched.renderer };
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  })();
  return liveRun;
}

function liveStepChecks() {
  const one = (name, pick, limit, what) => ({
    name,
    async run() {
      const { rows, renderer } = await measureLive();
      const worst = Math.max(...rows.map(pick));
      const note = rows.map((r) => `${r.label}: ${what} ${pick(r).toFixed(2)} ms (median ${r.stepMedian.toFixed(2)}, p95 ${r.stepP95.toFixed(2)}, worst ${r.stepMax.toFixed(1)}) over ${r.steps} steps, frame ms median ${r.frameMedian.toFixed(2)}, worst ${r.frameMax.toFixed(1)}`).join('; ');
      return { pass: worst <= limit, worst, limit, unit: `ms ${what}`, note: `${note}; renderer ${renderer}` };
    },
  });
  return [
    one('budget: sim step ms, median, sandbox loaded live in a browser (the perf overlay figure)', (r) => r.stepMedian, SANDBOX_BUDGET.liveStepMs, 'median'),
    one('budget: sim step ms, 95th percentile, sandbox loaded live in a browser (the perf overlay figure)', (r) => r.stepP95, SANDBOX_BUDGET.liveStepP95Ms, 'p95'),
    one('budget: sim step ms, worst step, sandbox loaded live in a browser, under one 60 Hz frame (16.7 ms)', (r) => r.stepMax, SANDBOX_BUDGET.liveStepWorstMs, 'worst'),
  ];
}
