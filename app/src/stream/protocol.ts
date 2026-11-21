/**
 * Wire protocol between the app and the stream bridge. Version 1.
 * Full description: ./README.md. This file is the single source of truth for the TypeScript side;
 * tools/stream-bridge/bridge.py implements the decoder in Python.
 *
 * Two message kinds on one WebSocket:
 *  - Binary: bulk sample data (EEG, optical). A 16 byte header then float32 little-endian samples.
 *  - Text: JSON objects with a "type" field.
 *
 * Null discipline: a measured value that is null is never encoded as 0 or as the last value.
 * In JSON a `Measured` becomes a number when measured, or a STRING holding the reason it is
 * null (the engine's `Reason`, e.g. "warming_up"). A consumer therefore sees `typeof x === 'string'`
 * as "not measured, because ...". Plain optional numbers use JSON null.
 */
import type {
  BandName,
  ChanceLevel,
  Cascade,
  FastFrame,
  Frame,
  HeartFrame,
  Marker,
  Measured,
  SlowFrame,
  StreamDescription,
} from '../engine/frames';

export const PROTOCOL_VERSION = 1;
export const BINARY_MAGIC = 0x48; // 'H'

export const BinaryKind = { EEG: 1, PPG: 2 } as const;
export type BinaryKindValue = (typeof BinaryKind)[keyof typeof BinaryKind];

/** A measured number, or the reason it is not measured. */
export type MV = number | string;

export function mv(m: Measured): MV {
  if (typeof m.v === 'number' && Number.isFinite(m.v)) return m.v;
  return m.why === 'ok' ? 'not_available' : m.why;
}

/** Decode a MV: number or null (with the reason). */
export function mvValue(x: MV | null | undefined): number | null {
  return typeof x === 'number' ? x : null;
}

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

export const BINARY_HEADER_BYTES = 16;

/**
 * Header (little endian):
 *   0  u8   magic 0x48
 *   1  u8   protocol version
 *   2  u8   kind (1 EEG, 2 PPG)
 *   3  u8   channel count
 *   4  f64  position: EEG = index of the first sample (session clock, exact integer);
 *                     PPG = session time of the first sample, seconds
 *  12  u32  samples per channel
 *  16  ...  float32 samples, interleaved by channel
 */
export function encodeBinary(kind: BinaryKindValue, position: number, nChannels: number, samples: Float32Array): ArrayBuffer {
  const nPer = nChannels > 0 ? Math.floor(samples.length / nChannels) : 0;
  const n = nPer * nChannels;
  const buf = new ArrayBuffer(BINARY_HEADER_BYTES + n * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, BINARY_MAGIC);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint8(2, kind);
  dv.setUint8(3, nChannels);
  dv.setFloat64(4, position, true);
  dv.setUint32(12, nPer, true);
  for (let i = 0; i < n; i++) dv.setFloat32(BINARY_HEADER_BYTES + i * 4, samples[i] as number, true);
  return buf;
}

export interface BinaryMessage {
  type: 'eeg' | 'ppg';
  /** EEG: first sample index. PPG: session time, seconds. */
  position: number;
  nChannels: number;
  nSamples: number;
  samples: Float32Array;
}

// ---------------------------------------------------------------------------
// JSON messages
// ---------------------------------------------------------------------------

export interface HelloMsg { type: 'hello'; v: number; app: string; schema: number }
export interface StreamsMsg { type: 'streams'; streams: StreamDescription }
export interface MotionMsg { type: 'motion'; t: number; acc: number[]; gyro: number[] }
export interface RrMsg { type: 'rr'; t: number; rr_ms: number[] }
export interface BatteryMsg { type: 'battery'; t: number | null; percent: number }
export interface MarkerMsg { type: 'marker'; t: number; marker: Marker['type']; label: string | null }

export interface WireChance { closeness: MV; p: MV; p_steps: MV }
export interface WireCascade {
  steps: number;
  tracks: number[];
  closeness: MV;
  held_s: number;
  excess_a: MV;
  excess_b: MV;
  chance_a: WireChance;
  chance_b: WireChance;
}
export interface WireState { active: boolean; for_s: number; stat: MV }

