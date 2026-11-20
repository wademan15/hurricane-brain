/**
 * Hand-built engine frames for TESTS ONLY. Nothing in the app imports this file.
 * The app has no demo or simulated mode: the hurricane only ever draws real engine frames.
 */
import type {
  BandName,
  Cascade,
  HeartFrame,
  Measured,
  Reason,
  SiteSpectrum,
  SlowFrame,
  Track,
} from '../../engine/frames.ts';

export const m = (v: number, se = 0.01): Measured => ({ v, se, why: 'ok' });
export const nul = (why: Reason = 'not_confirmed'): Measured => ({ v: null, why });

const BANDS: BandName[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];

export function track(id: number, freq: number, heightDb: number, band: BandName = 'alpha'): Track {
  return {
    id,
    state: 'confirmed',
    site: 'temporal',
    freq: m(freq, 0.05),
    freq_integrated: m(freq, 0.03),
    height_db: m(heightDb, 0.4),
    width_hz: m(1.2, 0.1),
    age_s: 30,
    band,
    harmonic_of: null,
  };
}

export function emptyCascade(target: 'phi' | 'octave', why: Reason = 'not_confirmed'): Cascade {
  return {
    target,
    tracks: [],
    steps: 0,
    skipped: [],
    closeness: nul(why),
    held_s: 0,
    chance: {
      a: { closeness: nul(why), p: nul(why), p_steps: nul(why) },
      b: { closeness: nul('warming_up'), p: nul('warming_up'), p_steps: nul('warming_up') },
    },
    excess_a: nul(why),
    excess_b: nul(why),
  };
}

export function cascade(target: 'phi' | 'octave', ids: number[], excessA: number, heldS: number): Cascade {
  return {
    target,
    tracks: ids,
    steps: Math.max(0, ids.length - 1),
    skipped: [],
    closeness: m(0.9, 0.03),
    held_s: heldS,
    chance: {
      a: { closeness: m(0.31, 0.02), p: m(0.004, 0.002), p_steps: m(0.006, 0.002) },
      b: { closeness: m(0.42, 0.04), p: m(0.03, 0.01), p_steps: m(0.05, 0.02) },
    },
    excess_a: m(excessA, 0.04),
    excess_b: m(Math.max(0, excessA - 0.2), 0.05),
  };
}

function bandSummaries(why: Reason, ok: boolean): SiteSpectrum['bands'] {
  const out = {} as SiteSpectrum['bands'];
  for (const b of BANDS) {
    out[b] = { above_bg_db: ok ? m(2) : nul(why), power: ok ? m(10) : nul(why) };
  }
  return out;
}

/** A 1/f background with Lorentzian-ish bumps at the given track frequencies. */
export function spectrum(site: string, peaks: { f: number; db: number }[]): SiteSpectrum {
  const f0 = 1;
  const df = 0.25;
  const n = 177; // 1..45 Hz
  const exponent = 1.4;
  const offset = 1.6;
  const psd: number[] = [];
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    const fr = f0 + i * df;
    const bg = 10 ** offset / fr ** exponent;
    let ratioDb = 0;
    for (const p of peaks) ratioDb += p.db * Math.exp(-0.5 * ((fr - p.f) / 0.6) ** 2);
    // Small deterministic ripple so the flattened line looks like a real estimate.
    ratioDb += 0.35 * Math.sin(i * 1.7) * Math.cos(i * 0.37);
    const ratio = 10 ** (ratioDb / 10);
    flat.push(ratio);
    psd.push(bg * ratio);
  }
  return {
    site,
    why: 'ok',
    f0,
    df,
    psd,
    flat,
    bg_exponent: m(exponent, 0.05),
    bg_offset: m(offset, 0.03),
    k: 30,
    bands: bandSummaries('ok', true),
  };
}

export function nullSpectrum(site: string, why: Reason): SiteSpectrum {
  return {
    site, why, f0: 1, df: 0.25, psd: [], flat: [],
    bg_exponent: nul(why), bg_offset: nul(why), k: 0, bands: bandSummaries(why, false),
  };
}

const BAND_EDGES: SlowFrame['band_edges'] = {
  delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 45],
};

const quality = (usable: boolean, why: Reason): SlowFrame['quality'] =>
  ['TP9', 'AF7', 'AF8', 'TP10'].map((name) => ({
    name, usable, why, mains_uv: usable ? 0.4 : null, sd_uv: usable ? 12 : null,
    railed: usable ? 0 : null, emg_db: usable ? 1 : null, clean_fraction: usable ? 0.95 : 0,
    artifacts: usable ? [] : ['muscle'],
  }));

/** (a) Everything null: bad contact on every channel. */
export function allNullSlow(t: number, why: Reason = 'bad_contact'): SlowFrame {
  return {
    kind: 'slow', schema: 1, t, window_s: 8,
    quality: quality(false, why),
    spectra: [nullSpectrum('temporal', why), nullSpectrum('TP9', why), nullSpectrum('TP10', why)],
    tracks: [], dominant: null, pairs: [],
    cascades: { phi: emptyCascade('phi', why), octave: emptyCascade('octave', why) },
    states: {
      phi: { target: 'phi', active: false, for_s: 0, stat: nul(why), enter_at: null, exit_at: null },
      octave: { target: 'octave', active: false, for_s: 0, stat: nul(why), enter_at: null, exit_at: null },
    },
    hemispheres: [], front_back: [], mains_hz: 50, iaf_hz: null, band_edges: BAND_EDGES,
  };
}

