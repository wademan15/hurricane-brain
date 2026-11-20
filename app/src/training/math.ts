/**
 * Small deterministic numeric helpers: seeded random numbers, quantiles and the
 * Student-t / normal distributions. No Math.random anywhere in the training layer
 * (spec rule 2.6): every random choice comes from a seed stored with the session or profile.
 */

/** A seeded generator (mulberry32). Same seed, same sequence, on every platform. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal (Box-Muller). */
  normal(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  /** The seed this generator was created from. */
  readonly seed: number;
}

export function createRng(seed: number): Rng {
  let a = (seed >>> 0) || 0x9e3779b9;
  let spare: number | null = null;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    normal() {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let u = next();
      while (u <= 1e-12) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    int(n: number) {
      return Math.floor(next() * n);
    },
  };
}

/** Derive a child seed from a parent seed and a label, deterministically. */
export function deriveSeed(seed: number, label: string): number {
  let h = (seed >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fisher-Yates shuffle into a new array. */
export function shuffled<T>(xs: readonly T[], rng: Rng): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : NaN;
}

/** Sample variance (n - 1). NaN for fewer than 2 values. */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - 1);
}

/** Linear-interpolated quantile (type 7). NaN for an empty array. */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.23173957245015, 0.001208650973866179, -0.5395239384953e-5];
  let y = x;
  const tmp0 = x + 5.5;
  const tmp = tmp0 - (x + 0.5) * Math.log(tmp0);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t cumulative distribution with df degrees of freedom (df may be fractional). */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student-t quantile by bisection on the CDF. Deterministic. */
export function tQuantile(p: number, df: number): number {
  if (!(df > 0)) return NaN;
  if (df > 1e6) return normalQuantile(p);
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26 via erf, adequate for decisions at 1e-7.
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** Standard normal quantile (Acklam's rational approximation). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
