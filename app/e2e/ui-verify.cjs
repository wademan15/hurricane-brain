/**
 * Verifies the built app (vite preview) in Chromium: PWA installability basics and offline use,
 * then replays a recording through the Home screen's replay and takes screenshots into
 * src/ui/test/out/. Usage: PREVIEW_URL=http://localhost:4455 NODE_PATH=$(npm root -g) node e2e/ui-verify.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL_ = process.env.PREVIEW_URL || 'http://localhost:4455';
const OUT = path.resolve(__dirname, '..', 'src', 'ui', 'test', 'out') + '/';
const REC = path.resolve(__dirname, 'out', 'recordings', process.env.REC || 'phi3_10db.hbraw');
const SEED = path.resolve(__dirname, 'out', 'seed', 'session.json');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

async function onboard(page) {
  await page.goto(URL_);
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
  // step 1 -> who is this for
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByPlaceholder('For example: Sam').fill('Sam');
  await page.getByRole('button', { name: 'Child', exact: true }).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByText('Training as').waitFor();
}

(async () => {
  const browser = await chromium.launch();

  // ---------------- PWA: manifest, service worker, offline ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await onboard(page);
    const mres = await page.request.get(URL_ + '/manifest.webmanifest');
    const m = await mres.json();
    check('manifest has name, short_name, start_url, standalone, theme and background colours', !!m.name && !!m.short_name && m.start_url === './' && m.display === 'standalone' && /^#/.test(m.theme_color) && /^#/.test(m.background_color));
    const has = (size, purpose) => m.icons.some((i) => i.sizes === size && (i.purpose || 'any').split(' ').includes(purpose));
    check('manifest has 192 and 512 icons and a maskable icon', has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable'));
    for (const i of m.icons) { const r = await page.request.get(new URL(i.src, URL_ + '/').href); check(`icon ${i.src} is served`, r.ok()); }
    const link = await page.evaluate(() => !!document.querySelector('link[rel=manifest]'));
    check('page links the manifest', link);
    // service worker registered and active
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active && r.active.state }; });
    check('service worker is registered and active', sw.state === 'activated', JSON.stringify(sw));
    await page.waitForTimeout(2500); // let it cache the worker, wasm and worklet
    const cached = await page.evaluate(async () => { const c = await caches.open('hurricane-brain-v2'); return (await c.keys()).map((r) => new URL(r.url).pathname); });
    check('cache holds the engine worker, the wasm and the audio worklet', ['/assets/worker-', '/assets/hb_wasm_bg-', '/assets/worklet-'].every((p) => cached.some((x) => x.startsWith(p))), cached.filter((x) => x.startsWith('/assets/')).join(' '));
    // offline reload
    await ctx.setOffline(true);
    await page.reload();
    await page.getByText('Training as').waitFor({ timeout: 8000 });
    check('offline: the app shell loads', true);
    // offline replay: needs the worker + wasm (and the worklet for real-time sound)
    await page.getByRole('button', { name: '4x', exact: true }).click();
    await page.locator('input[type=file][aria-label="Choose a recording file"]').setInputFiles(REC);
    await page.getByTestId('live-session').waitFor({ timeout: 8000 });
    await page.waitForTimeout(16000);
    const txt = await page.innerText('[data-testid=live-session]');
    check('offline: replay runs through the engine (frames arrive, a golden ratio cell shows a number)', /Golden ratio alignment\s*\n?\s*0\.\d+/.test(txt), txt.slice(0, 300).replace(/\n/g, ' | '));
    check('offline: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------------- Screens and replay screenshots ----------------
  for (const [tag, w, h] of [['desk', 1440, 900], ['mob', 412, 915]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await onboard(page);
    await page.screenshot({ path: OUT + `${tag}-10-home.png` });
    // replay speed 4x from the Home screen, then open the file
    await page.getByRole('button', { name: '4x', exact: true }).click();
    await page.locator('input[type=file][aria-label="Choose a recording file"]').setInputFiles(REC);
    await page.getByTestId('live-session').waitFor();
    // the photosensitivity notice appears once before the first picture; the onboarding already acknowledged it
    await page.waitForTimeout(14000);
    await page.screenshot({ path: OUT + `${tag}-20-live-mid-replay-a.png` });
    await page.waitForTimeout(4500);
    await page.screenshot({ path: OUT + `${tag}-21-live-mid-replay-b.png` });
    const mid = await page.innerText('[data-testid=live-session]');
    check(`${tag}: live screen shows golden ratio, octave and chance side by side`, /Golden ratio alignment/.test(mid) && /Octave alignment/.test(mid) && /Chance level/.test(mid));
    check(`${tag}: live screen shows the cascades and both at once`, /Golden ratio cascade/.test(mid) && /Octave cascade/.test(mid) && /Both at once/.test(mid));
    // fit coaching with live frames (the same component the get-ready step uses)
    await page.evaluate(() => { location.hash = '#/fit'; });
    await page.waitForTimeout(800);
    await page.screenshot({ path: OUT + `${tag}-30-fit-coaching.png`, fullPage: true });
    const fit = await page.innerText('body');
    check(`${tag}: fit coaching shows every sensor and the fixes`, /TP9/.test(fit) && /AF8/.test(fit) && /Smaller heads and children/.test(fit));
    await page.evaluate(() => { location.hash = '#/session'; });
    // wait for the replay to end
    await page.waitForFunction(() => document.querySelector('[data-testid=live-session]')?.getAttribute('data-state') === 'finished', null, { timeout: 90000 });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: OUT + `${tag}-40-live-finished.png` });
    const fin = await page.innerText('[data-testid=live-session]');
    check(`${tag}: after the replay the live screen stays, finished, with exit and replay speeds`, /Replay finished/.test(fin) && /Exit/.test(fin) && /As fast as possible/.test(fin));
    check(`${tag}: after the replay every cell is not measured with a reason`, !/over chance A: \d/.test(fin));
    // play again as fast as possible: ends without sound
    await page.getByRole('button', { name: /As fast as possible/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=live-session]')?.getAttribute('data-state') === 'finished', null, { timeout: 60000 });
    check(`${tag}: replay again at full speed finishes`, true);
    await page.getByRole('button', { name: 'Exit the replay' }).click();
    await page.getByText('Training as').waitFor();

    // seed a stored session into IndexedDB (test only) so History can be looked at
    const seed = fs.readFileSync(SEED, 'utf8');
    await page.evaluate(async (seedJson) => {
      const open = () => new Promise((res, rej) => { const r = indexedDB.open('hurricane-brain'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const db = await open();
      const keys = await new Promise((res) => { const r = db.transaction('profiles').objectStore('profiles').getAllKeys(); r.onsuccess = () => res(r.result); });
      const s = JSON.parse(seedJson); s.profileId = keys[0];
      await new Promise((res, rej) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(s, s.id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      db.close();
    }, seed);
    await page.evaluate(() => { location.hash = '#/history'; });
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT + `${tag}-50-history-list.png` });
    await page.evaluate(() => { location.hash = '#/history/s_seed_phi3'; });
    await page.waitForTimeout(800);
    await page.screenshot({ path: OUT + `${tag}-51-history-events.png`, fullPage: true });
    const hist = await page.innerText('body');
    check(`${tag}: history shows the cascade event log and the journal`, /Golden ratio, octave and both at once/.test(hist) && /Felt settled/.test(hist) && /theta/.test(hist));
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid=journal-form]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: OUT + `${tag}-52-journal-form.png` });
    // settings, profiles, fit, programs
    for (const [name, r] of [['60-settings', 'settings'], ['61-profiles', 'profiles'], ['62-ready-empty', 'ready'], ['63-programs', 'programs'], ['64-discover', 'discover']]) {
      await page.evaluate((x) => { location.hash = '#/' + x; }, r);
      await page.waitForTimeout(500);
      await page.screenshot({ path: OUT + `${tag}-${name}.png`, fullPage: true });
      const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(`${tag}: ${r} has no horizontal overflow`, !over);
    }
    check(`${tag}: no page errors or console errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
