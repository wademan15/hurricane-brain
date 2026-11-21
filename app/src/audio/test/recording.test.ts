/**
 * Bloom smoothness on a real engine recording (fake test, third run, item 4).
 *
 * `both_phi_octave_12db`: golden ratio chain 5, 8.09, 13.09 Hz and octave chain 5, 10, 20 Hz, 12 dB.
 * The engine's control values for the blooms flicker (tracks lose lock, the 10 and 20 Hz steps are
 * marked harmonic in some frames, cascade membership changes): targets jump 0.99 -> 0 -> 0.98 within
 * seconds. These tests check that the SOUND changes slowly anyway, and that the three blooms differ.
 *
 * Needs the wasm package (`pnpm build:wasm`) and the recording (`npx vitest run e2e/make-recordings.test.ts`).
 * Skipped, with a note, when either is missing.
 */

import { describe, expect, it } from 'vitest';
import { ReplaySource } from '../../device/recording/replay';
import type { Frame } from '../../engine/frames.ts';
import { FrameBinder } from '../bindings.ts';
import { DEFAULT_AUDIO_SETTINGS, type AudioSettingsPatch } from '../settings.ts';
import { SynthCore } from '../synth-core.ts';
import { centroid, spectrum } from './helpers.ts';

const SR = 48000;
// Node built-ins through a computed specifier: the app tsconfig has no Node types.
const fs: { readFileSync(p: string | URL): Uint8Array; existsSync(p: string | URL): boolean } = await import('node:' + 'fs');
const pkgDir = new URL('../../wasm/pkg/', import.meta.url);
const recording = new URL('../../../e2e/out/recordings/both_phi_octave_12db.hbraw', import.meta.url);
const available = fs.existsSync(new URL('hb_wasm_bg.wasm', pkgDir)) && fs.existsSync(recording);
if (!available) console.warn('recording.test: wasm pkg or e2e recording missing; skipped');

async function engineFrames(): Promise<Frame[]> {
  const wasm = await import(/* @vite-ignore */ new URL('hb_wasm.js', pkgDir).href);
  wasm.initSync({ module: fs.readFileSync(new URL('hb_wasm_bg.wasm', pkgDir)) });
  const src = new ReplaySource(new Uint8Array(fs.readFileSync(recording)), { speed: 'fast' });
  let session: { pending(): number; drain(): string; pushEeg(i: number, s: Float32Array): void; free(): void } | null = null;
  const out: Frame[] = [];
  const drain = () => {
    if (session && session.pending() > 0) for (const f of JSON.parse(session.drain())) out.push(f);
  };
  src.on('streams', (s: unknown) => {
    if (!session) session = new wasm.HbSession(JSON.stringify({ streams: s, params: null, seed: 1, mains_hz: null }));
  });
  src.on('eeg', (e: { firstIndex: number; samples: Float32Array }) => {
    session!.pushEeg(e.firstIndex, e.samples);
    drain();
  });
  await src.start();
  (session as { free(): void } | null)?.free();
  return out;
}

interface Run {
  left: Float32Array;
  /** Per-voice bloom level (presence x amount) per layer, sampled every 10 ms: [time][layer] summed over voices. */
  levels: { t: number; phi: number; octave: number; both: number }[];
  /** Max over voices of the control targets, per slow frame (what the fake test reported). */
  targets: { t: number; octave: number }[];
}

function render(frames: Frame[], seconds: number, settings: AudioSettingsPatch): Run {
  const core = new SynthCore(SR, settings);
  const binder = new FrameBinder(settings);
  const left = new Float32Array(Math.round(seconds * SR));
  const levels: Run['levels'] = [];
  const targets: Run['targets'] = [];
  let k = 0;
  const step = SR / 100;
  for (let pos = 0; pos < left.length; pos += 120) {
    const t = pos / SR;
    while (k < frames.length && frames[k].t <= t) {
      const o = binder.handleFrame(frames[k], core.timeS);
      if (o.reset) core.newSession();
      core.setControl(o.control);
      if (frames[k].kind === 'slow') targets.push({ t: frames[k].t, octave: Math.max(0, ...o.control.voices.map((v) => v.octave)) });
      k++;
    }
    core.render(left, null, pos, Math.min(120, left.length - pos));
    if (pos % step === 0) {
      const st = core.status();
      const sum = (f: (v: (typeof st.voices)[number]) => number) => st.voices.reduce((a, v) => a + v.bloomPresence * f(v), 0);
      levels.push({ t, phi: sum((v) => v.phi), octave: sum((v) => v.octave), both: sum((v) => v.both) });
    }
  }
  return { left, levels, targets };
}

const bloomOnly = { gains: { tones: 0, bed: 0, heart: 0, breath: 0, anchor: 0, bloom: 1 } };
const frames = available ? await engineFrames() : [];
const seconds = available ? Math.ceil(frames[frames.length - 1].t) + 1 : 0;

