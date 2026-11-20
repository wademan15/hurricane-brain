/**
 * Athena decoder (Muse S Athena). Pure functions.
 *
 * A notification on 0x0013 holds one or more packets back to back:
 *   [0]      packet length, header included
 *   [1]      packet counter (8-bit)
 *   [2..6)   device clock, u32 LE (meaning disputed between sources; not used for timing)
 *   [6..9)   unknown
 *   [9]      first subpacket tag, [10] its counter, [11..14) unknown, [14..] its payload
 *   then [tag][counter][3 unknown][payload] ... to the end of the packet.
 * Payload length is fixed per tag except 0x88, which runs to the end of its packet.
 * An unknown tag ends its packet; an impossible packet length ends the notification.
 *
 * Sources (NOTES.md): muse-rs parse.rs + docs/athena-protocol.md, OpenMuse decode.py,
 * muse-lsl athena.py (ported from BrainFlow). Checked against real captures from both
 * muse-rs and OpenMuse in test/athena.fixtures.test.ts.
 */
import { u16le, i16le, unpackUintLE } from '../bytes';
import {
  ACCEL_SCALE_G,
  ATHENA_BATTERY_DIVISOR,
  ATHENA_EEG_BITS,
  ATHENA_EEG_MIDPOINT,
  ATHENA_EEG_SCALE_UV,
  ATHENA_FIRST_TAG_OFFSET,
  ATHENA_GYRO_SCALE_DPS,
  ATHENA_OPTICS_BITS,
  ATHENA_PACKET_HEADER,
  ATHENA_SUBPACKET_HEADER,
  ATHENA_TAGS,
  type AthenaTagInfo,
} from './constants';

export interface AthenaSubpacket {
  tag: number;
  info: AthenaTagInfo;
  /** The sensor's own 8-bit counter. */
  counter: number;
  /** Counter of the packet this subpacket came in. */
  packetCounter: number;
  payload: Uint8Array;
}

export interface AthenaSplit {
  subpackets: AthenaSubpacket[];
  /** Bytes that could not be framed: impossible length or truncated packet. */
  droppedBytes: number;
  /** Subpackets skipped because of an unknown tag (the rest of that packet is lost). */
  unknownTags: number[];
}

export function splitAthenaNotification(data: Uint8Array): AthenaSplit {
  const subpackets: AthenaSubpacket[] = [];
  const unknownTags: number[] = [];
  let offset = 0;
  let droppedBytes = 0;
  while (offset < data.length) {
    const pktLen = data[offset];
    if (pktLen < ATHENA_PACKET_HEADER || offset + pktLen > data.length) {
      droppedBytes = data.length - offset;
      break;
    }
    const packet = data.subarray(offset, offset + pktLen);
    offset += pktLen;
    const packetCounter = packet[1];
    let idx = ATHENA_FIRST_TAG_OFFSET;
    while (idx + ATHENA_SUBPACKET_HEADER <= packet.length) {
      const tag = packet[idx];
      const info = ATHENA_TAGS[tag];
      if (!info) {
        unknownTags.push(tag);
        break;
      }
      const start = idx + ATHENA_SUBPACKET_HEADER;
      const len = info.len ?? packet.length - start;
      if (len <= 0 || start + len > packet.length) break;
      subpackets.push({ tag, info, counter: packet[idx + 1], packetCounter, payload: packet.subarray(start, start + len) });
      idx = start + len;
    }
  }
  return { subpackets, droppedBytes, unknownTags };
}

/** Raw integers of a subpacket, sample-major (every channel's first sample, then the second...). */
export function athenaRaw(sp: AthenaSubpacket): number[] {
  const { kind, channels, samples } = sp.info;
  switch (kind) {
    case 'eeg':
      return unpackUintLE(sp.payload, ATHENA_EEG_BITS, channels * samples);
    case 'optics':
      return unpackUintLE(sp.payload, ATHENA_OPTICS_BITS, channels * samples);
    case 'imu': {
      const out: number[] = [];
      for (let i = 0; i < 18; i++) out.push(i16le(sp.payload, i * 2));
      return out;
    }
    case 'drlref': {
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push(u16le(sp.payload, i * 2));
      return out;
    }
    case 'battery':
      return sp.payload.length >= 2 ? [u16le(sp.payload, 0)] : [];
  }
}

export function athenaEegToUv(raw: number): number {
  return (raw - ATHENA_EEG_MIDPOINT) * ATHENA_EEG_SCALE_UV;
}
export const athenaAccelToG = (raw: number) => raw * ACCEL_SCALE_G;
export const athenaGyroToDps = (raw: number) => raw * ATHENA_GYRO_SCALE_DPS;
export const athenaBatteryPercent = (raw: number) => raw / ATHENA_BATTERY_DIVISOR;
