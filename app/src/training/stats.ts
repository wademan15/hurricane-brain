/**
 * Block statistics (spec section 12): change from baseline as an effect size with a confidence
 * interval, time to first reach the target, fraction of the block in target, stability, clean
 * fraction, and comparison of two techniques with an explicit "within noise" verdict.
 *
 * Autocorrelation. Slow frames arrive 4 times a second but each one is computed from an 8 s
 * window, so neighbouring values share most of their data. Treating 4 Hz values as independent
 * would make every interval about six times too narrow. We estimate the integrated
 * autocorrelation time from the data (Geyer's initial positive sequence) and never let it fall
 * below a floor set by the window behind the value (params: slow 8 s, fast 0.5 s, heart 60 s).
 * The variance of a block mean is then s^2 * tau / (n - tau), which also corrects the
 * downward bias of s^2 for correlated data, and the interval uses Student t with the effective
 * sample sizes (Welch). A moving-block bootstrap is provided as a cross-check.
 *
 * Time in session. People settle as a session goes on. The reference for a block can be
 * shifted along a linear trend fitted to the session's rest blocks, and the trend's own
 * uncertainty is added to the interval.
 */

import { clamp, createRng, mean, normalQuantile, quantile, tCdf, tQuantile, variance } from './math';
import { TRAINING_PARAMS } from './params';

export interface Sample {
  t: number;
  /** Null when the field was not measured. */
  v: number | null;
  /** False when gating withheld this moment (artifact, bad contact). */
  clean: boolean;
}

export interface SeriesStats {
  /** Clean, measured samples used. */
  n: number;
  mean: number;
  sd: number;
  /** Integrated autocorrelation time in samples (>= floor). */
  tau: number;
  /** Effective sample size n / tau. */
  ess: number;
  /** Variance of the mean. */
  varMean: number;
  /** Time of the middle of the data, s. */
  tMid: number;
}

export interface Interval {
  estimate: number;
  lo: number;
  hi: number;
  se: number;
  df: number;
}

/** Integrated autocorrelation time (samples) by Geyer's initial positive sequence. */
export function autocorrelationTime(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 4) return 1;
  const m = mean(xs);
  const c0 = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / n;
  if (!(c0 > 0)) return 1;
  const acf = (k: number) => {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += (xs[i] - m) * (xs[i + k] - m);
    return s / n / c0;
  };
  let tau = -1;
  let prevPair = Infinity;
  for (let k = 0; 2 * k + 1 < n; k++) {
    let pair = acf(2 * k) + acf(2 * k + 1);
    if (pair <= 0) break;
    if (pair > prevPair) pair = prevPair; // initial monotone sequence
    prevPair = pair;
    tau += 2 * pair;
  }
  return Math.max(1, tau);
}

/** Summarize a series of clean values sampled every `dt` seconds. Null with fewer than 3 values. */
export function seriesStats(samples: readonly Sample[], dt: number, floorS: number): SeriesStats | null {
  const vals: number[] = [];
  const ts: number[] = [];
  for (const s of samples) {
    if (s.clean && s.v !== null && Number.isFinite(s.v)) {
      vals.push(s.v);
      ts.push(s.t);
    }
  }
  const n = vals.length;
  if (n < 3) return null;
  const sd = Math.sqrt(variance(vals));
  const floor = Math.max(1, floorS / dt);
  // Short series underestimate tau (the mean is estimated from the same data); a first-order
  // correction tau / (1 - 2 tau / n) keeps intervals from being optimistic on 90 s blocks.
  const raw = Math.max(floor, autocorrelationTime(vals));
  const tau = Math.min(n / 2, raw / Math.max(1 - (2 * raw) / n, 0.5));
  const ess = n / tau;
  const varMean = (sd * sd * tau) / Math.max(n - tau, 1);
  return { n, mean: mean(vals), sd, tau, ess, varMean, tMid: 0.5 * (ts[0] + ts[ts.length - 1]) };
}

