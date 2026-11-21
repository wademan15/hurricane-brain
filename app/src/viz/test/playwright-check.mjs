#!/usr/bin/env node
/**
 * Renders the real hurricane shader headlessly and checks the authenticity rules.
 * TEST ONLY. Run from anywhere:   node app/src/viz/test/playwright-check.mjs
 *
 * (a) all-null frames  -> calm water, two screenshots 1 s apart are pixel-identical
 * (b) the same static frame repeated:
 *       rotation bound to a measured frequency -> the image rotates (screenshots differ)
 *       dominant = null                        -> pixel-identical across time
 * (c) a 3-step golden ratio cascade vs (d) an octave cascade -> look different
 * (e) the combined state (both at once) looks different from spiral-only, rings-only and from both
 *     cascades overlaid without the combined state; it is pixel-stable when nothing changes
 * (f) reduced motion (prefers-reduced-motion) rotates far less in the same second
 * (g) accessibility: readout outside role="img", focus in and back, Escape, keyboard parts, text
 *     alternative and live region, readout placement hook, greyscale distinguishability, spectrum
 *     summary, and axe (if axe-core is available: AXE_CORE=/path/to/axe.min.js)
 * Also: frame time of the shader at 1920x1080, and animation-frame intervals of the live view.
 * Screenshots are written to app/src/viz/test/out/.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../../..');
const out = resolve(here, 'out');
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createServer } = await import(resolve(appRoot, 'node_modules/vite/dist/node/index.js'));

const server = await createServer({ root: appRoot, configFile: resolve(appRoot, 'vite.config.ts'), logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const addr = server.httpServer.address();
const base = `http://127.0.0.1:${addr.port}/src/viz/test/harness.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const results = [];
/** Optional axe-core run. Fails a check on any serious or critical violation inside the views. */
const axePath = process.env.AXE_CORE;
const runAxe = async (label) => {
  if (!axePath) return;
  await page.addScriptTag({ path: axePath });
  const v = await page.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('.hb-hurricane, .hb-spectrum'), { resultTypes: ['violations'] });
    return r.violations.map((x) => `${x.id} (${x.impact}, ${x.nodes.length})`);
  });
  check(`axe on ${label}: no violations`, v.length === 0, v.join('; ') || 'clean');
};
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name) => {
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(resolve(out, `${name}.png`), buf);
  return buf;
};
/** Mean absolute difference per channel (0..255) and fraction of changed pixels, computed in the page. */
const diff = (a, b) =>
  page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const px = (img) => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height).data;
    };
    const da = px(ia), db = px(ib);
    let sum = 0, changed = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      sum += d;
      if (d > 0) changed++;
    }
    return { mean: sum / (da.length / 4) / 3, changed: changed / (da.length / 4) };
  }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]);

