/**
 * The engine as the UI thread sees it. The implementation (engine worker + WebAssembly)
 * lives in ./worker-client.ts; the UI depends only on this interface.
 *
 * Frames are delivered in time order. There is no simulated or demo implementation of
 * this interface: when no device or replay is feeding the engine, no frames arrive.
 */
import type { EngineConfig, Frame, Marker } from './frames';

export interface EngineClient {
  /** Start a fresh engine for a session. Resolves when the WebAssembly module is ready. */
  init(config: EngineConfig): Promise<void>;
  pushEeg(firstIndex: number, samples: Float32Array): void;
  pushMotion(t: number, acc: Float32Array, gyro: Float32Array): void;
  pushPpg(t: number, samples: Float32Array): void;
  pushRr(t: number, rrMs: Float32Array): void;
  pushMarker(marker: Marker): void;
  setPacer(breathsPerMinute: number | null): void;
  setIaf(hz: number | null): void;
  /** Mark a baseline window for the heart measures (session seconds). */
  markHeartBaseline(t0: number, t1: number): void;
  /** Subscribe to frames. Returns an unsubscribe function. */
  subscribe(listener: (frame: Frame) => void): () => void;
  /** Engine version and the parameter set in force, for the session record. */
  info(): Promise<{ version: string; params: Record<string, number | string | boolean> }>;
  /** Stop and release the engine. */
  dispose(): void;
}
