/**
 * Theme screenshots and axe: per theme, dark and light, at 1440 and 412 wide: home, Settings >
 * Appearance and the live screen mid-replay (standard readouts); one kid session screen per theme;
 * the three readout levels in one theme. Zero serious or critical axe violations on each.
 * Usage: PREVIEW_URL=http://localhost:4733 NODE_PATH=$(npm root -g) node e2e/ui-themes.cjs
 */
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');

const URL_ = process.env.PREVIEW_URL || 'http://localhost:4733';
const OUT = path.resolve(__dirname, '..', 'src', 'ui', 'test', 'out', 'themes') + '/';
const REC = path.resolve(__dirname, 'out', 'recordings', process.env.REC || 'phi3_10db.hbraw');
fs.mkdirSync(OUT, { recursive: true });
const THEMES = [['still-water', 'Still Water'], ['dawn-journal', 'Dawn Journal'], ['calm-instrument', 'Calm Instrument'], ['night-garden', 'Night Garden']];
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

async function axe(page, label) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(`axe: ${label}`, bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(' ')} ${(v.nodes[0].any[0] || {}).message || ''}`).join(' | '));
}
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(400); };
const seg = (page, group, label) => page.getByRole('group', { name: group, exact: true }).getByRole('button', { name: label, exact: true }).click();

async function onboard(page) {
  await page.goto(URL_);
  await page.getByRole('heading', { name: /Welcome/ }).waitFor();
  for (let i = 1; i < 7; i++) await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByText('Training as').waitFor();
}

async function setAppearance(page, { theme, mode, readouts, kid, session }) {
  await go(page, '#/settings');
  if (theme) await page.locator('.theme-cards button', { hasText: theme }).click();
  if (mode) await seg(page, 'Light or dark', mode);
  if (session) await seg(page, 'Session screen', session);
  if (readouts) await seg(page, 'Readouts', readouts);
  if (kid) await seg(page, 'Kid version of the session screen', kid);
}

async function replay(page) {
  await go(page, '#/home');
  await page.getByRole('button', { name: '4x', exact: true }).click();
  await page.locator('input[type=file][aria-label="Choose a recording file"]').setInputFiles(REC);
  await page.getByTestId('live-session').waitFor();
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  if (await cont.isVisible().catch(() => false)) await cont.click();
  await page.waitForTimeout(Number(process.env.WAIT || 20000));
}
async function closeReplay(page) {
  await page.getByRole('button', { name: /Close replay|Stop session|Exit the replay/ }).first().click();
  const c = page.locator('dialog[open]').getByRole('button', { name: 'Close replay', exact: true });
  if (await c.isVisible().catch(() => false)) await c.click();
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, w, h] of [['1440', 1440, 900], ['412', 412, 915]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await onboard(page);
    for (const [id, name] of THEMES) {
      for (const mode of ['Dark', 'Light']) {
        const tag = `${id}-${mode.toLowerCase()}-${vp}`;
        await setAppearance(page, { theme: name, mode, readouts: 'Standard', kid: 'Off', session: mode === 'Light' ? 'Match my mode' : 'Always dark' });
        const attrs = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, m: document.documentElement.dataset.mode }));
        check(`${tag}: root carries theme and mode`, attrs.t === id && attrs.m === mode.toLowerCase(), JSON.stringify(attrs));
        await page.getByRole('heading', { name: 'Appearance' }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: OUT + `${tag}-settings-appearance.png` });
        await axe(page, `${tag} settings`);
        await go(page, '#/home');
        await page.screenshot({ path: OUT + `${tag}-home.png` });
        await axe(page, `${tag} home`);
        await replay(page);
        await page.screenshot({ path: OUT + `${tag}-live.png` });
        await axe(page, `${tag} live`);
        const t = await page.innerText('[data-testid=live-session]');
        check(`${tag}: live screen shows golden ratio beside octave and chance`, /Golden ratio alignment/.test(t) && /Octave alignment/.test(t) && /[Cc]hance/.test(t));
        await closeReplay(page);
      }
    }
    // kid session screen per theme (dark), and the three readout levels in Still Water
    for (const [id, name] of THEMES) {
      await setAppearance(page, { theme: name, mode: 'Dark', readouts: 'Standard', kid: 'On' });
      await replay(page);
      await page.screenshot({ path: OUT + `kid-${id}-${vp}.png` });
      await axe(page, `kid ${id} ${vp}`);
      const small = await page.evaluate(() => [...document.querySelectorAll('[data-view=simple] button')].filter((b) => !b.closest('[inert]') && b.offsetParent && b.getBoundingClientRect().height < 47.5).map((b) => b.textContent.trim().slice(0, 20)));
      check(`kid ${id} ${vp}: buttons are at least 48 px`, small.length === 0, small.join(','));
      await closeReplay(page);
    }
    for (const lvl of ['Minimal', 'Standard', 'Full']) {
      await setAppearance(page, { theme: 'Still Water', mode: 'Dark', readouts: lvl === 'Full' ? 'Full instrument' : lvl, kid: 'Off' });
      await replay(page);
      await page.screenshot({ path: OUT + `readouts-${lvl.toLowerCase()}-${vp}.png` });
      await axe(page, `readouts ${lvl} ${vp}`);
      const t = await page.innerText('[data-testid=live-session]');
      check(`readouts ${lvl} ${vp}: golden ratio, octave and chance all present`, /Golden ratio alignment/.test(t) && /Octave alignment/.test(t) && /[Cc]hance/.test(t));
      await closeReplay(page);
    }
    check(`${vp}: no page errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})();
