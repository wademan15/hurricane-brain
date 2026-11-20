import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from './math';
import { blockBootstrapMeanCi, compareTechniques, computeBlockStats, fitSessionTrend, seFromInterval, seriesStats, type Sample } from './stats';

/**
 * Synthetic slow-frame series: each 4 Hz value is the mean of an 8 s window of an underlying
 * 4 Hz process (white noise plus a slow AR(1) wander), which is how the engine's slow path
 * correlates neighbouring frames.
 */
function slowSeries(rng: Rng, n: number, mu: number, t0 = 0, sigma = 1): Sample[] {
  const L = 32;
  const raw: number[] = [];
  let ar = 0;
  for (let i = 0; i < n + L; i++) {
    ar = 0.97 * ar + Math.sqrt(1 - 0.97 * 0.97) * rng.normal();
    raw.push(sigma * (rng.normal() * 2.5 + 0.8 * ar));
  }
  const out: Sample[] = [];
  let s = 0;
  for (let i = 0; i < L; i++) s += raw[i];
  for (let i = 0; i < n; i++) {
    out.push({ t: t0 + i * 0.25, v: mu + s / L, clean: true });
    s += raw[i + L] - raw[i];
  }
  return out;
}

describe('stats: block effect intervals are calibrated on autocorrelated 4 Hz frames', () => {
  it('recovers a planted effect with about 95% coverage over many seeds', () => {
    const seeds = 400;
    const planted = 0.5;
    let covered = 0;
    let detected = 0;
    let naiveCovered = 0;
    for (let k = 0; k < seeds; k++) {
      const rng = createRng(1000 + k);
      const base = slowSeries(rng, 480, 0, 0); // 2 min baseline
      const block = slowSeries(rng, 360, planted, 200); // 90 s block
      const ref = seriesStats(base, 0.25, 8)!;
      const st = computeBlockStats({ field: 'x', samples: block, tStart: 200, durationS: 90, dt: 0.25, floorS: 8, reference: { stats: ref, kind: 'baseline' }, sessionStart: 0, position: 1 });
      const e = st.effect!.diff;
      if (e.lo <= planted && planted <= e.hi) covered++;
      if (e.lo > 0) detected++;
      // Naive iid interval for comparison: shows why autocorrelation must be handled.
      const bm = block.reduce((a, b) => a + (b.v as number), 0) / block.length;
      const naiveSe = Math.sqrt(st.sd! ** 2 / block.length + ref.sd ** 2 / ref.n);
      if (Math.abs(bm - ref.mean - planted) <= 1.96 * naiveSe) naiveCovered++;
    }
    const coverage = covered / seeds;
    console.log(`[stats] planted effect 0.5: coverage ${(coverage * 100).toFixed(1)}% (naive iid ${(naiveCovered / seeds * 100).toFixed(1)}%), detected ${(detected / seeds * 100).toFixed(1)}%`);
    expect(coverage).toBeGreaterThan(0.9);
    expect(coverage).toBeLessThan(0.99);
    expect(naiveCovered / seeds).toBeLessThan(0.7);
  });

  it('reports a null technique difference as within noise at about the nominal rate', () => {
    const seeds = 500;
    let withinNoise = 0;
    let plantedFound = 0;
    for (let k = 0; k < seeds; k++) {
      const rng = createRng(50_000 + k);
      const obs = (mu: number, nBlocks: number) =>
        Array.from({ length: nBlocks }, () => {
          const base = slowSeries(rng, 240, 0);
          // Block-to-block variation in the true effect: real people vary between blocks.
          const block = slowSeries(rng, 360, mu + 0.15 * rng.normal(), 100);
          const st = computeBlockStats({ field: 'x', samples: block, tStart: 100, durationS: 90, dt: 0.25, floorS: 8, reference: { stats: seriesStats(base, 0.25, 8)!, kind: 'baseline' }, sessionStart: 0, position: 1 });
          return { estimate: st.effect!.d, se: seFromInterval(st.effect!.dLo, st.effect!.dHi, st.effect!.diff.df) };
        });
      const nullCmp = compareTechniques(obs(0.3, 3), obs(0.3, 3))!;
      if (nullCmp.verdict === 'within_noise') withinNoise++;
      const realCmp = compareTechniques(obs(1.2, 4), obs(0, 4))!;
      if (realCmp.verdict === 'a_higher') plantedFound++;
    }
    const rate = withinNoise / seeds;
    console.log(`[stats] null difference judged within noise in ${(rate * 100).toFixed(1)}% of ${seeds} seeds; planted difference found in ${(plantedFound / seeds * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThan(0.92);
    expect(rate).toBeLessThan(0.995);
    expect(plantedFound / seeds).toBeGreaterThan(0.6);
  });

  it('single-block comparisons are conservative but not blind', () => {
    let within = 0;
    for (let k = 0; k < 300; k++) {
      const rng = createRng(9000 + k);
      const one = () => ({ estimate: 0.3 + 0.3 * rng.normal(), se: 0.3 });
      if (compareTechniques([one()], [one()])!.verdict === 'within_noise') within++;
    }
    expect(within / 300).toBeGreaterThan(0.93);
  });

  it('a session trend correction removes settling drift', () => {
    const rng = createRng(7);
    const drift = 0.004; // per second: the person settles
    const mk = (t0: number, extra: number) => slowSeries(rng, 240, drift * (t0 + 30) + extra, t0);
    const rests = [mk(0, 0), mk(200, 0), mk(400, 0), mk(600, 0)].map((s) => seriesStats(s, 0.25, 8)!);
    const trend = fitSessionTrend(rests)!;
    expect(trend.slope).toBeGreaterThan(0.001);
    // A block late in the session with no real effect.
    const late = mk(700, 0);
    const noCorr = computeBlockStats({ field: 'x', samples: late, tStart: 700, durationS: 60, dt: 0.25, floorS: 8, reference: { stats: rests[0], kind: 'baseline' }, sessionStart: 0, position: 4 });
    const corr = computeBlockStats({ field: 'x', samples: late, tStart: 700, durationS: 60, dt: 0.25, floorS: 8, reference: { stats: rests[0], kind: 'baseline' }, trend, sessionStart: 0, position: 4 });
    console.log(`[stats] late block: uncorrected effect ${noCorr.effect!.diff.estimate.toFixed(2)}, trend-corrected ${corr.effect!.diff.estimate.toFixed(2)} [${corr.effect!.diff.lo.toFixed(2)}, ${corr.effect!.diff.hi.toFixed(2)}]`);
    expect(Math.abs(corr.effect!.diff.estimate)).toBeLessThan(Math.abs(noCorr.effect!.diff.estimate));
    expect(corr.effect!.diff.lo).toBeLessThan(0);
    expect(corr.effect!.diff.hi).toBeGreaterThan(0);
  });

  it('time to target, fraction in target and stability', () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 240; i++) {
      const t = 10 + i * 0.25;
      const v = i < 40 ? 0 : i < 200 ? 2 : 0; // reaches at 10 s, holds 40 s
      samples.push({ t, v, clean: !(i >= 100 && i < 104) });
    }
    const st = computeBlockStats({ field: 'x', samples, tStart: 10, durationS: 60, dt: 0.25, floorS: 8, threshold: { value: 1, direction: 'up' }, sessionStart: 0, position: 0 });
    expect(st.timeToTargetS).toBeCloseTo(10, 5);
    expect(st.fractionInTarget!).toBeCloseTo(156 / 236, 3);
    expect(st.cleanFraction).toBeCloseTo(236 / 240, 3);
    expect(st.stability).toBe(1);
    expect(st.longestRunS!).toBeCloseTo(24, 5);
  });

  it('block bootstrap agrees in scale with the effective-sample-size interval', () => {
    const rng = createRng(3);
    const s = slowSeries(rng, 2000, 0);
    const vals = s.map((x) => x.v as number);
    const ess = seriesStats(s, 0.25, 8)!;
    const boot = blockBootstrapMeanCi(vals, 4 * ess.tau, 11)!;
    const ratio = boot.se / Math.sqrt(ess.varMean);
    console.log(`[stats] bootstrap se / ESS se = ${ratio.toFixed(2)}`);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1.6);
  });
});
