/**
 * ReplaySource: plays a recorded session back as a DeviceSource.
 *
 *  from: 'raw' (default) re-decodes the recorded inputs through the same pipelines the live
 *        devices use, with a fresh session clock built from the header. Output is identical to
 *        the live session (asserted in test/record-replay.test.ts).
 *  from: 'decoded' emits the decoded records stored in the file, without decoding.
 *  speed: 'fast' as fast as possible (yielding to the event loop every `chunk` records),
 *         or a factor of real time (1 = real time), paced by recorded arrival times.
 */
import { SessionClock } from '../clock';
import { Emitter } from '../emitter';
import { MusePipeline } from '../muse/pipeline';
import { ChestStrapPipeline } from '../polar/pipeline';
import type { ConnectionState, DeviceEventName, DeviceSource, Listener } from '../types';
import { readRecording, type ParsedRecording, type RecordedEvent } from './format';

export interface ReplayOptions {
  from?: 'raw' | 'decoded';
  speed?: 'fast' | number;
  /** Records per event-loop turn in fast mode. Default 2000. */
  chunk?: number;
  /** Injectable clock and timer, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the Muse pipeline's settle length (normally taken from the header). */
  settleSamples?: number;
}

export class ReplaySource implements DeviceSource {
  readonly kind = 'replay' as const;
  readonly recording: ParsedRecording;
  private readonly em = new Emitter();
  private readonly opts: ReplayOptions;
  private _state: ConnectionState = 'idle';
  private stopping = false;

  constructor(data: Uint8Array | ParsedRecording, opts: ReplayOptions = {}) {
    this.recording = data instanceof Uint8Array ? readRecording(data) : data;
    this.opts = opts;
  }

  get state(): ConnectionState {
    return this._state;
  }

  on<K extends DeviceEventName>(type: K, listener: Listener<K>): () => void {
    return this.em.on(type, listener);
  }

  async stop(): Promise<void> {
    this.stopping = true;
  }

  /** Plays to the end (or until stop()). Resolves when done. */
  async start(): Promise<void> {
    this.stopping = false;
    this.setState('replaying');
    const fromRaw = (this.opts.from ?? 'raw') === 'raw';
    const out = <K extends DeviceEventName>(type: K, ev: Parameters<Listener<K>>[0]) => this.em.emit(type, ev);
    const clock = new SessionClock({ eegRateHz: this.recording.header.clock.eegRateHz });
    const muse = new MusePipeline(out, {
      clock,
      settleSamples: this.opts.settleSamples ?? this.recording.header.clock.settleSamples,
    });
    const strap = new ChestStrapPipeline(out, clock);

    const speed = this.opts.speed ?? 'fast';
    const chunk = this.opts.chunk ?? 2000;
    const now = this.opts.now ?? (() => performance.now());
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const recs = this.recording.records;
    const t0 = recs.length ? recs[0].tUs : 0;
    const wall0 = now();

    for (let i = 0; i < recs.length; i++) {
      if (this.stopping) break;
      const rec = recs[i];
      if (speed === 'fast') {
        if (i > 0 && i % chunk === 0) await sleep(0);
      } else {
        const due = wall0 + (rec.tUs - t0) / 1000 / speed;
        const wait = due - now();
        if (wait > 1) await sleep(wait);
      }
      if (fromRaw) {
        if (rec.kind === 'input') {
          this.em.emit('input', rec.input);
          muse.push(rec.input);
          strap.push(rec.input);
        }
      } else {
        this.emitDecoded(rec);
      }
    }
    this.setState(this.stopping ? 'stopped' : 'ended');
  }

  private emitDecoded(rec: RecordedEvent): void {
    switch (rec.kind) {
      case 'input': return this.em.emit('input', rec.input);
      case 'streams': return this.em.emit('streams', rec.streams);
      case 'note': return;
      default: return this.em.emit(rec.kind, rec.ev as never);
    }
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    this.em.emit('status', { slot: null, state });
  }
}
