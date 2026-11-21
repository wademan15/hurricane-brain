/**
 * The binding table (spec 9.1) as code: frames in, synth controls out, plus a trace of exactly
 * which frame field and value is driving every sound element.
 *
 * Pure and deterministic: the caller supplies the core's current time with each frame. Live, that
 * is AudioContext.currentTime; offline (tests, replay renders), it is the frame time itself.
 *
 * Reads only SlowFrame, FastFrame and HeartFrame fields named in the binding table. Computes no
 * private measurement: the only arithmetic is the declared mapping (x32, dB to 0..1, baseline
 * subtraction) and freshness checks.
 */

import type { FastFrame, Frame, HeartFrame, Measured, Reason, SlowFrame, Track } from '../engine/frames.ts';
import { type AudioSettings, type AudioSettingsPatch, DEFAULT_AUDIO_SETTINGS, mergeSettings } from './settings.ts';
import type { SynthControl, VoiceControl } from './synth-core.ts';

/** The person's resting baseline for the bed's driving field (from a baseline block, spec 12). */
export interface AudioBaseline {
  /** Mean of alpha above_bg_db at the bed site over the baseline block, dB. */
  alphaAboveBgDbMean: number;
  /** Its spread, dB (informational; the mapping uses warmthRangeDb). */
  alphaAboveBgDbSd?: number | null;
}

export interface ScheduledBeat {
  /** Core time to play, seconds. */
  atS: number;
  /** Beat.t on the session clock. */
  t: number;
  flagged: boolean;
}

/** One line of the tap-to-inspect panel: a sound element and the field driving it. */
export interface BindingTrace {
  element: 'tone' | 'bloom_phi' | 'bloom_octave' | 'bloom_both' | 'bed' | 'bed_thin' | 'heart' | 'breath_guide' | 'anchor';
  /** Track id for tones and blooms. */
  trackId?: number;
  /** Is this element being asked to sound right now? */
  on: boolean;
  /** Frame fields and values behind it, e.g. { 'fast.tracks[id=2].freq.v': 10.21 }. */
  fields: Record<string, number | string | boolean | null>;
  /** What the sound does with it, e.g. "pitch 326.72 Hz = 10.21 Hz x 32". */
  mapping: string;
  /** Declared smoothing, e.g. "pitch one-pole tau 150 ms". */
  smoothing: string;
  /** When off, why (a Reason from the frames, or a binder reason). */
  why: Reason | 'stale' | 'unconfirmed' | 'unlocked' | 'state_inactive' | 'not_member' | 'disabled' | 'no_source' | 'muted' | 'ok';
}

export interface BinderOutput {
  control: SynthControl;
  beats: ScheduledBeat[];
  /**
   * True when this frame started a new session (session time jumped backwards by more than
   * `sessionJumpS`). The caller must call `SynthCore.newSession()` before applying `control`.
   */
  reset: boolean;
}

/** Composite sites and the channels they contain. */
const COMPOSITES: Record<string, string[]> = {
  temporal: ['TP9', 'TP10', 'temporal'],
  frontal: ['AF7', 'AF8', 'Fpz', 'frontal'],
};

/** Does a track followed at `trackSite` count for the bound `site`? */
function siteMatches(site: string, trackSite: string): boolean {
  if (site === 'all' || trackSite === site) return true;
  return (COMPOSITES[site] ?? []).includes(trackSite);
}

const CLOCK_WINDOW = 320; // ~10 s of fast frames

const num = (m: Measured | undefined | null): number | null =>
  m && m.v !== null && m.v !== undefined && Number.isFinite(m.v) ? m.v : null;
const ms = (s: number) => `${Math.round(s * 1000)} ms`;

export class FrameBinder {
  private s: AudioSettings;
  private baseline: AudioBaseline | null = null;
  private slow: SlowFrame | null = null;
  private fast: FastFrame | null = null;
  private heart: HeartFrame | null = null;
  private latestT = -Infinity;
  private offsets: number[] = [];
  private lastBeatT = -Infinity;
  private dropped = 0;
  private traces: BindingTrace[] = [];
  private lastBeat: ScheduledBeat | null = null;

  constructor(settings: AudioSettingsPatch = {}) {
    this.s = mergeSettings(DEFAULT_AUDIO_SETTINGS, settings);
  }

  setSettings(patch: AudioSettingsPatch): void {
    this.s = mergeSettings(this.s, patch);
  }
  get settings(): AudioSettings {
    return this.s;
  }

