/**
 * Personal sound anchors (spec section 12.1): the parameter set, deterministic generation of
 * candidates from a seed, and the neutral control sound an anchor is tested against.
 *
 * An anchor is the one kind of sound (besides the labelled breath guide) that plays without a
 * measurement behind it, and only when the app explicitly plays it. Its slow internal motion is
 * part of the sound's identity, fixed by its parameters, and never driven by randomness at play time.
 *
 * Intervals are just-intonation ratios, so partials of an anchor coincide exactly or stay well
 * apart: no slow beating between voices (nothing in this app may pulse at brainwave rates).
 */

export interface AnchorSynthParams {
  /** Lowest voice, Hz. 98..330: the warm register. */
  basePitchHz: number;
  /** Ratios of each voice to basePitchHz, first is 1. 1..4 entries, each from ANCHOR_RATIOS. */
  intervals: number[];
  /** 0..1: how much upper-partial energy (0 = nearly pure, 1 = soft reed). */
  brightness: number;
  /** Rate of the slow swell of the upper partials, Hz (0.03..0.25). */
  motionRateHz: number;
  /** Depth of that swell, 0..0.5. 0 = static. */
  motionDepth: number;
  /** Raised-cosine fade in, seconds (>= 1). */
  attackS: number;
  /** Hold at full level, seconds. */
  sustainS: number;
  /** Raised-cosine fade out, seconds (>= 1). */
  releaseS: number;
  /** 0..1: blend of a soft air band (1 = all air, no pitch; used by the neutral control). */
  noise: number;
  /** 0..1: send to the shared room. */
  space: number;
  /** 0..1 overall level. */
  level: number;
}

/** Consonant just ratios available to anchors. */
export const ANCHOR_RATIOS = [1, 6 / 5, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2, 3] as const;

const BASE_PITCHES = [98, 110, 123.47, 130.81, 146.83, 164.81, 174.61, 196, 220, 246.94, 261.63, 293.66, 329.63];
const CHORDS: number[][] = [
  [1],
  [1, 3 / 2],
  [1, 4 / 3],
  [1, 5 / 4, 3 / 2],
  [1, 6 / 5, 3 / 2],
  [1, 3 / 2, 2],
  [1, 4 / 3, 5 / 3],
  [1, 5 / 3],
  [1, 3 / 2, 9 / 4],
  [1, 5 / 4, 2],
  [1, 2, 3],
  [1, 6 / 5, 3 / 2, 2],
  [1, 5 / 4, 3 / 2, 5 / 2],
  [1, 4 / 3, 2],
];

/** Mulberry32: tiny deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** One candidate anchor from a seed. Same seed, same anchor, always. */
export function anchorFromSeed(seed: number): AnchorSynthParams {
  const r = mulberry32(seed ^ 0x9e3779b9);
  r(); // decorrelate small seeds
  const base = BASE_PITCHES[Math.floor(r() * BASE_PITCHES.length)];
  // Keep the top voice below about 700 Hz so the anchor stays warm.
  const fitting = CHORDS.filter((c) => base * c[c.length - 1] <= 700);
  const intervals = [...fitting[Math.floor(r() * fitting.length)]];
  return {
    basePitchHz: base,
    intervals,
    brightness: round3(lerp(0.1, 0.65, r())),
    motionRateHz: round3(lerp(0.04, 0.2, r())),
    motionDepth: round3(lerp(0.05, 0.4, r())),
    attackS: round3(lerp(1.5, 4, r())),
    sustainS: round3(lerp(3, 6, r())),
    releaseS: round3(lerp(2, 5, r())),
    noise: round3(r() < 0.3 ? lerp(0.05, 0.3, r()) : 0),
    space: round3(lerp(0.2, 0.8, r())),
    level: 0.8,
  };
}

/**
 * Distance between two anchors in a perceptual-ish parameter space (0 = identical). Pitch in
 * octaves, chord by set difference, the rest by range-normalised difference.
 */
export function anchorDistance(a: AnchorSynthParams, b: AnchorSynthParams): number {
  const pitch = Math.abs(Math.log2(a.basePitchHz / b.basePitchHz));
  const setA = new Set(a.intervals.map((x) => x.toFixed(4)));
  const setB = new Set(b.intervals.map((x) => x.toFixed(4)));
  let common = 0;
  for (const k of setA) if (setB.has(k)) common++;
  const chord = 1 - common / Math.max(setA.size, setB.size);
  return (
    pitch +
    chord +
    Math.abs(a.brightness - b.brightness) +
    Math.abs(a.motionRateHz - b.motionRateHz) / 0.16 * 0.5 +
    Math.abs(a.motionDepth - b.motionDepth) +
    Math.abs(a.noise - b.noise) +
    Math.abs(a.space - b.space) * 0.5
  );
}

/**
 * `count` candidates, each at least `minDistance` from every other and from `existing` (the
 * user's anchors already in use), generated deterministically from `seed`.
 */
export function anchorCandidates(seed: number, count: number, existing: AnchorSynthParams[] = [], minDistance = 0.8): AnchorSynthParams[] {
  const out: AnchorSynthParams[] = [];
  for (let i = 0; out.length < count && i < count * 200; i++) {
    const c = anchorFromSeed((seed * 7919 + i) >>> 0);
    if ([...existing, ...out].every((e) => anchorDistance(e, c) >= minDistance)) out.push(c);
  }
  return out;
}

/**
 * The neutral control sound for testing an anchor (spec 12.1): the same length, envelope, level
 * and spectral region, but no pitch identity, no chord and no motion. A soft band of air centred
 * where the anchor's energy is.
 */
export function neutralControlFor(anchor: AnchorSynthParams): AnchorSynthParams {
  const ratios = anchor.intervals.length ? anchor.intervals : [1];
  const geoMean = Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length);
  return {
    basePitchHz: round3(anchor.basePitchHz * geoMean),
    intervals: [1],
    brightness: anchor.brightness,
    motionRateHz: anchor.motionRateHz,
    motionDepth: 0,
    attackS: anchor.attackS,
    sustainS: anchor.sustainS,
    releaseS: anchor.releaseS,
    noise: 1,
    space: anchor.space,
    level: anchor.level,
  };
}

/** Clamp anchor params to safe ranges. Pure. */
export function sanitizeAnchor(p: AnchorSynthParams): AnchorSynthParams {
  const c = (x: number, lo: number, hi: number, f: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : f);
  const intervals = (Array.isArray(p.intervals) ? p.intervals : [1])
    .filter((x) => Number.isFinite(x) && x >= 1 && x <= 4)
    .slice(0, 4);
  return {
    basePitchHz: c(p.basePitchHz, 60, 440, 196),
    intervals: intervals.length ? intervals : [1],
    brightness: c(p.brightness, 0, 1, 0.3),
    motionRateHz: c(p.motionRateHz, 0.01, 0.3, 0.1),
    motionDepth: c(p.motionDepth, 0, 0.5, 0),
    attackS: c(p.attackS, 1, 10, 2),
    sustainS: c(p.sustainS, 0, 60, 4),
    releaseS: c(p.releaseS, 1, 10, 3),
    noise: c(p.noise, 0, 1, 0),
    space: c(p.space, 0, 1, 0.4),
    level: c(p.level, 0, 1, 0.8),
  };
}

/** Total length of one play, seconds. */
export const anchorDurationS = (p: AnchorSynthParams): number => p.attackS + p.sustainS + p.releaseS;