/** Welch interval for a - b. */
export function meanDifference(a: SeriesStats, b: SeriesStats, extraVar = 0, level = TRAINING_PARAMS.ciLevel): Interval {
  const va = a.varMean;
  const vb = b.varMean;
  const se = Math.sqrt(va + vb + extraVar);
  const dfa = Math.max(a.ess - 1, 1);
  const dfb = Math.max(b.ess - 1, 1);
  const num = (va + vb + extraVar) ** 2;
  const den = (va * va) / dfa + (vb * vb) / dfb + (extraVar > 0 ? (extraVar * extraVar) / Math.min(dfa, dfb) : 0);
  const df = den > 0 ? Math.max(1, num / den) : 1;
  const q = tQuantile(0.5 + level / 2, df);
  const est = a.mean - b.mean;
  return { estimate: est, lo: est - q * se, hi: est + q * se, se, df };
}

/** Moving-block bootstrap interval for the mean of a series (cross-check; deterministic by seed). */
export function blockBootstrapMeanCi(xs: readonly number[], blockLen: number, seed: number, resamples = TRAINING_PARAMS.bootstrapResamples, level = TRAINING_PARAMS.ciLevel): Interval | null {
  const n = xs.length;
  const L = Math.max(1, Math.min(Math.round(blockLen), n));
  if (n < 2 * L) return null;
  const rng = createRng(seed);
  const means: number[] = [];
  const nBlocks = Math.ceil(n / L);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    let c = 0;
    for (let b = 0; b < nBlocks; b++) {
      const start = rng.int(n - L + 1);
      for (let i = 0; i < L && c < n; i++, c++) s += xs[start + i];
    }
    means.push(s / c);
  }
  const m = mean(xs);
  const se = Math.sqrt(variance(means));
  return { estimate: m, lo: quantile(means, (1 - level) / 2), hi: quantile(means, 1 - (1 - level) / 2), se, df: Infinity };
}

// ---------------------------------------------------------------------------
// Session trend
// ---------------------------------------------------------------------------

export interface Trend {
  /** Change per second. */
  slope: number;
  slopeSe: number;
  nBlocks: number;
}

