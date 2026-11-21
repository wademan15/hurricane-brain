/**
 * EngineClient backed by the engine worker (./worker.ts) running the WebAssembly signal engine.
 *
 * - Every push copies its samples into a fresh buffer and transfers that buffer to the worker,
 *   so the caller may reuse its own arrays and the UI thread never waits on the engine.
 * - Frames arrive as one JSON string per worker drain, are parsed here and handed to every
 *   subscriber in time order.
 * - There is no simulated implementation: if nothing is pushed, no frames arrive.
 */
import type { EngineClient } from './client';
import type { EngineConfig, Frame, Marker } from './frames';
import type { FromWorker, ToWorker } from './protocol';

/** Delivery statistics, for diagnostics and the end-to-end test. Not part of EngineClient. */
export interface EngineStats {
  /** Pushes sent to the worker. */
  pushes: number;
  /** Frames delivered to subscribers. */
  frames: number;
  /** Frame messages received from the worker. */
  messages: number;
  /**
   * Recent push-to-frame latencies, ms: time from the push call on this thread to the frames it
   * produced being handed to subscribers (worker queueing + engine + drain + transfer + parse).
   * The last 4096 messages.
   */
  latency_ms: number[];
  /** Engine time for the push behind each frames message, ms, last 4096. */
  push_ms: number[];
  /** Drain and JSON serialization time per frames message (in the worker), ms, last 4096. */
  drain_ms: number[];
  /** UI-thread JSON.parse time per frames message, ms, last 4096. */
  parse_ms: number[];
  /** Frames per message, last 4096 (to turn per-message costs into per-frame costs). */
  count: number[];
  /** Whether each message held a slow frame (a slow update ran in that push), last 4096. */
  has_slow: boolean[];
  /** The last error the worker reported, if any. */
  error: string | null;
}

const RING = 4096;

function push<T>(arr: T[], v: T): void {
  if (arr.length >= RING) arr.shift();
  arr.push(v);
}

export class WorkerEngineClient implements EngineClient {
  private worker: Worker | null;
  private listeners = new Set<(frame: Frame) => void>();
  private seq = 0;
  private sentAt = new Float64Array(RING);
  private pendingInit: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private infoId = 0;
  private pendingInfo = new Map<number, { resolve: (v: { version: string; params: Record<string, number | string | boolean> }) => void; reject: (e: Error) => void }>();
  private readonly s: EngineStats = { pushes: 0, frames: 0, messages: 0, latency_ms: [], push_ms: [], drain_ms: [], parse_ms: [], count: [], has_slow: [], error: null };

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'hb-engine' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    this.worker.onerror = (ev: ErrorEvent) => this.fail(`engine worker error: ${ev.message || 'failed to start'}`, true);
  }

  init(config: EngineConfig): Promise<void> {
    if (!this.worker) return Promise.reject(new Error('engine disposed'));
    this.pendingInit?.reject(new Error('superseded by a newer init'));
    return new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      this.send({ op: 'init', config });
    });
  }

  pushEeg(firstIndex: number, samples: Float32Array): void {
    const x = samples.slice();
    this.send({ op: 'eeg', seq: this.stamp(), i: firstIndex, x }, [x.buffer]);
  }

  pushMotion(t: number, acc: Float32Array, gyro: Float32Array): void {
    const a = acc.slice();
    const g = gyro.slice();
    this.send({ op: 'motion', seq: this.stamp(), t, acc: a, gyro: g }, [a.buffer, g.buffer]);
  }

  pushPpg(t: number, samples: Float32Array): void {
    const x = samples.slice();
    this.send({ op: 'ppg', seq: this.stamp(), t, x }, [x.buffer]);
  }

  pushRr(t: number, rrMs: Float32Array): void {
    const x = rrMs.slice();
    this.send({ op: 'rr', seq: this.stamp(), t, x }, [x.buffer]);
  }

  pushMarker(marker: Marker): void {
    this.send({ op: 'marker', seq: this.stamp(), json: JSON.stringify(marker) });
  }

  setPacer(breathsPerMinute: number | null): void {
    this.send({ op: 'pacer', bpm: breathsPerMinute });
  }

  setIaf(hz: number | null): void {
    this.send({ op: 'iaf', hz });
  }

  markHeartBaseline(t0: number, t1: number): void {
    this.send({ op: 'baseline', t0, t1 });
  }

  subscribe(listener: (frame: Frame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  info(): Promise<{ version: string; params: Record<string, number | string | boolean> }> {
    if (!this.worker) return Promise.reject(new Error('engine disposed'));
    const id = ++this.infoId;
    return new Promise((resolve, reject) => {
      this.pendingInfo.set(id, { resolve, reject });
      this.send({ op: 'info', id });
    });
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.listeners.clear();
    this.rejectAll(new Error('engine disposed'));
  }

  /** Delivery statistics (a live object; copy it if you keep it). */
  stats(): EngineStats {
    return this.s;
  }

  // ---------------------------------------------------------------------------------------------

  private stamp(): number {
    const seq = ++this.seq;
    this.sentAt[seq % RING] = performance.now();
    this.s.pushes++;
    return seq;
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.op) {
      case 'ready':
        this.pendingInit?.resolve();
        this.pendingInit = null;
        return;
      case 'error':
        this.fail(msg.message, msg.fatal);
        return;
      case 'info': {
        const p = this.pendingInfo.get(msg.id);
        this.pendingInfo.delete(msg.id);
        p?.resolve({ version: msg.version, params: JSON.parse(msg.params) as Record<string, number | string | boolean> });
        return;
      }
      case 'frames': {
        const t0 = performance.now();
        const frames = JSON.parse(msg.json) as Frame[];
        const t1 = performance.now();
        const s = this.s;
        s.messages++;
        push(s.parse_ms, t1 - t0);
        push(s.push_ms, msg.push_ms);
        push(s.drain_ms, msg.drain_ms);
        push(s.count, frames.length);
        push(s.has_slow, frames.some((f) => f.kind === 'slow'));
        if (this.seq - msg.seq < RING) push(s.latency_ms, t1 - this.sentAt[msg.seq % RING]);
        for (const f of frames) {
          s.frames++;
          for (const l of this.listeners) {
            try {
              l(f);
            } catch (e) {
              console.error('engine frame listener failed', e);
            }
          }
        }
        return;
      }
    }
  }

  private fail(message: string, fatal: boolean): void {
    this.s.error = message;
    console.error(`engine: ${message}`);
    const e = new Error(message);
    if (this.pendingInit) {
      this.pendingInit.reject(e);
      this.pendingInit = null;
    }
    if (fatal) this.rejectAll(e);
  }

  private rejectAll(e: Error): void {
    this.pendingInit?.reject(e);
    this.pendingInit = null;
    for (const p of this.pendingInfo.values()) p.reject(e);
    this.pendingInfo.clear();
  }
}

/** A new engine in its own worker. Call `init` before pushing; `dispose` ends the worker. */
export function createEngineClient(): EngineClient {
  return new WorkerEngineClient();
}
