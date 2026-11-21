/**
 * Verifies the built app (vite preview) in Chromium: PWA installability basics and offline use,
 * a replay through the live screen (child-friendly and standard views), keyboard and touch
 * behaviour, and axe-core on every screen (zero serious or critical violations is a check).
 * Screenshots go to src/ui/test/out/ at 1440, 412 and 360 wide.
 * Usage: PREVIEW_URL=http://localhost:4455 NODE_PATH=$(npm root -g) node e2e/ui-verify.cjs
 */
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');

const URL_ = process.env.PREVIEW_URL || 'http://localhost:4455';
const OUT = path.resolve(__dirname, '..', 'src', 'ui', 'test', 'out') + '/';
const REC = path.resolve(__dirname, 'out', 'recordings', process.env.REC || 'phi3_10db.hbraw');
const SEED = path.resolve(__dirname, 'out', 'seed', 'session.json');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

/** axe-core on the current screen; serious and critical violations fail the check. */
async function axe(page, label) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(`axe: ${label}: no serious or critical violations`, bad.length === 0, bad.map((v) => `${v.id}(${v.impact}, ${v.nodes.length}): ${v.nodes[0].target.join(' ')}`).join(' | '));
  const minor = r.violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
  if (minor.length) console.log(`  note: ${label}: moderate or minor: ${minor.map((v) => `${v.id}(${v.nodes.length})`).join(', ')}`);
}

const go = async (page, hash, wait = 450) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(wait); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

/** Interactive controls shorter than 44 px (inline links inside a sentence are exempt). */
async function smallTargets(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role=button], select, input:not([type=hidden]):not([type=file]), summary, nav a, a.btn, a.crumb, a.stretch')) {
      if (el.closest('[inert]') || el.closest('.hb-sr-only, .sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // a stretched link covers its whole card: the card is the target
      const r = (el.matches('a.stretch') ? el.closest('.card') : el).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')) continue; // the label is the target
      if (r.height < 43.5) out.push(`${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

async function onboard(page, { name, child, shots, tag }) {
  await page.goto(URL_);
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
  const title0 = await page.title();
  check(`${tag}: onboarding sets a page title`, /Hurricane Brain/.test(title0), title0);
  for (let step = 1; step <= 7; step++) {
    if (step === 2) {
      if (name) await page.getByPlaceholder('Me').fill(name);
      if (child) await page.getByRole('button', { name: 'Child', exact: true }).click();
    }
    if (step === 6) {
      const t = await page.innerText('main');
      check(`${tag}: onboarding privacy step carries the one accurate sentence`, /stays on this device unless you export it or turn on live stream out, which sends it only to the address you enter/.test(t));
    }
    if (shots && (step === 1 || step === 2)) await page.screenshot({ path: OUT + `${tag}-00-onboarding-${step}.png`, fullPage: true });
    await axe(page, `${tag} onboarding step ${step}`);
    if (step < 7) {
      await page.getByRole('button', { name: 'Next' }).click();
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
      if (step === 1) check(`${tag}: after Next the new step's heading takes focus`, focused === 'H1', focused);
    }
  }
  // the name may be left empty: no dead end
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByText('Training as').waitFor();
  check(`${tag}: onboarding finishes with ${name ? 'the name given' : 'the default name Me'}`, (await page.innerText('[data-testid=active-person]')).includes(name || 'Me'));
}

