/**
 * TEST ONLY. A fake EngineClient, a fake audio engine and a recording builder. Nothing here is
 * imported by app code and none of it is a demo or simulated data source: the fake engine only
 * answers the samples it is given with frames at the engine's own cadence, so wiring can be tested.
 */
import { vi } from 'vitest';
import type { AudioEngine } from '../../audio';
import { synthClassic } from '../../device/test/synth';
import { LinkRecorder } from '../session/linkRecorder';
import type { EngineClient } from '../../engine/client';
import type { EngineConfig, Frame, Marker } from '../../engine/frames';
import { fastFrame, slowFrame } from '../../training/test-fixtures';
import type { DeviceEventName, DeviceInput, DeviceSource, Listener } from '../../device';

export class FakeEngine implements EngineClient {
  configs: EngineConfig[] = [];
  eegSamples = 0;
  eegCalls: { firstIndex: number; n: number }[] = [];
  markers: Marker[] = [];
  pacer: (number | null)[] = [];
  iaf: (number | null)[] = [];
  rr: number[][] = [];
  disposed = false;
  private listeners = new Set<(f: Frame) => void>();
  private nextFrameT = 0.25;
  private channels = 4;
  /** Frame times in the order frames were emitted (for determinism checks). */
  emitted: number[] = [];

  async init(config: EngineConfig): Promise<void> {
    this.configs.push(config);
    this.channels = config.streams.eeg?.channels.length ?? 4;
    this.nextFrameT = 0.25;
  }
  pushEeg(firstIndex: number, samples: Float32Array): void {
    const n = samples.length / this.channels;
    this.eegSamples += n;
    this.eegCalls.push({ firstIndex, n });
    const tEnd = (firstIndex + n) / 256;
    while (this.nextFrameT <= tEnd) {
      const t = this.nextFrameT;
      this.emit(slowFrame(t, { bands: { alpha: 3, theta: 1, beta: 0 }, alphaTrack: { freq: 10, height: 8 }, phiExcess: 0.2, octaveExcess: 0.1, phiSteps: 1 }));
      this.emit(fastFrame(t, { alphaHeight: 8, alphaFreq: 10 }));
      this.nextFrameT += 0.25;
    }
  }
  pushMotion(): void {}
  pushPpg(): void {}
  pushRr(_t: number, rrMs: Float32Array): void {
    this.rr.push([...rrMs]);
  }
  pushMarker(m: Marker): void {
    this.markers.push(m);
  }
  setPacer(bpm: number | null): void {
    this.pacer.push(bpm);
  }
  setIaf(hz: number | null): void {
    this.iaf.push(hz);
  }
  markHeartBaseline(): void {}
  subscribe(l: (f: Frame) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  async info() {
    return { version: 'fake-1', params: { tolerance_phi: 0.02, window_s: 8 } };
  }
  dispose(): void {
    this.disposed = true;
  }
  private emit(f: Frame): void {
    this.emitted.push(f.t);
    for (const l of [...this.listeners]) l(f);
  }
}

export function fakeAudio() {
  const calls = { start: 0, stop: 0, frames: 0, anchors: [] as unknown[], settings: [] as unknown[], baseline: [] as unknown[] };
  const audio = {
    start: vi.fn(async () => { calls.start++; }),
    stop: vi.fn(async () => { calls.stop++; }),
    handleFrame: vi.fn(() => { calls.frames++; }),
    setSettings: vi.fn((p: unknown) => { calls.settings.push(p); }),
    getSettings: vi.fn(() => ({ pitchTauS: 0.15, ceilingDb: -6 })),
    setBaseline: vi.fn((b: unknown) => { calls.baseline.push(b); }),
    playAnchor: vi.fn((p: unknown) => { calls.anchors.push(p); }),
    stopAnchor: vi.fn(),
  };
  return { audio: audio as unknown as AudioEngine, calls };
}

/** A DeviceSource that tests drive by hand. */
export class ManualSource implements DeviceSource {
  readonly kind: 'muse' | 'chest_strap' | 'replay';
  state: DeviceSource['state'] = 'idle';
  private listeners = new Map<string, Set<(e: never) => void>>();
  constructor(kind: 'muse' | 'chest_strap' | 'replay' = 'muse') {
    this.kind = kind;
  }
  on<K extends DeviceEventName>(type: K, listener: Listener<K>): () => void {
    const s = this.listeners.get(type) ?? new Set();
    s.add(listener as (e: never) => void);
    this.listeners.set(type, s);
    return () => s.delete(listener as (e: never) => void);
  }
  emit<K extends DeviceEventName>(type: K, ev: Parameters<Listener<K>>[0]): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) (l as Listener<K>)(ev);
  }
  async start(): Promise<void> {
    this.state = 'streaming';
    this.emit('status', { slot: 0, state: 'streaming' });
  }
  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}

/**
 * Build a small recorded session (HBRAW bytes) from the device layer's synthetic headset
 * packets, with session notes written the way the controller writes them.
 */
export function buildRecording(opts: { seconds: number; notes?: { afterInput: number; json: unknown }[] }): Uint8Array {
  const syn = synthClassic({ seconds: opts.seconds, ppg: false, motion: false, t0Us: 0 });
  const rec = new LinkRecorder({ clock: { eegRateHz: 256 }, devices: [{ slot: 0, kind: 'muse', name: 'Muse-SYNT' }], meta: { seed: 7, mains_hz: 50, engineOverrides: {} }, createdAt: '2026-01-01T00:00:00.000Z' });
  const src = new ManualSource('muse');
  rec.attach(src);
  const notes = [...(opts.notes ?? [])].sort((a, b) => a.afterInput - b.afterInput);
  syn.inputs.forEach((i: DeviceInput, k: number) => {
    src.emit('input', i);
    while (notes.length && notes[0].afterInput <= k) rec.note((notes.shift() as { json: unknown }).json);
  });
  for (const n of notes) rec.note(n.json);
  return rec.finish();
}
