/**
 * The measurement frame contract. Schema version 1.
 *
 * This file is the single source of truth for what the signal engine outputs.
 * The Rust crates serialize to exactly these shapes (serde, same field names).
 * Sound, visuals, training and storage read these frames and nothing else.
 *
 * Rules (docs/spec/signal-engine.md section 2):
 *  - Every measured quantity is `Measured`: a value or null. Null means "not measured"
 *    and always carries a reason. Never substitute zero or the last value.
 *  - Times are seconds on the session clock: EEG sample index / EEG rate, with index 0
 *    at the first EEG sample of the session. All other streams are mapped onto it.
 *  - Frequencies in Hz. Amplitudes in microvolts. Heights in dB above the fitted background.
 *    Ratios and misses in natural-log units unless a field says otherwise.
 */

export const SCHEMA_VERSION = 1;

/** Why a value is null, or 'ok'. */
export type Reason =
  | 'ok'
  | 'warming_up' // not enough data yet
  | 'no_data' // stream absent
  | 'gap' // packet loss in the window
  | 'bad_contact' // channel failed signal quality
  | 'artifact' // gated out
  | 'insufficient_clean' // not enough clean data in the window
  | 'bad_fit' // background fit failed
  | 'not_confirmed' // no confirmed peak
  | 'weak' // amplitude too low for a meaningful reading
  | 'lost_lock' // fast tracker disagrees with slow path
  | 'unresolved' // uncertainty too large to score
  | 'too_few_beats'
  | 'too_many_corrections'
  | 'not_available';

/** A measured value. `se` is one standard error where the engine can estimate it. */
export interface Measured {
  v: number | null;
  se?: number | null;
  why: Reason;
}

/** 'ratio_3' (3:1) is scored and logged like the controls; it never forms cascades or states. */
export type Target = 'phi' | 'octave' | 'ratio_3' | 'control_1_5' | 'control_1_8';
export type BandName = 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma';
/** A channel name ('TP9', 'AF7', 'AF8', 'TP10', ...) or a composite. */
export type Site = string | 'temporal' | 'frontal' | 'all';

// ---------------------------------------------------------------------------
// Slow frame: 4 per second
// ---------------------------------------------------------------------------

export interface ChannelQuality {
  name: string;
  usable: boolean;
  why: Reason;
  /** Mains line amplitude, microvolts. */
  mains_uv: number | null;
  /** Standard deviation of the conditioned signal over the last second, microvolts. */
  sd_uv: number | null;
  /** Fraction of samples at the converter limits over the last second. */
  railed: number | null;
  /** Muscle band (30-100 Hz, mains excluded) power relative to the fitted background, dB, last second. */
  emg_db: number | null;
  /** Fraction of the slow window that passed gating. */
  clean_fraction: number;
  /** Artifact kinds seen in the slow window. */
  artifacts: ArtifactKind[];
}

export type ArtifactKind = 'blink' | 'eye_movement' | 'muscle' | 'motion' | 'pop' | 'gap';

export interface SiteSpectrum {
  site: Site;
  why: Reason;
  /** First frequency and spacing of the arrays below, Hz. */
  f0: number;
  df: number;
  /** Power spectral density, microvolts squared per Hz. Empty when null. */
  psd: number[];
  /** Spectrum divided by the fitted background. 1 means no rhythm. Empty when null. */
  flat: number[];
  /** Fitted background: psd_bg(f) = 10^offset / f^exponent. */
  bg_exponent: Measured;
  bg_offset: Measured;
  /** Independent estimates averaged per bin (K in spec 6.1). */
  k: number;
  bands: Record<BandName, BandSummary>;
}

export interface BandSummary {
  /** Mean power above the fitted background across the band, dB. This is the one training uses. */
  above_bg_db: Measured;
  /** Total band power, microvolts squared. */
  power: Measured;
}

export type TrackState = 'new' | 'confirmed' | 'fading';

export interface Track {
  id: number;
  state: TrackState;
  /** Site where this track is strongest. The fast path follows it there. */
  site: Site;
  /** Centre frequency from the latest window. */
  freq: Measured;
  /** Precision-weighted running mean over the integration time. Ratio scoring uses this. */
  freq_integrated: Measured;
  /** Height above the fitted background at the peak, dB. */
  height_db: Measured;
  /** Full width at half height, Hz. */
  width_hz: Measured;
  /** Seconds since the track was first confirmed. */
  age_s: number;
  /** Display label only. */
  band: BandName;
  /** If this track is a harmonic of another: that track's id and the integer multiple. */
  harmonic_of: { id: number; n: number } | null;
}

export interface PairScore {
  lo: number; // track id, lower frequency
  hi: number; // track id, higher frequency
  /** ln(f_hi / f_lo) with its standard error. Null if either track lacks an integrated frequency. */
  log_ratio: Measured;
  harmonic: boolean;
  targets: Record<Target, PairTargetScore>;
}

