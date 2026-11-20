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
  /**
   * Hard cap on rotation, rev/s: MAX_FLICKER_HZ / MAX_ARMS * 0.96. It equals 45 Hz x 0.008, the
   * top of the peak search range, so it never binds on a measured EEG rhythm; it is a guarantee.
   */
  ROT_MAX_REV_PER_S: 0.36,
  /** Combined-state eye wall clarity = 1 - exp(-both.for_s / this). Display mapping. */
  BOTH_HELD_TAU_S: 20,
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

/**
 * Photosensitivity limits (README, "Photosensitivity"). Nothing on screen may change luminance
 * back and forth faster than MAX_FLICKER_HZ anywhere.
 */
export const VIZ_PHOTOSAFE = {
  MAX_FLICKER_HZ: 3,
  /**
   * Size of the fine cloud texture, storm radii. When the storm rotates fast enough that texture
   * features of this size would pass a point faster than MAX_FLICKER_HZ, their contrast is reduced
   * in proportion (a temporal low-pass done spatially). Depends only on the measured rotation.
   */
  DETAIL_FEATURE_R: 0.06,
  /** Same for the coarse patches that break up the cloud bands. */
  PATCH_FEATURE_R: 0.4,
  /** Angular size of the streaks across an arm, radians. */
  STREAK_FEATURE_RAD: 0.16,
} as const;

/**
 * Reduced motion (prefers-reduced-motion, or the user's setting). Still driven only by
 * measurements: rotation is a slow drift proportional to the measured frequency, with a low cap;
 * heartbeat pulses are longer and fainter; the breath swell is halved.
 */
export const VIZ_REDUCED_MOTION = {
  ROT_REV_PER_S_PER_HZ: 0.0015,
  /** One turn in 33 s at most (reached at 20 Hz). */
  ROT_MAX_REV_PER_S: 0.03,
  PULSE_S: 1.0,
  PULSE_GAIN_SCALE: 0.35,
  SWELL_SCALE: 0.5,
} as const;

export type Motion = 'full' | 'reduced';
/** Which chance level drives winding and rings (open decision D1). A: random peaks. B: own wandering. */
export type ChanceDriver = 'a' | 'b';

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
  /** Combined state: luminous beads where arms cross the rings, angular half-width (radians). */
  BEAD_WIDTH: 0.05,
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

/**
 * Storm colours, linear-ish RGB 0..1. Defaults; each can be overridden from CSS with the custom
 * property named in `VIZ_THEME_CSS` (hex or rgb()), read when the view mounts or resizes.
 * Changing these never changes what is bound to what.
 */
export interface VizTheme {
  water: [number, number, number];
  waterRipple: [number, number, number];
  cloudDark: [number, number, number];
  cloudLight: [number, number, number];
  octaveRing: [number, number, number];
  eyeWall: [number, number, number];
  pulse: [number, number, number];
  /** Combined state: shared eye wall and the beads where arms cross rings. */
  combined: [number, number, number];
}

export const VIZ_THEME: VizTheme = {
  water: [0.010, 0.018, 0.034],
  waterRipple: [0.010, 0.017, 0.026],
  cloudDark: [0.26, 0.34, 0.48],
  cloudLight: [0.84, 0.89, 0.96],
  octaveRing: [0.95, 0.72, 0.45],
  eyeWall: [0.70, 0.82, 1.0],
  pulse: [1.0, 0.70, 0.66],
  combined: [1.0, 0.93, 0.78],
};

/** CSS custom property for each theme colour. */
export const VIZ_THEME_CSS: Record<keyof VizTheme, string> = {
  water: '--hb-storm-water',
  waterRipple: '--hb-storm-water-ripple',
  cloudDark: '--hb-storm-cloud-dark',
  cloudLight: '--hb-storm-cloud-light',
  octaveRing: '--hb-storm-octave-ring',
  eyeWall: '--hb-storm-eye-wall',
  pulse: '--hb-storm-pulse',
  combined: '--hb-storm-combined',
};
