import { describe, expect, it } from 'vitest';
import {
  classicAccelToG,
  classicEegToUv,
  classicGyroToDps,
  decode12BitBE,
  decode24BitBE,
  parseClassicEeg,
  parseClassicImu,
  parseClassicPpg,
  parseClassicTelemetry,
} from '../muse/classic';
import { ControlAccumulator, decodeResponseFragment, encodeCommand } from '../muse/control';
import { encodeClassicEeg, encodeClassicImu, encodeClassicPpg, encodeClassicTelemetry, encodeControlReply } from './encoder';

/**
 * Test vectors from muse-js src/lib/muse-parse.spec.ts (MIT, Uri Shaked and contributors),
 * described there as data "received from muse". Expected values copied from that file.
 */
describe('Classic decoders against muse-js test vectors', () => {
  const v = new Uint8Array([87, 33, 192, 82, 73, 6, 106, 242, 49, 64, 88, 153, 128, 66, 254, 44, 119, 157]);

  it('12-bit EEG unpacking', () => {
    expect(decode12BitBE(v, 12)).toEqual([1394, 448, 1316, 2310, 1711, 561, 1029, 2201, 2052, 766, 711, 1949]);
  });

  it('24-bit PPG unpacking', () => {
    expect(decode24BitBE(v, 6)).toEqual([5710272, 5392646, 7008817, 4216985, 8405758, 2914205]);
  });

  it('telemetry', () => {
    const t = parseClassicTelemetry(new Uint8Array([1, 74, 181, 184, 7, 64, 15, 127, 0, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))!;
    expect(t.seq).toBe(330);
    expect(t.batteryPercent).toBe(90.859375);
    expect(t.fuelGaugeMv).toBeCloseTo(4083.2, 9);
    expect(t.temperatureRaw).toBe(27);
  });

  it('accelerometer', () => {
    const p = parseClassicImu(new Uint8Array([82, 109, 13, 178, 13, 157, 60, 115, 18, 5, 13, 73, 60, 53, 17, 183, 17, 227, 60, 143]))!;
    expect(p.seq).toBe(21101);
    const g = p.raw.map(classicAccelToG);
    const want = [0.2139894112, 0.212707672, 0.94451972, 0.2815553776, 0.2075807152, 0.9407355376, 0.276794632, 0.2794801808, 0.9462287056];
    g.forEach((x, i) => expect(x).toBeCloseTo(want[i], 12));
  });

  it('gyroscope', () => {
    const p = parseClassicImu(new Uint8Array([1, 109, 5, 12, 0, 157, 0, 115, 5, 5, 0, 73, 0, 53, 5, 183, 0, 227, 0, 143]))!;
    expect(p.seq).toBe(365);
    const d = p.raw.map(classicGyroToDps);
    const want = [9.6600256, 1.1738576, 0.859832, 9.607688, 0.5458064, 0.3962704, 10.9385584, 1.6972336, 1.0691824];
    d.forEach((x, i) => expect(x).toBeCloseTo(want[i], 9));
  });

  it('control replies split across notifications', () => {
    const acc = new ControlAccumulator();
    const frags = ['{"ap":"headset",', '"sp":"RevE",', '"fw":"1.2.13",', '"rc":0}', '{"rc":0}', '{"hn":"Muse-1324",', '"bp":82,', '"rc":0}{"r', 'c":0}'];
    const out = frags.flatMap((f) => acc.push(f));
    expect(out).toEqual([{ ap: 'headset', sp: 'RevE', fw: '1.2.13', rc: 0 }, { rc: 0 }, { hn: 'Muse-1324', bp: 82, rc: 0 }, { rc: 0 }]);
  });
});

describe('Classic encode -> decode round trip (synthetic encoder)', () => {
  it('EEG: every 12-bit value, exact', () => {
    for (let base = 0; base < 4096; base += 12) {
      const raw = Array.from({ length: 12 }, (_, i) => (base + i * 341) % 4096);
      const p = parseClassicEeg(encodeClassicEeg(base & 0xffff, raw))!;
      expect(p.raw).toEqual(raw);
      expect(p.seq).toBe(base & 0xffff);
    }
    expect(classicEegToUv(2048)).toBe(0);
    expect(classicEegToUv(4095)).toBe(0.48828125 * 2047);
  });

  it('PPG, IMU, telemetry', () => {
    const ppg = [0, 1, 0xffffff, 123456, 0x800000, 42];
    expect(parseClassicPpg(encodeClassicPpg(65535, ppg))).toEqual({ seq: 65535, raw: ppg });
    const imu = [-32768, 32767, 0, -1, 1, 1000, -1000, 12345, -12345];
    expect(parseClassicImu(encodeClassicImu(7, imu))).toEqual({ seq: 7, raw: imu });
    expect(parseClassicTelemetry(encodeClassicTelemetry(3, 512 * 50))!.batteryPercent).toBe(50);
  });

  it('command encoding matches muse-js/muse-rs ("d" -> 02 64 0a)', () => {
    expect([...encodeCommand('d')]).toEqual([0x02, 0x64, 0x0a]);
    expect([...encodeCommand('p21')]).toEqual([0x04, 0x70, 0x32, 0x31, 0x0a]);
    expect(() => encodeCommand('x'.repeat(19))).toThrow();
  });

  it('reply fragments decode through the accumulator', () => {
    const acc = new ControlAccumulator();
    const json = '{"fw":"1.3.4","hw":"03.1","rc":0}';
    const out = encodeControlReply(json, 7).flatMap((n) => acc.push(decodeResponseFragment(n)));
    expect(out).toEqual([JSON.parse(json)]);
  });

  it('short packets are rejected, not misread', () => {
    expect(parseClassicEeg(new Uint8Array(19))).toBeNull();
    expect(parseClassicImu(new Uint8Array(19))).toBeNull();
    expect(parseClassicTelemetry(new Uint8Array(9))).toBeNull();
  });
});
