/**
 * Every tunable number of the sound layer, in one place (CLAUDE.md rule 9).
 *
 * Two kinds:
 *  - Declared smoothing (spec section 2, rule 8): the time constants between a measurement and
 *    what the user hears. Each sound element has exactly one, named here, shown in settings and
 *    recorded with the session (`AudioEngine.getDebug().settings`).
 *  - Mapping and design constants: how a measured number becomes a pitch, a level or a timbre.
 *
 * Handover: the smoothing constants belong in the provisional parameter table (spec section 14).
 * The sound layer does not own that file; see app/src/audio/README.md, "Requests".
 */

import type { Site } from '../engine/frames.ts';

export const AUDIO_SETTINGS_VERSION = 1;

/** Per-layer gains, linear 0..2 (1 = design level). The master ceiling still applies. */
export interface LayerGains {
  tones: number;
  bed: number;
  bloom: number;
  heart: number;
  breath: number;
  anchor: number;
}

export interface BreathGuideSettings {
  /** The breath guide is the one sound that is not a measurement. Off by default. */
  enabled: boolean;
  /** Pacer rate, breaths per minute (2..20). Must match what the engine was given in setPacer. */
  bpm: number;
}

export interface AudioSettings {
  // --- Tracking tones -------------------------------------------------------------------------
  /** Exact multiplier from brain frequency to tone pitch. Five octaves. Not user-editable. */
  readonly pitchMultiplier: 32;
  /**
   * THE declared pitch smoothing (portamento): one-pole time constant applied to log pitch, seconds.
   * After 7 time constants the tone is within 0.1 cent of a 1-semitone step. Range 0.02..1.
   */
  pitchTauS: number;
  /** Fade out when a tone loses its measurement (null, unlocked, unconfirmed, artifact), and fade in on return. Raised cosine, seconds, >= 1. */
  toneFadeS: number;
  /** One-pole smoothing between fast-frame height above background and tone loudness, seconds. */
  toneLoudnessTauS: number;
  /** Height above background (dB) at which a tone is silent, and at which it reaches full level. */
  heightFloorDb: number;
  heightFullDb: number;
  /** Gentle loudness roll-off above this pitch, dB per octave, so beta tones are never piercing. */
  rolloffStartHz: number;
  rolloffDbPerOctave: number;
  /** Second harmonic of each tone (exact 2x, same phase), 0..0.3. Helps small speakers. 0 = pure sine. */
  toneHarmonic2: number;
  /** Most tracking tones at once. */
  maxVoices: number;

  // --- State bed and blooms -------------------------------------------------------------------
  /** Spectrum site whose alpha power above background drives the bed. */
  bedSite: Site;
  /** Alpha above background, relative to baseline, that gives full warmth, dB. */
  warmthRangeDb: number;
  /** One-pole smoothing of warmth, seconds (>= 1). */
  warmthTauS: number;
  /** One-pole smoothing of steadiness, seconds. This is the "how long it has held" integrator. */
  steadyTauS: number;
  /** Bed presence fade (on/off with the alpha measurement), raised cosine, seconds (>= 1). */
  bedFadeS: number;
  /** Artifact thinning: bed level multiplier while the fast frame flags artifact, and its fade, seconds (>= 1). */
  thinLevel: number;
  thinFadeS: number;
  /** One-pole smoothing of the golden ratio and octave bloom levels, seconds (>= 1). Rising. */
  bloomTauS: number;
  /** One-pole smoothing when a bloom thins (state left), seconds (>= 1). */
  bloomReleaseTauS: number;

  // --- Heart ----------------------------------------------------------------------------------
  /** Fixed latency from Beat.t (session clock) to the pulse in the ear, seconds. */
  heartLatencyS: number;
  /** A beat that would play later than its slot by more than this is dropped, never shifted. */
  heartLateToleranceS: number;
  /** Pulse pitch, Hz (glides down 20% across the pulse). */
  heartPitchHz: number;
  /** Pulse length, seconds. */
  heartPulseS: number;
  /** Level of beats the engine flagged (missed, extra, ectopic), 0..1 of normal. */
  heartFlaggedLevel: number;

  // --- Breath guide ---------------------------------------------------------------------------
  breathGuide: BreathGuideSettings;
  /** Breath guide on/off fade, seconds (>= 1). */
  breathFadeS: number;

  // --- Mix ------------------------------------------------------------------------------------
  gains: LayerGains;
  /** One-pole smoothing of gain and master changes, seconds. */
  gainTauS: number;
  /** Master gain, dB (-60..+6). */
  masterDb: number;
  /** Absolute peak ceiling, dBFS (-40..-1). No output sample ever exceeds it. */
  ceilingDb: number;

  // --- Safety ---------------------------------------------------------------------------------
  /** Freshness: fast frames older than this are not used. Seconds. */
  staleFastS: number;
  /** Freshness: slow frames older than this are not used. Seconds. */
  staleSlowS: number;
  /** Worklet watchdog: if no control update arrives for this long, every measured layer fades. */
  watchdogS: number;

  /** Seed for the bed's fixed noise carrier (determinism). */
  seed: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  pitchMultiplier: 32,
  pitchTauS: 0.15,
  toneFadeS: 1.5,
  toneLoudnessTauS: 0.25,
  heightFloorDb: 0,
  heightFullDb: 15,
  rolloffStartHz: 700,
  rolloffDbPerOctave: 6,
  toneHarmonic2: 0.1,
  maxVoices: 6,

