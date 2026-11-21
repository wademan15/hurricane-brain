/**
 * StreamOut: sends live data to a local bridge program over a WebSocket.
 * See ./README.md for the protocol. Nothing is sent, and no socket is opened, until connect(url)
 * has been called with a URL the user entered. This class never throws into its caller: every
 * failure becomes a status event.
 */
import type { Frame, Marker, StreamDescription } from '../engine/frames';
import { SCHEMA_VERSION } from '../engine/frames';
import {
  BinaryKind,
  PROTOCOL_VERSION,
  encodeBinary,
  encodeFrame,
  type BatteryMsg,
  type HelloMsg,
  type MarkerMsg,
  type MotionMsg,
  type RrMsg,
  type StreamsMsg,
} from './protocol';

export const DEFAULT_URL = 'ws://localhost:8765';

export type StreamStatusState = 'idle' | 'connecting' | 'open' | 'error';

export interface StreamStatus {
  state: StreamStatusState;
  /** For 'error': why. For 'connecting' after a failure: the last reason. */
  reason?: string;
  /** Reconnect attempt number, from 1, while waiting or connecting again. */
  attempt?: number;
  /** Milliseconds until the next attempt, while in 'error' and waiting. */
  retryInMs?: number;
}

export interface StreamStats {
  sent: number;
  /** Messages not sent because the socket was not open or its buffer was backed up. */
  dropped: number;
  droppedNotOpen: number;
  droppedBackedUp: number;
  bytesSent: number;
}

/** The subset of WebSocket this class uses, so tests can supply a fake. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: unknown) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface StreamOutOptions {
  /** Defaults to the global WebSocket. */
  socketFactory?: (url: string) => SocketLike;
  /** Drop new messages while the socket's send buffer holds more than this many bytes. Default 1 MiB. */
  maxBufferedBytes?: number;
  /** Reconnect delay: min(maxMs, baseMs * 2^(attempt-1)). Defaults 500 and 10000. No jitter (deterministic). */
  backoff?: { baseMs: number; maxMs: number };
  /** Set false to stay in 'error' after a failure instead of reconnecting. Default true. */
  autoReconnect?: boolean;
}

type StatusListener = (s: StreamStatus) => void;

const OPEN = 1;

export class StreamOut {
  private url: string | null = null;
  private sock: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private wanted = false;
  private streams: StreamDescription | null = null;
  private listeners = new Set<StatusListener>();
  private current: StreamStatus = { state: 'idle' };
  private counters: StreamStats = { sent: 0, dropped: 0, droppedNotOpen: 0, droppedBackedUp: 0, bytesSent: 0 };
  private readonly factory: (url: string) => SocketLike;
  private readonly maxBuffered: number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly autoReconnect: boolean;
  private lastError: string | null = null;
  private eegChannels = 0;
  private ppgChannels = 0;

  constructor(opts: StreamOutOptions = {}) {
    this.factory = opts.socketFactory ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.maxBuffered = opts.maxBufferedBytes ?? 1024 * 1024;
    this.backoff = opts.backoff ?? { baseMs: 500, maxMs: 10_000 };
    this.autoReconnect = opts.autoReconnect ?? true;
  }

  get status(): StreamStatus {
    return this.current;
  }

  get stats(): StreamStats {
    return { ...this.counters };
  }

