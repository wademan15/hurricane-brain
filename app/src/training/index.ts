/**
 * Training layer public API. Pure logic and data; no UI. See README.md.
 */

export { TRAINING_PARAMS, TRAINING_PARAMS_VERSION, type TrainingParams } from './params';
export { compileField, isValidField, resolveField, selectTrack, substitutePath, FieldPathError, type FieldRef, type FrameContext, type FrameKind } from './fields';
export {
  instantiateProgram, validateProgram, LADDER, PROGRAM_FORMAT, PROGRAM_FORMAT_VERSION, ProgramError,
  type Program, type ProgramFamily, type TargetSpec, type ThresholdSpec, type GatingSpec, type BlockSpec, type BlockGroup, type BlockItem, type BlockKind,
  type Bindings, type Binding, type SoundElement, type VisualElement, type VariableSpec, type VarValue, type Evidence, type EvidenceGrade,
  type SessionPlan, type PlannedBlock, type PlanTarget, type InstantiateOptions, type RatingKey, type SafetyFlag, type StateId, type ValidationIssue, type WatchSpec,
} from './program';
export { PROGRAMS, getProgram, NOT_OFFERED } from './programs';
export { STRATEGIES, CORE_STRATEGIES, getStrategy, strategiesFor, type Strategy, type StrategyFamily, type TraitId, type ExpectedEffect } from './strategies';
export {
  createSessionRunner, validateSession, SESSION_FORMAT, SESSION_FORMAT_VERSION, SIGNATURE_FIELD,
  type SessionRunner, type RunnerOptions, type RunnerOutput, type RunnerEvent, type SessionRecord, type BlockRecord, type BaselineSummary, type CheckIn, type Posture, type TargetReading, type ThresholdChange,
} from './runner';
export {
  seriesStats, computeBlockStats, compareTechniques, meanDifference, fitSessionTrend, autocorrelationTime, blockBootstrapMeanCi, seFromInterval,
  type Sample, type SeriesStats, type Interval, type BlockStats, type BlockEffect, type Comparison, type ComparisonVerdict, type EffectObservation, type Trend,
} from './stats';
export {
  createProfile, parseProfile, ingestSession, planDiscoverySession, recommendNext, recommendPrograms, bestStrategy, compareStrategies, estimateStrategy,
  rankingReliability, priorGuess, calibrationFromSession, findResonanceRate, subjectiveVsMeasured, availablePrograms, signatureReach, excludedStrategies, williamsRow,
  STATE_METRICS, FIRST_DISCOVERY, PROFILE_FORMAT, PROFILE_FORMAT_VERSION,
  type UserProfile, type Questionnaire, type SafetyAnswers, type CalibrationRecord, type StrategyEstimate, type StrategyLabel, type BlockEffectEntry, type SessionSummary,
  type ResonanceResult, type DiscoveryPlan, type Recommendation, type ProgramSuggestion,
} from './profile';
export {
  learnSignature, fitSignatureFields, scoreFeatures, createSignatureDetector, describeSignature, auc, SIGNATURE_CANDIDATE_FIELDS,
  type Signature, type SignatureBlock, type SignatureField, type SignatureStatus, type SignatureValidation, type SignatureDetector, type SignatureReading,
} from './signatures';
export {
  createAnchor, anchorEligibility, canPair, evaluateAnchor, planProbeOrder, recordSession, controlExposuresOwed, validPairings, readyForProbe, shouldIncludePairing,
  type AnchorRecord, type PairingRecord, type ProbeTrial, type ExposureRecord, type AnchorEvaluation, type AnchorVerdict, type Eligibility, type SynthParams, type SessionReach,
} from './anchors';
export { createRng, deriveSeed, type Rng } from './math';
