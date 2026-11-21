/**
 * TEST ONLY. Synthetic packet encoder: the inverse of the decoders, written from the same
 * documented layouts, so known values can be pushed through the real decode path.
 */
import { packUintLE } from '../bytes';
import { ATHENA_TAGS } from '../muse/constants';

// ---- Classic ---------------------------------------------------------------

function u16be(seq: number): [number, number] {
  return [(seq >> 8) & 0xff, seq & 0xff];
}

/** 12 raw 12-bit values -> 20-byte EEG notification. */
export function encodeClassicEeg(seq: number, raw: readonly number[]): Uint8Array {
  if (raw.length !== 12) throw new Error('12 samples');
  const out = new Uint8Array(20);
  [out[0], out[1]] = u16be(seq);
  for (let i = 0; i < 6; i++) {
    const a = raw[2 * i], b = raw[2 * i + 1];
    if (a < 0 || a > 4095 || b < 0 || b > 4095) throw new RangeError('12-bit');
    out[2 + 3 * i] = a >> 4;
    out[3 + 3 * i] = ((a & 0xf) << 4) | (b >> 8);
    out[4 + 3 * i] = b & 0xff;
  }
  return out;
}

export function encodeClassicPpg(seq: number, raw: readonly number[]): Uint8Array {
  if (raw.length !== 6) throw new Error('6 samples');
  const out = new Uint8Array(20);
  [out[0], out[1]] = u16be(seq);
  raw.forEach((v, i) => {
    out[2 + 3 * i] = (v >> 16) & 0xff;
    out[3 + 3 * i] = (v >> 8) & 0xff;
    out[4 + 3 * i] = v & 0xff;
  });
  return out;
}

/** 9 raw i16 (x0 y0 z0 x1 ... z2) -> 20-byte accelerometer/gyroscope notification. */
export function encodeClassicImu(seq: number, raw: readonly number[]): Uint8Array {
  if (raw.length !== 9) throw new Error('9 values');
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, seq, false);
  raw.forEach((v, i) => dv.setInt16(2 + 2 * i, v, false));
  return out;
}

export function encodeClassicTelemetry(seq: number, batteryRaw: number, fuelRaw = 0, tempRaw = 0): Uint8Array {
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, seq, false);
  dv.setUint16(2, batteryRaw, false);
  dv.setUint16(4, fuelRaw, false);
  dv.setUint16(8, tempRaw, false);
  return out;
}

/** Control reply notifications: JSON split into fragments of at most 19 bytes, [len][text]. */
export function encodeControlReply(json: string, fragment = 10): Uint8Array[] {
  const bytes = new TextEncoder().encode(json);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += fragment) {
    const part = bytes.subarray(i, i + fragment);
    const n = new Uint8Array(20);
    n[0] = part.length;
    n.set(part, 1);
    out.push(n);
  }
  return out;
}

// ---- Athena ------------------------------------------------------------------

export interface SubpacketSpec {
  tag: number;
  counter: number;
  /** Raw integers, sample-major; or `payload` for tags without an integer layout. */
  raw?: readonly number[];
  payload?: Uint8Array;
}

export function athenaPayload(spec: SubpacketSpec): Uint8Array {
  if (spec.payload) return spec.payload;
  const info = ATHENA_TAGS[spec.tag];
  const raw = spec.raw ?? [];
  if (!info) throw new Error(`unknown tag ${spec.tag}`);
  switch (info.kind) {
    case 'eeg': return packUintLE(raw, 14);
    case 'optics': return packUintLE(raw, 20);
    case 'imu': {
      const out = new Uint8Array(36);
      const dv = new DataView(out.buffer);
      raw.forEach((v, i) => dv.setInt16(i * 2, v, true));
      return out;
    }
    case 'drlref': {
      const out = new Uint8Array(24);
      const dv = new DataView(out.buffer);
      raw.forEach((v, i) => dv.setUint16(i * 2, v, true));
      return out;
    }
    case 'battery': {
      const out = new Uint8Array(info.len ?? 2);
      new DataView(out.buffer).setUint16(0, raw[0] ?? 0, true);
      return out;
    }
  }
}

/** One packet: 14-byte header (first subpacket's tag/counter at 9/10), then the rest. */
export function encodeAthenaPacket(packetCounter: number, subs: readonly SubpacketSpec[], deviceClock = 0): Uint8Array {
  if (subs.length === 0) throw new Error('a packet needs at least one subpacket');
  const parts: number[] = [];
  subs.forEach((s, i) => {
    const payload = athenaPayload(s);
    void i; // the first subpacket's tag/counter sit in header bytes 9/10, the same shape as the rest
    parts.push(s.tag, s.counter & 0xff, 0, 0, 0, ...payload);
  });
  const len = 9 + parts.length;
  if (len > 255) throw new Error(`packet too long: ${len}`);
  const out = new Uint8Array(len);
  out[0] = len;
  out[1] = packetCounter & 0xff;
  new DataView(out.buffer).setUint32(2, deviceClock >>> 0, true);
  out.set(parts, 9);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- Heart Rate Measurement -------------------------------------------------------

export function encodeHrm(m: { bpm: number; contact?: boolean | null; energyKj?: number | null; rrRaw?: readonly number[] }): Uint8Array {
  const bytes: number[] = [];
  let flags = 0;
  if (m.bpm > 255) {
    flags |= 0x01;
    bytes.push(m.bpm & 0xff, m.bpm >> 8);
  } else {
    bytes.push(m.bpm);
  }
  if (m.contact !== undefined && m.contact !== null) flags |= 0x04 | (m.contact ? 0x02 : 0);
  if (m.energyKj !== undefined && m.energyKj !== null) {
    flags |= 0x08;
    bytes.push(m.energyKj & 0xff, m.energyKj >> 8);
  }
  if (m.rrRaw && m.rrRaw.length) {
    flags |= 0x10;
    for (const r of m.rrRaw) bytes.push(r & 0xff, r >> 8);
  }
  return Uint8Array.from([flags, ...bytes]);
}
