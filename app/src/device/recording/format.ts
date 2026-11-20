/**
 * The raw session file, "HBRAW" version 1. Documented in app/src/device/README.md.
 *
 *   magic   8 bytes  'H' 'B' 'R' 'A' 'W' 0x00, then u16 LE format version (1)
 *   hlen    u32 LE   length of the header
 *   header  hlen bytes of UTF-8 JSON (RecordingHeader)
 *   records until end of file, each:
 *     kind   u8
 *     dt     zigzag varint   arrival time minus the previous record's, integer microseconds
 *     len    varint          body length in bytes
 *     body   len bytes       (layout per kind below; little endian; unknown kinds are skipped)
 *
 * Inputs (what the decoders consume; replaying these re-decodes the session):
 *   1 RAW      u8 slot, u16 char, notification bytes
 *   2 LINK     u8 slot, u8 state (1 connected, 0 disconnected), UTF-8 JSON LinkConfig (may be empty)
 * Decoded outputs (kept so a file is usable without the decoder, and to prove replay equality):
 *  16 STREAMS  JSON StreamDescription
 *  17 EEG      varint firstIndex, u8 nChannels, f32[] samples
 *  18 PPG      f64 t, u8 nChannels, f32[] samples
 *  19 MOTION   f64 t, f32 acc[3], f32 gyro[3]
 *  20 RR       f64 t, f32[] rrMs
 *  21 HR       f64 t, f32 bpm, u8 contact (0 no, 1 yes, 2 not reported)
 *  22 BATTERY  u8 slot, u8 hasT, f64 t, f32 percent
 *  23 GAP      JSON GapEvent
 *  24 INFO     u8 slot, JSON
 *  32 NOTE     JSON (free-form annotation by the app)
 * Decoded records carry the arrival time of the input that produced them.
 */
import type { StreamDescription } from '../../engine/frames';
import type {
  BatteryEvent,
  DeviceInput,
  DeviceSlot,
  EegEvent,
  GapEvent,
  HeartRateEvent,
  InfoEvent,
  LinkConfig,
  MotionEvent,
  PpgEvent,
  RrEvent,
} from '../types';

export const FORMAT_VERSION = 1;
const MAGIC = [0x48, 0x42, 0x52, 0x41, 0x57, 0x00];

export const RecordKind = {
  RAW: 1,
  LINK: 2,
  STREAMS: 16,
  EEG: 17,
  PPG: 18,
  MOTION: 19,
  RR: 20,
  HR: 21,
  BATTERY: 22,
  GAP: 23,
  INFO: 24,
  NOTE: 32,
} as const;

export interface RecordingHeader {
  format: 'hurricane-brain-raw';
  version: number;
  createdAt: string;
  /** How the session clock was configured. Replay rebuilds it from this. */
  clock: { eegRateHz: number | null; settleSamples?: number };
  /** Free description of the devices, for people reading the file. */
  devices: { slot: DeviceSlot; kind: 'muse' | 'chest_strap'; name: string | null }[];
  /** Anything else the app wants to keep (engine version, seed...). */
  meta?: Record<string, unknown>;
}

export type RecordedEvent =
  | { kind: 'input'; tUs: number; input: DeviceInput }
  | { kind: 'streams'; tUs: number; streams: StreamDescription }
  | { kind: 'eeg'; tUs: number; ev: EegEvent }
  | { kind: 'ppg'; tUs: number; ev: PpgEvent }
  | { kind: 'motion'; tUs: number; ev: MotionEvent }
  | { kind: 'rr'; tUs: number; ev: RrEvent }
  | { kind: 'heartRate'; tUs: number; ev: HeartRateEvent }
  | { kind: 'battery'; tUs: number; ev: BatteryEvent }
  | { kind: 'gap'; tUs: number; ev: GapEvent }
  | { kind: 'info'; tUs: number; ev: InfoEvent }
  | { kind: 'note'; tUs: number; json: unknown };

