/**
 * Photosensitivity rate caps, combined state, chance driver and readout wording.
 * "Rate" here means how often a luminance feature rises and falls at one point on screen.
 */
import { describe, expect, it } from 'vitest';
import type { Frame } from '../../engine/frames.ts';
import { computeVisualState, toUniforms, type VisualState, type VizOptions } from '../bindings.ts';
import { applyFrame, EMPTY_SNAPSHOT, type FrameSnapshot } from '../frameStore.ts';
import {
  armMaskAt,
  bothClarityFromHeld,
  featurePassHz,
  flickerGain,
  rotationRevPerS,
  TAU,
} from '../geometry.ts';
import { VIZ_GEOMETRY, VIZ_PHOTOSAFE, VIZ_REDUCED_MOTION, VIZ_SMOOTHING } from '../params.ts';
import { chanceInWords, chanceLines, fmtBound, hitTest } from '../readout.ts';
import {
  allNullSlow,
  cascade,
  combinedFrame,
  heartFrame,
  m,
  phiCascadeFrame,
  slowFrame,
  track,
} from './fixtures.ts';

const MAX = VIZ_PHOTOSAFE.MAX_FLICKER_HZ;
const FPS = 60;

/** Step the bindings at 60 fps from 0 to `until`, returning every state. */
function series(schedule: { at: number; frame: Frame }[], until: number, opts?: VizOptions): VisualState[] {
  let snap: FrameSnapshot = EMPTY_SNAPSHOT;
  let s: VisualState | null = null;
  const out: VisualState[] = [];
  const sorted = [...schedule].sort((a, b) => a.at - b.at);
  let k = 0;
  for (let i = 0; i / FPS <= until; i++) {
    const now = i / FPS;
    while (k < sorted.length && sorted[k].at <= now) {
      snap = applyFrame(snap, sorted[k].frame, sorted[k].at, VIZ_SMOOTHING.PULSE_MIN_INTERVAL_S);
      k++;
    }
    s = computeVisualState(s, snap, now, opts);
    out.push(s);
  }
  return out;
}

const every = (dt: number, until: number, make: (t: number) => Frame) => {
  const out: { at: number; frame: Frame }[] = [];
  for (let i = 0; i * dt <= until; i++) out.push({ at: i * dt, frame: make(i * dt) });
  return out;
};

/** Number of local maxima (rises followed by falls) in a sampled signal, ignoring changes below eps. */
function peaks(xs: number[], eps = 1e-6): number {
  let n = 0;
  let rising = false;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > eps) rising = true;
    else if (d < -eps && rising) { n++; rising = false; }
  }
  return n;
}

