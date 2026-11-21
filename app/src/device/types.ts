/**
 * Public types of the device layer.
 *
 * Every decoded event is already on the session clock (spec section 3) and in the exact form
 * the engine's push functions take (app/src/engine/frames.ts, EngineApi):
 *   eeg    -> pushEeg(firstIndex, samples)
 *   ppg    -> pushPpg(t, samples)
 *   motion -> pushMotion(t, acc, gyro)
 *   rr     -> pushRr(t, rrMs)
 */
import type { StreamDescription } from '../engine/frames';

/** Which device a record belongs to. Written into recordings; never renumber. */
export const DeviceSlot = { MUSE: 0, CHEST_STRAP: 1 } as const;
export type DeviceSlot = (typeof DeviceSlot)[keyof typeof DeviceSlot];

export type MuseProtocol = 'classic' | 'athena';

/**
 * One raw Bluetooth notification (or a value read), exactly as received.
 * `tUs` is the arrival time in integer microseconds since the session clock's host origin.
 * Arrival times are quantized to whole microseconds BEFORE decoding, so a replay of the
 * recorded integers reproduces the live decode exactly.
 */
export interface RawNotification {
  type: 'raw';
  slot: DeviceSlot;
  /** Characteristic id: the Muse 16-bit UUID suffix, or the SIG 16-bit UUID (0x2a37, 0x2a19). */
  char: number;
  tUs: number;
  bytes: Uint8Array;
}

/** A link change. Decoders reset their per-connection state on these. Recorded. */
export interface LinkEvent {
  type: 'link';
  slot: DeviceSlot;
  tUs: number;
  state: 'connected' | 'disconnected';
  /** For 'connected': what was configured on this connection. */
  config?: LinkConfig;
}

export interface LinkConfig {
  name: string | null;
  /** Muse only. */
  protocol?: MuseProtocol;
  /** Muse only: the preset sent. */
  preset?: string;
  /** Classic only: which EEG characteristics were subscribed (4, or 5 with AUX). */
  eegChars?: number[];
  /** Classic only: PPG characteristics subscribed. */
  ppgChars?: number[];
}

/** What the decoders consume. Live devices produce these; recordings store them; replay feeds them back. */
export type DeviceInput = RawNotification | LinkEvent;

export type ConnectionState =
  | 'idle'
  | 'requesting' // chooser open (needs a user gesture)
  | 'connecting'
  | 'starting' // sending the start sequence
  | 'streaming'
  | 'reconnecting'
  | 'stopped' // stopped by the app
  | 'failed' // gave up; see `detail`
  | 'replaying'
  | 'ended'; // replay finished

export interface StatusEvent {
  slot: DeviceSlot | null;
  state: ConnectionState;
  detail?: string;
  /** Reconnect attempt number, from 1. */
  attempt?: number;
  /** Milliseconds until the next reconnect attempt. */
  retryInMs?: number;
}

export interface EegEvent {
  /** Index of the first sample on the session clock (EEG sample count, 0 = first sample). */
  firstIndex: number;
  nSamples: number;
  nChannels: number;
  /** Interleaved by channel in the stream description's channel order, microvolts. */
  samples: Float32Array;
}

export interface PpgEvent {
  /** Session time of the first sample, seconds. */
  t: number;
  nSamples: number;
  nChannels: number;
  /** Interleaved by channel, raw ADC units (the optical sensors are unscaled). */
  samples: Float32Array;
}

export interface MotionEvent {
  t: number;
  /** x, y, z in g. */
  acc: Float32Array;
  /** x, y, z in degrees per second. */
  gyro: Float32Array;
}

export interface RrEvent {
  /** Session time the notification arrived, seconds. */
  t: number;
  /** Beat-to-beat intervals, milliseconds, oldest first. */
  rrMs: Float32Array;
}

export interface HeartRateEvent {
  t: number;
  bpm: number;
  /** Skin contact as reported by the strap; null if the strap does not report it. */
  contact: boolean | null;
}

export interface BatteryEvent {
  slot: DeviceSlot;
  /** Session time, or null before the session clock is anchored. */
  t: number | null;
  percent: number;
}

export type GapCause =
  | 'counter' // a sequence counter skipped
  | 'reassembly' // Classic: one channel's notification of a packet never came
  | 'reconnect' // the link dropped and came back
  | 'restart'; // counter went backwards (firmware restart, preset change)

export interface GapEvent {
  stream: 'eeg' | 'ppg' | 'motion';
  cause: GapCause;
  /** EEG: first missing sample index. PPG/motion: session time of the first missing sample. */
  at: number;
  /** Missing samples per channel. For a reconnect this is estimated from arrival time. */
  samples: number;
  /** True when `samples` is estimated from arrival time rather than counted. */
  estimated: boolean;
}

export interface InfoEvent {
  slot: DeviceSlot;
  /** A JSON object the device sent (Muse: version and status replies). */
  json: Record<string, unknown>;
}

export interface DeviceErrorEvent {
  slot: DeviceSlot | null;
  message: string;
}

export interface DeviceEvents {
  status: StatusEvent;
  /** The streams this source provides. Emitted once, before the first sample event. */
  streams: StreamDescription;
  eeg: EegEvent;
  ppg: PpgEvent;
  motion: MotionEvent;
  rr: RrEvent;
  heartRate: HeartRateEvent;
  battery: BatteryEvent;
  gap: GapEvent;
  info: InfoEvent;
  error: DeviceErrorEvent;
  /** Every decoder input, for the recorder. */
  input: DeviceInput;
}

export type DeviceEventName = keyof DeviceEvents;
export type Listener<K extends DeviceEventName> = (e: DeviceEvents[K]) => void;

/** One interface for live Muse, live chest strap and replay. */
export interface DeviceSource {
  readonly kind: 'muse' | 'chest_strap' | 'replay';
  readonly state: ConnectionState;
  on<K extends DeviceEventName>(type: K, listener: Listener<K>): () => void;
  /** Live: open the chooser (call from a user gesture) and connect. Replay: start playback. */
  start(): Promise<void>;
  /** Stop and release. Live: halts streaming and disconnects. Idempotent. */
  stop(): Promise<void>;
}
