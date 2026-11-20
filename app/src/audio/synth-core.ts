/**
 * The sound of Hurricane Brain: a pure, dependency-free DSP core.
 *
 * It renders audio sample by sample from a stream of control values. It runs unchanged inside the
 * AudioWorkletProcessor (worklet.ts) and in unit tests (offline, in Node). Nothing in here reads a
 * clock, a random source or the DOM: given the same settings, controls and render calls, it writes
 * the same samples, bit for bit.
 *
 * Layers (README.md has the binding table):
 *  a. Tracking tones: one per confirmed, locked track. Pitch = measured frequency x 32 exactly,
 *     one-pole glide on log pitch with the declared `pitchTauS`. Loudness from height above
 *     background. Raised-cosine fade out (>= 1 s) when the measurement goes away; the pitch is never
 *     moved toward anything that was not measured.
 *  b. State bed: a fixed, seeded noise carrier whose level and colour move only with alpha power
 *     above background (relative to baseline). Blooms: the measured tones themselves gain a soft
 *     sub-octave pad in a room (golden ratio) or a hollow octave-above pad, dry (octave alignment).
 *     When both states hold at once (`states.both`), a third bloom gathers: the fifth and twelfth
 *     above each member (the 3rd and 6th harmonics of its own sub-octave), deep in the room.
 *  c. Heartbeat: a low, rounded pulse with a smooth envelope on each scheduled measured beat.
 *  d. Breath guide: a slow swell of soft air at the pacer rate. Off by default. Not a measurement.
 *  e. Personal anchors: a small parametric voice, played only on explicit request.
 *  f. Per-layer gains, master gain, a peak leveller and a soft clipper under an absolute ceiling.
 *
 * No binaural, monaural or isochronic entrainment: both output channels carry the same dry signal,
 * the only left/right difference is the decorrelated tail of a static room on bloom and anchor
 * sends, and nothing is amplitude-modulated at a brainwave rate.
 */

import { type AnchorSynthParams, sanitizeAnchor } from './anchors.ts';
import { type AudioSettings, type AudioSettingsPatch, DEFAULT_AUDIO_SETTINGS, mergeSettings } from './settings.ts';

// ---------------------------------------------------------------------------------------------
// Control stream (what the frame binder sends; everything here is already measured or gated)
// ---------------------------------------------------------------------------------------------

export interface VoiceControl {
  /** Track id from the frames. */
  id: number;
  /** True only when the tone has a measurement behind it (confirmed, locked, not artifact, not null). */
  on: boolean;
  /** Measured instantaneous brain frequency, Hz (NOT multiplied). Null when not measured. */
  freqHz: number | null;
  /** Measured height above background, dB. Null when not measured. */
  heightDb: number | null;
  /** Golden ratio bloom target 0..1 for this tone: cascades.phi.excess_a when the state is active and this track is a member, else 0. */
  phi: number;
  /** Octave bloom target 0..1 for this tone: cascades.octave.excess_a likewise. */
  octave: number;
  /** Combined bloom target 0..1: min(phi excess, octave excess) while states.both is active and this track is in either cascade, else 0. */
  both: number;
}

export interface BedControl {
  /** True only when alpha power above background is measured at the bed site. */
  on: boolean;
  /** 0..1: alpha above background relative to baseline, mapped by warmthRangeDb. */
  warmth: number;
  /** Fast-frame artifact flag: thin the bed. */
  artifact: boolean;
}

export interface SynthControl {
  voices: VoiceControl[];
  bed: BedControl;
}

export const SILENT_CONTROL: SynthControl = { voices: [], bed: { on: false, warmth: 0, artifact: false } };

// ---------------------------------------------------------------------------------------------
// Status (for the tap-to-inspect UI and tests)
// ---------------------------------------------------------------------------------------------

export interface VoiceStatus {
  slot: number;
  id: number;
  /** 0..1 presence (raised-cosine fade position). */
  gate: number;
  /** Pitch now sounding and the pitch it is gliding to, Hz. */
  pitchHz: number;
  targetPitchHz: number;
  /** 0..1 loudness from height above background (smoothed). */
  loudness: number;
  phi: number;
  octave: number;
  both: number;
  fadingOut: boolean;
}

export interface SynthStatus {
  timeS: number;
  voices: VoiceStatus[];
  /** Tracks that wanted a voice when all were busy. */
  droppedVoiceIds: number[];
  bed: { gate: number; warmth: number; steadiness: number; thin: number };
  heart: { activePulses: number; pending: number; played: number };
  breath: { gate: number; phase: number; enabled: boolean; bpm: number };
  anchor: { playing: boolean; level: number };
  /** Peak absolute output sample since the previous status call, and the ceiling. */
  peak: number;
  ceiling: number;
  /** Leveller gain reduction in dB (0 = untouched). */
  limiterDb: number;
  /** True when the watchdog has silenced measured layers for lack of control updates. */
  watchdog: boolean;
}

