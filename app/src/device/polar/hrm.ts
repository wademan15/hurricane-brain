/**
 * Heart Rate Measurement (0x2A37), Bluetooth SIG Heart Rate Service. Pure functions.
 *
 * Flags (byte 0), per the Heart Rate Service spec v1.0 (bluetooth.com HRS_v1.0):
 *   bit 0  heart rate value format: 0 = UINT8, 1 = UINT16
 *   bit 1  sensor contact detected (meaningful only if bit 2 is set)
 *   bit 2  sensor contact feature supported
 *   bit 3  Energy Expended present (UINT16, kJ)
 *   bit 4  one or more RR-Interval values present
 * Field order: flags, heart rate, [energy expended], [RR-intervals...]. All little endian.
 * RR-Interval: UINT16, resolution 1/1024 s, oldest first (GATT Specification Supplement as
 * implemented by Google Bumble heart_rate_service.py and Adafruit's BLE heart rate library).
 */
export const HEART_RATE_SERVICE = 0x180d;
export const HEART_RATE_MEASUREMENT = 0x2a37;
export const BATTERY_SERVICE = 0x180f;
export const BATTERY_LEVEL = 0x2a19;

export interface HeartRateMeasurement {
  bpm: number;
  /** null when the strap does not support contact detection. */
  contact: boolean | null;
  energyKj: number | null;
  /** Raw RR values in 1/1024 s units. */
  rrRaw: number[];
  /** RR intervals in milliseconds (raw * 1000 / 1024). */
  rrMs: number[];
}

export function parseHeartRateMeasurement(d: Uint8Array): HeartRateMeasurement | null {
  if (d.length < 2) return null;
  const flags = d[0];
  let o = 1;
  let bpm: number;
  if (flags & 0x01) {
    if (d.length < 3) return null;
    bpm = d[1] | (d[2] << 8);
    o = 3;
  } else {
    bpm = d[1];
    o = 2;
  }
  const contact = flags & 0x04 ? (flags & 0x02) !== 0 : null;
  let energyKj: number | null = null;
  if (flags & 0x08) {
    if (d.length < o + 2) return null;
    energyKj = d[o] | (d[o + 1] << 8);
    o += 2;
  }
  const rrRaw: number[] = [];
  if (flags & 0x10) {
    for (; o + 1 < d.length; o += 2) rrRaw.push(d[o] | (d[o + 1] << 8));
  }
  return { bpm, contact, energyKj, rrRaw, rrMs: rrRaw.map((r) => (r * 1000) / 1024) };
}
