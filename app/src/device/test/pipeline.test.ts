import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../bytes';
import { athenaEegToUv } from '../muse/athena';
import { classicEegToUv } from '../muse/classic';
import { MuseChar } from '../muse/constants';
import type { DeviceInput } from '../types';
import { DeviceSlot } from '../types';
import { eegByIndex, peakFrequency, runPipelines } from './helpers';
import { synthAthena, synthClassic, tenHz } from './synth';

function expectExact(got: Map<number, number[]>, sent: Map<number, number[]>, toUv: (r: number) => number) {
  expect([...got.keys()].sort((a, b) => a - b)).toEqual([...sent.keys()].sort((a, b) => a - b));
  for (const [idx, raw] of sent) expect(got.get(idx)).toEqual(raw.map((r) => Math.fround(toUv(r))));
}

describe('Classic pipeline (synthetic packets through the real decode path)', () => {
  it('clean stream: every sample at its index, exact values, one description first', () => {
    const syn = synthClassic({ seconds: 6 });
    const { got } = runPipelines(syn.inputs);
    expect(got.streams.length).toBe(1);
    expect(got.streams[0].eeg).toEqual({ channels: ['TP9', 'AF7', 'AF8', 'TP10'], rate_hz: 256, bits: 12, model: 'Muse (classic protocol) Muse-SYNT' });
    expect(got.streams[0].ppg).toEqual({ channels: ['ambient', 'infrared', 'red'], rate_hz: 64 });
    expect(got.streams[0].motion).toEqual({ rate_hz: 52 });
    expect(got.gap).toEqual([]);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, classicEegToUv);
    expect(got.eeg[0].firstIndex).toBe(0);
    expect(got.battery.length).toBe(6);
    expect(got.battery[0].percent).toBe(40000 / 512);
  });

  it('dropped packets become gaps of exactly 12 samples; a missing channel too', () => {
    const syn = synthClassic({ seconds: 6, dropEeg: new Set([50, 51, 90]), dropEegChannel: new Map([[70, 2]]) });
    const { got } = runPipelines(syn.inputs);
    const eegGaps = got.gap.filter((g) => g.stream === 'eeg');
    expect(eegGaps).toEqual([
      { stream: 'eeg', cause: 'counter', at: 600, samples: 24, estimated: false },
      { stream: 'eeg', cause: 'reassembly', at: 840, samples: 12, estimated: false },
      { stream: 'eeg', cause: 'counter', at: 1080, samples: 12, estimated: false },
    ]);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, classicEegToUv);
  });

  it('16-bit counter wrap (65530 -> 5) is not a gap', () => {
    const syn = synthClassic({ seconds: 4, startCounter: 65530, ppg: false, motion: false });
    const { got } = runPipelines(syn.inputs);
    expect(got.gap).toEqual([]);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, classicEegToUv);
    expect(got.streams[0].ppg).toBeNull();
    expect(got.streams[0].motion).toBeNull();
  });

  it('channel notifications arriving out of order across characteristics are reassembled', () => {
    const syn = synthClassic({ seconds: 4, ppg: false, motion: false });
    // swap TP10 of packet k with TP9 of packet k+1 throughout
    const eeg = syn.inputs.filter((i) => i.type === 'raw' && i.char >= 3 && i.char <= 6);
    const others = syn.inputs.filter((i) => !eeg.includes(i));
    for (let k = 3; k + 4 < eeg.length; k += 4) [eeg[k], eeg[k + 1]] = [eeg[k + 1], eeg[k]];
    const { got } = runPipelines([...others.slice(0, 1), ...eeg, ...others.slice(1)]);
    expect(got.gap).toEqual([]);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, classicEegToUv);
  });

  it('a synthetic 10 Hz signal reads 10.0 Hz within 0.1, with 1 % packet loss and a 0.3 % fast headset clock', () => {
    const drop = new Set<number>();
    for (let p = 7; p < 30 * 21; p += 97) drop.add(p);
    const syn = synthClassic({ seconds: 30, dropEeg: drop, clockScale: 1.003, eeg: tenHz(300, 2048) });
    const { got } = runPipelines(syn.inputs);
    const byIdx = eegByIndex(got.eeg);
    const f = peakFrequency(byIdx, 0, 256, 9.5, 10.5);
    expect(Math.abs(f - 10)).toBeLessThan(0.1);
    // Index-based time makes it exact here, regardless of the host clock: 10.000 within the scan step.
    expect(Math.abs(f - 10)).toBeLessThan(0.002);
    expect(got.gap.filter((g) => g.stream === 'eeg').reduce((n, g) => n + g.samples, 0)).toBe(drop.size * 12);
  });

  it('PPG and motion are mapped onto the session clock, in order, at their rates', () => {
    const syn = synthClassic({ seconds: 20 });
    const { got } = runPipelines(syn.inputs);
    const ppgT = got.ppg.map((e) => e.t);
    for (let i = 1; i < ppgT.length; i++) expect(ppgT[i] - ppgT[i - 1]).toBeCloseTo(6 / 64, 2);
    const mT = got.motion.map((e) => e.t);
    for (let i = 1; i < mT.length; i++) expect(mT[i] - mT[i - 1]).toBeCloseTo(1 / 52, 2);
    // acc and gyro paired: synth sends gyro = -acc
    for (const m of got.motion) for (let a = 0; a < 3; a++) expect(m.gyro[a] / 0.0074768).toBeCloseTo(-m.acc[a] / 0.0000610352, 0);
    // PPG sample k carries value 100000*(ch+1) + k: times must follow the counts
    const first = got.ppg[0];
    expect(first.samples[0]).toBe(100000);
    // session time of PPG sample 0 is near its true time (0 + latency floor), within 50 ms
    expect(Math.abs(first.t - 0)).toBeLessThan(0.1);
  });

  it('reconnect: the gap is placed by arrival time and marked estimated', () => {
    const a = synthClassic({ seconds: 4, ppg: false, motion: false });
    const b = synthClassic({ seconds: 4, ppg: false, motion: false, startCounter: 0, t0Us: 1_000_000 + 7_000_000 });
    const link: DeviceInput = { type: 'link', slot: DeviceSlot.MUSE, tUs: 6_000_000, state: 'disconnected' };
    const { got } = runPipelines([...a.inputs, link, ...b.inputs]);
    const g = got.gap.filter((x) => x.stream === 'eeg');
    expect(g.length).toBe(1);
    expect(g[0].cause).toBe('reconnect');
    expect(g[0].estimated).toBe(true);
    // second session started 7 s after the first; first ran 4 s -> about 3 s (768 samples) missing
    expect(Math.abs(g[0].samples - 768)).toBeLessThan(40);
    const firstOfB = got.eeg.find((e) => e.firstIndex > 1000)!;
    expect(firstOfB.firstIndex).toBe(g[0].at + g[0].samples);
  });
});

