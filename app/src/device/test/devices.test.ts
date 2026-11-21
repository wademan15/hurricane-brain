import { describe, expect, it } from 'vitest';
import { SessionClock } from '../clock';
import { MuseDevice } from '../muse/MuseDevice';
import { PolarH10 } from '../polar/PolarH10';
import { Recorder } from '../recording/recorder';
import { ReplaySource } from '../recording/replay';
import type { DeviceEvents, DeviceSource, RawNotification } from '../types';
import { encodeHrm } from './encoder';
import { FakeTimers, fakeBluetooth, fakeMuse, fakeStrap, flush, type FakeMuse } from './fakeBluetooth';
import { emptyCollected, eegByIndex, type Collected } from './helpers';
import { synthAthena, synthClassic } from './synth';

function collect(src: DeviceSource): Collected {
  const got = emptyCollected();
  for (const k of Object.keys(got) as (keyof DeviceEvents)[]) src.on(k, (e) => (got[k] as unknown[]).push(e));
  return got;
}

/** Play synthetic notifications into a fake headset at their arrival times. */
async function play(m: FakeMuse, timers: FakeTimers, raws: RawNotification[]) {
  for (const r of raws) {
    if (r.tUs / 1000 > timers.now) await timers.advance(r.tUs / 1000 - timers.now);
    m.chars.get(r.char)!.notify(r.bytes);
  }
}

function setup(protocol: 'classic' | 'athena') {
  const timers = new FakeTimers();
  const clock = new SessionClock({ eegRateHz: 256, hostOriginMs: 0 });
  const m = fakeMuse(protocol);
  const bt = fakeBluetooth(m.device);
  const dev = new MuseDevice({ clock, bluetooth: bt, timers, now: () => timers.now, settleSamples: 256 });
  return { timers, clock, m, bt, dev, got: collect(dev) };
}

const rawsOf = (inputs: { type: string }[]) => inputs.filter((i): i is RawNotification => i.type === 'raw');