export interface SlowMsg {
  type: 'slow';
  t: number;
  window_s: number;
  /** Per channel: usable, why, artifact kinds seen in the slow window. */
  quality: { name: string; usable: boolean; why: string; artifacts: string[] }[];
  /** Band summaries, one per site and band. */
  bands: { site: string; band: BandName; above_bg_db: MV; power: MV }[];
  tracks: {
    id: number;
    state: string;
    site: string;
    freq: MV;
    freq_se: number | null;
    freq_integrated: MV;
    height_db: MV;
    width_hz: MV;
    age_s: number;
    band: BandName;
  }[];
  dominant: number | null;
  /** phi and octave targets only. */
  pairs: { lo: number; hi: number; log_ratio: MV; harmonic: boolean; phi: WirePair; octave: WirePair }[];
  cascades: { phi: WireCascade; octave: WireCascade };
  states: { phi: WireState; octave: WireState; both: { active: boolean; for_s: number } };
  iaf_hz: number | null;
  mains_hz: number | null;
}
export interface WirePair { miss: MV; closeness: MV; aligned: boolean }

export interface FastMsg {
  type: 'fast';
  t: number;
  artifact: boolean;
  tracks: { id: number; freq: MV; amp_uv: MV; height_db: MV; phase: MV; locked: boolean }[];
}

export interface HeartMsg {
  type: 'heart';
  t: number;
  source: string;
  beats: { t: number; ibi_ms: number; flagged: boolean }[];
  hr_bpm: MV;
  rmssd_ms: MV;
  sdnn_ms: MV;
  lf_power: MV;
  hf_power: MV;
  resonance_hz: MV;
  resonance_strength: MV;
  breath_bpm: MV;
  breath_phase: MV;
  pacer_adherence: MV;
  corrected_fraction: number;
  high_hrv: { active: boolean; for_s: number; stat: MV };
  coupling: { brain: string; measure: string; value: MV; chance: MV; p: MV; suspect_artifact: boolean }[];
}

export type JsonMessage =
  | HelloMsg | StreamsMsg | MotionMsg | RrMsg | BatteryMsg | MarkerMsg | SlowMsg | FastMsg | HeartMsg;

export type DecodedMessage = JsonMessage | BinaryMessage;

// ---------------------------------------------------------------------------
// Frame encoders
// ---------------------------------------------------------------------------

const wireChance = (c: ChanceLevel): WireChance => ({ closeness: mv(c.closeness), p: mv(c.p), p_steps: mv(c.p_steps) });

function wireCascade(c: Cascade): WireCascade {
  return {
    steps: c.steps,
    tracks: c.tracks.slice(),
    closeness: mv(c.closeness),
    held_s: c.held_s,
    excess_a: mv(c.excess_a),
    excess_b: mv(c.excess_b),
    chance_a: wireChance(c.chance.a),
    chance_b: wireChance(c.chance.b),
  };
}

export function encodeSlow(f: SlowFrame): SlowMsg {
  const bands: SlowMsg['bands'] = [];
  for (const sp of f.spectra) {
    for (const band of Object.keys(sp.bands) as BandName[]) {
      const b = sp.bands[band];
      bands.push({ site: String(sp.site), band, above_bg_db: mv(b.above_bg_db), power: mv(b.power) });
    }
  }
  return {
    type: 'slow',
    t: f.t,
    window_s: f.window_s,
    quality: f.quality.map((q) => ({ name: q.name, usable: q.usable, why: q.why, artifacts: q.artifacts.slice() })),
    bands,
    tracks: f.tracks.map((tr) => ({
      id: tr.id,
      state: tr.state,
      site: String(tr.site),
      freq: mv(tr.freq),
      freq_se: tr.freq.se ?? null,
      freq_integrated: mv(tr.freq_integrated),
      height_db: mv(tr.height_db),
      width_hz: mv(tr.width_hz),
      age_s: tr.age_s,
      band: tr.band,
    })),
    dominant: f.dominant,
    pairs: f.pairs.map((p) => ({
      lo: p.lo,
      hi: p.hi,
      log_ratio: mv(p.log_ratio),
      harmonic: p.harmonic,
      phi: { miss: mv(p.targets.phi.miss), closeness: mv(p.targets.phi.closeness), aligned: p.targets.phi.aligned },
      octave: { miss: mv(p.targets.octave.miss), closeness: mv(p.targets.octave.closeness), aligned: p.targets.octave.aligned },
    })),
    cascades: { phi: wireCascade(f.cascades.phi), octave: wireCascade(f.cascades.octave) },
    states: {
      phi: { active: f.states.phi.active, for_s: f.states.phi.for_s, stat: mv(f.states.phi.stat) },
      octave: { active: f.states.octave.active, for_s: f.states.octave.for_s, stat: mv(f.states.octave.stat) },
      both: { active: f.states.both.active, for_s: f.states.both.for_s },
    },
    iaf_hz: f.iaf_hz,
    mains_hz: f.mains_hz,
  };
}

