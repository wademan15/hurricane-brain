/**
 * Every tunable number the hurricane uses, in one place (CLAUDE.md rule 9).
 *
 * These are presentation constants, not measurements. Two kinds:
 *  - Declared smoothing (spec 2, rule 8): time constants between a measurement and what the user
 *    sees. They must be visible in settings and recorded with the session. `VIZ_SMOOTHING` is the
 *    object the settings screen and the session recorder should read.
 *  - Mapping and design constants: how a measured number becomes a size, angle or brightness.
 *
 * Handover: these belong in the provisional parameter table (spec section 14). The visualizer does
 * not own that file; see app/src/viz/NOTES.md.
 */

/**
 * Declared smoothing. One named time constant per path, nothing else smooths.
 *
 * RAMP_S: when a bound field changes, the drawn value moves in a straight line from where it was
 * to the new measured value over this many seconds, then stops exactly on the measured value.
 * It never overshoots and never runs ahead of the latest frame (interpolation, not extrapolation).
 * 0.5 s = two slow frames. It also limits how fast large areas of the picture can change, which
 * keeps the picture below 3 flashes per second even if a signal toggles between valid and null
 * at the 4 Hz slow-frame rate (see README, "Photosensitivity").
 */
export const VIZ_SMOOTHING = {
  RAMP_S: 0.5,
  /** Slow frames older than this are treated as no data: the storm dissolves (over RAMP_S) to calm. */
  SLOW_STALE_S: 1.0,
  /** Heart frames arrive on every beat and at least once a second, so allow two missed frames. */
  HEART_STALE_S: 2.5,
  /** Length of one heartbeat pulse through the eye wall, seconds (rise and fall). */
  PULSE_S: 0.6,
  /**
   * A new pulse never starts sooner than this after the previous one (photosensitivity: at most
   * 3 pulses per second). Only matters above 180 beats per minute.
   */
  PULSE_MIN_INTERVAL_S: 0.34,
} as const;

export const VIZ_MAPPING = {
  /**
   * Rotation: revolutions per second per Hz of the dominant track's frequency.
   * 10 Hz alpha -> 0.08 rev/s (one turn in 12.5 s). Chosen so that with the maximum 8 arms at
   * 45 Hz an arm passes any one point at most 8 * 45 * 0.008 = 2.9 times per second (< 3 Hz).
   */
  ROT_REV_PER_S_PER_HZ: 0.008,
  /** Arm and band brightness reaches full at this height above background, dB. Linear below. */
  HEIGHT_DB_FULL: 12,
  /** Spiral pitch angle (degrees) at golden ratio excess alignment 0 (loose) and 1 (tight). */
  PITCH_LOOSE_DEG: 72,
  PITCH_TIGHT_DEG: 13,
  /** Eye clarity = 1 - exp(-held_s / EYE_HELD_TAU_S). A display mapping of measured hold time. */
  EYE_HELD_TAU_S: 20,
  /** Angular offset between the left and right halves at hemisphere match 0, radians. */
  SYMMETRY_MAX_OFFSET_RAD: 0.7,
  /** Scale change of the whole picture at the peak of the breath swell (fraction). */
  SWELL_AMPLITUDE: 0.03,
  /** Brightness boost of the eye wall at the peak of a heartbeat pulse (fraction). */
  PULSE_GAIN: 0.45,
} as const;

/** Geometry of the drawn storm, in units of the storm radius. Pure design choices. */
export const VIZ_GEOMETRY = {
  EYE_R: 0.11,
  EYE_WALL_R: 0.15,
  /** Octave rings sit at radii that double (a visual pun on the octave, a design choice). */
  RING_RADII: [0.24, 0.48, 0.96] as readonly number[],
  RING_WIDTH: 0.035,
  /** Unorganized bands of cloud sit in these radius slots, in track order (design choice). */
  BAND_INNER_R: 0.25,
  BAND_OUTER_R: 0.9,
  STORM_OUTER_R: 1.0,
  /** Maximum arms and bands the shader draws. Extra tracks are listed in the readout. */
  MAX_ARMS: 8,
  MAX_BANDS: 8,
} as const;

export type Quality = 'low' | 'medium' | 'high';

/** Render resolution per quality setting: cap on device pixel ratio and on total pixels. */
export const VIZ_QUALITY: Record<Quality, { maxDpr: number; maxPixels: number }> = {
  low: { maxDpr: 0.6, maxPixels: 1280 * 720 * 0.36 },
  medium: { maxDpr: 1, maxPixels: 1920 * 1080 },
  high: { maxDpr: 2, maxPixels: 2560 * 1440 },
};