describe('rate cap: no luminance feature rises and falls more than 3 times a second', () => {
  it('rotation rate x maximum arms stays under 3 Hz for any frequency, full and reduced motion', () => {
    for (let f = 0; f <= 500; f += 0.5) {
      expect(rotationRevPerS(f, 'full') * VIZ_GEOMETRY.MAX_ARMS).toBeLessThan(MAX);
      expect(rotationRevPerS(f, 'reduced')).toBeLessThanOrEqual(VIZ_REDUCED_MOTION.ROT_MAX_REV_PER_S);
    }
    // Proportional in the measured range (1..45 Hz): the cap does not bind on EEG rhythms.
    expect(rotationRevPerS(45, 'full')).toBeCloseTo(45 * 0.008, 12);
    expect(rotationRevPerS(10, 'full')).toBeCloseTo(2 * rotationRevPerS(5, 'full'), 12);
  });

  for (const hz of [45, 120]) {
    it(`8 bright arms on a ${hz} Hz dominant track pass a fixed point fewer than 3 times a second`, () => {
      const tracks = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => track(i, i === 8 ? hz : 2 + i * 4, 12, 'beta'));
      const make = (t: number) => slowFrame({ t, tracks, dominant: 8, phi: cascade('phi', [1, 2, 3, 4, 5, 6, 7, 8], 0.8, 40), match: 1 });
      const st = series(every(0.25, 12, make), 12).slice(2 * FPS); // settled after 2 s
      for (const [x, y] of [[0.5, 0], [0.3, 0.3], [-0.7, 0.2]]) {
        const r = Math.hypot(x, y);
        const xs = st.map((s) => {
          const u = toUniforms(s);
          const c = Math.cos(s.rotationPhase);
          const sn = Math.sin(s.rotationPhase);
          const th = Math.atan2(-sn * x + c * y, c * x + sn * y);
          return armMaskAt(r, th, u.armCount, u.winding)?.mask ?? 0;
        });
        const seconds = xs.length / FPS;
        expect(peaks(xs) / seconds).toBeLessThan(MAX);
        // Not vacuous: the arms really are sweeping past (about 2.9 times a second).
        expect(peaks(xs) / seconds).toBeGreaterThan(2);
      }
    });
  }

  it('fine rotating texture is softened so its contrast x pass rate stays bounded above 3 Hz', () => {
    expect(flickerGain(0)).toBe(1);
    expect(flickerGain(MAX)).toBe(1);
    for (let hz = MAX; hz < 200; hz += 1) {
      // Effective contrast-weighted rate never exceeds the cap.
      expect(flickerGain(hz) * hz).toBeLessThanOrEqual(MAX + 1e-9);
    }
    // At 45 Hz dominant, the finest texture at the storm edge would pass ~34 times a second: softened ~100x.
    const pass = featurePassHz(rotationRevPerS(45, 'full'), 1, VIZ_PHOTOSAFE.DETAIL_FEATURE_R);
    expect(pass).toBeGreaterThan(30);
    expect(flickerGain(pass)).toBeLessThan(0.01);
    // At 10 Hz alpha the coarse band patches keep full contrast.
    expect(flickerGain(featurePassHz(rotationRevPerS(10, 'full'), 1, VIZ_PHOTOSAFE.PATCH_FEATURE_R))).toBe(1);
  });

  it('heartbeat pulses at 300 beats per minute still rise and fall at most 3 times a second', () => {
    const sched = [
      ...every(0.25, 6, (t) => phiCascadeFrame(t)),
      ...every(0.2, 6, (t) => heartFrame(t, [{ t, ibi: 200 }], 0)),
    ];
    const xs = series(sched, 6).map((s) => s.pulse.value ?? 0);
    expect(peaks(xs, 1e-4) / 6).toBeLessThanOrEqual(MAX);
  });

  it('a new beat never cuts a fading pulse off abruptly (no downward step)', () => {
    const sched = every(0.4, 4, (t) => heartFrame(t, [{ t, ibi: 400 }], 0));
    const xs = series(sched, 4).map((s) => s.pulse.value ?? 0);
    for (let i = 1; i < xs.length; i++) expect(xs[i - 1] - xs[i]).toBeLessThan(0.15);
  });

  it('signal toggling between valid and null at 4 Hz moves arm brightness by at most ~30% of full', () => {
    const sched = every(0.125, 6, (t) => (Math.round(t / 0.125) % 2 === 0 ? phiCascadeFrame(t) : allNullSlow(t)));
    const xs = series(sched, 6).slice(3 * FPS).map((s) => toUniforms(s).armBrightness[2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.3);
  });

  it('the combined state toggling at 4 Hz moves its glow by at most ~30% of full', () => {
    const sched = every(0.125, 6, (t) => combinedFrame(t, null, 40, Math.round(t / 0.125) % 2 === 0));
    const xs = series(sched, 6).slice(3 * FPS).map((s) => toUniforms(s).both);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.3 * 0.7);
  });
});

describe('reduced motion', () => {
  const sched = [
    ...every(0.25, 4, () => phiCascadeFrame(0, 3)),
    { at: 1, frame: heartFrame(1, [{ t: 1, ibi: 900 }], 0) as Frame },
  ];
  it('rotation is a slow capped drift, still proportional to the measured frequency', () => {
    const full = series(sched, 3);
    const red = series(sched, 3, { chance: 'a', motion: 'reduced' });
    const dFull = full[2 * FPS + 30].rotationPhase - full[2 * FPS].rotationPhase;
    const dRed = red[2 * FPS + 30].rotationPhase - red[2 * FPS].rotationPhase;
    expect(dRed).toBeGreaterThan(0);
    expect(dRed).toBeCloseTo((TAU * rotationRevPerS(9.95, 'reduced') * 30) / FPS, 6);
    expect(dRed).toBeLessThan(dFull / 4);
  });
  it('pulses are softer and longer', () => {
    const full = series(sched, 3).map((s) => toUniforms(s).pulse);
    const red = series(sched, 3, { chance: 'a', motion: 'reduced' }).map((s) => toUniforms(s).pulse);
    expect(Math.max(...red)).toBeLessThan(Math.max(...full) * 0.5);
    expect(red.filter((x) => x > 0).length).toBeGreaterThan(full.filter((x) => x > 0).length);
  });
});

