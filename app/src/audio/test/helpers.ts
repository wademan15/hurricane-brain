/** Test helpers: frame builders, an offline renderer, FFT and pitch measurement. */

import type { Cascade, FastFrame, FastTrack, Frame, HeartFrame, Measured, SiteSpectrum, SlowFrame, Track } from '../../engine/frames.ts';
import { FrameBinder } from '../bindings.ts';
import type { AudioSettingsPatch } from '../settings.ts';
import { SynthCore } from '../synth-core.ts';

export const SR = 48000;
export const ok = (v: number): Measured => ({ v, se: 0.01, why: 'ok' });
export const nul = (why: Measured['why'] = 'weak'): Measured => ({ v: null, why });

export interface TrackSpec {
  id: number;
  freq: number | null;
  height?: number | null;
  locked?: boolean;
  state?: Track['state'];
  /** Display band; by default from the fixed band edges. */
  band?: Track['band'];
  site?: string;
}

export const bandOf = (f: number | null): Track['band'] =>
  f === null ? 'alpha' : f < 4 ? 'delta' : f < 8 ? 'theta' : f < 13 ? 'alpha' : f < 30 ? 'beta' : 'gamma';

export function fastFrame(t: number, tracks: TrackSpec[], artifact = false): FastFrame {
  return {
    kind: 'fast',
    schema: 1,
    t,
    artifact,
    tracks: tracks.map(
      (k): FastTrack => ({
        id: k.id,
        freq: k.freq === null ? nul() : ok(k.freq),
        amp_uv: ok(5),
        height_db: k.height === null ? nul() : ok(k.height ?? 15),
        phase: ok(0),
        locked: k.locked ?? true,
        delay_s: 0.2,
      }),
    ),
  };
}

const emptyCascade = (target: 'phi' | 'octave'): Cascade => ({
  target,
  tracks: [],
  steps: 0,
  skipped: [],
  closeness: nul('not_confirmed'),
  held_s: 0,
  chance: {
    a: { closeness: nul('not_confirmed'), p: nul('not_confirmed'), p_steps: nul('not_confirmed') },
    b: { closeness: nul('not_confirmed'), p: nul('not_confirmed'), p_steps: nul('not_confirmed') },
  },
  excess_a: nul('not_confirmed'),
  excess_b: nul('not_confirmed'),
});

export interface SlowSpec {
  tracks?: TrackSpec[];
  alphaDb?: number | null;
  phi?: { tracks: number[]; excess: number; active: boolean };
  octave?: { tracks: number[]; excess: number; active: boolean };
  /** Combined state; defaults to phi.active && octave.active, as the engine defines it. */
  both?: boolean;
  /** Excess against chance B (defaults to the same as excess_a). */
  excessB?: { phi?: number; octave?: number };
}

export function slowFrame(t: number, spec: SlowSpec): SlowFrame {
  const band = (v: number | null) => ({ above_bg_db: v === null ? nul('insufficient_clean') : ok(v), power: ok(1) });
  const spectra: SiteSpectrum[] =
    spec.alphaDb === undefined
      ? []
      : [
          {
            site: 'temporal',
            why: 'ok',
            f0: 0,
            df: 0.25,
            psd: [],
            flat: [],
            bg_exponent: ok(1),
            bg_offset: ok(1),
            k: 4,
            bands: { delta: band(0), theta: band(0), alpha: band(spec.alphaDb), beta: band(0), gamma: band(0) },
          },
        ];
  const casc = (target: 'phi' | 'octave', c?: { tracks: number[]; excess: number; active: boolean }): Cascade =>
    c
      ? { ...emptyCascade(target), tracks: c.tracks, steps: c.tracks.length - 1, excess_a: ok(c.excess), excess_b: ok(spec.excessB?.[target] ?? c.excess) }
      : emptyCascade(target);
  const state = (target: 'phi' | 'octave', c?: { active: boolean }) => ({ target, active: !!c?.active, for_s: 10, stat: ok(1), enter_at: 1, exit_at: 0.5 });
  return {
    kind: 'slow',
    schema: 1,
    t,
    window_s: 8,
    quality: [],
    spectra,
    tracks: (spec.tracks ?? []).map(
      (k): Track => ({
        id: k.id,
        state: k.state ?? 'confirmed',
        site: k.site ?? 'temporal',
        freq: k.freq === null ? nul() : ok(k.freq),
        freq_integrated: k.freq === null ? nul() : ok(k.freq),
        height_db: ok(k.height ?? 15),
        width_hz: ok(1),
        age_s: 10,
        band: k.band ?? bandOf(k.freq),
        harmonic_of: null,
      }),
    ),
    dominant: null,
    pairs: [],
    cascades: { phi: casc('phi', spec.phi), octave: casc('octave', spec.octave) },
    states: {
      phi: state('phi', spec.phi),
      octave: state('octave', spec.octave),
      both: { active: spec.both ?? (!!spec.phi?.active && !!spec.octave?.active), for_s: 0 },
    },
    hemispheres: [],
    front_back: [],
    mains_hz: 50,
    iaf_hz: null,
    band_edges: { delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 45] },
  };
}