// ---------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------

const TWO_PI = 2 * Math.PI;
const LN2 = Math.LN2;
const LN15 = Math.log(1.5);
const LN3 = Math.log(3);
const SNAP = 1e-9;
const FLUSH = 1e-12;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const dbToAmp = (db: number) => Math.pow(10, db / 20);
/** One-pole coefficient for a time constant in seconds. */
const tauCoef = (tauS: number, sr: number) => 1 - Math.exp(-1 / (tauS * sr));
/** One-pole lowpass coefficient for a cutoff in Hz. */
const lpCoef = (hz: number, sr: number) => 1 - Math.exp((-TWO_PI * hz) / sr);

/**
 * A fade that moves linearly in time over a declared duration and is shaped by a raised cosine,
 * so it starts and ends with zero slope and lands exactly on 0 or 1. Arbitrary levels supported.
 */
class Fade {
  pos = 0;
  target = 0;
  step = 0;
  value = 0;
  setDuration(seconds: number, sr: number): void {
    this.step = 1 / (seconds * sr);
  }
  setLevel(level: number): void {
    const l = clamp01(level);
    this.target = l === 0 ? 0 : l === 1 ? 1 : Math.acos(1 - 2 * l) / Math.PI;
  }
  /** Jump (only used while silent or at construction). */
  reset(level: number): void {
    this.setLevel(level);
    this.pos = this.target;
    this.value = l2v(this.pos);
  }
  tick(): number {
    if (this.pos !== this.target) {
      if (this.pos < this.target) this.pos = Math.min(this.target, this.pos + this.step);
      else this.pos = Math.max(this.target, this.pos - this.step);
      this.value = l2v(this.pos);
    }
    return this.value;
  }
  get idle(): boolean {
    return this.pos === 0 && this.target === 0;
  }
}
const l2v = (pos: number) => (pos === 0 ? 0 : pos === 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * pos));

/** Deterministic xorshift32 white noise in [-1, 1). */
class Noise {
  s: number;
  b0 = 0;
  b1 = 0;
  b2 = 0;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x2545f491;
  }
  white(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 2147483648 - 1;
  }
  /** Pink-ish noise (Kellet's economy filter), RMS about 0.25. */
  pink(w: number): number {
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.11;
  }
}

class Comb {
  buf: Float64Array;
  i = 0;
  store = 0;
  constructor(len: number) {
    this.buf = new Float64Array(Math.max(1, len));
  }
  run(x: number, fb: number, damp: number): number {
    const y = this.buf[this.i];
    let s = y * (1 - damp) + this.store * damp;
    if (s < FLUSH && s > -FLUSH) s = 0;
    this.store = s;
    let w = x + s * fb;
    if (w < FLUSH && w > -FLUSH) w = 0;
    this.buf[this.i] = w;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}

class Allpass {
  buf: Float64Array;
  i = 0;
  constructor(len: number) {
    this.buf = new Float64Array(Math.max(1, len));
  }
  run(x: number): number {
    const b = this.buf[this.i];
    let w = x + b * 0.5;
    if (w < FLUSH && w > -FLUSH) w = 0;
    this.buf[this.i] = w;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

/** A small static stereo room (Schroeder style). Decays to exact zero. */
class Room {
  cl: Comb[];
  cr: Comb[];
  al: Allpass[];
  ar: Allpass[];
  outL = 0;
  outR = 0;
  constructor(sr: number) {
    const k = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491];
    const aps = [556, 441, 341];
    this.cl = combs.map((n) => new Comb(Math.round(n * k)));
    this.cr = combs.map((n) => new Comb(Math.round((n + 23) * k)));
    this.al = aps.map((n) => new Allpass(Math.round(n * k)));
    this.ar = aps.map((n) => new Allpass(Math.round((n + 23) * k)));
  }
  run(x: number): void {
    const fb = 0.84;
    const damp = 0.45;
    const inp = x * 0.03;
    let l = 0;
    let r = 0;
    for (let j = 0; j < this.cl.length; j++) {
      l += this.cl[j].run(inp, fb, damp);
      r += this.cr[j].run(inp, fb, damp);
    }
    for (let j = 0; j < this.al.length; j++) {
      l = this.al[j].run(l);
      r = this.ar[j].run(r);
    }
    this.outL = l;
    this.outR = r;
  }
}

// ---------------------------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------------------------

interface ToneVoice {
  id: number | null;
  gate: Fade;
  logF: number;
  logFTarget: number;
  /** Phase in cycles of the tone, kept in [0, 2) so the sub-octave stays continuous. */
  phase: number;
  loud: number;
  loudTarget: number;
  phi: number;
  phiTarget: number;
  oct: number;
  octTarget: number;
  both: number;
  bothTarget: number;
}

interface Pulse {
  age: number;
  phase: number;
  level: number;
}

interface AnchorVoice {
  p: AnchorSynthParams;
  t: number;
  releaseAt: number | null;
  releaseLevel: number;
  env: number;
  phases: Float64Array;
  freqs: Float64Array;
  amps: Float64Array;
  lp1: number;
  lp2: number;
  hp: number;
  lpA: number;
  hpA: number;
  done: boolean;
}

/** Design levels (amplitude) for each layer at gain 1. Chosen so a busy session sits near -12 dBFS. */
export const LAYER_LEVELS = {
  tone: 0.09,
  bloom: 0.1,
  bed: 0.22,
  heart: 0.26,
  breath: 0.35,
  anchor: 0.14,
} as const;

// ---------------------------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------------------------

export class SynthCore {
  readonly sampleRate: number;
  private s: AudioSettings;
  private n = 0;
  private voices: ToneVoice[] = [];
  private dropped: number[] = [];
  private lastControlN = -1;
  private watchdog = false;
  private lastControl: SynthControl = SILENT_CONTROL;

