// Video capture in a real browser, both modes through the sandbox's own
// controls: an action rendered offline (every frame, 60 fps) and a short live
// recording, each saved, read back and played. The native save dialog cannot
// be driven headless, so the page's picker is removed and the download path
// is the one taken; the dialog path is a manual check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, serve } from '../shoot.js';
import { readWebM } from '../../app/capture/webm.js';
import { readMp4 } from '../../app/capture/mp4.js';

async function play(page, bytes, type) {
  return page.evaluate(async ({ b64, type: t }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([bin], { type: t }));
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error(`decode error ${v.error && v.error.message}`)); });
    if (!Number.isFinite(v.duration)) { v.currentTime = 1e6; await new Promise((r) => { v.ontimeupdate = r; }); }
    const duration = v.duration;
    v.currentTime = 0;
    await v.play();
    await new Promise((r) => setTimeout(r, 300));
    const frames = v.getVideoPlaybackQuality().totalVideoFrames;
    v.pause();
    return { width: v.videoWidth, height: v.videoHeight, duration, frames };
  }, { b64: bytes.toString('base64'), type });
}

export const videoChecks = [
  {
    name: 'video: an action rendered offline (60 fps, every frame) and a live recording both save a file that plays',
    async run() {
      const { server, base } = await serve();
      let browser = null;
      const bad = [];
      const notes = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-video-'));
      try {
        ({ browser } = await launchBrowser());
        const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, acceptDownloads: true });
        const page = await ctx.newPage();
        page.setDefaultTimeout(20000);
        await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
        page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
        await page.goto(`${base}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__handsApp && window.__handsApp.plansLoaded, null, { timeout: 30000 });
        await page.keyboard.press('c');
        await page.getByRole('button', { name: 'Grab, lift, carry, place', exact: true }).click();
        await page.waitForTimeout(300);
        const captureTab = () => page.locator('.tabs').getByRole('button', { name: 'Capture', exact: true }).click();
        await captureTab();
        const take = async (start) => {
          const dl = page.waitForEvent('download', { timeout: 120000 });
          await start();
          const d = await dl;
          const file = path.join(dir, d.suggestedFilename());
          await d.saveAs(file);
          return file;
        };
        const blank = await ctx.newPage();
        // Offline: this action, from its start.
        const off = await take(() => page.getByRole('button', { name: 'Render video', exact: true }).click());
        const offBytes = fs.readFileSync(off);
        const offS = off.endsWith('.webm') ? readWebM(new Uint8Array(offBytes)) : readMp4(new Uint8Array(offBytes));
        const offFrames = offS.blocks ?? offS.samples;
        const offP = await play(blank, offBytes, off.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
        const expectFrames = Math.round((offS.durationMs ?? offS.durationS * 1000) * 60 / 1000);
        if (offFrames !== expectFrames || offFrames < 300) bad.push(`offline: ${offFrames} frames for ${expectFrames} at 60 fps`);
        if (offP.width !== offS.width || !(offP.duration > 4) || !(offP.frames > 0)) bad.push(`offline: did not play (${JSON.stringify(offP)})`);
        if (!/^hands-sandbox-grabcarryplace-\d{8}-\d{6}\.(webm|mp4)$/.test(path.basename(off))) bad.push(`offline: file name ${path.basename(off)}`);
        notes.push(`offline ${offS.codec || 'H.264'} ${offS.width}x${offS.height}, ${offFrames} frames = ${(offFrames / 60).toFixed(2)} s at 60 fps, played ${offP.duration.toFixed(2)} s`);
        // Live: two seconds.
        await page.keyboard.press('c');
        await captureTab();
        const live = await take(async () => {
          await page.getByRole('button', { name: 'Record video', exact: true }).click();
          await page.waitForTimeout(2000);
          await page.locator('.cap-live').click();
        });
        const liveBytes = fs.readFileSync(live);
        const liveP = await play(blank, liveBytes, live.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
        if (!(liveP.duration > 1.5) || !(liveP.width > 0) || !(liveP.frames > 0)) bad.push(`live: did not play (${JSON.stringify(liveP)})`);
        const liveCodec = live.endsWith('.webm') ? readWebM(new Uint8Array(liveBytes)).codec : 'mp4';
        notes.push(`live ${liveCodec} ${liveP.width}x${liveP.height}, ${liveP.duration.toFixed(2)} s`);
        await ctx.close();
      } catch (e) {
        bad.push(String(e.message || e).split('\n')[0]);
      } finally {
        if (browser) await browser.close();
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { pass: bad.length === 0, worst: bad.length, limit: 0, unit: 'faults', note: bad.length ? bad.slice(0, 4).join('; ') : notes.join('; ') };
    },
  },
];
