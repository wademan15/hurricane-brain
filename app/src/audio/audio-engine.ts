/**
 * Main-thread audio engine. Owns the AudioContext and the worklet node, runs the frame binder,
 * and keeps the debug snapshot for the tap-to-inspect UI.
 *
 *   const audio = new AudioEngine();
 *   button.onclick = () => audio.start();       // must be called from a user gesture
 *   engineWorker.onFrames = (fs) => fs.forEach((f) => audio.handleFrame(f));
 *   audio.setBaseline({ alphaAboveBgDbMean: 3.1 });
 *   audio.getDebug();                           // every sounding voice and the field driving it
 *
 * The worklet module is bundled by Vite through the `?worker&url` suffix (see README, "Worklet
 * loading"), so the worklet can import the shared core.
 */

import type { Frame } from '../engine/frames.ts';
import type { AnchorSynthParams } from './anchors.ts';
import { type AudioBaseline, type BindingTrace, FrameBinder } from './bindings.ts';
import { type FromWorklet, PROCESSOR_NAME, type ToWorklet, type WorkletOptions } from './messages.ts';
import { type AudioSettings, type AudioSettingsPatch, DEFAULT_AUDIO_SETTINGS, mergeSettings } from './settings.ts';
import type { SynthStatus, VoiceStatus } from './synth-core.ts';
import workletUrl from './worklet.ts?worker&url';

export interface SoundingVoice {
  element: BindingTrace['element'];
  trackId?: number;
  /** Current level 0..1 of this element's presence (from the worklet). */
  level: number;
  /** For tones: the pitch now sounding and its target, Hz. */
  pitchHz?: number;
  targetPitchHz?: number;
  fields: BindingTrace['fields'];
  mapping: string;
  smoothing: string;
  why: BindingTrace['why'];
}

export interface AudioDebug {
  running: boolean;
  sampleRate: number | null;
  /** Context output latency (base + output), seconds. Bluetooth adds more that the browser may not report. */
  outputLatencyS: number | null;
  /** Session clock to audio clock offset in use for heartbeats, seconds. */
  clockOffsetS: number | null;
  droppedLateBeats: number;
  /** Everything currently audible or fading, with the field behind it. */
  sounding: SoundingVoice[];
  /** Every binding, sounding or not, with the reason when not. */
  bindings: BindingTrace[];
  status: SynthStatus | null;
  settings: AudioSettings;
}

export interface AudioEngineOptions {
  settings?: AudioSettingsPatch;
  /** For tests: supply a context factory. */
  createContext?: () => AudioContext;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private binder: FrameBinder;
  private settings: AudioSettings;
  private status: SynthStatus | null = null;
  /** ctx.currentTime minus core time (min over status messages). */
  private coreOffset = Infinity;
  private startedAt = 0;
  private createContext: () => AudioContext;
  private starting: Promise<void> | null = null;

  constructor(opts: AudioEngineOptions = {}) {
    this.settings = mergeSettings(DEFAULT_AUDIO_SETTINGS, opts.settings ?? {});
    this.binder = new FrameBinder(this.settings);
    this.createContext = opts.createContext ?? (() => new AudioContext({ latencyHint: 'interactive' }));
  }

  get running(): boolean {
    return this.node !== null;
  }