  // coefficients
  private kPitch = 0;
  private kLoud = 0;
  private kWarm = 0;
  private kSteady = 0;
  private kBloomUp = 0;
  private kBloomDown = 0;
  private kBothUp = 0;
  private retiredId = -1;
  private kGain = 0;
  private rollExp = 0;
  private logRollStart = 0;

  // bed
  private noise: Noise;
  private bedGate = new Fade();
  private thin = new Fade();
  private warm = 0;
  private warmTarget = 0;
  private steady = 0;
  private bedLp1 = 0;
  private bedLp2 = 0;
  private bedHp = 0;
  private bodyLp1 = 0;
  private bodyLp2 = 0;
  private bodyHp = 0;
  private bedA = 0;
  private hpA = 0;
  private bodyA = 0;
  private bodyHpA = 0;

  // heart
  private pending: { at: number; level: number }[] = [];
  private pulses: Pulse[] = [];
  private beatsPlayed = 0;

  // breath
  private breathGate = new Fade();
  private breathPhase = 0;
  private brLp1 = 0;
  private brLp2 = 0;
  private brHp = 0;
  private brA = 0;

  // anchors
  private anchors: AnchorVoice[] = [];

  // mix
  private room: Room;
  private g = { tones: 1, bed: 1, bloom: 1, heart: 1, breath: 1, anchor: 1, master: 1, bPhi: 1, bOct: 1, bBoth: 1 };
  private env = 0;
  private envAtk = 0;
  private envRel = 0;
  private ceiling = 0.5;
  private peak = 0;
  private minGain = 1;

  constructor(sampleRate: number, settings: AudioSettingsPatch = {}) {
    this.sampleRate = sampleRate;
    this.s = mergeSettings(DEFAULT_AUDIO_SETTINGS, settings);
    this.noise = new Noise(this.s.seed * 2654435761);
    this.room = new Room(sampleRate);
    this.thin.reset(1);
    this.applySettings(true);
  }

  get timeS(): number {
    return this.n / this.sampleRate;
  }
  get sampleIndex(): number {
    return this.n;
  }
  get settings(): AudioSettings {
    return this.s;
  }

  setSettings(patch: AudioSettingsPatch): void {
    const wasEnabled = this.s.breathGuide.enabled;
    this.s = mergeSettings(this.s, patch);
    this.applySettings(false);
    if (this.s.breathGuide.enabled && !wasEnabled && this.breathGate.idle) this.breathPhase = 0;
  }