describe('MuseDevice over a fake Web Bluetooth stack', () => {
  it('Classic: chooser filter, start sequence, streaming, decoded data', async () => {
    const { timers, m, bt, dev, got } = setup('classic');
    await dev.start();
    expect(bt.requests[0]).toEqual({ filters: [{ services: [0xfe8d] }, { namePrefix: 'Muse' }], optionalServices: [0xfe8d] });
    expect(m.commands).toEqual(['h', 's', 'p50', 'd', 'v1']);
    expect(dev.state).toBe('streaming');
    expect(dev.protocol).toBe('classic');
    expect(dev.version?.fw).toBe('9.9.9');
    expect(got.status.map((s) => s.state)).toEqual(['requesting', 'connecting', 'starting', 'streaming']);
    expect(got.battery[0].percent).toBe(63.5); // from the status reply's "bp"
    const syn = synthClassic({ seconds: 3, t0Us: 1_000_000 });
    await play(m, timers, rawsOf(syn.inputs));
    expect(got.streams.length).toBe(1);
    expect(eegByIndex(got.eeg).size).toBe(syn.sentEeg.size);
    expect(got.gap).toEqual([]);
  });

  it('Athena: detected by 0x0013, its own start sequence, dc001 accepted so no d', async () => {
    const { m, dev } = setup('athena');
    await dev.start();
    expect(dev.protocol).toBe('athena');
    expect(m.commands).toEqual(['v4', 's', 'h', 'p1041', 'dc001', 'L1']);
  });

  it('Athena: dc001 refused -> falls back to d', async () => {
    const { m, dev } = setup('athena');
    m.rc.dc001 = 69;
    m.rc.d = 0;
    await dev.start();
    expect(m.commands).toEqual(['v4', 's', 'h', 'p1041', 'dc001', 'd', 'L1']);
  });

  it('reconnects with exponential backoff after a drop, and the gap is reported', async () => {
    const { timers, m, dev, got } = setup('athena');
    await dev.start();
    const syn = synthAthena({ seconds: 4, t0Us: 1_000_000 });
    const raws = rawsOf(syn.inputs);
    await play(m, timers, raws.slice(0, raws.length / 2));
    m.device.failNextConnects = 2;
    m.device.dropLink();
    await flush();
    expect(got.status.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1, retryInMs: 1000 });
    await timers.advance(1000); // attempt 1 fails
    expect(got.status.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 2, retryInMs: 2000 });
    await timers.advance(2000); // attempt 2 fails
    expect(got.status.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 3, retryInMs: 4000 });
    await timers.advance(4000); // attempt 3 succeeds
    expect(dev.state).toBe('streaming');
    expect(m.device.connectCalls).toBe(4);
    expect(m.commands.filter((c) => c === 'dc001').length).toBe(2);
    // the headset restarts its counters after a reconnect: a fresh synthetic stream 9 s later
    const syn2 = synthAthena({ seconds: 2, t0Us: timers.now * 1000 + 100_000 });
    await play(m, timers, rawsOf(syn2.inputs));
    const gaps = got.gap.filter((g) => g.stream === 'eeg');
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toMatchObject({ cause: 'reconnect', estimated: true });
    expect(got.input.filter((i) => i.type === 'link').map((i) => (i as { state: string }).state)).toEqual(['connected', 'disconnected', 'connected']);
  });

  it('gives up after maxAttempts', async () => {
    const timers = new FakeTimers();
    const m = fakeMuse('classic');
    const dev = new MuseDevice({ clock: new SessionClock({ eegRateHz: 256 }), bluetooth: fakeBluetooth(m.device), timers, now: () => timers.now, reconnect: { maxAttempts: 2, baseMs: 100 } });
    const got = collect(dev);
    await dev.start();
    m.device.failNextConnects = 99;
    m.device.dropLink();
    await timers.advance(10_000);
    expect(got.status.at(-1)).toMatchObject({ state: 'failed' });
  });

  it('watchdog: a silent headset is disconnected and reconnected', async () => {
    const { timers, m, dev, got } = setup('classic');
    await dev.start();
    await timers.advance(6500); // no data at all (watchdog checks every 1.25 s, limit 5 s)
    expect(got.error.some((e) => e.message.includes('no data'))).toBe(true);
    await timers.advance(1000);
    expect(m.device.connectCalls).toBe(2);
    expect(dev.state).toBe('streaming');
  });

  it('keep-alive k every 10 s; stop() halts, disconnects and does not reconnect', async () => {
    const { timers, m, dev, got } = setup('classic');
    await dev.start();
    const syn = synthClassic({ seconds: 25, t0Us: 0, ppg: false, motion: false });
    await play(m, timers, rawsOf(syn.inputs));
    expect(m.commands.filter((c) => c === 'k').length).toBe(2);
    await dev.stop();
    expect(m.commands.at(-1)).toBe('h');
    expect(m.device.gatt.connected).toBe(false);
    await timers.advance(60_000);
    expect(m.device.connectCalls).toBe(1);
    expect(got.status.at(-1)!.state).toBe('stopped');
  });

  it('reports a clear error where Web Bluetooth is missing', async () => {
    const dev = new MuseDevice({ clock: new SessionClock({ eegRateHz: 256 }) });
    await expect(dev.start()).rejects.toThrow(/Web Bluetooth is not available/);
    expect(dev.state).toBe('failed');
  });
});

describe('PolarH10 over a fake Web Bluetooth stack', () => {
  it('reads battery, decodes RR intervals and stamps them on the session clock', async () => {
    const timers = new FakeTimers();
    const clock = new SessionClock({ eegRateHz: null, hostOriginMs: 0 });
    const s = fakeStrap();
    const bt = fakeBluetooth(s.device);
    const dev = new PolarH10({ clock, bluetooth: bt, timers, now: () => timers.now });
    const got = collect(dev);
    await dev.start();
    expect(bt.requests[0]).toEqual({ filters: [{ services: [0x180d] }], optionalServices: [0x180f] });
    expect(got.battery[0]).toMatchObject({ percent: 88 });
    await timers.advance(2000);
    s.hrm.notify(encodeHrm({ bpm: 60, contact: true, rrRaw: [1024] }));
    await timers.advance(1500);
    s.hrm.notify(encodeHrm({ bpm: 61, contact: true, rrRaw: [1000, 1010] }));
    expect(got.streams[0].chest_strap).toEqual({ name: 'Polar H10 FAKE' });
    expect(got.rr.map((r) => [r.t, Array.from(r.rrMs)])).toEqual([
      [0, [1000]],
      [1.5, [(1000 * 1000) / 1024, (1010 * 1000) / 1024].map(Math.fround)],
    ]);
    expect(got.heartRate.map((h) => [h.bpm, h.contact])).toEqual([[60, true], [61, true]]);
  });
});