export interface PairTargetScore {
  /** log_ratio minus ln(target). */
  miss: Measured;
  /** exp(-0.5 (miss/tolerance)^2), 0..1. Null if unresolved. */
  closeness: Measured;
  /** ln of the evidence ratio (spec 8.4, T3). */
  log_evidence: Measured;
  aligned: boolean;
}

export interface Cascade {
  target: 'phi' | 'octave';
  /** Member track ids, lowest frequency first. Empty if there is no aligned pair. */
  tracks: number[];
  /** Number of aligned steps: tracks.length - 1, or 0. */
  steps: number;
  /** Track ids skipped over between members. */
  skipped: number[];
  /** Mean closeness across steps. */
  closeness: Measured;
  /** Seconds the cascade has held with at least its current number of steps. */
  held_s: number;
  chance: ChancePair;
  /** (closeness - chance A closeness) / (1 - chance A closeness), floored at 0. Drives the hurricane. */
  excess_a: Measured;
  /** The same against chance B. */
  excess_b: Measured;
}

export interface ChanceLevel {
  /** Expected closeness of the best cascade under this null. */
  closeness: Measured;
  /** Fraction of surrogates scoring at least as well as observed (a p-value). */
  p: Measured;
  /** Fraction of surrogates in which a cascade of at least the observed number of steps appears. */
  p_steps: Measured;
}

export interface ChancePair {
  /** Chance A: the same number of peaks placed at random. */
  a: ChanceLevel;
  /** Chance B: each track's own history, shifted in time against the others. */
  b: ChanceLevel;
}

export interface AlignedState {
  target: 'phi' | 'octave';
  active: boolean;
  /** Seconds in the current state (active or not). */
  for_s: number;
  /** The statistic the threshold is applied to, and the entry and exit thresholds in force. */
  stat: Measured;
  enter_at: number | null;
  exit_at: number | null;
}

export interface SiteComparison {
  /** Track id this comparison is for. */
  track: number;
  /** Frequency at side A minus side B, Hz. */
  freq_diff: Measured;
  /** (A - B) / (A + B) of amplitude, -1..1. */
  balance: Measured;
  /** Phase locking between the two sides in excess of a time-shifted surrogate, 0..1. */
  locking_excess: Measured;
  /** 0..1 summary: 1 when frequency matches, balance is even and locking is high. */
  match: Measured;
}

export interface SlowFrame {
  kind: 'slow';
  schema: number;
  t: number;
  /** Seconds of data behind this frame (the slow window length). */
  window_s: number;
  quality: ChannelQuality[];
  spectra: SiteSpectrum[];
  tracks: Track[];
  /** Id of the strongest confirmed track, or null. */
  dominant: number | null;
  pairs: PairScore[];
  cascades: { phi: Cascade; octave: Cascade };
  states: {
    phi: AlignedState;
    octave: AlignedState;
    /**
     * The combined state: active only while BOTH the golden ratio state and the octave state
     * are active. `for_s` counts seconds in the current combined condition. It has no statistic
     * of its own: it is the conjunction of two measured states.
     */
    both: { active: boolean; for_s: number };
  };
  /** Left (TP9) against right (TP10), one entry per track present on both. */
  hemispheres: SiteComparison[];
  /** Frontal pair against temporal pair. */
  front_back: SiteComparison[];
  /** Mains frequency in use, 50 or 60, or null while detecting. */
  mains_hz: number | null;
  /**
   * Individual alpha frequency: the integrated frequency of the person's alpha track at the
   * temporal pair, eyes closed, once a calibration has set it (EngineApi.setIaf). Null until then.
   */
  iaf_hz: number | null;
  /**
   * Band edges in force, Hz. Fixed defaults (delta 1-4, theta 4-8, alpha 8-13, beta 13-30,
   * gamma 30-45) until an individual alpha frequency is set, then scaled to it
   * (theta 0.4-0.8 x, alpha 0.8-1.2 x, beta 1.2 x to 30 Hz).
   */
  band_edges: Record<BandName, [number, number]>;
}

// ---------------------------------------------------------------------------
// Fast frame: 32 per second
// ---------------------------------------------------------------------------

export interface FastTrack {
  id: number;
  /** Instantaneous frequency, Hz. The tone's pitch is this times 32. */
  freq: Measured;
  /** Instantaneous amplitude, microvolts. */
  amp_uv: Measured;
  /** Height above background, dB. */
  height_db: Measured;
  /** Phase in radians, -pi..pi. */
  phase: Measured;
  locked: boolean;
  /** Processing delay of this reading, seconds (already subtracted from nothing: `t` is output time). */
  delay_s: number;
}

export interface FastFrame {
  kind: 'fast';
  schema: number;
  t: number;
  tracks: FastTrack[];
  /** True when the current moment is gated on the sites the tracks are followed on. */
  artifact: boolean;
}