  setBaseline(b: AudioBaseline | null): void {
    this.baseline = b && Number.isFinite(b.alphaAboveBgDbMean) ? { ...b } : null;
  }

  get droppedLateBeats(): number {
    return this.dropped;
  }

  /** Session-clock to core-clock offset in use (seconds), or null before any frame. */
  get clockOffsetS(): number | null {
    return this.offsets.length ? Math.min(...this.offsets) : null;
  }

  /**
   * Forget everything about the previous session: frames, clock mapping, beat history, traces.
   * The baseline and settings are kept. Pair with `SynthCore.newSession()` (AudioEngine does).
   */
  reset(): void {
    this.slow = null;
    this.fast = null;
    this.heart = null;
    this.latestT = -Infinity;
    this.offsets = [];
    this.lastBeatT = -Infinity;
    this.dropped = 0;
    this.traces = [];
    this.lastBeat = null;
  }

  /** Feed one frame. `coreNowS` is the audio core's current time in seconds. */
  handleFrame(frame: Frame, coreNowS: number): BinderOutput {
    let reset = false;
    if (Number.isFinite(frame.t) && frame.t < this.latestT - this.s.sessionJumpS) {
      // Session time went backwards: a new session in the same page. Start clean.
      this.reset();
      reset = true;
    }
    if (Number.isFinite(frame.t)) {
      this.latestT = Math.max(this.latestT, frame.t);
      this.offsets.push(coreNowS - frame.t);
      if (this.offsets.length > CLOCK_WINDOW) this.offsets.shift();
    }
    const beats: ScheduledBeat[] = [];
    if (frame.kind === 'slow') this.slow = frame;
    else if (frame.kind === 'fast') this.fast = frame;
    else {
      this.heart = frame;
      this.scheduleBeats(frame, coreNowS, beats);
    }
    return { control: this.build(), beats, reset };
  }

  /** Latest trace for each sound element (for getDebug). */
  traceAll(): BindingTrace[] {
    return this.traces;
  }

  private scheduleBeats(h: HeartFrame, coreNowS: number, out: ScheduledBeat[]): void {
    if (h.source === 'none') return;
    const offset = this.clockOffsetS ?? coreNowS - h.t;
    for (const b of h.beats) {
      if (!Number.isFinite(b.t) || b.t <= this.lastBeatT) continue;
      this.lastBeatT = b.t;
      const atS = b.t + offset + this.s.heartLatencyS;
      if (atS < coreNowS - this.s.heartLateToleranceS) {
        this.dropped++;
        continue;
      }
      const sb = { atS: Math.max(atS, coreNowS), t: b.t, flagged: b.flagged };
      out.push(sb);
      this.lastBeat = sb;
    }
  }