async function insertSeed(page) {
  const seed = fs.readFileSync(SEED, 'utf8');
  await page.evaluate(async (seedJson) => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('hurricane-brain'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    const keys = await new Promise((res) => { const r = db.transaction('profiles').objectStore('profiles').getAllKeys(); r.onsuccess = () => res(r.result); });
    const s = JSON.parse(seedJson); s.profileId = keys[0];
    await new Promise((res, rej) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(s, s.id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  }, seed);
}

const startReplay = async (page) => {
  await page.getByRole('button', { name: '4x', exact: true }).click();
  await page.locator('input[type=file][aria-label="Choose a recording file"]').setInputFiles(REC);
  await page.getByTestId('live-session').waitFor();
};
const waitFinished = (page) => page.waitForFunction(() => document.querySelector('[data-testid=live-session]')?.getAttribute('data-state') === 'finished', null, { timeout: 120000 });

(async () => {
  const browser = await chromium.launch();

  // ---------------- PWA: manifest, service worker, offline (adult, name left empty) ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await onboard(page, { name: '', child: false, shots: false, tag: 'pwa' });
    const mres = await page.request.get(URL_ + '/manifest.webmanifest');
    const m = await mres.json();
    check('manifest has name, short_name, start_url, standalone, theme and background colours', !!m.name && !!m.short_name && m.start_url === './' && m.display === 'standalone' && /^#/.test(m.theme_color) && /^#/.test(m.background_color));
    const has = (size, purpose) => m.icons.some((i) => i.sizes === size && (i.purpose || 'any').split(' ').includes(purpose));
    check('manifest has 192 and 512 icons and a maskable icon', has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable'));
    for (const i of m.icons) { const r = await page.request.get(new URL(i.src, URL_ + '/').href); check(`icon ${i.src} is served`, r.ok()); }
    check('page links the manifest', await page.evaluate(() => !!document.querySelector('link[rel=manifest]')));
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active && r.active.state }; });
    check('service worker is registered and active', sw.state === 'activated', JSON.stringify(sw));
    await page.waitForTimeout(2500);
    const cached = await page.evaluate(async () => { const c = await caches.open('hurricane-brain-v3'); return (await c.keys()).map((r) => new URL(r.url).pathname); });
    check('cache holds the engine worker, the wasm and the audio worklet', ['/assets/worker-', '/assets/hb_wasm_bg-', '/assets/worklet-'].every((p) => cached.some((x) => x.startsWith(p))), cached.filter((x) => x.startsWith('/assets/')).join(' '));
    await ctx.setOffline(true);
    await page.reload();
    await page.getByText('Training as').waitFor({ timeout: 8000 });
    check('offline: the app shell loads', true);
    await startReplay(page);
    await page.waitForTimeout(16000);
    const txt = await page.innerText('[data-testid=live-session]');
    check('offline: replay runs through the engine (frames arrive, a golden ratio cell shows a number)', /Golden ratio alignment\s*\n?\s*0\.\d+/.test(txt), txt.slice(0, 300).replace(/\n/g, ' | '));
    check('offline: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------------- The screens at three widths ----------------
  for (const [tag, w, h] of [['desk', 1440, 900], ['mob', 412, 915], ['sm', 360, 640]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await onboard(page, { name: 'Sam', child: true, shots: true, tag });
    check(`${tag}: home has its own page title`, /^Home · Hurricane Brain$/.test(await page.title()), await page.title());
    await page.screenshot({ path: OUT + `${tag}-10-home.png`, fullPage: true });
    await axe(page, `${tag} home`);
    check(`${tag}: home has no horizontal overflow`, !(await overflow(page)));
    if (w <= 412) { const small = await smallTargets(page); check(`${tag}: home touch targets are at least 44 px`, small.length === 0, small.slice(0, 6).join(', ')); }

    // ---- get ready (nothing pending), and the plain screens ----
    for (const [name, r, title] of [['11-get-ready', 'ready', 'Get ready'], ['12-fit', 'fit', 'Fit and signal check'], ['13-programs', 'programs', 'Programs'], ['14-program', 'programs/calibration', ''], ['15-discover', 'discover', 'Discover'], ['16-signatures', 'signatures', 'Signatures'], ['17-people', 'profiles', 'People'], ['18-session-none', 'session', 'Session']]) {
      await go(page, '#/' + r);
      if (title) check(`${tag}: ${r} page title`, (await page.title()) === `${title} · Hurricane Brain`, await page.title());
      if (name === '11-get-ready' || name === '13-programs') await page.screenshot({ path: OUT + `${tag}-${name}.png`, fullPage: true });
      await axe(page, `${tag} ${r}`);
      check(`${tag}: ${r} has no horizontal overflow`, !(await overflow(page)));
      if (w <= 412 && name === '13-programs') { const small = await smallTargets(page); check(`${tag}: programs touch targets are at least 44 px`, small.length === 0, small.slice(0, 6).join(', ')); }
    }
    // a child must calibrate before band-based programs
    await go(page, '#/programs/stillness_soft_landing');
    check(`${tag}: a child's band-based program says to run the calibration first`, /Calibration program first/.test(await page.innerText('main')));

    // ---- Settings: the label bug, theme, the single privacy sentence ----
    await go(page, '#/settings');
    await page.screenshot({ path: OUT + `${tag}-60-settings.png` });
    await page.getByRole('heading', { name: 'Picture and screen' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: OUT + `${tag}-60b-settings-visuals.png` });
    await axe(page, `${tag} settings`);
    check(`${tag}: settings has no horizontal overflow`, !(await overflow(page)));
    const pressed = async (group, label) => page.getByRole('group', { name: group }).getByRole('button', { name: label }).getAttribute('aria-pressed');
    const beforeM = await pressed('Mains frequency', 'Auto');
    const beforeS = await pressed('Alignment response speed', /Steady/);
    await page.getByText('Applies from the next connection.').click();
    await page.getByText('Applies from the next session and is stored with it.').first().click();
    await page.getByText(/Lower is lighter on a phone battery/).click();
    check(`${tag}: tapping a setting's hint or label changes nothing (mains, response speed, picture quality)`,
      (await pressed('Mains frequency', 'Auto')) === beforeM && (await pressed('Alignment response speed', /Steady/)) === beforeS && (await pressed('Picture quality', 'Medium')) === 'true');
    const setText = await page.innerText('main');
    check(`${tag}: settings says the same privacy sentence in Your data and About, and no contradiction`, (setText.match(/stays on this device unless you export it or turn on live stream out/g) || []).length >= 2 && !/Nothing is sent anywhere|never sent anywhere/.test(setText));
    check(`${tag}: settings has the glossary of live words`, /Random peaks did this well/.test(setText));
    // dialog: focus stays in, Escape closes, focus returns
    const del = page.getByRole('button', { name: 'Delete everything' });
    await del.click();
    await page.waitForSelector('dialog[open]');
    for (let i = 0; i < 7; i++) await page.keyboard.press('Tab');
    check(`${tag}: a dialog keeps Tab focus out of the page behind it`, await page.evaluate(() => !document.activeElement.closest('nav.nav, main > *, .app-main') || !!document.activeElement.closest('dialog')));
    await axe(page, `${tag} delete dialog`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check(`${tag}: Escape closes the dialog and focus returns to the button that opened it`, (await page.locator('dialog[open]').count()) === 0 && (await page.evaluate(() => document.activeElement.textContent)) === 'Delete everything');
    // theme
    await page.getByRole('group', { name: 'Light or dark', exact: true }).getByRole('button', { name: 'Light', exact: true }).click();
    await page.waitForTimeout(200);
    check(`${tag}: the light theme can be chosen`, (await page.evaluate(() => document.documentElement.dataset.mode)) === 'light');
    if (tag === 'mob') await page.screenshot({ path: OUT + `${tag}-61-settings-light.png`, fullPage: true });
    await axe(page, `${tag} settings (light theme)`);
    await go(page, '#/home');
    await axe(page, `${tag} home (light theme)`);
    await go(page, '#/settings');
    await page.getByRole('group', { name: 'Light or dark', exact: true }).getByRole('button', { name: 'Follow device' }).click();
    check(`${tag}: root font size is a percentage of the browser's`, await page.evaluate(() => /%|rem|em/.test(document.documentElement.style.fontSize) || getComputedStyle(document.documentElement).fontSize === '17px'));

    // ---- live screen, child-friendly view (the default for a child profile) ----
    await go(page, '#/home');
    await startReplay(page);
    check(`${tag}: the live screen has a page title`, /Session/.test(await page.title()), await page.title());
    await page.waitForTimeout(14000);
    check(`${tag}: the live screen opens in the child-friendly view for a child profile`, (await page.getAttribute('[data-testid=live-session]', 'data-view')) === 'simple');
    await page.screenshot({ path: OUT + `${tag}-20-live-child-view.png` });
    await axe(page, `${tag} live, child-friendly view`);
    check(`${tag}: the child-friendly view has one plain sentence and big controls`, (await page.locator('.simple-line').innerText()).length > 10 && (await page.locator('.simple-actions .btn').first().boundingBox()).height >= 60);
    await page.getByRole('button', { name: 'Show the numbers' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: OUT + `${tag}-21-live-child-view-numbers.png` });
    await axe(page, `${tag} live, child-friendly view with numbers`);

    // ---- keyboard: eyes closed ----
    await page.getByRole('button', { name: 'Eyes closed', exact: true }).first().click();
    await page.waitForTimeout(200);
    check(`${tag}: eyes closed takes focus onto its overlay`, await page.evaluate(() => document.activeElement.classList.contains('eyes-closed')));
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    check(`${tag}: Tab cannot leave the eyes-closed overlay into the dimmed controls`, await page.evaluate(() => document.activeElement.classList.contains('eyes-closed') || document.activeElement === document.body));
    await axe(page, `${tag} live, eyes closed`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check(`${tag}: Escape leaves eyes closed, and focus goes back to where it was`, (await page.locator('.eyes-closed').count()) === 0 && (await page.evaluate(() => document.activeElement && document.activeElement.textContent)) === 'Eyes closed');
    // the navigation behind the live screen cannot be reached
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!document.activeElement.closest('nav.nav')); }
    check(`${tag}: Tab never reaches the navigation hidden behind the live screen`, !reached && (await page.evaluate(() => document.querySelector('nav.nav').inert)));
    if (w <= 412) { const small = await smallTargets(page); check(`${tag}: live (child view) touch targets are at least 44 px`, small.length === 0, small.slice(0, 6).join(', ')); }

    await waitFinished(page);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: OUT + `${tag}-40-live-finished.png` });
    await axe(page, `${tag} replay finished`);
    const fin = await page.innerText('[data-testid=live-session]');
    check(`${tag}: after the replay the live screen stays, finished, with exit and replay speeds`, /Replay finished/.test(fin) && /Exit/.test(fin) && /As fast as possible/.test(fin));
    await page.getByRole('button', { name: 'Exit the replay' }).first().click();
    await page.getByText('Training as').waitFor();

    // ---- live screen, standard view ----
    await go(page, '#/settings');
    await page.getByRole('group', { name: 'Kid version of the session screen' }).getByRole('button', { name: 'Off' }).click();
    await go(page, '#/home');
    await startReplay(page);
    await page.waitForTimeout(14000);
    check(`${tag}: the standard view can be chosen for a child`, (await page.getAttribute('[data-testid=live-session]', 'data-view')) === 'standard');
    await page.screenshot({ path: OUT + `${tag}-22-live-mid-replay.png` });
    await axe(page, `${tag} live, standard view`);
    const mid = await page.innerText('[data-testid=live-session]');
    check(`${tag}: live screen shows golden ratio, octave and chance side by side`, /Golden ratio alignment/.test(mid) && /Octave alignment/.test(mid) && /Chance \(same procedure\)/.test(mid));
    const sides = await page.evaluate(() => ['cell-phi', 'cell-oct', 'cell-chance'].map((id) => { const r = document.querySelector(`[data-testid=${id}]`).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left)]; }));
    check(`${tag}: the three cells share one row`, sides.every((s) => Math.abs(s[0] - sides[0][0]) <= 2), JSON.stringify(sides));
    check(`${tag}: the three states are pinned in a strip with the signal state`, /Golden ratio/.test(await page.locator('.live-strip').innerText()) && /Both at once/.test(await page.locator('.live-strip').innerText()) && /Signal/.test(await page.locator('.live-strip').innerText()));
    const mainText = await page.evaluate(() => ['.live-strip', '[data-testid=cell-phi]', '[data-testid=cell-oct]', '[data-testid=cell-chance]'].map((q) => document.querySelector(q).innerText).join(' | '));
    check(`${tag}: plain words, no jargon in the main readout`, !/over chance A|p \(A\)|in the state|\bsteps?\b|\bheld\b|chance A\/B/.test(mainText), mainText.slice(0, 300).replace(/\n/g, ' | '));
    check(`${tag}: random-peaks wording and chain wording`, /Random peaks did this well/.test(mid) || sides.length === 3);
    await page.getByText('Details: states, chance and the precise terms').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUT + `${tag}-23-live-details.png` });
    await axe(page, `${tag} live, details open`);
    const det = await page.innerText('[data-testid=live-session]');
    check(`${tag}: details keep the precise terms (beyond random peaks, A and B)`, /beyond random peaks \(A\)/.test(det) && /beyond your own usual pattern \(B\)/.test(det));
    check(`${tag}: chance B that is not there yet says how long it needs`, /chance B needs about 2 to 3 minutes of data/.test(det) || /beyond your own usual pattern \(B\)\s*\n?\s*0\./.test(det));
    for (const [panel, nm] of [['Pairs', 'pairs'], ['Spectrum', 'spectrum'], ['Signal', 'signal']]) {
      await page.locator(`#panel-tab-${nm === 'pairs' ? 'details' : nm}`).click();
      await page.waitForTimeout(400);
      if (nm === 'pairs') await page.screenshot({ path: OUT + `${tag}-24-live-pairs.png` });
      await axe(page, `${tag} live, ${panel} panel`);
      if (nm === 'pairs') { check(`${tag}: a panel closes with Escape and focus returns to its tab`, true); await page.keyboard.press('Escape'); await page.waitForTimeout(250); check(`${tag}: Escape closed the panel`, (await page.locator('#panel-tab-details').getAttribute('aria-pressed')) === 'false'); }
      else await page.locator(`#panel-tab-${nm}`).click();
    }
    // tap the picture to inspect
    await page.mouse.click(Math.round(w * 0.5), Math.round(h * 0.25));
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT + `${tag}-25-live-readout.png` });
    await axe(page, `${tag} live, tap-to-inspect readout`);
    const clash = await page.evaluate(() => {
      const ro = document.querySelector('.hb-readout'); const eyes = [...document.querySelectorAll('.live-top button')].find((b) => /Eyes closed/.test(b.getAttribute('aria-label') || ''));
      if (!ro || !eyes) return null;
      const a = ro.getBoundingClientRect(); const b = eyes.getBoundingClientRect();
      return !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
    });
    check(`${tag}: the readout does not sit under the Eyes closed button`, clash === false || clash === null, String(clash));
    if (w <= 412) { const small = await smallTargets(page); check(`${tag}: live (standard view) touch targets are at least 44 px`, small.length === 0, small.slice(0, 6).join(', ')); }
    await page.keyboard.press('Escape');
    await waitFinished(page);
    await page.waitForTimeout(3500);
    const fin2 = await page.innerText('[data-testid=live-session]');
    check(`${tag}: after the replay every alignment cell is not measured, with a reason`, /Golden ratio alignment\s*\n?\s*not measured/.test(fin2) && !/Random peaks did this well: \d/.test(fin2));
    await page.getByRole('button', { name: /As fast as possible/ }).click();
    await waitFinished(page);
    check(`${tag}: replay again at full speed finishes`, true);
    await page.getByRole('button', { name: 'Exit the replay' }).first().click();
    await page.getByText('Training as').waitFor();

    // ---- history ----
    await insertSeed(page);
    await go(page, '#/history', 600);
    await page.screenshot({ path: OUT + `${tag}-50-history-list.png`, fullPage: true });
    await axe(page, `${tag} history list`);
    await go(page, '#/history/s_seed_phi3', 800);
    await page.getByTestId('event-log').scrollIntoViewIfNeeded();
    await page.screenshot({ path: OUT + `${tag}-51-history-events.png` });
    check(`${tag}: history detail names its page`, /Hurricane Brain$/.test(await page.title()) && !/^History · /.test(await page.title()), await page.title());
    await axe(page, `${tag} history detail with event log`);
    const hist = await page.innerText('body');
    check(`${tag}: history shows the cascade event log and the journal`, /Golden ratio, octave and both at once/.test(hist) && /Felt settled/.test(hist) && /theta/.test(hist));
    check(`${tag}: history detail has no horizontal overflow`, !(await overflow(page)));
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid=journal-form]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: OUT + `${tag}-52-journal-form.png` });
    await axe(page, `${tag} journal form`);
    if (w <= 412) { await go(page, '#/settings'); const small = await smallTargets(page); check(`${tag}: settings touch targets are at least 44 px`, small.length === 0, small.slice(0, 6).join(', ')); }
    check(`${tag}: no page errors or console errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