  private applySettings(initial: boolean): void {
    const sr = this.sampleRate;
    const s = this.s;
    this.kPitch = tauCoef(s.pitchTauS, sr);
    this.kLoud = tauCoef(s.toneLoudnessTauS, sr);
    this.kWarm = tauCoef(s.warmthTauS, sr);
    this.kSteady = tauCoef(s.steadyTauS, sr);
    this.kBloomUp = tauCoef(s.bloomTauS, sr);
    this.kBloomDown = tauCoef(s.bloomReleaseTauS, sr);
    this.kBothUp = tauCoef(s.combinedBloomTauS, sr);
    this.kGain = tauCoef(s.gainTauS, sr);
    this.rollExp = s.rolloffDbPerOctave / (20 * Math.log10(2));
    this.logRollStart = Math.log(s.rolloffStartHz);
    this.bedGate.setDuration(s.bedFadeS, sr);
    this.thin.setDuration(s.thinFadeS, sr);
    this.breathGate.setDuration(s.breathFadeS, sr);
    this.breathGate.setLevel(s.breathGuide.enabled ? 1 : 0);
    while (this.voices.length < s.maxVoices) {
      const gate = new Fade();
      this.voices.push({ id: null, gate, logF: 0, logFTarget: 0, phase: 0, loud: 0, loudTarget: 0, phi: 0, phiTarget: 0, oct: 0, octTarget: 0, both: 0, bothTarget: 0 });
    }
    // Voices beyond a reduced maxVoices fade out and are not reused.
    for (let i = s.maxVoices; i < this.voices.length; i++) this.voices[i].gate.setLevel(0);
    for (const v of this.voices) v.gate.setDuration(s.toneFadeS, sr);
    this.hpA = lpCoef(70, sr);
    this.bodyA = lpCoef(240, sr);
    this.bodyHpA = lpCoef(110, sr);
    this.ceiling = dbToAmp(s.ceilingDb);
    this.envAtk = tauCoef(0.002, sr);
    this.envRel = tauCoef(0.4, sr);
    if (initial) {
      const g = s.gains;
      this.g = { ...g, master: dbToAmp(s.masterDb), ...bloomGains(s) };
      this.bedA = lpCoef(1500, sr);
      this.brA = lpCoef(300, sr);
    }
  }

  /** New control targets from the binder. Takes effect smoothly inside render(). */
  setControl(c: SynthControl): void {
    this.lastControlN = this.n;
    this.watchdog = false;
    this.lastControl = c;
    this.applyControl(c);
  }

  private applyControl(c: SynthControl): void {
    const used = new Set<ToneVoice>();
    const active = this.voices.slice(0, this.s.maxVoices);
    this.dropped = [];
    for (const vc of c.voices) {
      let v = this.voices.find((x) => x.id === vc.id);
      const valid = vc.on && vc.freqHz !== null && Number.isFinite(vc.freqHz) && vc.freqHz > 0 && vc.heightDb !== null && Number.isFinite(vc.heightDb);
      if (!v) {
        if (!valid) continue;
        v = active.find((x) => x.id === null);
        if (!v) {
          this.dropped.push(vc.id);
          continue;
        }
        v.id = vc.id;
      }
      used.add(v);
      if (valid) {
        const lf = Math.log((vc.freqHz as number) * this.s.pitchMultiplier);
        if (v.gate.idle) {
          // Silent: start exactly at the measured pitch (no glide from a stale or default pitch).
          v.logF = lf;
          v.phase = 0;
          v.loud = 0;
          v.phi = 0;
          v.oct = 0;
          v.both = 0;
        }
        v.logFTarget = lf;
        const range = this.s.heightFullDb - this.s.heightFloorDb;
        v.loudTarget = clamp01(((vc.heightDb as number) - this.s.heightFloorDb) / range);
        v.phiTarget = clamp01(Number.isFinite(vc.phi) ? vc.phi : 0);
        v.octTarget = clamp01(Number.isFinite(vc.octave) ? vc.octave : 0);
        v.bothTarget = clamp01(Number.isFinite(vc.both) ? vc.both : 0);
        v.gate.setLevel(this.voices.indexOf(v) < this.s.maxVoices ? 1 : 0);
      } else {
        // Measurement gone: fade at the last measured pitch, never move the pitch.
        v.gate.setLevel(0);
        v.phiTarget = 0;
        v.octTarget = 0;
        v.bothTarget = 0;
      }
    }
    for (const v of this.voices) {
      if (v.id !== null && !used.has(v)) {
        v.gate.setLevel(0);
        v.phiTarget = 0;
        v.octTarget = 0;
        v.bothTarget = 0;
      }
    }
    // Bed
    const b = c.bed;
    const bedValid = b.on && Number.isFinite(b.warmth);
    if (bedValid) {
      const w = clamp01(b.warmth);
      if (this.bedGate.idle) {
        this.warm = w;
        this.steady = 0;
      }
      this.warmTarget = w;
      this.bedGate.setLevel(1);
    } else {
      this.bedGate.setLevel(0);
    }
    this.thin.setLevel(b.artifact ? this.s.thinLevel : 1);
  }