describe('Athena pipeline (synthetic packets through the real decode path)', () => {
  it('8-channel: exact values, 8-bit counter wraps every 2 s without gaps', () => {
    const syn = synthAthena({ seconds: 6, startCounter: 200 });
    const { got } = runPipelines(syn.inputs);
    expect(got.streams[0].eeg!.channels).toEqual(['TP9', 'AF7', 'AF8', 'TP10', 'AUX1', 'AUX2', 'AUX3', 'AUX4']);
    expect(got.streams[0].eeg!.bits).toBe(14);
    expect(got.streams[0].ppg!.channels.length).toBe(16);
    expect(got.gap).toEqual([]);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, athenaEegToUv);
    expect(got.battery.every((b) => b.percent === 77.5)).toBe(true);
  });

  it('4-channel EEG with 4-channel optics', () => {
    const syn = synthAthena({ seconds: 4, eegChannels: 4, opticsChannels: 4 });
    const { got } = runPipelines(syn.inputs);
    expect(got.streams[0].eeg!.channels).toEqual(['TP9', 'AF7', 'AF8', 'TP10']);
    expect(got.streams[0].ppg!.channels).toEqual(['LI_NIR', 'RI_NIR', 'LI_IR', 'RI_IR']);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, athenaEegToUv);
  });

  it('lost subpackets become gaps of exactly their samples, including a loss longer than the counter range', () => {
    const drop = new Set<number>([10, 11, 12, 300]);
    for (let k = 1000; k < 1000 + 600; k++) drop.add(k); // 600 subpackets = 1200 samples > 256-count range
    const syn = synthAthena({ seconds: 12, dropEeg: drop, ppg: false, motion: false });
    const { got } = runPipelines(syn.inputs);
    const gaps = got.gap.filter((g) => g.stream === 'eeg').map((g) => [g.at, g.samples]);
    expect(gaps).toEqual([[20, 6], [600, 2], [2000, 1200]]);
    expectExact(eegByIndex(got.eeg), syn.sentEeg, athenaEegToUv);
  });

  it('a synthetic 10 Hz signal reads 10.0 Hz within 0.1 (Athena, with loss)', () => {
    const drop = new Set<number>();
    for (let k = 5; k < 30 * 128; k += 140) drop.add(k); // ~0.7 % loss, the rate muse-rs measured
    const syn = synthAthena({ seconds: 30, dropEeg: drop, clockScale: 0.998 });
    const { got } = runPipelines(syn.inputs);
    const f = peakFrequency(eegByIndex(got.eeg), 1, 256, 9.5, 10.5);
    expect(Math.abs(f - 10)).toBeLessThan(0.002);
  });
});

