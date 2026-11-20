/**
 * TEST FIXTURES ONLY. Synthetic frame builders for unit tests of the training layer.
 * Never imported by app code and never used as a demo mode (CLAUDE.md rule 1).
 */

import { SCHEMA_VERSION, type BandName, type Cascade, type FastFrame, type HeartFrame, type Measured, type SiteSpectrum, type SlowFrame, type Track } from '../engine/frames';
import { createRng, type Rng } from './math';

const M = (v: number | null, se: number | null = null): Measured => (v === null ? { v: null, se: null, why: 'insufficient_clean' } : { v, se, why: 'ok' });

export interface SlowSpec {
  /** Band power above background at every site (dB). Null: the spectrum is null. */
  bands?: Partial<Record<BandName, number | null>>;
  /** Per-site overrides, e.g. { AF8: { alpha: 2 } }. */
  sites?: Record<string, Partial<Record<BandName, number>>>;
  emgDb?: number;
  usable?: boolean;
  cleanFraction?: number;
  artifacts?: ('blink' | 'muscle' | 'motion')[];
  alphaTrack?: { freq: number; height: number } | null;
  thetaTrack?: { freq: number; height: number } | null;
  phiExcess?: number;
  phiSteps?: number;
  octaveExcess?: number;
  hemiMatch?: number;
}

function cascade(target: 'phi' | 'octave', excess: number, steps: number): Cascade {
  const ch = { closeness: M(0.1), p: M(0.5), p_steps: M(0.5) };
  return { target, tracks: [], steps, skipped: [], closeness: M(excess), held_s: 0, chance: { a: ch, b: ch }, excess_a: M(excess), excess_b: M(excess) };
}

export function slowFrame(t: number, s: SlowSpec = {}): SlowFrame {
  const sites = ['TP9', 'AF7', 'AF8', 'TP10', 'temporal', 'frontal', 'all'];
  const bands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, ...(s.bands ?? {}) };
  const nullSpectrum = s.bands?.alpha === null;
  const spectra: SiteSpectrum[] = sites.map((site) => {
    const o = s.sites?.[site] ?? {};
    const mk = (b: BandName) => ({ above_bg_db: nullSpectrum ? M(null) : M((o[b] ?? bands[b]) as number, 0.3), power: M(1) });
    return {
      site, why: nullSpectrum ? 'insufficient_clean' : 'ok', f0: 1, df: 0.125, psd: [], flat: [], bg_exponent: M(1.5, 0.05), bg_offset: M(1), k: 7,
      bands: { delta: mk('delta'), theta: mk('theta'), alpha: mk('alpha'), beta: mk('beta'), gamma: mk('gamma') },
    };
  });
  const tracks: Track[] = [];
  if (s.alphaTrack) tracks.push({ id: 1, state: 'confirmed', site: 'temporal', freq: M(s.alphaTrack.freq, 0.1), freq_integrated: M(s.alphaTrack.freq, 0.05), height_db: M(s.alphaTrack.height, 0.3), width_hz: M(1), age_s: 30, band: 'alpha', harmonic_of: null });
  if (s.thetaTrack) tracks.push({ id: 2, state: 'confirmed', site: 'temporal', freq: M(s.thetaTrack.freq, 0.1), freq_integrated: M(s.thetaTrack.freq, 0.05), height_db: M(s.thetaTrack.height, 0.3), width_hz: M(1), age_s: 30, band: 'theta', harmonic_of: null });
  const usable = s.usable ?? true;
  return {
    kind: 'slow', schema: SCHEMA_VERSION, t, window_s: 8,
    quality: ['TP9', 'AF7', 'AF8', 'TP10'].map((name) => ({ name, usable, why: usable ? 'ok' : 'bad_contact', mains_uv: 1, sd_uv: 10, railed: 0, emg_db: s.emgDb ?? 0, clean_fraction: s.cleanFraction ?? 1, artifacts: s.artifacts ?? [] })),
    spectra, tracks, dominant: tracks[0]?.id ?? null, pairs: [],
    cascades: { phi: cascade('phi', s.phiExcess ?? 0, s.phiSteps ?? 0), octave: cascade('octave', s.octaveExcess ?? 0, 0) },
    states: { phi: { target: 'phi', active: false, for_s: 0, stat: M(0), enter_at: 1, exit_at: 0.5 }, octave: { target: 'octave', active: false, for_s: 0, stat: M(0), enter_at: 1, exit_at: 0.5 } },
    hemispheres: s.hemiMatch !== undefined && tracks.length ? [{ track: tracks[0].id, freq_diff: M(0), balance: M(0), locking_excess: M(0.2), match: M(s.hemiMatch) }] : [],
    front_back: [], mains_hz: 50, iaf_hz: null,
    band_edges: { delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 45] },
  };
}

export function fastFrame(t: number, s: { artifact?: boolean; alphaHeight?: number | null; alphaFreq?: number; locked?: boolean } = {}): FastFrame {
  return {
    kind: 'fast', schema: SCHEMA_VERSION, t, artifact: s.artifact ?? false,
    tracks: s.alphaHeight === undefined ? [] : [{ id: 1, freq: M(s.alphaFreq ?? 10), amp_uv: M(5), height_db: M(s.alphaHeight), phase: M(0), locked: s.locked ?? true, delay_s: 0.2 }],
  };
}

export function heartFrame(t: number, s: { rmssd?: number | null; res?: number | null; hr?: number | null; lf?: number | null; adherence?: number | null } = {}): HeartFrame {
  const hi = { active: false, for_s: 0, stat: M(0), enter_at: null, exit_at: null };
  return {
    kind: 'heart', schema: SCHEMA_VERSION, t, source: 'chest_strap', beats: [],
    hr_bpm: M(s.hr === undefined ? 60 : s.hr), rmssd_ms: M(s.rmssd === undefined ? 40 : s.rmssd), sdnn_ms: M(50), lf_power: M(s.lf === undefined ? 500 : s.lf), hf_power: M(300), resonance_hz: M(0.1),
    resonance_strength: M(s.res === undefined ? 0.3 : s.res), breath_bpm: M(6), breath_phase: M(0), pacer_adherence: s.adherence === undefined ? { v: null, se: null, why: 'not_available' } : M(s.adherence),
    corrected_fraction: 0, high_hrv: hi, coupling: [],
  };
}

/**
 * A slowly correlated process sampled every dt: each value is the mean of an `memoryS` window of
 * white noise plus a slow AR(1) wander, like a slow-frame band value.
 */
export function correlatedNoise(rng: Rng, n: number, dt: number, memoryS = 8, sd = 1): number[] {
  const L = Math.max(1, Math.round(memoryS / dt));
  const raw: number[] = [];
  let ar = 0;
  for (let i = 0; i < n + L; i++) {
    ar = 0.98 * ar + Math.sqrt(1 - 0.98 * 0.98) * rng.normal();
    raw.push(rng.normal() * 2.5 + 0.5 * ar);
  }
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < L; i++) s += raw[i];
  const norm = Math.sqrt(6.25 / L + 0.25);
  for (let i = 0; i < n; i++) {
    out.push((sd * s) / L / norm);
    s += raw[i + L] - raw[i];
  }
  return out;
}

export { createRng };