  /**
   * A new session starts (explicit, or the binder saw session time jump backwards). Everything
   * measured from the previous session fades out over its own declared fade and is never reused:
   * old voices are retired (a new session's track ids cannot pick them up), the bed fades, pending
   * beats are cleared. Anchors and the breath guide are not measurements and are left alone.
   */
  newSession(): void {
    for (const v of this.voices) {
      if (v.id === null) continue;
      v.id = this.retiredId--;
      v.gate.setLevel(0);
      v.phiTarget = 0;
      v.octTarget = 0;
      v.bothTarget = 0;
    }
    this.bedGate.setLevel(0);
    this.thin.setLevel(1);
    this.pending = [];
    this.lastControl = SILENT_CONTROL;
    this.lastControlN = this.n;
    this.watchdog = false;
  }

  /**
   * Schedule a measured heartbeat at core time `atS` (seconds). Beats in the past play now.
   * The caller (binder) has already applied the declared latency and dropped beats that are too late.
   */
  scheduleBeat(atS: number, flagged = false): void {
    if (!Number.isFinite(atS)) return;
    const at = Math.max(this.n, Math.round(atS * this.sampleRate));
    const level = flagged ? this.s.heartFlaggedLevel : 1;
    if (level <= 0) return;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].at > at) i--;
    this.pending.splice(i, 0, { at, level });
    if (this.pending.length > 16) this.pending.splice(0, this.pending.length - 16);
  }

