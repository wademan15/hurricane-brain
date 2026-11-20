/**
 * Storm geometry shared by the shader (hurricane.ts) and the tap-to-inspect hit test
 * (readout.ts). The GLSL in hurricane.ts implements the same formulas; keep them in step.
 *
 * Coordinates: storm space, origin at the centre, unit = storm radius, y up.
 */
import { VIZ_GEOMETRY, VIZ_MAPPING, VIZ_PHOTOSAFE, VIZ_REDUCED_MOTION, type Motion } from './params.ts';

export const TAU = Math.PI * 2;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Golden ratio excess alignment (0..1) -> spiral pitch angle, degrees. */
export function pitchDegFromExcess(excess: number): number {
  const e = clamp(excess, 0, 1);
  return VIZ_MAPPING.PITCH_LOOSE_DEG + (VIZ_MAPPING.PITCH_TIGHT_DEG - VIZ_MAPPING.PITCH_LOOSE_DEG) * e;
}

/** Winding coefficient b of the logarithmic spiral theta = theta0 + b ln r: b = cot(pitch). */
export function windingFromExcess(excess: number): number {
  return 1 / Math.tan((pitchDegFromExcess(excess) * Math.PI) / 180);
}

/** Height above background (dB) -> 0..1 brightness. Linear, clamped. */
export function brightnessFromDb(db: number): number {
  return clamp(db / VIZ_MAPPING.HEIGHT_DB_FULL, 0, 1);
}

/** Measured cascade hold time -> eye clarity 0..1. */
export function eyeClarityFromHeld(heldS: number): number {
  return 1 - Math.exp(-Math.max(0, heldS) / VIZ_MAPPING.EYE_HELD_TAU_S);
}

/** Measured time in the combined state -> shared eye wall clarity 0..1. */
export function bothClarityFromHeld(forS: number): number {
  return 1 - Math.exp(-Math.max(0, forS) / VIZ_MAPPING.BOTH_HELD_TAU_S);
}

/** Hemisphere match (0..1) -> angular offset between left and right halves, radians. */
export function symmetryOffsetFromMatch(match: number): number {
  return (1 - clamp(match, 0, 1)) * VIZ_MAPPING.SYMMETRY_MAX_OFFSET_RAD;
}

/**
 * Measured dominant frequency (Hz) -> rotation rate (rev/s). Proportional, with a hard cap that
 * keeps arms passing any point below MAX_FLICKER_HZ. Reduced motion: slower, lower cap.
 */
export function rotationRevPerS(hz: number, motion: Motion): number {
  const k = motion === 'reduced' ? VIZ_REDUCED_MOTION.ROT_REV_PER_S_PER_HZ : VIZ_MAPPING.ROT_REV_PER_S_PER_HZ;
  const cap = motion === 'reduced' ? VIZ_REDUCED_MOTION.ROT_MAX_REV_PER_S : VIZ_MAPPING.ROT_MAX_REV_PER_S;
  return Math.min(Math.abs(hz) * k, cap);
}

/**
 * Contrast gain for rotating texture whose features pass a point `passHz` times a second.
 * 1 at or below MAX_FLICKER_HZ, falling as (MAX/passHz)^2 above it. The shader uses the same formula.
 */
export function flickerGain(passHz: number): number {
  const m = VIZ_PHOTOSAFE.MAX_FLICKER_HZ;
  return passHz <= m ? 1 : (m / passHz) * (m / passHz);
}

/** How often texture features of linear size `feature` (storm radii) pass a point at radius r. */
export function featurePassHz(revPerS: number, r: number, feature: number): number {
  return (TAU * r * Math.abs(revPerS)) / feature;
}

/** Heartbeat pulse envelope, 0..1, as a function of seconds since the beat arrived. */
export function pulseEnvelope(sinceS: number, pulseS: number): number {
  if (sinceS < 0 || sinceS >= pulseS) return 0;
  const x = sinceS / pulseS;
  // Smooth rise over the first fifth, smooth fall to exactly 0 at the end.
  const rise = smoothstep(0, 0.2, x);
  const fall = 1 - smoothstep(0.2, 1, x);
  return rise * fall;
}

/** Angular half-width (sigma) of each arm for a given (possibly fractional) arm count. */
export function armSigma(armCount: number): number {
  return (0.55 * Math.PI) / Math.max(armCount, 2);
}

/** Radial envelope of the arms: they start at the eye wall and fade at the storm edge. */
export function armRadialEnvelope(r: number): number {
  return smoothstep(VIZ_GEOMETRY.EYE_R * 0.8, VIZ_GEOMETRY.EYE_WALL_R * 1.8, r) *
    (1 - smoothstep(0.45, VIZ_GEOMETRY.STORM_OUTER_R, r));
}

/** Radius slot of unorganized band j of `count`. Order only, not frequency (design choice). */
export function bandRadius(j: number, count: number): number {
  const n = Math.max(count, 1);
  return VIZ_GEOMETRY.BAND_INNER_R + (VIZ_GEOMETRY.BAND_OUTER_R - VIZ_GEOMETRY.BAND_INNER_R) * ((j + 0.5) / n);
}

export interface ArmHit {
  index: number;
  /** Mask value at the point, before brightness, 0..1. */
  mask: number;
}

/**
 * Which arm covers a point. `theta` is the polar angle in the storm's rotating frame, already
 * including the symmetry offset. Mirrors the arm loop in the shader.
 */
export function armMaskAt(r: number, theta: number, armCount: number, winding: number): ArmHit | null {
  if (r <= 0 || armCount <= 0) return null;
  const sigma = armSigma(armCount);
  const env = armRadialEnvelope(r);
  const lnr = Math.log(r);
  let best: ArmHit | null = null;
  const n = Math.min(Math.ceil(armCount), VIZ_GEOMETRY.MAX_ARMS);
  for (let i = 0; i < n; i++) {
    const presence = clamp(armCount - i, 0, 1);
    const a0 = (TAU * i) / Math.max(armCount, 1);
    const d = wrapAngle(theta - winding * lnr - a0);
    const m = presence * Math.exp(-(d * d) / (2 * sigma * sigma)) * env;
    if (!best || m > best.mask) best = { index: i, mask: m };
  }
  return best;
}

/** Symmetry weight: -1 on the left half, +1 on the right, a short smooth seam between. */
export function sideWeight(xScreen: number): number {
  return clamp(xScreen / 0.04, -1, 1);
}
