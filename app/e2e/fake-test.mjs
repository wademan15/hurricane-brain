// Skeptic whole-app fake test driver. Serves nothing itself: expects `vite preview` on PREVIEW_URL (default http://localhost:4173).
// Usage: node e2e/fake-test.mjs [--speed 1|4|fast] [--only name1,name2] [--tag label]
// Everything is driven through the UI as a user would: onboarding, Settings > Replay speed, Home > "Open a recording file".
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SPEED = opt('speed', '4');
const TAG = opt('tag', `speed${SPEED}`);
const URL = process.env.PREVIEW_URL ?? 'http://localhost:4173';
const recDir = join(here, 'out', 'recordings');
const outDir = join(here, 'out', TAG);
mkdirSync(outDir, { recursive: true });
const index = JSON.parse(readFileSync(join(recDir, 'index.json'), 'utf8'));
const ALL = Object.keys(index);
const names = opt('only', '') ? opt('only').split(',') : ALL;
const speedLabel = { '1': 'Real time (with sound)', '4': '4 times', fast: 'As fast as possible' }[SPEED];
const speedFactor = SPEED === 'fast' ? Infinity : Number(SPEED);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseClock = (s) => { const m = /(\d+):(\d+)/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${String(e).slice(0, 300)}`));

// Audio tap: record every message the real AudioEngine posts to its worklet (only exists when sound is on, i.e. real-time replay).
await page.addInitScript(() => {
  window.__audioMsgs = [];
  const W = window.AudioWorkletNode;
  if (W) {
    window.AudioWorkletNode = class extends W {
      constructor(...a) {
        super(...a);
        const orig = this.port.postMessage.bind(this.port);
        this.port.postMessage = (m, t) => {
          try { window.__audioMsgs.push({ w: performance.now(), m: JSON.parse(JSON.stringify(m, (k, v) => (ArrayBuffer.isView(v) ? undefined : v))) }); } catch {}
          return orig(m, t);
        };
      }
    };
  }
});

await page.goto(URL);
await page.waitForLoadState('networkidle');
// onboarding
for (let i = 0; i < 10; i++) {
  const next = page.getByRole('button', { name: 'Next' });
  if (await next.count()) { await next.click(); continue; }
  const gs = page.getByRole('button', { name: 'Get started' });
  if (await gs.count()) { await gs.click(); break; }
  await sleep(300);
}
await page.waitForSelector('text=Replay a recording');
await page.screenshot({ path: join(outDir, '00-home.png') });
// Settings > replay speed
await page.evaluate(() => { window.location.hash = '#/settings'; });
await page.getByRole('button', { name: speedLabel, exact: true }).click().catch(async () => { await page.getByText(speedLabel).first().click(); });
await page.screenshot({ path: join(outDir, '00-settings.png') });
await page.evaluate(() => { window.location.hash = '#/home'; });

async function snapshotText() {
  return page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.innerText?.replace(/\s+/g, ' ').trim() ?? null;
    const chips = [...document.querySelectorAll('.live .chips .chip')].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
    return {
      title: t('.live-top .title'),
      phi: t('[data-testid=cell-phi]'), oct: t('[data-testid=cell-oct]'), chance: t('[data-testid=cell-chance]'),
      signal: t('[data-testid=signal-state]'), chips,
      calm: t('.hb-calm-message'), guide: t('.live-guide'),
      page: document.querySelector('[data-testid=live-session]') ? 'live' : (document.body.innerText.includes('Replay finished') ? 'finished' : 'other'),
    };
  });
}
async function inspect(dx = 0, dy = 0) {
  if (!(await page.locator('.hb-hurricane').count())) return null;
  const box = await page.locator('.hb-hurricane').first().boundingBox({ timeout: 2000 }).catch(() => null);
  if (!box) return null;
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await sleep(150);
  const txt = await page.evaluate(() => document.querySelector('.hb-readout')?.innerText?.replace(/\s+/g, ' ').trim() ?? null);
  await page.evaluate(() => document.querySelector('.hb-readout button')?.click());
  return txt;
}
async function shot(name, locator = '.live-stage') {
  const p = join(outDir, name);
  try { await page.locator(locator).first().screenshot({ path: p }); } catch { await page.screenshot({ path: p }); }
  return name;
}

const results = {};
for (const name of names) {
  const rec = index[name];
  const dur = rec.seconds;
  console.log(`== ${name} (${dur}s) at ${SPEED}`);
  const t0 = Date.now();
  await page.evaluate(() => { window.location.hash = '#/home'; });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Open a recording file' }).click(),
  ]);
  await chooser.setFiles(join(recDir, `${name}.hbraw`));
  await page.waitForSelector('[data-testid=live-session]', { timeout: 30000 });
  const series = [];
  const shots = {};
  const marks = [30, 60, Math.max(70, dur - 20), Math.max(75, dur - 6)];
  const pending = [...marks];
  const inspects = [];
  let lastElapsed = -1, stuckSince = Date.now(), ended = false;
  const timeoutMs = (dur / speedFactor) * 1000 + 90000;
  while (Date.now() - t0 < timeoutMs) {
    const s = await snapshotText();
    if (s.page !== 'live') { ended = true; series.push({ wall: Date.now() - t0, ...s }); break; }
    const el = parseClock(s.title);
    series.push({ wall: Date.now() - t0, el, ...s });
    if (el !== lastElapsed) { lastElapsed = el; stuckSince = Date.now(); }
    while (pending.length && el !== null && el >= pending[0]) {
      const m = pending.shift();
      shots[`t${m}`] = await shot(`${name}-t${m}.png`);
      shots[`t${m}-full`] = await shot(`${name}-t${m}-full.png`, 'body');
      if (m === marks[2]) { // two canvas-only shots 2 s apart (pixel-motion check)
        await shot(`${name}-pairA.png`, '.hb-hurricane'); await sleep(2000); await shot(`${name}-pairB.png`, '.hb-hurricane');
        shots.pair = [`${name}-pairA.png`, `${name}-pairB.png`];
      }
      const c = await inspect(0, 0);
      const arm = [];
      for (const [dx, dy] of [[0, -120], [120, 0], [0, 120], [-120, 0], [0, -200], [200, 0]]) { const t = await inspect(dx, dy); if (t) arm.push({ dx, dy, text: t }); }
      inspects.push({ at: m, el, eye: c, probes: arm });
    }
    await sleep(500);
  }
  results[name] = { series, shots, inspects, ended };
  // after end: let the storm dissolve and screenshot again
  await sleep(4000);
  const after = await snapshotText();
  shots.afterEnd = await shot(`${name}-end.png`, 'body');
  results[name].afterEnd = after;
  console.log('  ended page=', after.page, 'phi=', after.phi?.slice(0, 80), 'wall', ((Date.now() - t0) / 1000).toFixed(0), 's');
  // dismiss the finished screen
  const done = page.getByRole('button', { name: 'Done' });
  if (await done.count()) await done.click();
  results[name].audioMsgs = await page.evaluate(() => { const a = window.__audioMsgs; window.__audioMsgs = []; return a; });
  results[name].console = consoleMsgs.splice(0);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ speed: SPEED, results }, null, 1));
}
await browser.close();
console.log('done');