try {
  await page.goto(base);
  await page.waitForFunction(() => !!window.hb);
  const api = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return c.getContext('webgl2') ? 'webgl2' : c.getContext('webgl') ? 'webgl1' : 'none';
  });
  console.log(`WebGL in this browser: ${api}`);

  // (a) all-null -> calm water, pixel-stable.
  await page.evaluate(() => window.hb.setScenario('null'));
  await wait(1500);
  const a1 = await shot('a-null-1');
  await wait(1000);
  const a2 = await shot('a-null-2');
  check('(a) all-null frames: two screenshots 1 s apart are pixel-identical', a1.equals(a2));
  const calmText = await page.locator('.hb-calm-message').textContent();
  check('(a) calm water shows the reason', /Calm water: poor sensor contact/.test(calmText ?? ''), calmText ?? '');

  // (b) static frame, rotation bound to a measured 9.95 Hz -> rotates.
  await page.evaluate(() => window.hb.setScenario('static-rot'));
  await wait(1500);
  const b1 = await shot('b-static-rot-1');
  await wait(1000);
  const b2 = await shot('b-static-rot-2');
  const db = await diff(b1, b2);
  check('(b) static frame with measured dominant frequency: image rotates', !b1.equals(b2) && db.changed > 0.05,
    `${(db.changed * 100).toFixed(1)}% of pixels changed in 1 s`);

  // (b) static frame, dominant = null -> identical.
  await page.evaluate(() => window.hb.setScenario('static-norot'));
  await wait(1500);
  const n1 = await shot('b-static-norot-1');
  await wait(1000);
  const n2 = await shot('b-static-norot-2');
  check('(b) static frame with dominant = null: pixel-identical across 1 s', n1.equals(n2));

  // Bands only (confirmed tracks, no cascade).
  await page.evaluate(() => window.hb.setScenario('bands'));
  await wait(1500);
  await shot('bands-no-cascade');

  // (c) phi cascade building to 3 steps; (d) octave cascade.
  await page.evaluate(() => window.hb.setScenario('phi'));
  await wait(500);
  await shot('c-phi-0-bands');
  await wait(1200);
  await shot('c-phi-1-one-step');
  await wait(2800);
  const c = await shot('c-phi-3-steps');
  await page.evaluate(() => window.hb.setScenario('octave'));
  await wait(2500);
  const d = await shot('d-octave');
  const cd = await diff(c, d);
  check('(c) vs (d): golden ratio and octave cascades look different', cd.mean > 2 && cd.changed > 0.2,
    `mean |diff| ${cd.mean.toFixed(2)}/255, ${(cd.changed * 100).toFixed(1)}% pixels differ`);

  // (e) Combined state, static, dominant null so it must be pixel-stable.
  await page.evaluate(() => window.hb.setScenario('both-cascades-no-state'));
  await wait(1500);
  const ov = await shot('e-both-cascades-no-combined-state');
  await page.evaluate(() => window.hb.setScenario('combined'));
  await wait(1500);
  const e1 = await shot('e-combined-state-1');
  await wait(1000);
  const e2 = await shot('e-combined-state-2');
  check('(e) combined state with nothing changing: pixel-identical across 1 s', e1.equals(e2));
  const ec = await diff(e1, c);
  const ed = await diff(e1, d);
  const eo = await diff(e1, ov);
  check('(e) combined state looks different from spiral-only, rings-only and the plain overlay',
    ec.mean > 2 && ed.mean > 2 && eo.mean > 0.5 && eo.changed > 0.01,
    `vs spiral ${ec.mean.toFixed(2)}, vs rings ${ed.mean.toFixed(2)}, vs overlay ${eo.mean.toFixed(2)}/255 over ${(eo.changed * 100).toFixed(1)}% px`);
  await page.mouse.click(640, 400 - Math.round(0.15 * 0.46 * 800));
  await wait(400);
  await shot('e-combined-readout');
  console.log(`  readout on the eye wall in the combined state: ${await page.locator('.hb-readout h3').textContent()}`);
  await page.keyboard.press('Escape');

  // (f) Reduced motion: the same measured 9.95 Hz rotates much less in 1 s.
  await page.evaluate(() => window.hb.setScenario('static-rot'));
  await wait(1200);
  const fr1 = await shot('f-full-motion-1');
  await wait(1000);
  const fr2 = await shot('f-full-motion-2');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await wait(1200);
  const rm1 = await shot('f-reduced-motion-1');
  await wait(1000);
  const rm2 = await shot('f-reduced-motion-2');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const dFull = await diff(fr1, fr2);
  const dRed = await diff(rm1, rm2);
  // Pixel difference grows much less than linearly with angle (and full motion softens fine texture),
  // so this only checks "clearly less, but still moving". The exact rate (5.3x slower at 9.95 Hz)
  // is asserted in photosafe.test.ts.
  check('(f) reduced motion: rotation is a slower drift (still moving, driven by the measurement)',
    dRed.mean > 0 && dRed.mean < dFull.mean * 0.7,
    `mean |diff| in 1 s: full ${dFull.mean.toFixed(2)}, reduced ${dRed.mean.toFixed(2)}/255`);

  // Worst case for flicker: 8 arms on a 45 Hz track.
  await page.evaluate(() => window.hb.setScenario('static-rot-8arms-45hz'));
  await wait(1500);
  await shot('g-8-arms-45hz');

  // Heart: pulse and swell, and tap-to-inspect readout.
  await page.evaluate(() => window.hb.setScenario('phi-heart'));
  await wait(2000);
  await shot('e-phi-heart');
  await page.mouse.click(640, 400);
  await wait(400);
  await shot('f-readout-eye');
  const readoutTitle = await page.locator('.hb-readout h3').textContent();
  check('tap on the centre opens a readout for the eye', /eye/i.test(readoutTitle ?? ''), readoutTitle ?? '');
  const hasAlignment = await page.locator('.hb-readout-alignment').count();
  check('readout shows golden ratio, octave and chance side by side', hasAlignment === 1);
  await page.keyboard.press('Escape');
  await page.mouse.click(640 + 120, 400 - 30);
  await wait(400);
  await shot('g-readout-arm');
  console.log(`  readout at (760,370): ${await page.locator('.hb-readout h3').textContent()}`);

  // (g) Accessibility.
  const a11y = await page.evaluate(() => {
    const ro = document.querySelector('.hb-readout');
    return {
      insideImg: !!ro?.closest('[role="img"]'),
      labelled: ro?.getAttribute('aria-labelledby') && document.getElementById(ro.getAttribute('aria-labelledby'))?.tagName,
      focusIsHeading: document.activeElement?.tagName === 'H3' && !!document.activeElement.closest('.hb-readout'),
    };
  });
  check('(g) the readout is a labelled region outside the picture\'s role="img"', !a11y.insideImg && a11y.labelled === 'H3');
  check('(g) opening the readout moves focus to its heading', a11y.focusIsHeading);
  await page.keyboard.press('Escape');
  check('(g) Escape closes the readout', (await page.locator('.hb-readout').count()) === 0);
  await runAxe('readout-closed');

  // Keyboard route to every part.
  await page.evaluate(() => window.hb.setScenario('combined'));
  await wait(2600);
  await page.evaluate(() => document.querySelector('.hb-hurricane')?.setAttribute('tabindex', '-1'));
  await page.focus('.hb-hurricane');
  await page.keyboard.press('Tab');
  const partNames = await page.locator('.hb-parts button').allTextContents();
  console.log(`  keyboard parts (combined state): ${partNames.join(' | ')}`);
  check('(g) keyboard parts list every element of the combined storm',
    ['Eye', 'Shared eye wall', 'Arms crossing rings', 'Spiral arm 1', 'Octave rings', 'Cloud band 1', 'Whole storm']
      .every((n) => partNames.some((p) => p.startsWith(n))));
  await shot('g-keyboard-parts-visible');
  // Tab to "Spiral arm 2" and open it.
  const idx = partNames.findIndex((p) => p.startsWith('Spiral arm 2'));
  for (let i = 0; i < idx; i++) await page.keyboard.press('Tab');
  const focusedName = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('Enter');
  await wait(300);
  const armTitle = await page.locator('.hb-readout h3').textContent();
  check('(g) a keyboard part opens the same readout as tapping it', /^Spiral arm 2/.test(armTitle ?? ''), `${focusedName} -> ${armTitle}`);
  await shot('g-keyboard-readout-arm');
  await runAxe('readout-open');
  await page.keyboard.press('Escape');
  const backTo = await page.evaluate(() => document.activeElement?.textContent);
  check('(g) closing returns focus to where it was', backTo === focusedName, backTo ?? '');

  // Text alternative and the polite live region.
  const alt = await page.locator('.hb-hurricane-picture').getAttribute('aria-label');
  const liveText = await page.locator('.hb-hurricane [aria-live="polite"]').textContent();
  console.log(`  text alternative: "${alt}"`);
  check('(g) one-sentence text alternative and live region state the combined state',
    /both at once/.test(alt ?? '') && liveText === alt, `live: "${liveText}"`);

  // Readout placement hook: the app can move it below its top bar.
  await page.evaluate(() => document.documentElement.style.setProperty('--hb-readout-top', '88px'));
  await page.mouse.click(640, 400);
  await wait(300);
  const top = await page.locator('.hb-readout').evaluate((el) => el.getBoundingClientRect().top);
  check('(g) --hb-readout-top moves the readout (app shell can clear its top bar)', Math.abs(top - 88) < 1, `top ${top}px`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.documentElement.style.removeProperty('--hb-readout-top'));

  // Without colour: the three states in greyscale.
  await page.addStyleTag({ content: '.grey .hb-hurricane-canvas { filter: grayscale(1); }' });
  await page.evaluate(() => document.body.classList.add('grey'));
  const greys = {};
  for (const [name, sc, ms] of [['phi', 'static-norot', 1500], ['octave', 'octave', 2500], ['combined', 'combined', 1500], ['overlay', 'both-cascades-no-state', 1500]]) {
    await page.evaluate((x) => window.hb.setScenario(x), sc);
    await wait(ms);
    greys[name] = await shot(`k-greyscale-${name}`);
  }
  await page.evaluate(() => document.body.classList.remove('grey'));
  const g1 = await diff(greys.combined, greys.overlay);
  const g2 = await diff(greys.combined, greys.phi);
  const g3 = await diff(greys.combined, greys.octave);
  check('(g) in greyscale the combined state still differs from spiral-only, rings-only and the plain overlay',
    g1.mean > 0.5 && g2.mean > 2 && g3.mean > 2,
    `vs overlay ${g1.mean.toFixed(2)}, vs spiral ${g2.mean.toFixed(2)}, vs rings ${g3.mean.toFixed(2)}/255`);

  // Context loss and restore: the storm comes back.
  await page.evaluate(() => window.hb.setScenario('static-norot'));
  await wait(3200); // heart frames from the previous scenario go stale after 2.5 s; let the swell settle
  const beforeLoss = await shot('i-before-context-loss');
  await page.evaluate(() => {
    const c = document.querySelector('.hb-hurricane-canvas');
    window.__lose = c.getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__lose.loseContext();
  });
  await wait(300);
  await page.evaluate(() => window.__lose.restoreContext());
  await wait(800);
  const afterRestore = await shot('i-after-context-restore');
  const lr = await diff(beforeLoss, afterRestore);
  check('WebGL context loss and restore: the same storm is drawn again', lr.mean < 0.5,
    `mean |diff| ${lr.mean.toFixed(3)}/255`);
  await page.evaluate(() => window.hb.setScenario('phi-heart'));
  await wait(500);

  // Live view frame pacing while rotating (redraws every frame).
  const iv = await page.evaluate(() => window.hb.rafIntervals(180));
  iv.sort((x, y) => x - y);
  const med = iv[Math.floor(iv.length / 2)];
  const p95 = iv[Math.floor(iv.length * 0.95)];
  console.log(`  live view 1280x800 rAF interval: median ${med.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);

  // Shader cost at 1080p with the GPU waited for.
  const bench = await page.evaluate(() => window.hb.bench(1920, 1080, 60));
  console.log(`  shader at 1920x1080 (${bench.api}): mean ${bench.meanMs.toFixed(2)} ms, p95 ${bench.p95Ms.toFixed(2)} ms per frame incl. glFinish`);
  const bench720 = await page.evaluate(() => window.hb.bench(1280, 720, 60));
  console.log(`  shader at 1280x720  (${bench720.api}): mean ${bench720.meanMs.toFixed(2)} ms, p95 ${bench720.p95Ms.toFixed(2)} ms`);
  const baseline = await page.evaluate(() => window.hb.benchBaseline(1920, 1080, 60));
  console.log(`  trivial one-texture-read shader at 1920x1080: mean ${baseline.meanMs.toFixed(2)} ms` +
    ` -> hurricane costs ${(bench.meanMs / baseline.meanMs).toFixed(1)}x the cheapest full-screen pass`);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log(`  GL renderer: ${renderer}`);

  // Spectrum view.
  await page.goto(`${base}?view=spectrum&site=temporal`);
  await page.waitForFunction(() => !!window.hb);
  await page.evaluate(() => window.hb.setScenario('static-rot'));
  await wait(700);
  await shot('h-spectrum-phi');
  const peakRows = await page.locator('.hb-spectrum-summary tbody tr').count();
  const described = await page.locator('.hb-spectrum canvas').getAttribute('aria-describedby');
  check('spectrum: accessible table of the 4 confirmed peaks, linked to the canvas',
    peakRows === 4 && !!described && (await page.locator(`[id="${described}"] table`).count()) === 1, `${peakRows} rows`);
  await runAxe('spectrum');
  await page.evaluate(() => window.hb.setScenario('null'));
  await wait(700);
  await shot('h-spectrum-null');

  writeFileSync(resolve(out, 'results.json'), JSON.stringify({ results, bench, bench720, baseline, renderer, raf: { med, p95 }, errors }, null, 2));
} finally {
  await browser.close();
  await server.close();
}

if (errors.length) console.log(`Page errors:\n  ${errors.join('\n  ')}`);
const failed = results.filter((r) => !r.ok).length + (errors.length ? 1 : 0);
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