  bedSite: 'temporal',
  warmthRangeDb: 6,
  warmthTauS: 2,
  steadyTauS: 8,
  bedFadeS: 2,
  thinLevel: 0.35,
  thinFadeS: 1,
  bloomTauS: 3,
  bloomReleaseTauS: 2,

  heartLatencyS: 0.3,
  heartLateToleranceS: 0.1,
  heartPitchHz: 58,
  heartPulseS: 0.42,
  heartFlaggedLevel: 0.5,

  breathGuide: { enabled: false, bpm: 6 },
  breathFadeS: 2,

  gains: { tones: 1, bed: 1, bloom: 1, heart: 1, breath: 1, anchor: 1 },
  gainTauS: 0.25,
  masterDb: 0,
  ceilingDb: -6,

  staleFastS: 0.25,
  staleSlowS: 1.0,
  watchdogS: 0.5,

  seed: 1,
};

/** Input to setSettings: any subset, gains and breath guide may be partial too. */
export type AudioSettingsPatch = Partial<Omit<AudioSettings, 'gains' | 'breathGuide' | 'pitchMultiplier'>> & {
  gains?: Partial<LayerGains>;
  breathGuide?: Partial<BreathGuideSettings>;
};

const clamp = (x: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;

/** Merge a patch into settings and clamp every value to its safe range. Pure. */
export function mergeSettings(base: AudioSettings, patch: AudioSettingsPatch = {}): AudioSettings {
  const d = DEFAULT_AUDIO_SETTINGS;
  const m = { ...base, ...patch, gains: { ...base.gains, ...patch.gains }, breathGuide: { ...base.breathGuide, ...patch.breathGuide } };
  const g = m.gains;
  const gain = (x: number, f: number) => clamp(x, 0, 2, f);
  return {
    pitchMultiplier: 32,
    pitchTauS: clamp(m.pitchTauS, 0.02, 1, d.pitchTauS),
    toneFadeS: clamp(m.toneFadeS, 1, 10, d.toneFadeS),
    toneLoudnessTauS: clamp(m.toneLoudnessTauS, 0.05, 2, d.toneLoudnessTauS),
    heightFloorDb: clamp(m.heightFloorDb, -10, 20, d.heightFloorDb),
    heightFullDb: Math.max(clamp(m.heightFloorDb, -10, 20, d.heightFloorDb) + 1, clamp(m.heightFullDb, -9, 40, d.heightFullDb)),
    rolloffStartHz: clamp(m.rolloffStartHz, 200, 2000, d.rolloffStartHz),
    rolloffDbPerOctave: clamp(m.rolloffDbPerOctave, 0, 18, d.rolloffDbPerOctave),
    toneHarmonic2: clamp(m.toneHarmonic2, 0, 0.3, d.toneHarmonic2),
    maxVoices: Math.round(clamp(m.maxVoices, 1, 8, d.maxVoices)),
    bedSite: typeof m.bedSite === 'string' ? m.bedSite : d.bedSite,
    warmthRangeDb: clamp(m.warmthRangeDb, 1, 30, d.warmthRangeDb),
    warmthTauS: clamp(m.warmthTauS, 1, 10, d.warmthTauS),
    steadyTauS: clamp(m.steadyTauS, 1, 60, d.steadyTauS),
    bedFadeS: clamp(m.bedFadeS, 1, 10, d.bedFadeS),
    thinLevel: clamp(m.thinLevel, 0, 1, d.thinLevel),
    thinFadeS: clamp(m.thinFadeS, 1, 10, d.thinFadeS),
    bloomTauS: clamp(m.bloomTauS, 1, 10, d.bloomTauS),
    bloomReleaseTauS: clamp(m.bloomReleaseTauS, 1, 10, d.bloomReleaseTauS),
    heartLatencyS: clamp(m.heartLatencyS, 0, 2, d.heartLatencyS),
    heartLateToleranceS: clamp(m.heartLateToleranceS, 0, 0.5, d.heartLateToleranceS),
    heartPitchHz: clamp(m.heartPitchHz, 35, 110, d.heartPitchHz),
    heartPulseS: clamp(m.heartPulseS, 0.2, 0.8, d.heartPulseS),
    heartFlaggedLevel: clamp(m.heartFlaggedLevel, 0, 1, d.heartFlaggedLevel),
    breathGuide: { enabled: m.breathGuide.enabled === true, bpm: clamp(m.breathGuide.bpm, 2, 20, d.breathGuide.bpm) },
    breathFadeS: clamp(m.breathFadeS, 1, 10, d.breathFadeS),
    gains: {
      tones: gain(g.tones, 1), bed: gain(g.bed, 1), bloom: gain(g.bloom, 1),
      heart: gain(g.heart, 1), breath: gain(g.breath, 1), anchor: gain(g.anchor, 1),
    },
    gainTauS: clamp(m.gainTauS, 0.02, 2, d.gainTauS),
    masterDb: clamp(m.masterDb, -60, 6, d.masterDb),
    ceilingDb: clamp(m.ceilingDb, -40, -1, d.ceilingDb),
    staleFastS: clamp(m.staleFastS, 0.05, 1, d.staleFastS),
    staleSlowS: clamp(m.staleSlowS, 0.3, 3, d.staleSlowS),
    watchdogS: clamp(m.watchdogS, 0.1, 5, d.watchdogS),
    seed: Number.isFinite(m.seed) ? Math.floor(m.seed) >>> 0 : d.seed,
  };
}