describe('combined state: golden ratio and octave at once', () => {
  const settle = (f: (t: number) => Frame, opts?: VizOptions) => series(every(0.25, 2, f), 2, opts).at(-1)!;

  it('binds to states.both.active, states.both.for_s and the smaller excess', () => {
    const s = settle((t) => combinedFrame(t, null, 30, true));
    expect(s.combined.field).toBe('slow.states.both.active');
    expect(s.combined.value).toBe(1);
    expect(s.combinedHeld.field).toBe('slow.states.both.for_s');
    expect(s.combinedHeld.value).toBe(30);
    expect(s.combinedStrength.field).toBe('min(slow.cascades.phi.excess_a, slow.cascades.octave.excess_a)');
    expect(s.combinedStrength.value).toBe(0.7);
    const u = toUniforms(s);
    expect(u.both).toBeCloseTo(0.7, 12);
    expect(u.bothEye).toBeCloseTo(bothClarityFromHeld(30), 12);
    // Both structures are present underneath.
    expect(u.armCount).toBe(4);
    expect(u.ring).toBe(0.7);
  });

  it('both cascades without the combined state: arms and rings, but no interlock', () => {
    const s = settle((t) => combinedFrame(t, null, 0, false));
    const u = toUniforms(s);
    expect(s.combined.measured).toBe(0);
    expect(s.combinedStrength.measured).toBeNull();
    expect(s.combinedStrength.why).toBe('not_combined');
    expect(u.both).toBe(0);
    expect(u.bothEye).toBe(0);
    expect(u.armCount).toBe(4);
    expect(u.ring).toBe(0.7);
  });

  it('tap on the eye wall in the combined state reports the combined fields', () => {
    const s = settle((t) => combinedFrame(t, null, 30, true));
    const r = hitTest(s, VIZ_GEOMETRY.EYE_WALL_R, 0);
    expect(r.key).toBe('combined-wall');
    expect(r.bindings.map((b) => b.field)).toContain('slow.states.both.for_s');
    expect(r.both).toEqual({ active: true, forS: 30 });
  });
});

describe('chance driver', () => {
  it("chance 'b' reads excess_b natively for winding, rings and the combined strength", () => {
    const s = series(every(0.25, 2, (t) => combinedFrame(t, null, 30, true)), 2, { chance: 'b', motion: 'full' }).at(-1)!;
    const f = combinedFrame(0);
    expect(s.winding.field).toBe('slow.cascades.phi.excess_b');
    expect(s.winding.value).toBe(f.cascades.phi.excess_b.v);
    expect(s.ring.field).toBe('slow.cascades.octave.excess_b');
    expect(s.ring.value).toBe(f.cascades.octave.excess_b.v);
    expect(s.combinedStrength.value).toBe(Math.min(f.cascades.phi.excess_b.v!, f.cascades.octave.excess_b.v!));
    // The readout still shows both chance levels.
    const r = hitTest(s, 0, 0);
    expect(r.alignment![0].excessA.v).toBe(f.cascades.phi.excess_a.v);
    expect(r.alignment![0].excessB.v).toBe(f.cascades.phi.excess_b.v);
  });

  it('chance B still warming up: no spiral, and the reason says so', () => {
    const make = (t: number) => {
      const fr = phiCascadeFrame(t);
      fr.cascades.phi.excess_b = { v: null, why: 'warming_up' };
      return fr;
    };
    const s = series(every(0.25, 2, make), 2, { chance: 'b', motion: 'full' }).at(-1)!;
    expect(s.mode).toBe('bands');
    expect(s.winding.why).toBe('warming_up');
  });
});

describe('readout wording leads with the chance comparison and never calls excess a probability', () => {
  it('p in plain words', () => {
    expect(chanceInWords(m(0.28))).toBe('28 in 100');
    expect(chanceInWords(m(0.004))).toBe('fewer than 1 in 100');
    expect(chanceInWords({ v: null, why: 'warming_up' })).toMatch(/not measured/);
  });

  it('the octave ring at p = 0.42 says "42 in 100" before any alignment number', () => {
    const make = (t: number) => {
      const f = phiCascadeFrame(t);
      f.cascades.octave = cascade('octave', [1, 3], 0.96, 10);
      f.cascades.octave.chance.a.p = m(0.42, 0.03);
      return f;
    };
    const s = series(every(0.25, 2, make), 2).at(-1)!;
    const lines = chanceLines(s);
    const oct = lines.find((l) => l.startsWith('Octave'))!;
    expect(oct).toMatch(/^Octave: as often as this by chance: 42 in 100/);
    expect(oct.indexOf('42 in 100')).toBeLessThan(oct.indexOf('Alignment'));
    expect(fmtBound(s.ring)).toMatch(/not a probability/);
    expect(fmtBound(s.winding)).toMatch(/not a probability/);
  });
});