  /** Play an anchor now (or at core time `atS`). A playing anchor is released smoothly. */
  playAnchor(params: AnchorSynthParams): void {
    const p = sanitizeAnchor(params);
    this.stopAnchor();
    const freqs: number[] = [];
    const ratios = p.intervals;
    for (let i = 0; i < ratios.length; i++) for (let k = 1; k <= 4; k++) freqs.push(p.basePitchHz * ratios[i] * k);
    const geo = Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length);
    const centre = p.basePitchHz * geo * (1 + p.brightness);
    this.anchors.push({
      p,
      t: 0,
      releaseAt: null,
      releaseLevel: 0,
      env: 0,
      phases: new Float64Array(freqs.length),
      freqs: Float64Array.from(freqs),
      amps: new Float64Array(freqs.length),
      lp1: 0,
      lp2: 0,
      hp: 0,
      lpA: lpCoef(centre * 1.5, this.sampleRate),
      hpA: lpCoef(centre * 0.6, this.sampleRate),
      done: false,
    });
    if (this.anchors.length > 3) this.anchors.splice(0, this.anchors.length - 3);
  }

  /** Release any playing anchor over its own release time. */
  stopAnchor(): void {
    for (const a of this.anchors) {
      if (a.releaseAt === null) {
        a.releaseAt = a.t;
        a.releaseLevel = a.env;
      }
    }
  }

  status(): SynthStatus {
    const out: VoiceStatus[] = [];
    this.voices.forEach((v, slot) => {
      if (v.id === null) return;
      out.push({
        slot,
        id: v.id,
        gate: v.gate.value,
        pitchHz: Math.exp(v.logF),
        targetPitchHz: Math.exp(v.logFTarget),
        loudness: v.loud,
        phi: v.phi,
        octave: v.oct,
        both: v.both,
        fadingOut: v.gate.target === 0,
      });
    });
    const peak = this.peak;
    this.peak = 0;
    const minGain = this.minGain;
    this.minGain = 1;
    const anchorLevel = this.anchors.reduce((m, a) => Math.max(m, a.env), 0);
    return {
      timeS: this.timeS,
      voices: out,
      droppedVoiceIds: [...this.dropped],
      bed: { gate: this.bedGate.value, warmth: this.warm, steadiness: this.steady, thin: this.thin.value },
      heart: { activePulses: this.pulses.length, pending: this.pending.length, played: this.beatsPlayed },
      breath: { gate: this.breathGate.value, phase: this.breathPhase, enabled: this.s.breathGuide.enabled, bpm: this.s.breathGuide.bpm },
      anchor: { playing: this.anchors.length > 0, level: anchorLevel },
      peak,
      ceiling: this.ceiling,
      limiterDb: 20 * Math.log10(minGain),
      watchdog: this.watchdog,
    };
  }

  /**
   * Render `count` samples into `left` (and `right`, if given) starting at `offset`.
   * Overwrites the buffers.
   */
  render(left: Float32Array, right?: Float32Array | null, offset = 0, count = left.length - offset): void {
    const sr = this.sampleRate;
    const s = this.s;
    const inv = 1 / sr;
    const end = offset + count;

    // Watchdog: with no control update for watchdogS, every measured layer fades.
    if (!this.watchdog && this.n - this.lastControlN > s.watchdogS * sr) {
      this.watchdog = true;
      this.applyControl({
        voices: this.lastControl.voices.map((v) => ({ ...v, on: false })),
        bed: { on: false, warmth: 0, artifact: false },
      });
    }

    const voices = this.voices;
    const h2 = s.toneHarmonic2;
    const rollExp = this.rollExp;
    const lrs = this.logRollStart;
    const kPitch = this.kPitch;
    const kLoud = this.kLoud;
    const kGain = this.kGain;
    const tg = s.gains;
    const masterT = dbToAmp(s.masterDb);
    const bloomT = bloomGains(s);
    const ceiling = this.ceiling;
    const thr = ceiling * 0.8;
    const knee = ceiling * 0.6;
    const breathRate = s.breathGuide.bpm / 60 / sr;
    const pulseLen = s.heartPulseS * sr;
    const pulseAtk = 0.04 * sr;
    const hf0 = s.heartPitchHz;

    for (let i = offset; i < end; i++) {
      // ---- gains (smoothed) ----
      const g = this.g;
      g.tones += (tg.tones - g.tones) * kGain;
      g.bed += (tg.bed - g.bed) * kGain;
      g.bloom += (tg.bloom - g.bloom) * kGain;
      g.heart += (tg.heart - g.heart) * kGain;
      g.breath += (tg.breath - g.breath) * kGain;
      g.anchor += (tg.anchor - g.anchor) * kGain;
      g.master += (masterT - g.master) * kGain;
      g.bPhi += (bloomT.bPhi - g.bPhi) * kGain;
      g.bOct += (bloomT.bOct - g.bOct) * kGain;
      g.bBoth += (bloomT.bBoth - g.bBoth) * kGain;
      if (g.bPhi < SNAP && bloomT.bPhi === 0) g.bPhi = 0;
      if (g.bOct < SNAP && bloomT.bOct === 0) g.bOct = 0;
      if (g.bBoth < SNAP && bloomT.bBoth === 0) g.bBoth = 0;

      let dry = 0;
      let send = 0;

      // ---- a + b(blooms): tracking tones ----
      for (let vi = 0; vi < voices.length; vi++) {
        const v = voices[vi];
        if (v.id === null) continue;
        const gate = v.gate.tick();
        if (v.gate.idle) {
          // Fully faded: release the slot. Nothing about it is kept.
          v.id = null;
          v.phi = 0;
          v.oct = 0;
          v.both = 0;
          continue;
        }
        v.logF += (v.logFTarget - v.logF) * kPitch;
        v.loud += (v.loudTarget - v.loud) * kLoud;
        v.phi += (v.phiTarget - v.phi) * (v.phiTarget > v.phi ? this.kBloomUp : this.kBloomDown);
        v.oct += (v.octTarget - v.oct) * (v.octTarget > v.oct ? this.kBloomUp : this.kBloomDown);
        if (v.phi < SNAP && v.phiTarget === 0) v.phi = 0;
        if (v.oct < SNAP && v.octTarget === 0) v.oct = 0;
        v.both += (v.bothTarget - v.both) * (v.bothTarget > v.both ? this.kBothUp : this.kBloomDown);
        if (v.both < SNAP && v.bothTarget === 0) v.both = 0;
        const f = Math.exp(v.logF);
        v.phase += f * inv;
        if (v.phase >= 2) v.phase -= 2;
        const over = v.logF - lrs;
        const r1 = over > 0 ? Math.exp(-rollExp * over) : 1;
        const over2 = over + LN2;
        const r2 = over2 > 0 ? Math.exp(-rollExp * over2) : 1;
        const over4 = over + 2 * LN2;
        const r4 = over4 > 0 ? Math.exp(-rollExp * over4) : 1;
        const p = TWO_PI * v.phase;
        const s1 = Math.sin(p);
        const s2 = Math.sin(2 * p);
        const amp = gate * v.loud;
        dry += g.tones * LAYER_LEVELS.tone * amp * (r1 * s1 + h2 * r2 * s2);
        if (v.phi > 0 || v.oct > 0 || v.both > 0) {
          const bl = g.bloom * LAYER_LEVELS.bloom * amp;
          // Golden ratio bloom: the measured tone and its own sub-octave, into the room.
          const sub = Math.sin(0.5 * p);
          const phiPad = bl * g.bPhi * v.phi * (0.6 * sub + 0.35 * r1 * s1);
          // Octave bloom: hollow upper octaves of the same tone, dry and close.
          const octPad = bl * g.bOct * v.oct * (0.55 * r2 * s2 + 0.3 * r4 * Math.sin(4 * p));
          dry += 0.35 * phiPad + 0.9 * octPad;
          send += 1.0 * phiPad + 0.15 * octPad;
          if (v.both > 0) {
            // Combined bloom: the fifth (1.5x) and twelfth (3x) above the tone, i.e. the 3rd and
            // 6th harmonics of its own sub-octave (phase-locked, no beating), mostly in the room.
            const over15 = over + LN15;
            const r15 = over15 > 0 ? Math.exp(-rollExp * over15) : 1;
            const over3 = over + LN3;
            const r3 = over3 > 0 ? Math.exp(-rollExp * over3) : 1;
            const bothPad = bl * g.bBoth * v.both * (0.5 * r15 * Math.sin(1.5 * p) + 0.22 * r3 * Math.sin(3 * p));
            dry += 0.3 * bothPad;
            send += 1.4 * bothPad;
          }
        }
      }

      // ---- shared noise ----
      const w = this.noise.white();
      const pink = this.noise.pink(w);

      // ---- b: state bed ----
      const bedG = this.bedGate.tick();
      const thin = this.thin.tick();
      if (bedG > 0) {
        this.warm += (this.warmTarget - this.warm) * this.kWarm;
        this.steady += (this.warmTarget - this.steady) * this.kSteady;
        if ((i & 31) === 0) {
          // Colour: cutoff falls from 1500 Hz (cool, airy) to 380 Hz (warm) as warmth rises.
          this.bedA = lpCoef(1500 * Math.pow(380 / 1500, this.warm), sr);
        }
      }
      this.bedLp1 += (pink - this.bedLp1) * this.bedA;
      this.bedLp2 += (this.bedLp1 - this.bedLp2) * this.bedA;
      this.bedHp += (this.bedLp2 - this.bedHp) * this.hpA;
      this.bodyLp1 += (pink - this.bodyLp1) * this.bodyA;
      this.bodyLp2 += (this.bodyLp1 - this.bodyLp2) * this.bodyA;
      this.bodyHp += (this.bodyLp2 - this.bodyHp) * this.bodyHpA;
      if (bedG > 0) {
        const airy = this.bedLp2 - this.bedHp;
        const body = this.bodyLp2 - this.bodyHp;
        const lvl = g.bed * LAYER_LEVELS.bed * bedG * thin;
        dry += lvl * ((0.55 + 0.9 * this.warm) * airy + 2.4 * this.steady * body);
      }

      // ---- c: heartbeat ----
      while (this.pending.length > 0 && this.pending[0].at <= this.n) {
        const b = this.pending.shift() as { at: number; level: number };
        if (this.pulses.length < 3) this.pulses.push({ age: 0, phase: 0, level: b.level });
        this.beatsPlayed++;
      }
      for (let k = this.pulses.length - 1; k >= 0; k--) {
        const pu = this.pulses[k];
        if (pu.age >= pulseLen) {
          this.pulses.splice(k, 1);
          continue;
        }
        let e: number;
        if (pu.age < pulseAtk) e = 0.5 - 0.5 * Math.cos((Math.PI * pu.age) / pulseAtk);
        else {
          const c = 0.5 + 0.5 * Math.cos((Math.PI * (pu.age - pulseAtk)) / (pulseLen - pulseAtk));
          e = c * c;
        }
        const f = hf0 * (1 - 0.2 * (pu.age / pulseLen));
        pu.phase += f * inv;
        if (pu.phase >= 1) pu.phase -= 1;
        const ph = TWO_PI * pu.phase;
        dry += g.heart * LAYER_LEVELS.heart * pu.level * e * (Math.sin(ph) + 0.3 * Math.sin(2 * ph));
        pu.age++;
      }

      // ---- d: breath guide (not a measurement) ----
      const brG = this.breathGate.tick();
      if (brG > 0) {
        this.breathPhase += breathRate;
        if (this.breathPhase >= 1) this.breathPhase -= 1;
        const a = 0.5 - 0.5 * Math.cos(TWO_PI * this.breathPhase);
        if ((i & 31) === 0) this.brA = lpCoef(260 + 700 * a, sr);
        this.brLp1 += (pink - this.brLp1) * this.brA;
        this.brLp2 += (this.brLp1 - this.brLp2) * this.brA;
        this.brHp += (this.brLp2 - this.brHp) * this.hpA;
        dry += g.breath * LAYER_LEVELS.breath * brG * a * (this.brLp2 - this.brHp);
      } else if (this.breathGate.idle && this.s.breathGuide.enabled === false) {
        this.breathPhase = 0;
      }

      // ---- e: anchors ----
      for (let k = this.anchors.length - 1; k >= 0; k--) {
        const an = this.anchors[k];
        const out = this.renderAnchor(an, pink);
        if (an.done) {
          this.anchors.splice(k, 1);
          continue;
        }
        const lvl = g.anchor * LAYER_LEVELS.anchor * an.p.level;
        dry += lvl * out;
        send += lvl * out * an.p.space * 0.8;
      }

      // ---- room ----
      this.room.run(send);

      // ---- f: master, leveller, soft clip under the ceiling ----
      let l = (dry + this.room.outL) * g.master;
      let r = (dry + this.room.outR) * g.master;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.env += (pk - this.env) * (pk > this.env ? this.envAtk : this.envRel);
      if (this.env < FLUSH) this.env = 0;
      if (this.env > thr) {
        const gr = thr / this.env;
        l *= gr;
        r *= gr;
        if (gr < this.minGain) this.minGain = gr;
      }
      l = softClip(l, knee, ceiling);
      r = softClip(r, knee, ceiling);
      const ap = Math.max(Math.abs(l), Math.abs(r));
      if (ap > this.peak) this.peak = ap;
      left[i] = l;
      if (right) right[i] = r;
      this.n++;
    }
  }

  private renderAnchor(an: AnchorVoice, pink: number): number {
    const sr = this.sampleRate;
    const p = an.p;
    const tS = an.t / sr;
    // Envelope: raised-cosine attack, hold, raised-cosine release (from wherever it was).
    let env: number;
    if (an.releaseAt !== null) {
      const u = (an.t - an.releaseAt) / (p.releaseS * sr);
      if (u >= 1) {
        an.done = true;
        an.env = 0;
        return 0;
      }
      env = an.releaseLevel * (0.5 + 0.5 * Math.cos(Math.PI * u));
    } else if (tS < p.attackS) env = 0.5 - 0.5 * Math.cos((Math.PI * tS) / p.attackS);
    else if (tS < p.attackS + p.sustainS) env = 1;
    else {
      an.releaseAt = an.t;
      an.releaseLevel = 1;
      env = 1;
    }
    an.env = env;
    if ((an.t & 63) === 0) {
      const n = p.intervals.length;
      const tilt = 3.2 - 2.4 * p.brightness;
      for (let j = 0; j < an.freqs.length; j++) {
        const voice = Math.floor(j / 4);
        const k = (j % 4) + 1;
        const f = an.freqs[j];
        const roll = f > this.s.rolloffStartHz ? Math.pow(this.s.rolloffStartHz / f, this.rollExp) : 1;
        const motion = k > 1 ? 1 + p.motionDepth * Math.sin(TWO_PI * p.motionRateHz * tS + 1.7 * voice + 0.9 * k) : 1;
        an.amps[j] = (Math.pow(k, -tilt) * motion * roll) / (1.3 * Math.sqrt(n));
      }
    }
    let tonal = 0;
    if (p.noise < 1) {
      const inv = 1 / sr;
      for (let j = 0; j < an.freqs.length; j++) {
        let ph = an.phases[j] + an.freqs[j] * inv;
        if (ph >= 1) ph -= 1;
        an.phases[j] = ph;
        tonal += an.amps[j] * Math.sin(TWO_PI * ph);
      }
    }
    an.lp1 += (pink - an.lp1) * an.lpA;
    an.lp2 += (an.lp1 - an.lp2) * an.lpA;
    an.hp += (an.lp2 - an.hp) * an.hpA;
    const air = (an.lp2 - an.hp) * 10.8;
    an.t++;
    return env * ((1 - p.noise) * tonal + p.noise * air);
  }
}

function bloomGains(s: AudioSettings): { bPhi: number; bOct: number; bBoth: number } {
  const b = s.blooms;
  return { bPhi: b.phi.on ? b.phi.level : 0, bOct: b.octave.on ? b.octave.level : 0, bBoth: b.both.on ? b.both.level : 0 };
}

/** Linear below the knee, then a smooth tanh shoulder that approaches but never reaches the ceiling. */
export function softClip(x: number, knee: number, ceiling: number): number {
  const a = Math.abs(x);
  if (a <= knee) return x;
  const room = ceiling - knee;
  const y = knee + room * Math.tanh((a - knee) / room);
  // tanh rounds to 1 for very large inputs in floating point; keep strictly at or under the ceiling.
  // The small margin also survives rounding to Float32 in the output buffer.
  const c = Math.min(y, ceiling * 0.99999);
  return x < 0 ? -c : c;
}
