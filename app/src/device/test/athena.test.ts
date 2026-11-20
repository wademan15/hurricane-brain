import { describe, expect, it } from 'vitest';
import { hexToBytes, packUintLE, unpackUintLE } from '../bytes';
import { athenaBatteryPercent, athenaEegToUv, athenaRaw, splitAthenaNotification } from '../muse/athena';
import { ATHENA_EEG_SCALE_UV } from '../muse/constants';
import { concatBytes, encodeAthenaPacket } from './encoder';

// Real captures, as text: muse-rs tests/fixtures (Apache-2.0) and OpenMuse tests/test_data (MIT).
// Each *.ref.json was produced by test/tools/make_reference.py, which decodes every notification
// with BOTH reference decoders and stores their (agreeing) output.
const fixtures = import.meta.glob('./fixtures/*.{txt,hex}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const refs = import.meta.glob('./fixtures/*.ref.json', { import: 'default', eager: true }) as Record<
  string,
  { notifications: { tag: number; counter: number; raw: number[] }[][] }
>;

function lines(text: string): Uint8Array[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => hexToBytes(l.split('\t').pop()!));
}

describe('Athena decoder against real captures (muse-rs + OpenMuse reference output)', () => {
  const names = Object.keys(fixtures).sort();
  it('has fixtures', () => expect(names.length).toBeGreaterThanOrEqual(8));

  for (const name of names) {
    it(`${name.replace('./fixtures/', '')}: every subpacket's tag, counter and raw values are identical`, () => {
      const ref = refs[`${name}.ref.json`];
      expect(ref).toBeDefined();
      const notes = lines(fixtures[name]);
      expect(notes.length).toBe(ref.notifications.length);
      let compared = 0;
      notes.forEach((bytes, i) => {
        const split = splitAthenaNotification(bytes);
        expect(split.droppedBytes).toBe(0);
        expect(split.unknownTags).toEqual([]);
        // The references skip 0x53 (OpenMuse does not decode it); so do we, for the comparison.
        const ours = split.subpackets.filter((s) => s.tag !== 0x53).map((s) => ({ tag: s.tag, counter: s.counter, raw: athenaRaw(s) }));
        expect(ours).toEqual(ref.notifications[i]);
        compared += ours.length;
      });
      expect(compared).toBeGreaterThan(300);
    });
  }

  it('per-tag counters advance by one across first and later subpackets (OpenMuse captures)', () => {
    for (const name of Object.keys(fixtures).filter((n) => n.includes('openmuse'))) {
      const last = new Map<number, number>();
      for (const bytes of lines(fixtures[name])) {
        for (const sp of splitAthenaNotification(bytes).subpackets) {
          const prev = last.get(sp.tag);
          if (prev !== undefined) expect((sp.counter - prev + 256) % 256, `${name} tag ${sp.tag}`).toBe(1);
          last.set(sp.tag, sp.counter);
        }
      }
    }
  });

  it('battery: captures at known levels read within 0.5 % (OpenMuse test names 16.80, 58.27, 90.40)', () => {
    const want: Record<string, number> = { '16_80': 16.8, '58_27': 58.27, '90_40': 90.4 };
    for (const [key, level] of Object.entries(want)) {
      const name = Object.keys(fixtures).find((n) => n.includes(key))!;
      const values = lines(fixtures[name]).flatMap((b) =>
        splitAthenaNotification(b).subpackets.filter((s) => s.info.kind === 'battery').map((s) => athenaBatteryPercent(athenaRaw(s)[0])),
      );
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(Math.abs(v - level)).toBeLessThan(0.5);
    }
  });

  it('a short 0x88 battery block (fw 3.1.19) is read to the end of its packet', () => {
    const name = Object.keys(fixtures).find((n) => n.includes('musers'))!;
    const b = lines(fixtures[name])[42];
    const sps = splitAthenaNotification(b).subpackets;
    expect(sps.map((s) => s.tag)).toEqual([0x47, 0x88]);
    expect(sps[1].payload.length).toBe(151);
  });
});

describe('Athena encode -> decode round trip (synthetic encoder)', () => {
  it('14- and 20-bit LSB-first packing is exact for edge values', () => {
    const v14 = [0, 1, 8191, 8192, 16383, 1234, 4321, 16000, 2, 3, 5, 8, 13, 21, 34, 55];
    expect(unpackUintLE(packUintLE(v14, 14), 14, 16)).toEqual(v14);
    const v20 = [0, 1, 1048575, 524288, 99999, 777777, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(unpackUintLE(packUintLE(v20, 20), 20, 16)).toEqual(v20);
  });

  it('multi-packet notification with every tag decodes to the encoded values', () => {
    const eeg8 = Array.from({ length: 16 }, (_, i) => (i * 1021) % 16384);
    const eeg4 = Array.from({ length: 16 }, (_, i) => 16383 - i * 7);
    const opt4 = Array.from({ length: 12 }, (_, i) => i * 87381);
    const opt8 = Array.from({ length: 16 }, (_, i) => 1048575 - i);
    const opt16 = Array.from({ length: 16 }, (_, i) => i * 65535);
    const imu = Array.from({ length: 18 }, (_, i) => (i % 2 ? -1 : 1) * i * 1800);
    const drl = Array.from({ length: 12 }, (_, i) => 8200 + i);
    const p1 = encodeAthenaPacket(5, [
      { tag: 0x12, counter: 255, raw: eeg8 },
      { tag: 0x36, counter: 0, raw: opt16 },
      { tag: 0x47, counter: 9, raw: imu },
      { tag: 0x53, counter: 1, raw: drl },
    ]);
    const p2 = encodeAthenaPacket(6, [
      { tag: 0x11, counter: 3, raw: eeg4 },
      { tag: 0x34, counter: 4, raw: opt4 },
      { tag: 0x35, counter: 5, raw: opt8 },
      { tag: 0x98, counter: 6, raw: [Math.round(42.5 * 256)] },
    ]);
    const p3 = encodeAthenaPacket(7, [{ tag: 0x47, counter: 10, raw: imu }, { tag: 0x88, counter: 2, payload: Uint8Array.from([0x00, 0x32, 9, 9, 9, 9, 9]) }]);
    const split = splitAthenaNotification(concatBytes([p1, p2, p3]));
    expect(split.droppedBytes).toBe(0);
    const got = split.subpackets.map((s) => [s.tag, s.counter, s.packetCounter, athenaRaw(s)]);
    expect(got).toEqual([
      [0x12, 255, 5, eeg8],
      [0x36, 0, 5, opt16],
      [0x47, 9, 5, imu],
      [0x53, 1, 5, drl],
      [0x11, 3, 6, eeg4],
      [0x34, 4, 6, opt4],
      [0x35, 5, 6, opt8],
      [0x98, 6, 6, [Math.round(42.5 * 256)]],
      [0x47, 10, 7, imu],
      [0x88, 2, 7, [0x3200]],
    ]);
    expect(athenaBatteryPercent(0x3200)).toBe(50);
  });

  it('EEG scaling: midpoint is 0 µV, full scale is ±725 µV', () => {
    expect(athenaEegToUv(8192)).toBe(0);
    expect(athenaEegToUv(16383)).toBeCloseTo(8191 * ATHENA_EEG_SCALE_UV, 12);
    expect(athenaEegToUv(16383) - athenaEegToUv(0)).toBeCloseTo(1450, 9);
  });

  it('an unknown tag ends its packet but not the notification; a bad length ends the notification', () => {
    const good = encodeAthenaPacket(1, [{ tag: 0x47, counter: 1, raw: new Array(18).fill(0) }]);
    const withUnknown = encodeAthenaPacket(2, [{ tag: 0x47, counter: 2, raw: new Array(18).fill(1) }, { tag: 0x47, counter: 3, raw: new Array(18).fill(2) }]);
    withUnknown[9 + 5 + 36] = 0x77; // corrupt the second subpacket's tag
    const s = splitAthenaNotification(concatBytes([withUnknown, good]));
    expect(s.subpackets.map((x) => x.counter)).toEqual([2, 1]);
    expect(s.unknownTags).toEqual([0x77]);
    const bad = concatBytes([good, Uint8Array.from([200, 1, 2, 3])]);
    const s2 = splitAthenaNotification(bad);
    expect(s2.subpackets.length).toBe(1);
    expect(s2.droppedBytes).toBe(4);
  });
});
