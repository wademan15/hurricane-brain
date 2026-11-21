import { describe, expect, it } from 'vitest';
import { SessionClock, StreamClock, unwrapCounter } from '../clock';

describe('unwrapCounter', () => {
  it('next, gap, duplicate and back without an estimate', () => {
    expect(unwrapCounter(10, 11, 256)).toEqual({ kind: 'next', unwrapped: 11, missing: 0 });
    expect(unwrapCounter(10, 14, 256)).toEqual({ kind: 'gap', unwrapped: 14, missing: 3 });
    expect(unwrapCounter(10, 10, 256)).toEqual({ kind: 'dup', unwrapped: 10, missing: 0 });
    expect(unwrapCounter(10, 5, 256).kind).toBe('back');
  });

  it('wraps: 255 -> 0 is the next packet, 65535 -> 1 is one lost', () => {
    expect(unwrapCounter(255, 0, 256)).toEqual({ kind: 'next', unwrapped: 256, missing: 0 });
    expect(unwrapCounter(1023, 0, 256)).toEqual({ kind: 'next', unwrapped: 1024, missing: 0 });
    expect(unwrapCounter(65535, 1, 65536)).toEqual({ kind: 'gap', unwrapped: 65537, missing: 1 });
  });

  it('an arrival-time estimate resolves gaps longer than the counter range, never shifting the counted value', () => {
    // 600 packets lost on an 8-bit counter: counter alone says 600 % 256 = 88.
    const last = 1000;
    const counter = (last + 601) % 256;
    expect(unwrapCounter(last, counter, 256).unwrapped).toBe(last + 89);
    const est = last + 601 + 7; // estimate biased by latency
    expect(unwrapCounter(last, counter, 256, est)).toEqual({ kind: 'gap', unwrapped: last + 601, missing: 600 });
    // A large jump that IS a restart is still 'back' when time says little has passed.
    expect(unwrapCounter(last, (last - 3 + 256) % 256, 256, last + 1).kind).toBe('back');
    // Normal next packet with a latency-biased estimate.
    expect(unwrapCounter(last, (last + 1) % 256, 256, last + 20).kind).toBe('next');
  });
});

describe('SessionClock', () => {
  it('anchors to the lowest-latency EEG packet and maps host time onto EEG time', () => {
    const c = new SessionClock({ eegRateHz: 256 });
    expect(c.anchored).toBe(false);
    // packets of 12 samples; host time 5 s at index 0; latencies 40, 10, 25 ms
    const lat = [0.04, 0.01, 0.025];
    lat.forEach((l, k) => c.observeEeg((k + 1) * 12, Math.round((5 + ((k + 1) * 12) / 256 + l) * 1e6)));
    expect(c.anchored).toBe(true);
    // offset = 5.01 s, so host 6.01 s -> session 1.0 s
    expect(c.toSession(6_010_000)).toBeCloseTo(1.0, 9);
    expect(c.eegIndexAt(6_010_000)).toBeCloseTo(256, 6);
  });

  it('host mode starts at the first strap notification', () => {
    const c = new SessionClock({ eegRateHz: null });
    expect(c.toSession(5_000_000)).toBeNull();
    c.anchorHost(5_000_000);
    c.anchorHost(9_000_000);
    expect(c.toSession(6_500_000)).toBe(1.5);
  });

  it('stamps arrival times as integer microseconds from the shared origin', () => {
    const c = new SessionClock({ eegRateHz: 256, hostOriginMs: 1000.25 });
    expect(c.stampUs(1001.2504)).toBe(1000);
  });

  it('reports host/headset drift from two minutes of packets', () => {
    const c = new SessionClock({ eegRateHz: 256 });
    const ppm = 300; // host runs 300 ppm fast
    for (let k = 1; k <= (180 * 256) / 12; k++) {
      const headsetT = (k * 12) / 256;
      c.observeEeg(k * 12, Math.round((headsetT * (1 + ppm * 1e-6) + 0.02 + (k % 5) * 0.003) * 1e6));
    }
    expect(c.driftPpm()!).toBeGreaterThan(250);
    expect(c.driftPpm()!).toBeLessThan(350);
  });
});

describe('StreamClock', () => {
  function run(trueHz: number, seconds: number) {
    const c = new StreamClock(64);
    const times: number[] = [];
    let started = false;
    for (let p = 0; p < (seconds * trueHz) / 6; p++) {
      const end = (p + 1) * 6;
      const arrival = end / trueHz + 0.012 + (p % 9 === 0 ? 0.08 : 0) + (p % 4) * 0.002;
      if (!started) {
        c.start(0, 6, arrival);
        started = true;
      }
      for (let s = end - 6; s < end; s++) times.push(c.timeOf(s));
      c.observe(end, arrival);
    }
    return { c, times };
  }

  it('on-time stream: converges onto the latency floor (first packet was 92 ms late, floor is 12 ms)', () => {
    const { c, times } = run(64, 120);
    expect(Math.abs(c.rateHz - 64) / 64).toBeLessThan(1e-3);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    const n = times.length;
    for (let i = n - 500; i < n; i++) expect(Math.abs(times[i] - (i / 64 + 0.012))).toBeLessThan(0.01);
  });

  it('follows a stream whose oscillator runs 0.5 % fast, without jumps', () => {
    const { c, times } = run(64 * 1.005, 300);
    expect(Math.abs(c.rateHz / (64 * 1.005) - 1)).toBeLessThan(5e-4);
    // continuity: no step larger than 1.5 sample periods, never backwards
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(1.5 / 64);
    }
    // late in the run, sample times sit within 20 ms of truth (truth = index / true rate)
    const n = times.length;
    for (let i = n - 500; i < n; i++) expect(Math.abs(times[i] - (i / (64 * 1.005) + 0.012))).toBeLessThan(0.01);
  });
});