describe.skipIf(!available)('blooms on the both_phi_octave_12db recording', () => {
  const run = available ? render(frames, seconds, bloomOnly) : null;

  it('the octave bloom targets really flicker (the input this test is about)', () => {
    const tg = run!.targets.filter((x) => x.t >= 50 && x.t <= 64);
    let maxJump = 0;
    for (let i = 1; i < tg.length; i++) maxJump = Math.max(maxJump, Math.abs(tg[i].octave - tg[i - 1].octave));
    console.log(`octave bloom target, 50-64 s: max jump between consecutive slow frames ${maxJump.toFixed(2)}`);
    expect(maxJump).toBeGreaterThan(0.5);
  });

  it('every bloom level changes slowly: at most 1/bloomFollowTauS + 1/min(tau) of full scale per second', () => {
    const s = DEFAULT_AUDIO_SETTINGS;
    // Product of two followers, each bounded by 1/tau per second (presence and amount).
    const bound = 1 / s.bloomFollowTauS + 1 / Math.min(s.bloomTauS, s.bloomReleaseTauS, s.combinedBloomTauS);
    const lv = run!.levels;
    const worst = { phi: 0, octave: 0, both: 0 };
    for (let i = 1; i < lv.length; i++) {
      const dt = lv[i].t - lv[i - 1].t;
      for (const key of ['phi', 'octave', 'both'] as const) worst[key] = Math.max(worst[key], Math.abs(lv[i][key] - lv[i - 1][key]) / dt);
    }
    const peak = { phi: Math.max(...lv.map((x) => x.phi)), octave: Math.max(...lv.map((x) => x.octave)), both: Math.max(...lv.map((x) => x.both)) };
    console.log(
      `bloom level max rate of change (full scale per s; bound ${bound.toFixed(3)}): golden ratio ${worst.phi.toFixed(3)}, octave ${worst.octave.toFixed(3)}, combined ${worst.both.toFixed(3)}; peaks ${peak.phi.toFixed(2)} / ${peak.octave.toFixed(2)} / ${peak.both.toFixed(2)}`,
    );
    // Summed over voices, so the bound scales with the number of voices changing together; per
    // voice it is `bound`. Allow the sum of the two largest members.
    for (const key of ['phi', 'octave', 'both'] as const) expect(worst[key]).toBeLessThanOrEqual(2 * bound);
    expect(peak.octave).toBeGreaterThan(0.1);
  });

  it('the audible bloom envelope never jumps: 250 ms RMS changes by under 20% of its peak per window', () => {
    const x = run!.left;
    const w = SR / 4;
    const env: number[] = [];
    for (let a = 0; a + w <= x.length; a += w) {
      let s2 = 0;
      for (let i = a; i < a + w; i++) s2 += x[i] * x[i];
      env.push(Math.sqrt(s2 / w));
    }
    const peak = Math.max(...env);
    let worst = 0;
    let at = 0;
    for (let i = 1; i < env.length; i++) {
      const d = Math.abs(env[i] - env[i - 1]) / peak;
      if (d > worst) [worst, at] = [d, i / 4];
    }
    console.log(`bloom layer: 250 ms RMS peak ${peak.toExponential(3)}, worst change ${(worst * 100).toFixed(1)}% of peak per 250 ms (at ${at.toFixed(2)} s)`);
    // Before the fix (bloom level = tone gate x 250 ms loudness, in a comb room): 52.7%.
    // A full-scale change at the declared rates takes >= 1 s, i.e. <= ~25% per window; measured
    // content (several voices whose measured pitch wanders) adds some on top.
    expect(worst).toBeLessThan(0.2);
  });

  it('the combined bloom is audibly distinct from the golden ratio and octave blooms', () => {
    const only = (b: 'phi' | 'octave' | 'both') =>
      render(frames, seconds, {
        ...bloomOnly,
        blooms: { phi: { on: b === 'phi' }, octave: { on: b === 'octave' }, both: { on: b === 'both' } },
      }).left;
    // While the combined state holds (engine frames: about 41 to 78 s).
    const slowBoth = frames.filter((f) => f.kind === 'slow' && f.states.both.active).map((f) => f.t);
    const a = Math.round((slowBoth[0] + 8) * SR);
    const b = Math.round(slowBoth[slowBoth.length - 1] * SR);
    const seg = (x: Float32Array) => x.subarray(a, b);
    const [p, o, c] = [only('phi'), only('octave'), only('both')].map(seg);
    const mags = [p, o, c].map((x) => spectrum(x).mag);
    const cos = (u: Float64Array, v: Float64Array) => {
      let d = 0, nu = 0, nv = 0;
      for (let i = 0; i < u.length; i++) {
        d += u[i] * v[i];
        nu += u[i] * u[i];
        nv += v[i] * v[i];
      }
      return d / Math.sqrt(nu * nv);
    };
    const sims = { phiOct: cos(mags[0], mags[1]), phiBoth: cos(mags[0], mags[2]), octBoth: cos(mags[1], mags[2]) };
    console.log(
      `recording, combined state ${(a / SR).toFixed(1)}-${(b / SR).toFixed(1)} s: centroids golden ratio ${centroid(p).toFixed(0)} Hz, octave ${centroid(o).toFixed(0)} Hz, combined ${centroid(c).toFixed(0)} Hz; spectral cosine phi/oct ${sims.phiOct.toFixed(3)}, phi/both ${sims.phiBoth.toFixed(3)}, oct/both ${sims.octBoth.toFixed(3)}`,
    );
    for (const v of Object.values(sims)) expect(v).toBeLessThan(0.3);
  }, 120_000);
});
