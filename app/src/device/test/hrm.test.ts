import { describe, expect, it } from 'vitest';
import { parseHeartRateMeasurement } from '../polar/hrm';
import type { DeviceInput } from '../types';
import { DeviceSlot } from '../types';
import { encodeHrm } from './encoder';
import { runPipelines } from './helpers';

describe('Heart Rate Measurement (0x2A37)', () => {
  it('8-bit rate, no contact feature, no RR', () => {
    expect(parseHeartRateMeasurement(Uint8Array.of(0x00, 72))).toEqual({ bpm: 72, contact: null, energyKj: null, rrRaw: [], rrMs: [] });
  });

  it('16-bit rate (flags bit 0), little endian', () => {
    expect(parseHeartRateMeasurement(Uint8Array.of(0x01, 0x2c, 0x01))!.bpm).toBe(300);
  });

  it('contact: bit 2 = supported, bit 1 = detected', () => {
    expect(parseHeartRateMeasurement(Uint8Array.of(0x06, 60))!.contact).toBe(true);
    expect(parseHeartRateMeasurement(Uint8Array.of(0x04, 60))!.contact).toBe(false);
    expect(parseHeartRateMeasurement(Uint8Array.of(0x02, 60))!.contact).toBeNull();
  });

  it('energy expended (bit 3) comes before RR intervals (bit 4); RR in 1/1024 s', () => {
    // flags 0x18: energy + RR; bpm 64; energy 0x0102; RR 1024 (1000 ms) and 512 (500 ms), oldest first
    const m = parseHeartRateMeasurement(Uint8Array.of(0x18, 64, 0x02, 0x01, 0x00, 0x04, 0x00, 0x02))!;
    expect(m.energyKj).toBe(258);
    expect(m.rrRaw).toEqual([1024, 512]);
    expect(m.rrMs).toEqual([1000, 500]);
  });

  it('a typical Polar H10 notification shape: flags 0x16, 8-bit rate, two RR values', () => {
    const m = parseHeartRateMeasurement(Uint8Array.of(0x16, 58, 0x1e, 0x04, 0x30, 0x04))!;
    expect(m).toMatchObject({ bpm: 58, contact: true, rrRaw: [0x041e, 0x0430] });
    expect(m.rrMs[0]).toBe((0x041e * 1000) / 1024); // 1054 / 1024 s = 1029.296875 ms
  });

  it('round trip through the test encoder, up to 9 RR values', () => {
    const rr = [700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500];
    expect(parseHeartRateMeasurement(encodeHrm({ bpm: 61, contact: true, rrRaw: rr }))!.rrRaw).toEqual(rr);
    expect(parseHeartRateMeasurement(encodeHrm({ bpm: 261, energyKj: 5, rrRaw: rr.slice(0, 7) }))).toMatchObject({ bpm: 261, energyKj: 5, rrRaw: rr.slice(0, 7) });
  });

  it('truncated packets are rejected', () => {
    expect(parseHeartRateMeasurement(Uint8Array.of(0x01, 0x2c))).toBeNull();
    expect(parseHeartRateMeasurement(Uint8Array.of(0x08, 60, 1))).toBeNull();
  });
});

describe('Chest strap timing', () => {
  const beat = (tUs: number, rr: number[]): DeviceInput => ({ type: 'raw', slot: DeviceSlot.CHEST_STRAP, char: 0x2a37, tUs, bytes: encodeHrm({ bpm: 60, rrRaw: rr }) });

  it('strap-only session: time 0 at the first notification', () => {
    const { got } = runPipelines([beat(3_000_000, [1024]), beat(4_000_000, [1024])], { eegRateHz: null });
    expect(got.rr.map((r) => r.t)).toEqual([0, 1]);
  });

  it('with a headset: beats wait for the EEG anchor; beats before session time 0 are dropped', () => {
    // A classic EEG stream (all-zero samples) anchors the session clock.
    const inputs: DeviceInput[] = [
      { type: 'link', slot: DeviceSlot.MUSE, tUs: 0, state: 'connected', config: { name: 'x', protocol: 'classic', eegChars: [3, 4, 5, 6], ppgChars: [] } },
      beat(500_000, [900]), // before the headset's first sample: held, then dropped
    ];
    for (let p = 0; p < 30; p++) {
      const tUs = 1_000_000 + Math.round(((p + 1) * 12 * 1e6) / 256) + 10_000;
      for (let ch = 0; ch < 4; ch++) {
        const b = new Uint8Array(20);
        b[0] = p >> 8; b[1] = p & 0xff;
        inputs.push({ type: 'raw', slot: DeviceSlot.MUSE, char: 3 + ch, tUs: tUs + ch, bytes: b });
      }
    }
    inputs.push(beat(1_510_000, [1000]));
    const { got, strap } = runPipelines(inputs, { settleSamples: 12 });
    expect(strap.stats.droppedBeforeZero).toBe(1);
    expect(got.rr.length).toBe(1);
    // EEG sample 0 was generated at host 1.0 s (+10 ms latency floor), so 1.51 s -> 0.5 s
    expect(got.rr[0].t).toBeCloseTo(0.5, 2);
  });
});
