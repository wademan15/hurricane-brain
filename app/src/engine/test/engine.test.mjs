// Node-side tests of the WebAssembly engine (src/wasm/pkg, built by `pnpm build:wasm`).
//
//  1. Identity: every lab fixture replayed through the wasm session gives byte-identical frames
//     to the native `hb-run` binary (crates/hb-engine).
//  2. Merged session: a fixture plus a chest-strap RR series gives byte-identical output to the
//     native `hb-session-run` binary (crates/hb-wasm), heart frames and coupling included.
//  3. Heart only: a synthetic RR series with a 0.1 Hz rhythm gives the expected heart measures.
//
// Run: pnpm test:engine   (HB_FIXTURES=phi3_10db,background_only to limit the fixture set)
// Plain JavaScript so that Node types stay out of the app's TypeScript program.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..', '..', '..');
const repo = resolve(app, '..');
const fixtures = join(repo, 'lab', 'fixtures');
const pkg = join(app, 'src', 'wasm', 'pkg');
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, 'target');
const hbRun = join(targetDir, 'release', 'hb-run');
const hbSessionRun = join(targetDir, 'release', 'hb-session-run');

let wasm;

function fixtureNames() {
  const all = readdirSync(fixtures)
    .filter((f) => f.endsWith('.f32'))
    .map((f) => f.slice(0, -4))
    .sort();
  const only = process.env.HB_FIXTURES?.split(',').filter(Boolean);
  return only ? all.filter((n) => only.includes(n)) : all;
}

function loadFixture(name) {
  const meta = JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));
  const buf = readFileSync(join(fixtures, `${name}.f32`));
  const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { meta, samples };
}

function eegConfig(meta, strap) {
  return {
    streams: {
      eeg: { channels: meta.channels, rate_hz: meta.rate_hz, bits: 0, model: meta.model ?? '' },
      ppg: null,
      motion: null,
      chest_strap: strap ? { name: 'replay' } : null,
    },
    params: meta.params ?? null,
    seed: meta.seed ?? 0,
    mains_hz: meta.mains_hz ?? null,
  };
}

/** Replays a fixture in 12-sample packets exactly as hb-run / hb-session-run do. */
function replay(name, rr = []) {
  const { meta, samples } = loadFixture(name);
  const s = new wasm.HbSession(JSON.stringify(eegConfig(meta, rr.length > 0)));
  const nch = meta.channels.length;
  const per = 12 * nch;
  const drains = [];
  let idx = 0;
  let k = 0;
  const times = [];
  for (let off = 0; off < samples.length; off += per) {
    const chunk = samples.subarray(off, Math.min(off + per, samples.length));
    const n = Math.floor(chunk.length / nch);
    const t0 = performance.now();
    s.pushEeg(idx, chunk.subarray(0, n * nch));
    idx += n;
    const tLast = (idx - 1) / meta.rate_hz;
    while (k < rr.length && rr[k][0] <= tLast) {
      s.pushRr(rr[k][0], new Float32Array(rr[k][1]));
      k++;
    }
    if (s.pending() > 0) drains.push(s.drain());
    times.push(performance.now() - t0);
  }
  s.free();
  return { drains, times };
}

/** A deterministic RR series: 60 bpm with a 0.1 Hz rhythm and small noise, one notification per beat. */
function rrSeries(durS, { mean = 1000, amp = 60, freq = 0.1 } = {}) {
  let state = 12345;
  const rand = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296 - 0.5;
  };
  const out = [];
  let t = 0.5;
  while (t < durS) {
    const rr = Math.fround(mean + amp * Math.sin(2 * Math.PI * freq * t) + 8 * rand());
    t += rr / 1000;
    out.push([Math.round((t + 0.05) * 1000) / 1000, [rr]]);
  }
  return out;
}

beforeAll(async () => {
  if (!existsSync(join(pkg, 'hb_wasm_bg.wasm'))) {
    throw new Error('src/wasm/pkg is missing: run `pnpm build:wasm` first');
  }
  // Native reference binaries (no-op when up to date).
  execFileSync('cargo', ['build', '--release', '-p', 'hb-engine', '-p', 'hb-wasm', '--bins'], { cwd: repo, stdio: 'ignore' });
  wasm = await import(join(pkg, 'hb_wasm.js'));
  wasm.initSync({ module: readFileSync(join(pkg, 'hb_wasm_bg.wasm')) });
}, 600_000);

