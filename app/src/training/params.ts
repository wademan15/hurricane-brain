/**
 * Provisional parameters of the training layer.
 *
 * CLAUDE.md rule 9: provisional numbers live in one table, never scattered through code.
 * These are the training-layer counterparts of spec section 14 and are recorded in every
 * Session record (`trainingParams`). See NOTES.md: the signal architect should fold this
 * table into spec section 14.
 */

export const TRAINING_PARAMS_VERSION = 1;

export const TRAINING_PARAMS = {
  // --- Freshness: a value older than this is not used (null, 'no_data'). Never held longer.
  staleSlowS: 1.0,
  staleFastS: 0.25,
  staleHeartS: 3.0,

  // --- Gating
  /** Default minimum clean fraction of the slow window on required channels (spec 5.3). */
  minCleanFraction: 0.6,
  /** Default EMG rise over the person's baseline above which reward is withheld, dB. */
  maxEmgRiseDb: 6,
  /** Seconds of continuous gating before the UI is asked to suggest refitting the headband. */
  checkFitAfterS: 20,

  // --- Thresholds and adaptation
  /** Default success band for feedback (fraction of clean time in target). */
  successBandLo: 0.6,
  successBandHi: 0.8,
  /** Fraction of the way the threshold moves toward the block's ideal threshold per adaptation. */
  adaptGain: 0.6,
  /** Largest threshold step per adaptation, in baseline standard deviations. */
  adaptMaxStepSd: 1.0,
  /** Minimum clean samples in a block for it to drive an adaptation. */
  adaptMinSamples: 40,
  /** Width of the reward ramp above threshold, in baseline standard deviations. */
  rewardSpanSd: 1.0,
  /** Default reward smoothing time constant, s (spec rule 2.8: declared and recorded). */
  rewardTauS: 1.5,
  /** Slow reward smoothing for alignment and cascade targets, s (spec 6.4: tens of seconds). */
  rewardTauSlowS: 8,
  /** Smallest baseline SD used, as a fraction of |mean| or absolute floor, to avoid zero spans. */
  minBaselineSd: 1e-3,

  // --- Statistics (stats.ts)
  /** Confidence level for all intervals. */
  ciLevel: 0.95,
  /** Bootstrap resamples where a bootstrap is used. */
  bootstrapResamples: 400,
  /** Minimum run in target counted as "stable", s. */
  stableRunS: 5,
  /** Lower bound on the autocorrelation time of a slow-frame series, s: one slow window. */
  slowCorrelationFloorS: 8,
  /** Lower bound for fast-frame series, s (tracker filter memory). */
  fastCorrelationFloorS: 0.5,
  /** Lower bound for heart variability series, s (spec 13: 60 s variability window). */
  heartCorrelationFloorS: 60,
  /** Blocks below this clean fraction are excluded from profiling and re-queued (design 5.4). */
  minBlockCleanFraction: 0.6,

  // --- Profile (profile.ts)
  /** Skeptical prior SD for a strategy effect (Cohen-d-like units). */
  priorEffectSd: 0.5,
  /** Assumed block-to-block heterogeneity SD when it cannot be estimated. */
  blockHeterogeneitySd: 0.35,
  /** Effect size counted as meaningful. */
  meaningfulEffect: 0.3,
  /** Blocks needed before a 'strong' or 'not_now' label. */
  minBlocksForLabel: 4,
  /** Sessions needed before a 'strong' label. */
  minSessionsForStrong: 2,
  /** Rank correlation between session halves needed to trust the ranking (design 9.2). */
  minRankReliability: 0.5,
  /** Probability floor of exploring in Thompson sampling. */
  minExploreProbability: 0.1,
  /** Core strategies each tested this many times during Discovery. */
  discoveryRepeats: 2,

  // --- Signatures (signatures.ts)
  signatureMaxFields: 4,
  signatureMinSessions: 3,
  signatureMinAuc: 0.75,
  signatureMaxP: 0.05,
  signaturePermutations: 199,
  /** Live detector smoothing window, s. */
  signatureWindowS: 10,
  /** Fraction of signature fields that must be measured for a live score. */
  signatureMinFieldFraction: 0.75,
  /** Live entry threshold: this quantile of the contrast-window score distribution. */
  signatureEnterQuantile: 0.95,
  /** Live exit threshold quantile (hysteresis). */
  signatureExitQuantile: 0.8,
  /** Dwell before entering the state, s (spec 8.4). */
  signatureDwellS: 5,

  // --- Anchors (anchors.ts)
  anchorEligibleWindow: 6,
  anchorEligibleMinSessions: 4,
  /** Seconds the signature must have been active before a pairing may start. */
  anchorPairDwellS: 5,
  /** Minimum seconds between pairings. */
  anchorPairMinIntervalS: 60,
  /** Pairings per block at most. */
  anchorMaxPairsPerBlock: 3,
  /** Anchor sound length assumed for pairing checks, s. */
  anchorSoundS: 8,
  /** Fraction of the sound during which the state must be present for a valid pairing. */
  anchorPairPresentFraction: 0.8,
  /** Probe: seconds before the cue used as the pre-cue reference. */
  probePreS: 20,
  /** Probe: seconds after the cue observed. */
  probePostS: 60,
  /** Probe trials of each kind before a verdict. */
  probeMinTrialsEach: 6,
  probeMinDays: 2,
  /** Pairings before the first probe makes sense. */
  anchorMinPairingsBeforeProbe: 20,

  // --- Resonance breathing
  resonanceRatesBpm: [6.5, 6.0, 5.5, 5.0, 4.5],
  resonanceMinAdherence: 0.5,
} as const;

export type TrainingParams = typeof TRAINING_PARAMS;