  /** Create the context and worklet. Call from a click or key handler (autoplay policy). Idempotent. */
  start(): Promise<void> {
    if (this.node) return Promise.resolve();
    if (this.starting) return this.starting;
    const p = (async () => {
      const ctx = this.ctx ?? this.createContext();
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      await ctx.audioWorklet.addModule(workletUrl);
      const processorOptions: WorkletOptions = { settings: stripReadonly(this.settings), statusEveryS: 0.1 };
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
        if (e.data.type === 'status') {
          this.status = e.data.status;
          const off = ctx.currentTime - e.data.status.timeS;
          if (off < this.coreOffset) this.coreOffset = off;
        }
      };
      node.connect(ctx.destination);
      this.startedAt = ctx.currentTime;
      this.node = node;
    })();
    this.starting = p;
    const clear = () => {
      this.starting = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** Core time now, seconds. */
  private coreNow(): number {
    if (!this.ctx) return 0;
    const off = Number.isFinite(this.coreOffset) ? this.coreOffset : this.startedAt;
    return this.ctx.currentTime - off;
  }

  /** Feed every frame from the engine, in order. Cheap; safe to call before start(). */
  handleFrame(frame: Frame): void {
    const out = this.binder.handleFrame(frame, this.coreNow());
    if (!this.node) return;
    this.post({ type: 'control', control: out.control });
    for (const b of out.beats) this.post({ type: 'beat', atS: b.atS, flagged: b.flagged });
  }

  setSettings(patch: AudioSettingsPatch): void {
    this.settings = mergeSettings(this.settings, patch);
    this.binder.setSettings(patch);
    this.post({ type: 'settings', patch });
  }

  getSettings(): AudioSettings {
    return this.settings;
  }

  setBaseline(b: AudioBaseline | null): void {
    this.binder.setBaseline(b);
  }

  /** Play a personal anchor (or a neutral control). Fades in and out on its own envelope. */
  playAnchor(params: AnchorSynthParams): void {
    this.post({ type: 'anchor', params });
  }

  stopAnchor(): void {
    this.post({ type: 'anchorStop' });
  }

  /** Fade everything, then close the context. */
  async stop(): Promise<void> {
    const node = this.node;
    const ctx = this.ctx;
    this.node = null;
    this.ctx = null;
    this.status = null;
    this.coreOffset = Infinity;
    if (!node || !ctx) return;
    // Gentle exit: master to silence over 1.5 s before the context closes (never a click).
    node.port.postMessage({ type: 'settings', patch: { masterDb: -60, gainTauS: 0.3 } } satisfies ToWorklet);
    await new Promise((r) => setTimeout(r, 1600));
    node.port.postMessage({ type: 'dispose' });
    node.disconnect();
    await ctx.close();
  }

  getDebug(): AudioDebug {
    const st = this.status;
    const traces = this.binder.traceAll();
    const sounding: SoundingVoice[] = [];
    if (st) {
      const byId = new Map<number, VoiceStatus>(st.voices.map((v) => [v.id, v]));
      for (const tr of traces) {
        if (tr.element === 'tone' && tr.trackId !== undefined) {
          const v = byId.get(tr.trackId);
          if (v && v.gate > 0) sounding.push({ ...tr, level: v.gate * v.loudness, pitchHz: v.pitchHz, targetPitchHz: v.targetPitchHz });
        } else if ((tr.element === 'bloom_phi' || tr.element === 'bloom_octave') && tr.trackId !== undefined) {
          const v = byId.get(tr.trackId);
          const lvl = v ? (tr.element === 'bloom_phi' ? v.phi : v.octave) * v.gate : 0;
          if (lvl > 0) sounding.push({ ...tr, level: lvl });
        } else if (tr.element === 'bed' && st.bed.gate > 0) {
          sounding.push({ ...tr, level: st.bed.gate * st.bed.thin });
        } else if (tr.element === 'heart' && st.heart.activePulses > 0) {
          sounding.push({ ...tr, level: 1 });
        } else if (tr.element === 'breath_guide' && st.breath.gate > 0) {
          sounding.push({ ...tr, level: st.breath.gate });
        }
      }
      if (st.anchor.playing) {
        sounding.push({ element: 'anchor', level: st.anchor.level, fields: {}, mapping: 'personal anchor, explicitly played (not a measurement)', smoothing: 'its own attack and release', why: 'ok' });
      }
    }
    return {
      running: this.running,
      sampleRate: this.ctx ? this.ctx.sampleRate : null,
      outputLatencyS: this.ctx ? (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0) : null,
      clockOffsetS: this.binder.clockOffsetS,
      droppedLateBeats: this.binder.droppedLateBeats,
      sounding,
      bindings: traces,
      status: st,
      settings: this.settings,
    };
  }

  private post(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }
}

function stripReadonly(s: AudioSettings): AudioSettingsPatch {
  const { pitchMultiplier: _ignored, ...rest } = s;
  return rest;
}