describe('wasm EEG frames are identical to native hb-run', () => {
  for (const name of fixtureNames()) {
    it(name, () => {
      const native = execFileSync(hbRun, [join(fixtures, name)], { maxBuffer: 1 << 30, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      const { drains, times } = replay(name);
      const ours = drains.map((d) => d.slice(1, -1)).join(',');
      const theirs = native.join(',');
      if (ours !== theirs) {
        const a = JSON.parse(`[${ours}]`);
        const b = native.map((l) => JSON.parse(l));
        const i = a.findIndex((f, j) => JSON.stringify(f) !== JSON.stringify(b[j]));
        throw new Error(`${name}: ${a.length} frames vs native ${b.length}; first difference at frame ${i} (t=${a[i]?.t})`);
      }
      const slow = native.filter((l) => l.startsWith('{"kind":"slow"')).length;
      expect(slow).toBeGreaterThan(0);
      const per = times.slice().sort((x, y) => x - y);
      console.log(
        `${name}: ${native.length} frames identical (${slow} slow); wasm push+drain per 12-sample packet: median ${per[per.length >> 1].toFixed(2)} ms, p99 ${per[Math.floor(per.length * 0.99)].toFixed(2)} ms, max ${per[per.length - 1].toFixed(1)} ms`,
      );
    }, 300_000);
  }
});

describe('merged EEG + heart session', () => {
  it('phi3_10db with a chest strap is identical to native hb-session-run and carries coupling', () => {
    const name = 'phi3_10db';
    const rr = rrSeries(125);
    const dir = mkdtempSync(join(tmpdir(), 'hb-engine-test-'));
    const rrPath = join(dir, 'rr.json');
    writeFileSync(rrPath, JSON.stringify(rr));
    const native = execFileSync(hbSessionRun, [join(fixtures, name), rrPath], { maxBuffer: 1 << 30, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    rmSync(dir, { recursive: true, force: true });
    const { drains } = replay(name, rr);
    expect(drains.length).toBe(native.length);
    expect(drains.join('\n') === native.join('\n')).toBe(true);

    const frames = drains.flatMap((d) => JSON.parse(d));
    const heart = frames.filter((f) => f.kind === 'heart');
    expect(heart.length).toBeGreaterThan(100);
    // Time order within each drain, and per kind across drains.
    for (const d of drains) {
      const ts = JSON.parse(d).map((f) => f.t);
      for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    }
    for (const kind of ['slow', 'fast', 'heart']) {
      const ts = frames.filter((f) => f.kind === kind).map((f) => f.t);
      for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    }
    const last = heart[heart.length - 1];
    expect(last.source).toBe('chest_strap');
    const names = last.coupling.map((c) => c.brain);
    for (const n of ['alpha.above_bg_db@temporal', 'theta.above_bg_db@temporal', 'dominant.height_db']) {
      expect(names).toContain(n);
    }
    // 120 s of data is less than the coupling window: every coupling value is a null with a reason.
    for (const c of last.coupling) {
      expect(c.value.v).toBeNull();
      expect(c.value.why).not.toBe('ok');
    }
  }, 300_000);
});

describe('heart only', () => {
  const config = { streams: { eeg: null, ppg: null, motion: null, chest_strap: { name: 'H10' } }, seed: 3 };

  function run() {
    const s = new wasm.HbSession(JSON.stringify(config));
    const out = [];
    for (const [t, rr] of rrSeries(300)) {
      s.pushRr(t, new Float32Array(rr));
      if (s.pending() > 0) out.push(s.drain());
    }
    s.free();
    return out;
  }

  it('measures a 0.1 Hz rhythm and is deterministic', () => {
    const a = run();
    expect(run().join('\n') === a.join('\n')).toBe(true);
    const frames = a.flatMap((d) => JSON.parse(d));
    expect(frames.every((f) => f.kind === 'heart')).toBe(true);
    const beats = frames.flatMap((f) => f.beats);
    expect(beats.length).toBeGreaterThan(280);
    const last = frames[frames.length - 1];
    console.log(
      `heart: ${frames.length} frames, ${beats.length} beats; last hr ${last.hr_bpm.v?.toFixed(2)} bpm, rmssd ${last.rmssd_ms.v?.toFixed(1)} ms, resonance ${last.resonance_hz.v?.toFixed(4)} Hz (strength ${last.resonance_strength.v?.toFixed(3)}), breath ${last.breath_bpm.v?.toFixed(2)}/min`,
    );
    expect(last.source).toBe('chest_strap');
    expect(last.hr_bpm.v).toBeGreaterThan(55);
    expect(last.hr_bpm.v).toBeLessThan(65);
    expect(last.rmssd_ms.why).toBe('ok');
    expect(Math.abs(last.resonance_hz.v - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(last.breath_bpm.v - 6)).toBeLessThan(0.6);
    expect(last.coupling).toEqual([]);
    expect(beats.filter((b) => b.flagged).length).toBe(0);
  });

  it('reports versions and merged parameters', () => {
    const s = new wasm.HbSession(JSON.stringify({ ...config, params: { 'heart.hr_window_s': 7 } }));
    expect(s.version()).toMatch(/^hb-engine\/.+\+hb-heart\/.+\+hb-wasm\/.+/);
    const p = JSON.parse(s.params());
    expect(p['heart.hr_window_s']).toBe(7);
    s.free();
    expect(() => new wasm.HbSession(JSON.stringify({ ...config, params: { 'heart.no_such': 1 } }))).toThrow(/unknown heart parameter/);
  });
});