/** Weighted least-squares slope of rest-block means against time. Null with fewer than 2 blocks. */
export function fitSessionTrend(rests: readonly SeriesStats[]): Trend | null {
  const pts = rests.filter((r) => r.varMean > 0);
  if (pts.length < 2) return null;
  let sw = 0, sx = 0, sy = 0;
  for (const r of pts) {
    const w = 1 / r.varMean;
    sw += w;
    sx += w * r.tMid;
    sy += w * r.mean;
  }
  const xb = sx / sw;
  const yb = sy / sw;
  let sxx = 0, sxy = 0;
  for (const r of pts) {
    const w = 1 / r.varMean;
    sxx += w * (r.tMid - xb) ** 2;
    sxy += w * (r.tMid - xb) * (r.mean - yb);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  // Inflate by residual scatter when the rest means disagree more than their own errors allow.
  let chi = 0;
  for (const r of pts) chi += (r.mean - (yb + slope * (r.tMid - xb))) ** 2 / r.varMean;
  const scale = pts.length > 2 ? Math.max(1, chi / (pts.length - 2)) : 1;
  return { slope, slopeSe: Math.sqrt(scale / sxx), nBlocks: pts.length };
}

// ---------------------------------------------------------------------------
// Block statistics
// ---------------------------------------------------------------------------

export interface BlockEffect {
  /** Block mean minus reference mean, in the field's units. */
  diff: Interval;
  /** diff divided by the reference SD: a standardized effect (Glass's delta). */
  d: number;
  dLo: number;
  dHi: number;
  /** The reference was shifted along the session trend. */
  trendCorrected: boolean;
  /** 'baseline' | 'preceding_rest' | 'profile' */
  reference: string;
}

export interface BlockStats {
  field: string;
  n: number;
  /** Clean measured samples over expected samples, 0..1. */
  cleanFraction: number;
  mean: number | null;
  sd: number | null;
  ess: number | null;
  effect: BlockEffect | null;
  /** Seconds from block start to the first clean sample beyond the threshold. */
  timeToTargetS: number | null;
  fractionInTarget: number | null;
  /** Share of in-target time spent in runs of at least stableRunS. */
  stability: number | null;
  longestRunS: number | null;
  /** Seconds since session start at the block start, and the block's position (for order correction). */
  tSinceStartS: number;
  position: number;
}

export interface BlockStatsInput {
  field: string;
  samples: readonly Sample[];
  tStart: number;
  durationS: number;
  /** Nominal sample interval, s (0.25 slow, 1/32 fast, about 1 heart). */
  dt: number;
  floorS: number;
  reference?: { stats: SeriesStats; kind: string } | null;
  trend?: Trend | null;
  threshold?: { value: number; direction: 'up' | 'down' } | null;
  sessionStart: number;
  position: number;
}

export function computeBlockStats(inp: BlockStatsInput): BlockStats {
  const s = seriesStats(inp.samples, inp.dt, inp.floorS);
  const expected = Math.max(1, Math.round(inp.durationS / inp.dt));
  const cleanCount = inp.samples.filter((x) => x.clean && x.v !== null).length;
  const out: BlockStats = {
    field: inp.field,
    n: cleanCount,
    cleanFraction: clamp(cleanCount / expected, 0, 1),
    mean: s ? s.mean : null,
    sd: s ? s.sd : null,
    ess: s ? s.ess : null,
    effect: null,
    timeToTargetS: null,
    fractionInTarget: null,
    stability: null,
    longestRunS: null,
    tSinceStartS: inp.tStart - inp.sessionStart,
    position: inp.position,
  };
  if (s && inp.reference) {
    const ref = inp.reference.stats;
    let refAdj = ref;
    let extra = 0;
    let corrected = false;
    if (inp.trend) {
      const dtMid = s.tMid - ref.tMid;
      refAdj = { ...ref, mean: ref.mean + inp.trend.slope * dtMid };
      extra = (inp.trend.slopeSe * dtMid) ** 2;
      corrected = true;
    }
    const diff = meanDifference(s, refAdj, extra);
    const sdRef = Math.max(ref.sd, TRAINING_PARAMS.minBaselineSd);
    out.effect = { diff, d: diff.estimate / sdRef, dLo: diff.lo / sdRef, dHi: diff.hi / sdRef, trendCorrected: corrected, reference: inp.reference.kind };
  }
  if (inp.threshold) {
    const { value, direction } = inp.threshold;
    const hit = (v: number) => (direction === 'up' ? v >= value : v <= value);
    let inCount = 0;
    let total = 0;
    let first: number | null = null;
    const runs: number[] = [];
    let runStart: number | null = null;
    let lastT = inp.tStart;
    for (const x of inp.samples) {
      const valid = x.clean && x.v !== null;
      const isIn = valid && hit(x.v as number);
      if (valid) total++;
      if (isIn) {
        inCount++;
        if (first === null) first = x.t - inp.tStart;
        if (runStart === null) runStart = x.t;
      } else if (runStart !== null) {
        runs.push(lastT - runStart + inp.dt);
        runStart = null;
      }
      lastT = x.t;
    }
    if (runStart !== null) runs.push(lastT - runStart + inp.dt);
    out.timeToTargetS = first;
    out.fractionInTarget = total ? inCount / total : null;
    const inTime = runs.reduce((a, b) => a + b, 0);
    out.longestRunS = runs.length ? Math.max(...runs) : total ? 0 : null;
    out.stability = inTime > 0 ? runs.filter((r) => r >= TRAINING_PARAMS.stableRunS).reduce((a, b) => a + b, 0) / inTime : total ? 0 : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparing techniques
// ---------------------------------------------------------------------------

export interface EffectObservation {
  /** Standardized block effect (BlockEffect.d). */
  estimate: number;
  /** Its standard error, ((dHi - dLo) / 2) / t quantile, or as stored. */
  se: number;
  sessionId?: string;
}

export type ComparisonVerdict = 'a_higher' | 'b_higher' | 'within_noise';

export interface Comparison {
  diff: Interval;
  verdict: ComparisonVerdict;
  /** Plain-language reading. */
  reading: string;
  nA: number;
  nB: number;
  method: 'welch_on_blocks' | 'pooled_se';
}

function pooledMean(obs: readonly EffectObservation[], het: number): { m: number; v: number } {
  let sw = 0, s = 0;
  for (const o of obs) {
    const w = 1 / (o.se * o.se + het * het);
    sw += w;
    s += w * o.estimate;
  }
  return { m: s / sw, v: 1 / sw };
}

/**
 * Compare two techniques' block effects. With at least two blocks each, the block-to-block
 * spread is used directly (Welch on block estimates), which includes every source of noise.
 * Otherwise each block's own error plus an assumed heterogeneity is used. The verdict is
 * "within noise" whenever the interval for the difference includes zero.
 */
export function compareTechniques(a: readonly EffectObservation[], b: readonly EffectObservation[], level = TRAINING_PARAMS.ciLevel): Comparison | null {
  if (!a.length || !b.length) return null;
  let diff: Interval;
  let method: Comparison['method'];
  if (a.length >= 2 && b.length >= 2) {
    const ea = a.map((o) => o.estimate);
    const eb = b.map((o) => o.estimate);
    // Each group's spread is the observed block-to-block variance, shrunk toward the blocks' own
    // squared errors with PRIOR_DF pseudo degrees of freedom, so two near-identical blocks cannot
    // claim certainty and the estimate stays unbiased when the per-block errors are calibrated.
    const PRIOR_DF = 2;
    const shrunk = (obs: readonly EffectObservation[], est: number[]) =>
      ((obs.length - 1) * variance(est) + PRIOR_DF * mean(obs.map((o) => o.se * o.se))) / (obs.length - 1 + PRIOR_DF);
    const va = shrunk(a, ea) / a.length;
    const vb = shrunk(b, eb) / b.length;
    const se = Math.sqrt(va + vb);
    const dfa = a.length - 1 + PRIOR_DF;
    const dfb = b.length - 1 + PRIOR_DF;
    const df = Math.max(1, (va + vb) ** 2 / ((va * va) / dfa + (vb * vb) / dfb));
    const q = tQuantile(0.5 + level / 2, df);
    const est = mean(ea) - mean(eb);
    diff = { estimate: est, lo: est - q * se, hi: est + q * se, se, df };
    method = 'welch_on_blocks';
  } else {
    const het = TRAINING_PARAMS.blockHeterogeneitySd;
    const pa = pooledMean(a, het);
    const pb = pooledMean(b, het);
    const se = Math.sqrt(pa.v + pb.v);
    const q = normalQuantile(0.5 + level / 2);
    const est = pa.m - pb.m;
    diff = { estimate: est, lo: est - q * se, hi: est + q * se, se, df: Infinity };
    method = 'pooled_se';
  }
  const verdict: ComparisonVerdict = diff.lo > 0 ? 'a_higher' : diff.hi < 0 ? 'b_higher' : 'within_noise';
  const reading =
    verdict === 'within_noise'
      ? 'These two techniques are within noise of each other so far. More blocks would tell them apart, or they may simply work about equally well for you.'
      : `One technique moved this measure more than the other, beyond what noise would explain (${a.length} and ${b.length} blocks).`;
  return { diff, verdict, reading, nA: a.length, nB: b.length, method };
}

/** Two-sided p-value for a t statistic (helper for reports). */
export function twoSidedP(t: number, df: number): number {
  return 2 * (1 - tCdf(Math.abs(t), df));
}

/** Standard error recovered from a stored interval. */
export function seFromInterval(lo: number, hi: number, df: number, level = TRAINING_PARAMS.ciLevel): number {
  const q = Number.isFinite(df) ? tQuantile(0.5 + level / 2, df) : normalQuantile(0.5 + level / 2);
  return (hi - lo) / (2 * q);
}