// ---------------------------------------------------------------------------
// Heart frame: on every beat, and at least once a second
// ---------------------------------------------------------------------------

export type HeartSource = 'chest_strap' | 'headset_ppg' | 'none';

export interface Beat {
  /** Time of the beat on the session clock. */
  t: number;
  /** Interval since the previous beat, milliseconds. */
  ibi_ms: number;
  /** True if beat cleaning marked this interval as missed, extra or ectopic. */
  flagged: boolean;
}

export interface HeartFrame {
  kind: 'heart';
  schema: number;
  t: number;
  source: HeartSource;
  /** Beats detected since the previous heart frame. The heartbeat sound fires on these. */
  beats: Beat[];
  hr_bpm: Measured;
  rmssd_ms: Measured;
  sdnn_ms: Measured;
  /** Power of the heart rhythm in 0.04-0.15 Hz and 0.15-0.4 Hz, ms squared. */
  lf_power: Measured;
  hf_power: Measured;
  /** Frequency of the tallest peak of the heart rhythm in 0.04-0.26 Hz. */
  resonance_hz: Measured;
  /** Share of 0.04-0.4 Hz power within +-0.015 Hz of that peak, 0..1. */
  resonance_strength: Measured;
  /** Breathing rate estimated from the heart rhythm, breaths per minute. An estimate. */
  breath_bpm: Measured;
  /** Phase of the measured breathing rhythm, radians, for the hurricane's slow swell. */
  breath_phase: Measured;
  /** 0..1: how closely the measured rhythm follows the pacer. Null when the pacer is off. */
  pacer_adherence: Measured;
  /** Fraction of intervals corrected or excluded in the variability window. */
  corrected_fraction: number;
  high_hrv: { active: boolean; for_s: number; stat: Measured; enter_at: number | null; exit_at: number | null };
  coupling: Coupling[];
}

export interface Coupling {
  /** What on the brain side: e.g. 'alpha.above_bg_db@temporal' or 'track:3.height_db'. */
  brain: string;
  /** 'correlation' | 'phase_locking' */
  measure: string;
  value: Measured;
  /** Mean of the time-shifted surrogates, and the fraction of them at least as large as observed. */
  chance: Measured;
  p: Measured;
  /** True when it looks like pulse leaking into the EEG (spec section 13). */
  suspect_artifact: boolean;
}

export type Frame = SlowFrame | FastFrame | HeartFrame;

// ---------------------------------------------------------------------------
// Engine input (what the device layer hands over)
// ---------------------------------------------------------------------------

export interface StreamDescription {
  eeg: { channels: string[]; rate_hz: number; bits: number; model: string } | null;
  ppg: { channels: string[]; rate_hz: number } | null;
  motion: { rate_hz: number } | null;
  chest_strap: { name: string } | null;
}

export interface EngineConfig {
  streams: StreamDescription;
  /** Overrides for the provisional parameters (spec section 14), by name. */
  params?: Record<string, number | string | boolean>;
  /** Seed for surrogates. Stored with the session. */
  seed: number;
  /** 50, 60, or null to detect. */
  mains_hz?: 50 | 60 | null;
}

/** A marker written into the session by the app (spec section 12). */
export interface Marker {
  t: number;
  type: 'block_start' | 'block_end' | 'technique' | 'instruction' | 'report' | 'baseline_start' | 'baseline_end' | 'anchor_play' | 'note';
  label?: string;
  data?: Record<string, unknown>;
}

/**
 * The engine as the app sees it (implemented by the WebAssembly module, run in a worker).
 *
 *  pushEeg(firstIndex, samples): samples interleaved by channel in `streams.eeg.channels` order,
 *    microvolts. `firstIndex` is the index of the first sample on the session clock. A jump in
 *    firstIndex beyond the expected next index is a gap of that many samples.
 *  pushMotion(t, acc[3] in g, gyro[3] in deg/s)
 *  pushPpg(t, samples interleaved by channel): t is the session time of the first sample.
 *  pushRr(t, rr_ms[]): beat-to-beat intervals from a chest strap; t is the session time the
 *    notification arrived.
 *  pushMarker(marker)
 *  drain(): all frames produced since the last call, in time order.
 */
export interface EngineApi {
  pushEeg(firstIndex: number, samples: Float32Array): void;
  pushMotion(t: number, acc: Float32Array, gyro: Float32Array): void;
  pushPpg(t: number, samples: Float32Array): void;
  pushRr(t: number, rrMs: Float32Array): void;
  pushMarker(marker: Marker): void;
  setPacer(breathsPerMinute: number | null): void;
  /** Set or clear the individual alpha frequency from the user's calibration. */
  setIaf(hz: number | null): void;
  drain(): Frame[];
  version(): string;
  params(): Record<string, number | string | boolean>;
}
