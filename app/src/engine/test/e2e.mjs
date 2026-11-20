// Browser end-to-end check of the engine in Chromium (Playwright, preinstalled globally).
//
//   pnpm test:engine:e2e        (needs `pnpm build:wasm` first)
//
// Serves src/engine/test/e2e/index.html with the Vite dev server, then in Chromium:
//  1. phi3_10db (planted 3-member golden ratio cascade), pushed in 12-sample packets as fast as
//     possible: slow frames report the confirmed tracks near the planted frequencies and the
//     golden ratio cascade; the frames are identical (SHA-256) to native hb-run.
//  2. background_only, the same way: no confirmed tracks and no cascade, identical to native.
//  3. phi3_10db paced at real time (one packet per 46.875 ms) for 30 s: push-to-frame latency.
//
// HB_E2E_BUILD=1 runs the same checks against a production build (vite build + vite preview),
// which exercises the bundled worker and the hashed .wasm asset.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build, createServer, preview } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..', '..', '..');
const repo = resolve(app, '..');
const fixtures = join(repo, 'lab', 'fixtures');
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, 'target');
const PACED_S = Number(process.env.HB_PACED_S ?? 30);

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  playwright = require(join(globalRoot, 'playwright'));
}

function nativeHash(name) {
  execFileSync('cargo', ['build', '--release', '-p', 'hb-engine', '--bin', 'hb-run'], { cwd: repo, stdio: 'ignore' });
  const out = execFileSync(join(targetDir, 'release', 'hb-run'), [join(fixtures, name)], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.stringify(JSON.parse(l)));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

const failures = [];
function check(cond, what) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`);
  if (!cond) failures.push(what);
}

const fmt = (d) => (d && d.n ? `median ${d.median.toFixed(2)} / p95 ${d.p95.toFixed(2)} / p99 ${d.p99.toFixed(2)} / max ${d.max.toFixed(2)} ms (n=${d.n})` : 'n=0');

// Serves lab/fixtures at /__fixtures/ in both the dev and the preview server.
const fixturePlugin = {
  name: 'hb-fixtures',
  configureServer: (srv) => {
    srv.middlewares.use(serveFixtures);
  },
  configurePreviewServer: (srv) => {
    srv.middlewares.use(serveFixtures);
  },
};
function serveFixtures(req, res, next) {
  const m = /^\/__fixtures\/([A-Za-z0-9_.]+\.(json|f32))$/.exec(req.url ?? '');
  if (!m || !existsSync(join(fixtures, m[1]))) return next();
  res.setHeader('Content-Type', m[2] === 'json' ? 'application/json' : 'application/octet-stream');
  createReadStream(join(fixtures, m[1])).pipe(res);
}
const common = { root: app, configFile: join(app, 'vite.config.ts'), logLevel: 'error', plugins: [fixturePlugin] };
let server;
let outDir = null;
const production = process.env.HB_E2E_BUILD === '1';
if (production) {
  outDir = mkdtempSync(join(tmpdir(), 'hb-e2e-dist-'));
  await build({ ...common, build: { outDir, emptyOutDir: true, rollupOptions: { input: join(here, 'e2e', 'index.html') } } });
  server = await preview({ ...common, build: { outDir }, preview: { port: 0, host: '127.0.0.1' } });
  console.log(`production build in ${outDir}`);
} else {
  server = await createServer({ ...common, server: { port: 0, host: '127.0.0.1' } });
  await server.listen();
}
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (m) => (m.type() === 'error' ? console.log(`[page] ${m.text()}`) : undefined));
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(`${base}/src/engine/test/e2e/index.html`);
  await page.waitForFunction(() => window.hbE2E?.ready, null, { timeout: 120_000 });
  const fx = (name) => `/__fixtures/${name}`;
  const truth = (await import(join(fixtures, 'phi3_10db.json'), { with: { type: 'json' } })).default.truth;
  const planted = truth.peaks.map((p) => p.mean_freq_hz).sort((a, b) => a - b);

  // 1. Planted golden ratio cascade.
  const phi = await page.evaluate((url) => window.hbE2E.run({ url, mode: 'fast' }), fx('phi3_10db'));
  console.log(`\nphi3_10db (fast): ${phi.data_s} s of data in ${phi.total_ms.toFixed(0)} ms = ${phi.x_realtime.toFixed(1)}x real time; init ${phi.init_ms.toFixed(0)} ms; ${phi.frames} frames (${phi.slow} slow, ${phi.fast} fast)`);
  console.log(`  version ${phi.version}, ${phi.params} parameters`);
  console.log(`  last slow frame t=${phi.last.t}: tracks ${JSON.stringify(phi.last.tracks.map((t) => [t.id, t.state, +t.f?.toFixed(3)]))}`);
  console.log(`  phi cascade ${JSON.stringify(phi.last.phi)}; octave steps ${phi.last.octave.steps}; phi aligned state in ${phi.phi_active_frames} slow frames`);
  const confirmed = phi.last.tracks.filter((t) => t.state === 'confirmed');
  check(!phi.error, 'phi3_10db: no engine error');
  check(phi.in_order, 'phi3_10db: frames delivered in time order');
  check(phi.slow === 480 && phi.fast === 3840, `phi3_10db: 480 slow and 3840 fast frames (got ${phi.slow}, ${phi.fast})`);
  check(phi.hash === nativeHash('phi3_10db'), 'phi3_10db: Chromium frames identical to native hb-run (SHA-256)');
  check(
    planted.every((f) => confirmed.some((t) => Math.abs(t.f - f) / f < 0.03)),
    `phi3_10db: confirmed tracks within 3% of the planted ${planted.map((f) => f.toFixed(2)).join(', ')} Hz`,
  );
  check(phi.last.phi.steps === 2 && phi.last.phi.tracks.length === 3, 'phi3_10db: golden ratio cascade of 3 tracks (2 steps) in the last slow frame');
  check(phi.max_octave_steps === 0, 'phi3_10db: no octave cascade');
  check(phi.phi_active_frames > 0, 'phi3_10db: golden ratio aligned state entered');

  // 2. Background only.
  const bg = await page.evaluate((url) => window.hbE2E.run({ url, mode: 'fast' }), fx('background_only'));
  console.log(`\nbackground_only (fast): ${bg.data_s} s in ${bg.total_ms.toFixed(0)} ms = ${bg.x_realtime.toFixed(1)}x real time; ${bg.slow} slow frames, confirmed tracks ever ${bg.confirmed_ever}, max phi steps ${bg.max_phi_steps}`);
  check(!bg.error, 'background_only: no engine error');
  check(bg.hash === nativeHash('background_only'), 'background_only: Chromium frames identical to native hb-run (SHA-256)');
  check(bg.confirmed_ever === 0, 'background_only: no confirmed track in any slow frame');
  check(bg.max_phi_steps === 0 && bg.max_octave_steps === 0 && bg.phi_active_frames === 0, 'background_only: no cascade and no aligned state');

  for (const [label, r] of [['phi3_10db fast', phi]]) {
    console.log(`\n${label} timings (worker, per frames message):`);
    console.log(`  engine push, with a slow update: ${fmt(r.timing.push_slow_ms)}`);
    console.log(`  engine push, fast frames only:   ${fmt(r.timing.push_fast_only_ms)}`);
    console.log(`  drain + JSON, with a slow frame: ${fmt(r.timing.drain_slow_ms)}`);
    console.log(`  drain + JSON, fast frames only:  ${fmt(r.timing.drain_fast_only_ms)}`);
    console.log(`  UI-thread JSON.parse, slow:      ${fmt(r.timing.parse_slow_ms)}`);
    console.log(`  UI-thread JSON.parse, fast only: ${fmt(r.timing.parse_fast_only_ms)}`);
  }

  // 3. Real-time pacing: latency.
  const paced = await page.evaluate(({ url, s }) => window.hbE2E.run({ url, mode: 'paced', seconds: s }), { url: fx('phi3_10db'), s: PACED_S });
  console.log(`\nphi3_10db paced at real time, ${paced.data_s} s: ${paced.frames} frames (${paced.slow} slow, ${paced.fast} fast)`);
  console.log(`  push-to-frame latency, message with a slow frame: ${fmt(paced.timing.latency_slow_ms)}`);
  console.log(`  push-to-frame latency, fast frames only:          ${fmt(paced.timing.latency_fast_only_ms)}`);
  console.log(`  engine push with a slow update: ${fmt(paced.timing.push_slow_ms)}`);
  console.log(`  drain + JSON with a slow frame: ${fmt(paced.timing.drain_slow_ms)}`);
  console.log(`  UI-thread JSON.parse, slow: ${fmt(paced.timing.parse_slow_ms)}; fast only: ${fmt(paced.timing.parse_fast_only_ms)}`);
  console.log(`  main-thread long tasks (>50 ms): ${paced.timing.main_long_tasks_ms.length}`);
  check(!paced.error, 'paced: no engine error');
  check(paced.timing.latency_fast_only_ms.p99 < 20, 'paced: fast-frame latency p99 under 20 ms');
  check(paced.timing.latency_slow_ms.p99 < 50, 'paced: slow-frame latency p99 under 50 ms');
  check(paced.timing.main_long_tasks_ms.length === 0, 'paced: no main-thread long task');
} finally {
  await browser.close();
  await server.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