export function heartFrame(t: number, beats: { t: number; flagged?: boolean }[]): HeartFrame {
  return {
    kind: 'heart',
    schema: 1,
    t,
    source: 'chest_strap',
    beats: beats.map((b) => ({ t: b.t, ibi_ms: 1000, flagged: !!b.flagged })),
    hr_bpm: ok(60),
    rmssd_ms: ok(40),
    sdnn_ms: ok(50),
    lf_power: ok(1),
    hf_power: ok(1),
    resonance_hz: ok(0.1),
    resonance_strength: ok(0.5),
    breath_bpm: ok(6),
    breath_phase: ok(0),
    pacer_adherence: nul('not_available'),
    corrected_fraction: 0,
    high_hrv: { active: false, for_s: 0, stat: ok(0), enter_at: null, exit_at: null },
    coupling: [],
  };
}

/**
 * A scripted session: `at(t)` returns the frames for each 1/32 s tick. Slow frames every 8 ticks.
 */
export type Script = (t: number, tick: number) => Frame[];

export interface Rendered {
  left: Float32Array;
  right: Float32Array;
  core: SynthCore;
  binder: FrameBinder;
}

/**
 * Render `seconds` of a scripted session offline, exactly as live: binder + core, frames delivered
 * at block boundaries, core time = session time.
 */
export function renderSession(script: Script, seconds: number, settings: AudioSettingsPatch = {}, setup?: (core: SynthCore, binder: FrameBinder) => void): Rendered {
  const core = new SynthCore(SR, settings);
  const binder = new FrameBinder(settings);
  setup?.(core, binder);
  const total = Math.round(seconds * SR);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const block = 128;
  let nextTick = 0;
  for (let pos = 0; pos < total; pos += block) {
    const t = pos / SR;
    while (nextTick / 32 <= t) {
      const ft = nextTick / 32;
      for (const f of script(ft, nextTick)) {
        const out = binder.handleFrame(f, core.timeS);
        if (out.reset) core.newSession();
        core.setControl(out.control);
        for (const b of out.beats) core.scheduleBeat(b.atS, b.flagged);
      }
      nextTick++;
    }
    const n = Math.min(block, total - pos);
    core.render(left, right, pos, n);
  }
  return { left, right, core, binder };
}

export const slice = (x: Float32Array, a: number, b: number) => x.subarray(Math.round(a * SR), Math.round(b * SR));

/** Frequency from upward zero crossings with linear interpolation. */
export function zeroCrossFreq(x: Float32Array): number {
  const ups: number[] = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) ups.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  if (ups.length < 3) return NaN;
  return ((ups.length - 1) * SR) / (ups[ups.length - 1] - ups[0]);
}

export const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

export function maxAbs(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}
export function maxDiff(x: Float32Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}
export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Magnitude spectrum (Hann window), length N/2, bin width SR/N. N = power of two <= x.length. */
export function spectrum(x: Float32Array): { mag: Float64Array; df: number } {
  let n = 1;
  while (n * 2 <= x.length) n *= 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, df: SR / n };
}

export function centroid(x: Float32Array): number {
  const { mag, df } = spectrum(x);
  let a = 0;
  let b = 0;
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i] * mag[i];
    a += p * i * df;
    b += p;
  }
  return a / b;
}

/** Fraction of energy above `hz`. */
export function energyAbove(x: Float32Array, hz: number): number {
  const { mag, df } = spectrum(x);
  let hi = 0;
  let all = 0;
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i] * mag[i];
    all += p;
    if (i * df > hz) hi += p;
  }
  return hi / all;
}

export function diff(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}
