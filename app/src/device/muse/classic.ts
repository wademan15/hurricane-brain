/**
 * Classic Muse decoders (Muse 2016, Muse 2, Muse S on pre-Athena firmware). Pure functions.
 *
 * Wire formats (sources in NOTES.md: muse-js muse-parse.ts, muse-rs parse.rs, muse-lsl muse.py):
 *  EEG    (0x0003..0x0007): u16 BE packet index, then 12 samples of 12 bits, big-endian packed
 *                           (3 bytes -> 2 samples). 20 bytes.
 *  PPG    (0x000f..0x0011): u16 BE index, then 6 samples of 24 bits BE unsigned. 20 bytes.
 *  ACCEL/GYRO (0x000a/0x0009): u16 BE sequence, then 3 samples of (x, y, z) i16 BE. 20 bytes.
 *  TELEMETRY (0x000b): u16 BE sequence, u16 BE battery (/512 = %), u16 BE fuel gauge (*2.2 = mV),
 *                      u16 BE unknown, u16 BE temperature (raw).
 */
import { i16be, u16be } from '../bytes';
import {
  ACCEL_SCALE_G,
  CLASSIC_BATTERY_DIVISOR,
  CLASSIC_EEG_MIDPOINT,
  CLASSIC_EEG_SAMPLES_PER_PACKET,
  CLASSIC_EEG_SCALE_UV,
  CLASSIC_GYRO_SCALE_DPS,
  CLASSIC_IMU_SAMPLES_PER_PACKET,
  CLASSIC_PPG_SAMPLES_PER_PACKET,
} from './constants';

export interface ClassicPacket {
  /** The 16-bit packet index / sequence id. */
  seq: number;
  /** Raw integers as sent. */
  raw: number[];
}

/** Big-endian 12-bit unpack: [AA BB CC] -> (AA<<4 | BB>>4), ((BB&0xF)<<8 | CC). */
export function decode12BitBE(data: Uint8Array, count: number, offset = 0): number[] {
  const out: number[] = [];
  for (let i = offset; out.length < count && i + 1 < data.length; i += 3) {
    out.push((data[i] << 4) | (data[i + 1] >> 4));
    if (out.length < count && i + 2 < data.length) out.push(((data[i + 1] & 0x0f) << 8) | data[i + 2]);
  }
  return out;
}

export function decode24BitBE(data: Uint8Array, count: number, offset = 0): number[] {
  const out: number[] = [];
  for (let i = offset; out.length < count && i + 2 < data.length; i += 3) {
    out.push(data[i] * 65536 + (data[i + 1] << 8) + data[i + 2]);
  }
  return out;
}

/** EEG packet -> seq + 12 raw 12-bit values. Null if the payload is too short. */
export function parseClassicEeg(data: Uint8Array): ClassicPacket | null {
  if (data.length < 2 + 18) return null;
  const raw = decode12BitBE(data, CLASSIC_EEG_SAMPLES_PER_PACKET, 2);
  if (raw.length !== CLASSIC_EEG_SAMPLES_PER_PACKET) return null;
  return { seq: u16be(data, 0), raw };
}

export function classicEegToUv(raw: number): number {
  return CLASSIC_EEG_SCALE_UV * (raw - CLASSIC_EEG_MIDPOINT);
}

export function parseClassicPpg(data: Uint8Array): ClassicPacket | null {
  if (data.length < 2 + 18) return null;
  return { seq: u16be(data, 0), raw: decode24BitBE(data, CLASSIC_PPG_SAMPLES_PER_PACKET, 2) };
}

/** Accelerometer or gyroscope packet -> seq + 9 raw i16 (x0,y0,z0,x1,y1,z1,x2,y2,z2). */
export function parseClassicImu(data: Uint8Array): ClassicPacket | null {
  if (data.length < 20) return null;
  const raw: number[] = [];
  for (let s = 0; s < CLASSIC_IMU_SAMPLES_PER_PACKET; s++) {
    for (let a = 0; a < 3; a++) raw.push(i16be(data, 2 + s * 6 + a * 2));
  }
  return { seq: u16be(data, 0), raw };
}

export const classicAccelToG = (raw: number) => raw * ACCEL_SCALE_G;
export const classicGyroToDps = (raw: number) => raw * CLASSIC_GYRO_SCALE_DPS;

export interface ClassicTelemetry {
  seq: number;
  batteryPercent: number;
  fuelGaugeMv: number;
  temperatureRaw: number;
}

export function parseClassicTelemetry(data: Uint8Array): ClassicTelemetry | null {
  if (data.length < 10) return null;
  return {
    seq: u16be(data, 0),
    batteryPercent: u16be(data, 2) / CLASSIC_BATTERY_DIVISOR,
    fuelGaugeMv: u16be(data, 4) * 2.2,
    temperatureRaw: u16be(data, 8),
  };
}