// ---------------------------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  private dv = new DataView(this.buf.buffer);

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }
  u8(v: number) { this.ensure(1); this.buf[this.length++] = v; }
  u16(v: number) { this.ensure(2); this.dv.setUint16(this.length, v, true); this.length += 2; }
  u32(v: number) { this.ensure(4); this.dv.setUint32(this.length, v, true); this.length += 4; }
  f32(v: number) { this.ensure(4); this.dv.setFloat32(this.length, v, true); this.length += 4; }
  f64(v: number) { this.ensure(8); this.dv.setFloat64(this.length, v, true); this.length += 8; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.length); this.length += b.length; }
  /** Unsigned LEB128 for integers up to 2^53. */
  varint(v: number) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`varint ${v}`);
    this.ensure(8);
    while (v >= 0x80) {
      this.buf[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.length++] = v;
  }
  zigzag(v: number) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
  f32s(a: Float32Array) { for (const x of a) this.f32(x); }
  json(v: unknown) { this.bytes(new TextEncoder().encode(JSON.stringify(v))); }
  result(): Uint8Array { return this.buf.slice(0, this.length); }
}

class ByteReader {
  pos = 0;
  readonly d: Uint8Array;
  private readonly dv: DataView;
  constructor(d: Uint8Array) {
    this.d = d;
    this.dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  need(n: number) { if (this.pos + n > this.d.length) throw new Error('truncated recording'); }
  u8() { this.need(1); return this.d[this.pos++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  bytes(n: number) { this.need(n); const b = this.d.slice(this.pos, this.pos + n); this.pos += n; return b; }
  varint() {
    let v = 0, mul = 1;
    for (;;) {
      const b = this.u8();
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 0x80;
      if (mul > 2 ** 56) throw new Error('varint too long');
    }
  }
  zigzag() { const z = this.varint(); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
  f32s(end: number) { const n = (end - this.pos) / 4; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  json(end: number): unknown { const b = this.bytes(end - this.pos); return b.length ? JSON.parse(new TextDecoder().decode(b)) : null; }
}

// ---------------------------------------------------------------------------

/** Streaming writer. Records must be appended in arrival order. */
export class RecordingWriter {
  private w = new ByteWriter();
  private lastTUs = 0;

  constructor(header: RecordingHeader) {
    for (const b of MAGIC) this.w.u8(b);
    this.w.u16(FORMAT_VERSION);
    const h = new TextEncoder().encode(JSON.stringify(header));
    this.w.u32(h.length);
    this.w.bytes(h);
  }

  get byteLength(): number {
    return this.w.length;
  }

  private record(kind: number, tUs: number, body: ByteWriter): void {
    if (!Number.isSafeInteger(tUs)) throw new RangeError(`arrival time must be integer microseconds, got ${tUs}`);
    this.w.u8(kind);
    this.w.zigzag(tUs - this.lastTUs);
    this.lastTUs = tUs;
    this.w.varint(body.length);
    this.w.bytes(body.result());
  }

  input(input: DeviceInput): void {
    const b = new ByteWriter();
    if (input.type === 'raw') {
      b.u8(input.slot);
      b.u16(input.char);
      b.bytes(input.bytes);
      this.record(RecordKind.RAW, input.tUs, b);
    } else {
      b.u8(input.slot);
      b.u8(input.state === 'connected' ? 1 : 0);
      if (input.config) b.json(input.config);
      this.record(RecordKind.LINK, input.tUs, b);
    }
  }

  event(e: Exclude<RecordedEvent, { kind: 'input' }>): void {
    const b = new ByteWriter();
    switch (e.kind) {
      case 'streams': b.json(e.streams); return this.record(RecordKind.STREAMS, e.tUs, b);
      case 'eeg': b.varint(e.ev.firstIndex); b.u8(e.ev.nChannels); b.f32s(e.ev.samples); return this.record(RecordKind.EEG, e.tUs, b);
      case 'ppg': b.f64(e.ev.t); b.u8(e.ev.nChannels); b.f32s(e.ev.samples); return this.record(RecordKind.PPG, e.tUs, b);
      case 'motion': b.f64(e.ev.t); b.f32s(e.ev.acc); b.f32s(e.ev.gyro); return this.record(RecordKind.MOTION, e.tUs, b);
      case 'rr': b.f64(e.ev.t); b.f32s(e.ev.rrMs); return this.record(RecordKind.RR, e.tUs, b);
      case 'heartRate': b.f64(e.ev.t); b.f32(e.ev.bpm); b.u8(e.ev.contact === null ? 2 : e.ev.contact ? 1 : 0); return this.record(RecordKind.HR, e.tUs, b);
      case 'battery': b.u8(e.ev.slot); b.u8(e.ev.t === null ? 0 : 1); b.f64(e.ev.t ?? 0); b.f32(e.ev.percent); return this.record(RecordKind.BATTERY, e.tUs, b);
      case 'gap': b.json(e.ev); return this.record(RecordKind.GAP, e.tUs, b);
      case 'info': b.u8(e.ev.slot); b.json(e.ev.json); return this.record(RecordKind.INFO, e.tUs, b);
      case 'note': b.json(e.json); return this.record(RecordKind.NOTE, e.tUs, b);
    }
  }

  finish(): Uint8Array {
    return this.w.result();
  }
}

export interface ParsedRecording {
  header: RecordingHeader;
  records: RecordedEvent[];
  /** Records of kinds this reader does not know (skipped). */
  skipped: number;
}

export function readRecording(data: Uint8Array): ParsedRecording {
  const r = new ByteReader(data);
  for (const b of MAGIC) if (r.u8() !== b) throw new Error('not a Hurricane Brain raw recording');
  const version = r.u16();
  if (version > FORMAT_VERSION) throw new Error(`recording format ${version} is newer than this reader (${FORMAT_VERSION})`);
  const hlen = r.u32();
  const header = JSON.parse(new TextDecoder().decode(r.bytes(hlen))) as RecordingHeader;
  const records: RecordedEvent[] = [];
  let tUs = 0;
  let skipped = 0;
  while (r.pos < data.length) {
    const kind = r.u8();
    tUs += r.zigzag();
    const len = r.varint();
    r.need(len);
    const end = r.pos + len;
    switch (kind) {
      case RecordKind.RAW: {
        const slot = r.u8() as DeviceSlot;
        const char = r.u16();
        records.push({ kind: 'input', tUs, input: { type: 'raw', slot, char, tUs, bytes: r.bytes(end - r.pos) } });
        break;
      }
      case RecordKind.LINK: {
        const slot = r.u8() as DeviceSlot;
        const state = r.u8() === 1 ? 'connected' : 'disconnected';
        const config = r.json(end) as LinkConfig | null;
        records.push({ kind: 'input', tUs, input: { type: 'link', slot, tUs, state, ...(config ? { config } : {}) } });
        break;
      }
      case RecordKind.STREAMS: records.push({ kind: 'streams', tUs, streams: r.json(end) as StreamDescription }); break;
      case RecordKind.EEG: {
        const firstIndex = r.varint();
        const nChannels = r.u8();
        const samples = r.f32s(end);
        records.push({ kind: 'eeg', tUs, ev: { firstIndex, nChannels, nSamples: samples.length / nChannels, samples } });
        break;
      }
      case RecordKind.PPG: {
        const t = r.f64();
        const nChannels = r.u8();
        const samples = r.f32s(end);
        records.push({ kind: 'ppg', tUs, ev: { t, nChannels, nSamples: samples.length / nChannels, samples } });
        break;
      }
      case RecordKind.MOTION: {
        const t = r.f64();
        const acc = Float32Array.of(r.f32(), r.f32(), r.f32());
        const gyro = Float32Array.of(r.f32(), r.f32(), r.f32());
        records.push({ kind: 'motion', tUs, ev: { t, acc, gyro } });
        break;
      }
      case RecordKind.RR: { const t = r.f64(); records.push({ kind: 'rr', tUs, ev: { t, rrMs: r.f32s(end) } }); break; }
      case RecordKind.HR: {
        const t = r.f64();
        const bpm = r.f32();
        const c = r.u8();
        records.push({ kind: 'heartRate', tUs, ev: { t, bpm, contact: c === 2 ? null : c === 1 } });
        break;
      }
      case RecordKind.BATTERY: {
        const slot = r.u8() as DeviceSlot;
        const hasT = r.u8() === 1;
        const t = r.f64();
        records.push({ kind: 'battery', tUs, ev: { slot, t: hasT ? t : null, percent: r.f32() } });
        break;
      }
      case RecordKind.GAP: records.push({ kind: 'gap', tUs, ev: r.json(end) as GapEvent }); break;
      case RecordKind.INFO: { const slot = r.u8() as DeviceSlot; records.push({ kind: 'info', tUs, ev: { slot, json: r.json(end) as Record<string, unknown> } }); break; }
      case RecordKind.NOTE: records.push({ kind: 'note', tUs, json: r.json(end) }); break;
      default: skipped++;
    }
    r.pos = end;
  }
  return { header, records, skipped };
}