export function encodeFast(f: FastFrame): FastMsg {
  return {
    type: 'fast',
    t: f.t,
    artifact: f.artifact,
    tracks: f.tracks.map((tr) => ({
      id: tr.id,
      freq: mv(tr.freq),
      amp_uv: mv(tr.amp_uv),
      height_db: mv(tr.height_db),
      phase: mv(tr.phase),
      locked: tr.locked,
    })),
  };
}

export function encodeHeart(f: HeartFrame): HeartMsg {
  return {
    type: 'heart',
    t: f.t,
    source: f.source,
    beats: f.beats.map((b) => ({ t: b.t, ibi_ms: b.ibi_ms, flagged: b.flagged })),
    hr_bpm: mv(f.hr_bpm),
    rmssd_ms: mv(f.rmssd_ms),
    sdnn_ms: mv(f.sdnn_ms),
    lf_power: mv(f.lf_power),
    hf_power: mv(f.hf_power),
    resonance_hz: mv(f.resonance_hz),
    resonance_strength: mv(f.resonance_strength),
    breath_bpm: mv(f.breath_bpm),
    breath_phase: mv(f.breath_phase),
    pacer_adherence: mv(f.pacer_adherence),
    corrected_fraction: f.corrected_fraction,
    high_hrv: { active: f.high_hrv.active, for_s: f.high_hrv.for_s, stat: mv(f.high_hrv.stat) },
    coupling: f.coupling.map((c) => ({
      brain: c.brain,
      measure: c.measure,
      value: mv(c.value),
      chance: mv(c.chance),
      p: mv(c.p),
      suspect_artifact: c.suspect_artifact,
    })),
  };
}

export function encodeFrame(f: Frame): SlowMsg | FastMsg | HeartMsg {
  switch (f.kind) {
    case 'slow': return encodeSlow(f);
    case 'fast': return encodeFast(f);
    case 'heart': return encodeHeart(f);
  }
}

// ---------------------------------------------------------------------------
// Decoder (used by tests and any TypeScript consumer; the bridge has its own in Python)
// ---------------------------------------------------------------------------

export function decodeMessage(data: string | ArrayBuffer | ArrayBufferView): DecodedMessage {
  if (typeof data === 'string') {
    const obj = JSON.parse(data) as { type?: unknown };
    if (obj === null || typeof obj !== 'object' || typeof obj.type !== 'string') throw new Error('stream protocol: JSON message without type');
    return obj as JsonMessage;
  }
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  if (bytes.length < BINARY_HEADER_BYTES) throw new Error('stream protocol: binary message too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== BINARY_MAGIC) throw new Error('stream protocol: bad magic');
  const ver = dv.getUint8(1);
  if (ver !== PROTOCOL_VERSION) throw new Error(`stream protocol: unsupported version ${ver}`);
  const kind = dv.getUint8(2);
  const nChannels = dv.getUint8(3);
  const position = dv.getFloat64(4, true);
  const nSamples = dv.getUint32(12, true);
  const n = nChannels * nSamples;
  if (bytes.length !== BINARY_HEADER_BYTES + n * 4) throw new Error('stream protocol: binary length mismatch');
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getFloat32(BINARY_HEADER_BYTES + i * 4, true);
  if (kind !== BinaryKind.EEG && kind !== BinaryKind.PPG) throw new Error(`stream protocol: unknown binary kind ${kind}`);
  return { type: kind === BinaryKind.EEG ? 'eeg' : 'ppg', position, nChannels, nSamples, samples };
}