describe('Record and replay', () => {
  it('a live session (headset + strap) replays to identical decoded samples, from raw and from stored', async () => {
    const timers = new FakeTimers();
    const clock = new SessionClock({ eegRateHz: 256, hostOriginMs: 0 });
    const m = fakeMuse('classic');
    const s = fakeStrap();
    const muse = new MuseDevice({ clock, bluetooth: fakeBluetooth(m.device), timers, now: () => timers.now, settleSamples: 256 });
    const strap = new PolarH10({ clock, bluetooth: fakeBluetooth(s.device), timers, now: () => timers.now });
    const rec = new Recorder({ clock: { eegRateHz: 256, settleSamples: 256 }, devices: [{ slot: 0, kind: 'muse', name: 'Muse-FAKE' }, { slot: 1, kind: 'chest_strap', name: 'Polar H10 FAKE' }] });
    rec.attach(muse);
    rec.attach(strap);
    const liveMuse = collect(muse);
    const liveStrap = collect(strap);
    await strap.start();
    s.hrm.notify(encodeHrm({ bpm: 70, rrRaw: [880] })); // before the headset: held, then dropped (t < 0)
    await muse.start();
    const syn = synthClassic({ seconds: 8, t0Us: 500_000, dropEeg: new Set([20, 21, 60]), dropEegChannel: new Map([[40, 1]]) });
    const raws = rawsOf(syn.inputs);
    // interleave strap beats every ~0.85 s
    let nextBeat = 1_000_000;
    for (const r of raws) {
      while (nextBeat < r.tUs) {
        await timers.advance(nextBeat / 1000 - timers.now);
        s.hrm.notify(encodeHrm({ bpm: 70, contact: true, rrRaw: [870, 875] }));
        nextBeat += 850_000;
      }
      await play(m, timers, [r]);
    }
    m.device.dropLink(); // a disconnect is part of the recording too
    await timers.advance(1000);
    await muse.stop();
    await strap.stop();
    const bytes = rec.finish();
    expect(liveMuse.gap.length).toBeGreaterThan(0);
    expect(liveStrap.rr.length).toBeGreaterThan(5);

    // Raw-bytes size check: compact enough (~ 8 s of Muse 2 with PPG and motion).
    expect(bytes.length).toBeLessThan(400_000);

    for (const from of ['raw', 'decoded'] as const) {
      const replay = new ReplaySource(bytes, { from, speed: 'fast' });
      const out = collect(replay);
      await replay.start();
      expect(replay.state).toBe('ended');
      for (const k of ['eeg', 'ppg', 'motion', 'gap'] as const) expect(out[k], `${from} ${k}`).toEqual(liveMuse[k]);
      expect(out.streams.filter((d) => d.eeg)).toEqual(liveMuse.streams);
      expect(out.streams.filter((d) => d.chest_strap)).toEqual(liveStrap.streams);
      for (const k of ['rr', 'heartRate'] as const) expect(out[k], `${from} ${k}`).toEqual(liveStrap[k]);
    }

    // Re-recording a raw replay reproduces the input records byte for byte.
    const again = new Recorder({ clock: { eegRateHz: 256, settleSamples: 256 }, devices: [], createdAt: 'x' }, { decoded: false });
    const once = new Recorder({ clock: { eegRateHz: 256, settleSamples: 256 }, devices: [], createdAt: 'x' }, { decoded: false });
    const r1 = new ReplaySource(bytes);
    once.attach(r1);
    await r1.start();
    const r2 = new ReplaySource(once.finish());
    again.attach(r2);
    await r2.start();
    expect(again.finish()).toEqual(once.finish());
  });

  it('real-time replay paces by recorded arrival times', async () => {
    const syn = synthClassic({ seconds: 2, ppg: false, motion: false, t0Us: 0 });
    const rec = new Recorder({ clock: { eegRateHz: 256 }, devices: [] });
    const fakeSrc = { on: (t: string, l: (e: unknown) => void) => (t === 'input' ? ((feed = l), () => {}) : () => {}) } as unknown as DeviceSource;
    let feed: (e: unknown) => void = () => {};
    rec.attach(fakeSrc);
    syn.inputs.forEach((i) => feed(i));
    let now = 0;
    const sleeps: number[] = [];
    const replay = new ReplaySource(rec.finish(), { speed: 1, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    await replay.start();
    const span = (syn.inputs.at(-1)!.tUs - syn.inputs[0].tUs) / 1000;
    expect(Math.abs(now - span)).toBeLessThan(2);
  });
});