describe('Athena pipeline on real captures', () => {
  const fixtures = import.meta.glob('./fixtures/*.{txt,hex}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  function inputsFrom(text: string, withTimes: boolean): DeviceInput[] {
    const ls = text.split('\n').filter((l) => l.trim());
    const t0 = withTimes ? Date.parse(ls[0].split('\t')[0]) : 0;
    const inputs: DeviceInput[] = [{ type: 'link', slot: DeviceSlot.MUSE, tUs: 0, state: 'connected', config: { name: 'capture', protocol: 'athena' } }];
    ls.forEach((l, i) => {
      const parts = l.split('\t');
      // OpenMuse captures carry ISO arrival times (ms resolution after parsing); muse-rs's do not.
      const tUs = withTimes ? 1000 + Math.round((Date.parse(parts[0]) - t0) * 1000) : 1000 + i * 20_000;
      inputs.push({ type: 'raw', slot: DeviceSlot.MUSE, char: MuseChar.ATHENA_DATA, tUs, bytes: hexToBytes(parts[parts.length - 1]) });
    });
    return inputs;
  }

  it('muse-rs fw 3.1.19 capture: the two real headset gaps come out with the right size', () => {
    const name = Object.keys(fixtures).find((n) => n.includes('musers'))!;
    const { got } = runPipelines(inputsFrom(fixtures[name], false), { settleSamples: 64 });
    const gaps = got.gap.map((g) => [g.stream, g.samples, g.cause]);
    // optical counter 107 -> 110 (tag 0x36, 1 sample each): 2 samples; IMU 30 -> 32: 3 samples.
    expect(gaps).toEqual([
      ['ppg', 2, 'counter'],
      ['motion', 3, 'counter'],
    ]);
    expect(got.streams[0].eeg!.channels.length).toBe(8);
    expect(got.streams[0].ppg!.channels.length).toBe(16);
    const n = got.eeg.reduce((a, e) => a + e.nSamples, 0);
    expect(n).toBe(275 * 2);
  });

  for (const key of ['p1034', 'p1035', 'p1041', 'p21']) {
    it(`OpenMuse ${key} capture: contiguous EEG, ordered optics and motion, no gaps`, () => {
      const name = Object.keys(fixtures).find((n) => n.includes(key))!;
      const { got, muse } = runPipelines(inputsFrom(fixtures[name], true));
      expect(got.gap).toEqual([]);
      let next = 0;
      for (const e of got.eeg) {
        expect(e.firstIndex).toBe(next);
        next += e.nSamples;
      }
      expect(muse.stats.malformed).toBe(0);
      for (let i = 1; i < got.ppg.length; i++) expect(got.ppg[i].t).toBeGreaterThan(got.ppg[i - 1].t);
      for (let i = 1; i < got.motion.length; i++) expect(got.motion[i].t).toBeGreaterThan(got.motion[i - 1].t);
      if (key === 'p21') expect(got.streams[0].ppg).toBeNull();
    });
  }
});