  private build(): SynthControl {
    const s = this.s;
    const traces: BindingTrace[] = [];
    const now = this.latestT;
    const slow = this.slow && now - this.slow.t <= s.staleSlowS ? this.slow : null;
    const fast = this.fast && now - this.fast.t <= s.staleFastS ? this.fast : null;

    const slowTracks = new Map<number, Track>();
    if (slow) for (const t of slow.tracks) slowTracks.set(t.id, t);

    const phi = slow ? slow.cascades.phi : null;
    const oct = slow ? slow.cascades.octave : null;
    const phiActive = !!slow && slow.states.phi.active;
    const octActive = !!slow && slow.states.octave.active;
    const bothActive = !!slow && !!slow.states.both && slow.states.both.active === true;
    const ex = s.bloomChance === 'b' ? 'excess_b' : 'excess_a';
    const phiExcess = num(phi?.[ex]);
    const octExcess = num(oct?.[ex]);
    const bothExcess = phiExcess !== null && octExcess !== null ? Math.min(phiExcess, octExcess) : null;
    const bl = s.blooms;

    // ---- tones ----
    const voices: VoiceControl[] = [];
    const tracks = fast ? fast.tracks : this.fast ? this.fast.tracks : [];
    for (const ft of tracks) {
      const st = slowTracks.get(ft.id);
      const freq = fast ? num(ft.freq) : null;
      const height = fast ? num(ft.height_db) : null;
      let why: BindingTrace['why'] = 'ok';
      if (!fast) why = 'stale';
      else if (fast.artifact) why = 'artifact';
      else if (!st) why = slow ? 'not_confirmed' : 'stale';
      else if (st.state !== 'confirmed') why = 'unconfirmed';
      else if (!ft.locked) why = 'unlocked';
      else if (freq === null) why = ft.freq.why === 'ok' ? 'no_data' : ft.freq.why;
      else if (freq <= 0 || freq > 100) why = 'unresolved';
      else if (height === null) why = ft.height_db.why === 'ok' ? 'no_data' : ft.height_db.why;
      const on = why === 'ok';
      const isPhi = !!phi && phi.tracks.includes(ft.id);
      const isOct = !!oct && oct.tracks.includes(ft.id);
      const phiT = on && phiActive && isPhi && phiExcess !== null ? phiExcess : 0;
      const octT = on && octActive && isOct && octExcess !== null ? octExcess : 0;
      const bothT = on && bothActive && (isPhi || isOct) && bothExcess !== null ? bothExcess : 0;
      voices.push({ id: ft.id, on, freqHz: on ? freq : null, heightDb: on ? height : null, phi: phiT, octave: octT, both: bothT });

      const base = `fast.tracks[id=${ft.id}]`;
      traces.push({
        element: 'tone',
        trackId: ft.id,
        on,
        fields: {
          [`${base}.freq.v`]: freq,
          [`${base}.height_db.v`]: height,
          [`${base}.locked`]: ft.locked,
          [`slow.tracks[id=${ft.id}].state`]: st ? st.state : null,
          'fast.artifact': fast ? fast.artifact : null,
          [`${base}.delay_s`]: ft.delay_s,
        },
        mapping: on
          ? `pitch ${((freq as number) * 32).toFixed(2)} Hz = ${(freq as number).toFixed(3)} Hz x 32; loudness ${(clamp01(((height as number) - s.heightFloorDb) / (s.heightFullDb - s.heightFloorDb)) * 100).toFixed(0)}% from ${(height as number).toFixed(1)} dB (floor ${s.heightFloorDb}, full ${s.heightFullDb})`
          : `fading out over ${s.toneFadeS} s at its last measured pitch`,
        smoothing: `pitch one-pole tau ${ms(s.pitchTauS)}; loudness one-pole tau ${ms(s.toneLoudnessTauS)}; presence fade ${s.toneFadeS} s`,
        why,
      });
      const exWhy = (c: typeof phi) => (c ? c[ex].why : 'no_data');
      const muteNote = (m: boolean) => (m ? '' : ' (MUTED in settings)');
      if (isPhi || phiActive) {
        traces.push({
          element: 'bloom_phi',
          trackId: ft.id,
          on: phiT > 0 && bl.phi.on,
          fields: { 'slow.states.phi.active': phiActive, [`slow.cascades.phi.${ex}.v`]: phiExcess, 'slow.cascades.phi.tracks': phi ? phi.tracks.join(',') : null },
          mapping: `sub-octave pad of this tone in the room, level ${phiT.toFixed(2)} x tone loudness x ${bl.phi.level}${muteNote(bl.phi.on)}`,
          smoothing: `one-pole tau ${s.bloomTauS} s rising, ${s.bloomReleaseTauS} s thinning`,
          why: !on ? why : !phiActive ? 'state_inactive' : !isPhi ? 'not_member' : phiExcess === null ? exWhy(phi) : !bl.phi.on ? 'muted' : 'ok',
        });
      }
      if (isOct || octActive) {
        traces.push({
          element: 'bloom_octave',
          trackId: ft.id,
          on: octT > 0 && bl.octave.on,
          fields: { 'slow.states.octave.active': octActive, [`slow.cascades.octave.${ex}.v`]: octExcess, 'slow.cascades.octave.tracks': oct ? oct.tracks.join(',') : null },
          mapping: `hollow upper-octave pad of this tone, dry, level ${octT.toFixed(2)} x tone loudness x ${bl.octave.level}${muteNote(bl.octave.on)}`,
          smoothing: `one-pole tau ${s.bloomTauS} s rising, ${s.bloomReleaseTauS} s thinning`,
          why: !on ? why : !octActive ? 'state_inactive' : !isOct ? 'not_member' : octExcess === null ? exWhy(oct) : !bl.octave.on ? 'muted' : 'ok',
        });
      }
      if (bothActive && (isPhi || isOct)) {
        traces.push({
          element: 'bloom_both',
          trackId: ft.id,
          on: bothT > 0 && bl.both.on,
          fields: {
            'slow.states.both.active': bothActive,
            [`slow.cascades.phi.${ex}.v`]: phiExcess,
            [`slow.cascades.octave.${ex}.v`]: octExcess,
          },
          mapping: `combined bloom: fifth and twelfth above this tone, deep in the room, level min(phi, octave) = ${bothT.toFixed(2)} x tone loudness x ${bl.both.level}${muteNote(bl.both.on)}`,
          smoothing: `one-pole tau ${s.combinedBloomTauS} s rising, ${s.bloomReleaseTauS} s thinning`,
          why: !on ? why : bothExcess === null ? (phiExcess === null ? exWhy(phi) : exWhy(oct)) : !bl.both.on ? 'muted' : 'ok',
        });
      }
    }

    // ---- bed ----
    const spec = slow ? slow.spectra.find((x) => x.site === s.bedSite) : undefined;
    const alpha = spec ? num(spec.bands.alpha.above_bg_db) : null;
    const ref = this.baseline ? this.baseline.alphaAboveBgDbMean : 0;
    const warmth = alpha !== null ? clamp01((alpha - ref) / s.warmthRangeDb) : 0;
    const artifact = !!fast && fast.artifact;
    // The bed needs a confirmed alpha peak at the bound site: a measurable band power alone is
    // not a rhythm (CLAUDE.md rule 2). Confirmed or in its hold time ('fading') both count.
    const alphaTrack = slow
      ? slow.tracks.find((t) => t.band === 'alpha' && (t.state === 'confirmed' || t.state === 'fading') && siteMatches(s.bedSite, t.site))
      : undefined;
    const bedOn = alpha !== null && alphaTrack !== undefined;
    traces.push({
      element: 'bed',
      on: bedOn,
      fields: {
        [`slow.spectra[site=${s.bedSite}].bands.alpha.above_bg_db.v`]: alpha,
        'slow.tracks[band=alpha].id': alphaTrack ? alphaTrack.id : null,
        'slow.tracks[band=alpha].state': alphaTrack ? alphaTrack.state : null,
        'baseline.alphaAboveBgDbMean': this.baseline ? this.baseline.alphaAboveBgDbMean : null,
      },
      mapping: bedOn
        ? `warmth ${(warmth * 100).toFixed(0)}% = (${alpha!.toFixed(2)} - ${ref.toFixed(2)} dB) / ${s.warmthRangeDb} dB${this.baseline ? '' : ' (no baseline set: relative to background)'}`
        : `fading out over ${s.bedFadeS} s`,
      smoothing: `warmth one-pole tau ${s.warmthTauS} s; steadiness (hold) tau ${s.steadyTauS} s; presence fade ${s.bedFadeS} s`,
      why: bedOn ? 'ok' : !slow ? 'stale' : !spec ? 'no_data' : alpha === null ? spec.bands.alpha.above_bg_db.why : 'not_confirmed',
    });
    traces.push({
      element: 'bed_thin',
      on: artifact,
      fields: { 'fast.artifact': fast ? fast.artifact : null },
      mapping: artifact ? `bed thinned to ${Math.round(s.thinLevel * 100)}%` : 'bed at full',
      smoothing: `raised-cosine fade ${s.thinFadeS} s`,
      why: fast ? 'ok' : 'stale',
    });

    // ---- heart ----
    const h = this.heart;
    traces.push({
      element: 'heart',
      on: !!h && h.source !== 'none',
      fields: {
        'heart.source': h ? h.source : null,
        'heart.beats[last].t': this.lastBeat ? this.lastBeat.t : null,
        'heart.beats[last].flagged': this.lastBeat ? this.lastBeat.flagged : null,
        'heart.hr_bpm.v': h ? num(h.hr_bpm) : null,
        droppedLateBeats: this.dropped,
      },
      mapping: 'one low rounded pulse per measured beat',
      smoothing: `fixed latency ${ms(s.heartLatencyS)} after Beat.t; late beats beyond ${ms(s.heartLateToleranceS)} are dropped`,
      why: !h ? 'no_data' : h.source === 'none' ? 'no_source' : 'ok',
    });

    // ---- breath guide (labelled: not a measurement) ----
    traces.push({
      element: 'breath_guide',
      on: s.breathGuide.enabled,
      fields: { 'settings.breathGuide.bpm': s.breathGuide.bpm, 'settings.breathGuide.enabled': s.breathGuide.enabled },
      mapping: 'GUIDE, NOT A MEASUREMENT: slow swell at the pacer rate',
      smoothing: `on/off fade ${s.breathFadeS} s`,
      why: s.breathGuide.enabled ? 'ok' : 'disabled',
    });

    this.traces = traces;
    return { voices, bed: { on: bedOn, warmth, artifact } };
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
