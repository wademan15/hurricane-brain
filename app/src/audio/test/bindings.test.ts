import { describe, expect, it } from 'vitest';
import { anchorCandidates, anchorDistance, anchorFromSeed, neutralControlFor, sanitizeAnchor } from '../anchors.ts';
import { FrameBinder } from '../bindings.ts';
import { mergeSettings, DEFAULT_AUDIO_SETTINGS } from '../settings.ts';
import { fastFrame, heartFrame, slowFrame } from './helpers.ts';

describe('FrameBinder', () => {
  it('passes the measured frequency unmultiplied (the core does x32) and traces the exact field', () => {
    const b = new FrameBinder();
    b.handleFrame(slowFrame(0, { tracks: [{ id: 3, freq: 10.21 }], alphaDb: 2 }), 0);
    const out = b.handleFrame(fastFrame(0.03125, [{ id: 3, freq: 10.21, height: 9 }]), 0.03125);
    expect(out.control.voices).toEqual([{ id: 3, on: true, freqHz: 10.21, heightDb: 9, phi: 0, octave: 0 }]);
    const tone = b.traceAll().find((t) => t.element === 'tone');
    expect(tone?.fields['fast.tracks[id=3].freq.v']).toBe(10.21);
    expect(tone?.mapping).toContain('326.72 Hz = 10.210 Hz x 32');
    expect(tone?.smoothing).toContain('tau 150 ms');
    const bed = b.traceAll().find((t) => t.element === 'bed');
    expect(bed?.fields['slow.spectra[site=temporal].bands.alpha.above_bg_db.v']).toBe(2);
  });

  it('gives the null reason when a tone is off', () => {
    const b = new FrameBinder();
    b.handleFrame(slowFrame(0, { tracks: [{ id: 1, freq: 10 }] }), 0);
    b.handleFrame(fastFrame(0.03, [{ id: 1, freq: null }]), 0.03);
    const tone = b.traceAll().find((t) => t.element === 'tone');
    expect(tone?.on).toBe(false);
    expect(tone?.why).toBe('weak');
  });

  it('stale frames are not used', () => {
    const b = new FrameBinder();
    b.handleFrame(slowFrame(0, { tracks: [{ id: 1, freq: 10 }], alphaDb: 3 }), 0);
    b.handleFrame(fastFrame(0.03, [{ id: 1, freq: 10, height: 10 }]), 0.03);
    // A heart frame 2 s later: fast and slow are both stale now.
    const out = b.handleFrame(heartFrame(2, []), 2);
    expect(out.control.voices.every((v) => !v.on)).toBe(true);
    expect(out.control.bed.on).toBe(false);
  });

  it('blooms only for members of an active aligned state, at excess_a', () => {
    const b = new FrameBinder();
    const tr = [{ id: 1, freq: 10 }, { id: 2, freq: 16.18 }, { id: 3, freq: 22 }];
    b.handleFrame(slowFrame(0, { tracks: tr, phi: { tracks: [1, 2], excess: 0.42, active: true }, octave: { tracks: [1, 3], excess: 0.3, active: false } }), 0);
    const out = b.handleFrame(fastFrame(0.03, tr.map((t) => ({ ...t, height: 10 }))), 0.03);
    expect(out.control.voices.map((v) => v.phi)).toEqual([0.42, 0.42, 0]);
    expect(out.control.voices.map((v) => v.octave)).toEqual([0, 0, 0]);
  });

  it('warmth is relative to the baseline', () => {
    const b = new FrameBinder({ warmthRangeDb: 6 });
    b.setBaseline({ alphaAboveBgDbMean: 2 });
    const out = b.handleFrame(slowFrame(0, { alphaDb: 5 }), 0);
    expect(out.control.bed.warmth).toBeCloseTo(0.5, 10);
  });

  it('schedules beats at Beat.t + offset + latency, once each', () => {
    const b = new FrameBinder({ heartLatencyS: 0.25 });
    b.handleFrame(fastFrame(10, []), 3); // session 10 s = core 3 s
    const o1 = b.handleFrame(heartFrame(10.1, [{ t: 10.05 }]), 3.12);
    expect(o1.beats.length).toBe(1);
    expect(o1.beats[0].atS).toBeCloseTo(10.05 - 7 + 0.25, 10);
    const o2 = b.handleFrame(heartFrame(10.2, [{ t: 10.05 }]), 3.2);
    expect(o2.beats.length).toBe(0);
  });
});

describe('anchors', () => {
  it('are deterministic from a seed', () => {
    expect(anchorFromSeed(42)).toEqual(anchorFromSeed(42));
    expect(anchorFromSeed(42)).not.toEqual(anchorFromSeed(43));
  });
  it('can produce many distinct candidates', () => {
    const c = anchorCandidates(7, 24);
    expect(c.length).toBe(24);
    let min = Infinity;
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) min = Math.min(min, anchorDistance(c[i], c[j]));
    console.log(`24 candidates, minimum pairwise distance ${min.toFixed(2)}`);
    expect(min).toBeGreaterThanOrEqual(0.8);
  });
  it('stay in the warm register and use only consonant just ratios', () => {
    for (let s = 0; s < 500; s++) {
      const a = anchorFromSeed(s);
      expect(a.basePitchHz * a.intervals[a.intervals.length - 1]).toBeLessThanOrEqual(700);
      expect(a.attackS).toBeGreaterThanOrEqual(1);
      expect(a.releaseS).toBeGreaterThanOrEqual(1);
      expect(sanitizeAnchor(a)).toEqual(a);
    }
  });
  it('neutral control keeps envelope and level, drops pitch identity and motion', () => {
    const a = anchorFromSeed(5);
    const n = neutralControlFor(a);
    expect([n.attackS, n.sustainS, n.releaseS, n.level]).toEqual([a.attackS, a.sustainS, a.releaseS, a.level]);
    expect(n.noise).toBe(1);
    expect(n.motionDepth).toBe(0);
    expect(n.intervals).toEqual([1]);
  });
});

describe('settings', () => {
  it('clamps fades to >= 1 s and keeps the x32 multiplier fixed', () => {
    const s = mergeSettings(DEFAULT_AUDIO_SETTINGS, { toneFadeS: 0.1, bedFadeS: 0, bloomTauS: 0.2, ceilingDb: 3 });
    expect(s.toneFadeS).toBe(1);
    expect(s.bedFadeS).toBe(1);
    expect(s.bloomTauS).toBe(1);
    expect(s.ceilingDb).toBe(-1);
    expect(s.pitchMultiplier).toBe(32);
  });
});
