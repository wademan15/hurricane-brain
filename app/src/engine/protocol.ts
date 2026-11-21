/**
 * Messages between the UI thread (worker-client.ts) and the engine worker (worker.ts).
 * Internal to src/engine; the UI depends only on EngineClient.
 */
import type { EngineConfig } from './frames';

/** UI thread -> worker. `seq` numbers every push so latency can be measured per push. */
export type ToWorker =
  | { op: 'init'; config: EngineConfig }
  | { op: 'eeg'; seq: number; i: number; x: Float32Array }
  | { op: 'motion'; seq: number; t: number; acc: Float32Array; gyro: Float32Array }
  | { op: 'ppg'; seq: number; t: number; x: Float32Array }
  | { op: 'rr'; seq: number; t: number; x: Float32Array }
  | { op: 'marker'; seq: number; json: string }
  | { op: 'pacer'; bpm: number | null }
  | { op: 'iaf'; hz: number | null }
  | { op: 'baseline'; t0: number; t1: number }
  | { op: 'info'; id: number };

/** Worker -> UI thread. */
export type FromWorker =
  | { op: 'ready'; version: string }
  | { op: 'error'; message: string; fatal: boolean }
  /**
   * Frames as a JSON array string (parsed on the UI thread: one string copy instead of a
   * structured clone of thousands of small objects). `seq` is the push that produced them.
   * `push_ms` is the engine's time for that push, `drain_ms` the time to drain and serialize.
   */
  | { op: 'frames'; seq: number; json: string; count: number; push_ms: number; drain_ms: number }
  | { op: 'info'; id: number; version: string; params: string };