export interface SlowOpts {
  t: number;
  tracks: Track[];
  dominant: number | null;
  phi?: Cascade;
  octave?: Cascade;
  match?: number | null;
}

export function slowFrame(o: SlowOpts): SlowFrame {
  const base = allNullSlow(o.t, 'not_confirmed');
  const peaks = o.tracks.map((t) => ({ f: t.freq.v ?? 10, db: t.height_db.v ?? 0 }));
  return {
    ...base,
    quality: quality(true, 'ok'),
    spectra: [spectrum('temporal', peaks), spectrum('TP9', peaks), spectrum('TP10', peaks)],
    tracks: o.tracks,
    dominant: o.dominant,
    cascades: {
      phi: o.phi ?? emptyCascade('phi', 'not_confirmed'),
      octave: o.octave ?? emptyCascade('octave', 'not_confirmed'),
    },
    states: {
      phi: { target: 'phi', active: (o.phi?.steps ?? 0) > 0, for_s: o.phi?.held_s ?? 0, stat: m(1.2), enter_at: 2, exit_at: 1 },
      octave: { target: 'octave', active: (o.octave?.steps ?? 0) > 0, for_s: o.octave?.held_s ?? 0, stat: m(0.5), enter_at: 2, exit_at: 1 },
    },
    hemispheres:
      o.match === undefined || o.dominant === null
        ? []
        : [{
            track: o.dominant,
            freq_diff: m(0.05, 0.02),
            balance: m(0.1, 0.05),
            locking_excess: m(0.4, 0.05),
            match: o.match === null ? nul('weak') : m(o.match, 0.05),
          }],
  };
}

/** Confirmed tracks but no cascade. */
export function bandsOnly(t: number, dominant: number | null = 2): SlowFrame {
  return slowFrame({
    t,
    tracks: [track(1, 6.1, 4, 'theta'), track(2, 10.2, 9), track(3, 21.5, 3, 'beta')],
    dominant,
    match: 0.9,
  });
}

/** (c) A 3-step golden ratio cascade: 3.8, 6.15, 9.95, 16.1 Hz. */
export function phiCascadeFrame(t: number, dominant: number | null = 3, heldS = 40): SlowFrame {
  const tracks = [track(1, 3.8, 5, 'delta'), track(2, 6.15, 7, 'theta'), track(3, 9.95, 11), track(4, 16.1, 6, 'beta')];
  return slowFrame({
    t, tracks, dominant,
    phi: cascade('phi', [1, 2, 3, 4], 0.8, heldS),
    octave: { ...emptyCascade('octave', 'not_confirmed'), excess_a: m(0, 0.02) },
    match: 0.85,
  });
}

/** (d) An octave cascade: 5, 10, 20 Hz, no golden ratio cascade. */
export function octaveCascadeFrame(t: number, dominant: number | null = 2, heldS = 40): SlowFrame {
  const tracks = [track(1, 5.0, 6, 'theta'), track(2, 10.0, 10), track(3, 20.0, 5, 'beta')];
  return slowFrame({
    t, tracks, dominant,
    phi: { ...emptyCascade('phi', 'not_confirmed'), excess_a: m(0, 0.02) },
    octave: cascade('octave', [1, 2, 3], 0.85, heldS),
    match: 0.85,
  });
}

export function heartFrame(t: number, beats: { t: number; ibi: number }[], breathPhase: number | null): HeartFrame {
  const none = (why: Reason): Measured => ({ v: null, why });
  return {
    kind: 'heart', schema: 1, t, source: 'chest_strap',
    beats: beats.map((b) => ({ t: b.t, ibi_ms: b.ibi, flagged: false })),
    hr_bpm: m(62, 1), rmssd_ms: m(48, 3), sdnn_ms: m(55, 3), lf_power: m(900, 80), hf_power: m(400, 50),
    resonance_hz: m(0.1, 0.005), resonance_strength: m(0.5, 0.05), breath_bpm: m(6, 0.3),
    breath_phase: breathPhase === null ? none('too_few_beats') : m(breathPhase, 0.1),
    pacer_adherence: none('not_available'), corrected_fraction: 0,
    high_hrv: { active: false, for_s: 0, stat: none('warming_up'), enter_at: null, exit_at: null },
    coupling: [],
  };
}

export function nullHeart(t: number): HeartFrame {
  const none: Measured = { v: null, why: 'no_data' };
  return {
    kind: 'heart', schema: 1, t, source: 'none', beats: [],
    hr_bpm: none, rmssd_ms: none, sdnn_ms: none, lf_power: none, hf_power: none, resonance_hz: none,
    resonance_strength: none, breath_bpm: none, breath_phase: none, pacer_adherence: none,
    corrected_fraction: 0,
    high_hrv: { active: false, for_s: 0, stat: none, enter_at: null, exit_at: null },
    coupling: [],
  };
}