  on(type: 'status', fn: StatusListener): () => void {
    if (type !== 'status') return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start streaming to a user-entered ws:// or wss:// URL. Safe to call again with another URL. */
  connect(url: string): void {
    this.teardown();
    const u = url.trim();
    if (!/^wss?:\/\/[^\s/]+/i.test(u)) {
      this.wanted = false;
      this.url = null;
      this.setStatus({ state: 'error', reason: 'URL must start with ws:// or wss://' });
      return;
    }
    this.url = u;
    this.wanted = true;
    this.attempt = 0;
    this.counters = { sent: 0, dropped: 0, droppedNotOpen: 0, droppedBackedUp: 0, bytesSent: 0 };
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.teardown();
    this.url = null;
    this.setStatus({ state: 'idle' });
  }

  // ---- data in -----------------------------------------------------------

  setStreams(desc: StreamDescription): void {
    this.streams = desc;
    this.eegChannels = desc.eeg?.channels.length ?? 0;
    this.ppgChannels = desc.ppg?.channels.length ?? 0;
    if (!this.hasWork()) return;
    this.sendJson<StreamsMsg>({ type: 'streams', streams: desc });
  }

  /** samples interleaved by channel, microvolts; firstIndex on the session clock. */
  handleEeg(firstIndex: number, samples: Float32Array): void {
    if (!this.hasWork()) return;
    if (this.eegChannels === 0) return this.drop('notOpen');
    this.sendBinary(encodeBinary(BinaryKind.EEG, firstIndex, this.eegChannels, samples));
  }

  handlePpg(t: number, samples: Float32Array): void {
    if (!this.hasWork()) return;
    if (this.ppgChannels === 0) return this.drop('notOpen');
    this.sendBinary(encodeBinary(BinaryKind.PPG, t, this.ppgChannels, samples));
  }

  /** acc in g, gyro in degrees per second. */
  handleMotion(t: number, acc: Float32Array | number[], gyro: Float32Array | number[]): void {
    if (!this.hasWork()) return;
    this.sendJson<MotionMsg>({ type: 'motion', t, acc: Array.from(acc), gyro: Array.from(gyro) });
  }

  handleRr(t: number, rrMs: Float32Array | number[]): void {
    if (!this.hasWork()) return;
    this.sendJson<RrMsg>({ type: 'rr', t, rr_ms: Array.from(rrMs) });
  }

  handleBattery(percent: number, t: number | null = null): void {
    if (!this.hasWork()) return;
    this.sendJson<BatteryMsg>({ type: 'battery', t, percent });
  }

  handleMarker(m: Marker): void {
    if (!this.hasWork()) return;
    this.sendJson<MarkerMsg>({ type: 'marker', t: m.t, marker: m.type, label: m.label ?? null });
  }

  handleFrame(frame: Frame): void {
    if (!this.hasWork()) return;
    try {
      this.sendJson(encodeFrame(frame));
    } catch (e) {
      this.drop('notOpen');
      void e;
    }
  }

  // ---- internals ---------------------------------------------------------

  /** False when connect() was never called (or after disconnect): nothing is counted or sent. */
  private hasWork(): boolean {
    return this.wanted;
  }

  private setStatus(s: StreamStatus): void {
    this.current = s;
    for (const fn of [...this.listeners]) {
      try { fn(s); } catch { /* a listener must not break streaming */ }
    }
  }

  private teardown(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.onopen = s.onclose = s.onerror = s.onmessage = null;
      try { s.close(); } catch { /* already closed */ }
    }
  }

  private open(): void {
    if (!this.wanted || this.url === null) return;
    const prior = this.current;
    this.lastError = null;
    this.setStatus(this.attempt > 0
      ? { state: 'connecting', attempt: this.attempt, reason: prior.reason }
      : { state: 'connecting' });
    let s: SocketLike;
    try {
      s = this.factory(this.url);
    } catch (e) {
      this.sock = null;
      this.failed(e instanceof Error ? e.message : 'could not create socket');
      return;
    }
    s.binaryType = 'arraybuffer';
    this.sock = s;
    s.onopen = () => {
      if (this.sock !== s) return;
      this.attempt = 0;
      this.setStatus({ state: 'open' });
      const hello: HelloMsg = { type: 'hello', v: PROTOCOL_VERSION, app: 'hurricane-brain', schema: SCHEMA_VERSION };
      this.sendJson(hello);
      if (this.streams) this.sendJson<StreamsMsg>({ type: 'streams', streams: this.streams });
    };
    s.onerror = () => {
      // The close event follows and carries the retry; remember the reason.
      if (this.sock === s) this.lastError = 'connection error';
    };
    s.onclose = (ev) => {
      if (this.sock !== s) return;
      this.sock = null;
      const why = this.lastError ?? (ev?.reason ? ev.reason : `closed (code ${ev?.code ?? 'unknown'})`);
      this.lastError = null;
      this.failed(why);
    };
  }

  private failed(reason: string): void {
    if (!this.wanted) return;
    if (!this.autoReconnect) {
      this.setStatus({ state: 'error', reason });
      return;
    }
    this.attempt += 1;
    const retryInMs = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (this.attempt - 1));
    this.setStatus({ state: 'error', reason, attempt: this.attempt, retryInMs });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, retryInMs);
  }

  private drop(kind: 'notOpen' | 'backedUp'): void {
    this.counters.dropped++;
    if (kind === 'notOpen') this.counters.droppedNotOpen++;
    else this.counters.droppedBackedUp++;
  }

  private sendJson<T extends object>(msg: T): void {
    if (!this.canSend()) return;
    let text: string;
    try { text = JSON.stringify(msg); } catch { return this.drop('notOpen'); }
    this.rawSend(text, text.length);
  }

  private sendBinary(buf: ArrayBuffer): void {
    if (!this.canSend()) return;
    this.rawSend(buf, buf.byteLength);
  }

  private canSend(): boolean {
    const s = this.sock;
    if (!s || s.readyState !== OPEN) { this.drop('notOpen'); return false; }
    if (s.bufferedAmount > this.maxBuffered) { this.drop('backedUp'); return false; }
    return true;
  }

  private rawSend(data: string | ArrayBuffer, bytes: number): void {
    try {
      this.sock?.send(data);
      this.counters.sent++;
      this.counters.bytesSent += bytes;
    } catch {
      this.drop('notOpen');
    }
  }
}
