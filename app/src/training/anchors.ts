/**
 * Personal sound anchors (spec 12.1; design section 7.2).
 *
 * An anchor is a sound unique to one person, paired with a state they can reliably produce,
 * so that later the sound alone may help bring the state back. This is classical conditioning,
 * and the rules here follow learning theory so that it can work and so that we can find out
 * honestly whether it does:
 *
 *  - Earned: the state's signature must be reliable, and reached in 4 of the last 6 sessions.
 *  - Contingent: the anchor plays only while the signature is detected (pairing gate). Each
 *    pairing records whether the state was actually present while the sound played.
 *  - Controlled: an equally familiar control sound is played in neutral rest blocks as often
 *    as the anchor is paired, and never paired.
 *  - Tested: probe trials from a neutral state compare the anchor with the control sound.
 *    The verdict is "working" only when the anchor's effect exceeds the control's beyond noise.
 *  - Maintained: plays without the state (on-demand uses) are counted; refresher pairing is
 *    suggested so the link does not fade.
 *
 * The synthesis parameters are opaque to this layer: the audio layer owns them.
 */

import { createRng, mean, quantile, shuffled, tQuantile, variance } from './math';
import { TRAINING_PARAMS } from './params';
import type { StateId } from './program';
import type { Signature } from './signatures';
import type { Interval } from './stats';

export type SynthParams = Record<string, number | string>;

export interface PairingRecord {
  sessionId: string;
  day: string;
  /** Session time the anchor started. */
  t: number;
  scoreAtOnset: number | null;
  /** Fraction of signature readings during the sound in which the state was detected. */
  presentFraction: number;
  /** The state was present for at least anchorPairPresentFraction of the sound. */
  valid: boolean;
}

export interface ExposureRecord {
  sessionId: string;
  day: string;
  t: number;
}

export interface ProbeTrial {
  sessionId: string;
  day: string;
  t: number;
  cue: 'anchor' | 'control' | 'none';
  /** Mean signature score over the probePreS seconds before the cue. */
  preScore: number | null;
  /** Mean signature score over the probePostS seconds after the cue. */
  postMean: number | null;
  /** postMean - preScore: movement toward the state signature. */
  delta: number | null;
  /** Seconds from cue to the signature being detected, or null if it was not. */
  latencyS: number | null;
  reached: boolean;
}

export interface AnchorRecord {
  id: string;
  name: string;
  state: StateId;
  signatureId: string;
  createdAt: string;
  synth: SynthParams;
  control: { id: string; synth: SynthParams };
  pairings: PairingRecord[];
  controlExposures: ExposureRecord[];
  probes: ProbeTrial[];
  /** Plays without a pairing check (on-demand uses). Too many weaken the link. */
  unpairedPlays: ExposureRecord[];
  retired: boolean;
}

export function createAnchor(a: { id: string; name: string; state: StateId; signatureId: string; createdAt: string; synth: SynthParams; control: { id: string; synth: SynthParams } }): AnchorRecord {
  return { ...a, pairings: [], controlExposures: [], probes: [], unpairedPlays: [], retired: false };
}

// ---------------------------------------------------------------------------
// Eligibility and pairing gate
// ---------------------------------------------------------------------------

export interface SessionReach {
  sessionId: string;
  day: string;
  /** The signature was detected in the session's state blocks and the user rated the state 4 or 5. */
  reached: boolean;
}

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
  reachedInWindow: number;
  window: number;
}

export function anchorEligibility(sig: Signature | null, recent: readonly SessionReach[]): Eligibility {
  const reasons: string[] = [];
  const window = TRAINING_PARAMS.anchorEligibleWindow;
  const last = recent.slice(-window);
  const reached = last.filter((r) => r.reached).length;
  if (!sig) reasons.push('no signature for this state yet');
  else if (sig.status !== 'reliable') reasons.push('the signature is still learning');
  if (reached < TRAINING_PARAMS.anchorEligibleMinSessions) reasons.push(`state reached in ${reached} of the last ${last.length} sessions; needs ${TRAINING_PARAMS.anchorEligibleMinSessions} of ${window}`);
  return { eligible: reasons.length === 0, reasons, reachedInWindow: reached, window };
}

export interface PairGateInput {
  active: boolean;
  forS: number;
  now: number;
  lastPairT: number | null;
  pairsThisBlock: number;
}

/** True when a pairing may start now. */
export function canPair(g: PairGateInput): boolean {
  if (!g.active || g.forS < TRAINING_PARAMS.anchorPairDwellS) return false;
  if (g.pairsThisBlock >= TRAINING_PARAMS.anchorMaxPairsPerBlock) return false;
  if (g.lastPairT !== null && g.now - g.lastPairT < TRAINING_PARAMS.anchorPairMinIntervalS) return false;
  return true;
}

export function validPairings(a: AnchorRecord): number {
  return a.pairings.filter((p) => p.valid).length;
}

/** Control-sound plays still owed so the control is as familiar as the anchor. */
export function controlExposuresOwed(a: AnchorRecord): number {
  return Math.max(0, a.pairings.length - a.controlExposures.length);
}

/** Append session results to an anchor (pure). */
export function recordSession(a: AnchorRecord, s: { pairings?: PairingRecord[]; controlExposures?: ExposureRecord[]; probes?: ProbeTrial[]; unpairedPlays?: ExposureRecord[] }): AnchorRecord {
  return {
    ...a,
    pairings: [...a.pairings, ...(s.pairings ?? [])],
    controlExposures: [...a.controlExposures, ...(s.controlExposures ?? [])],
    probes: [...a.probes, ...(s.probes ?? [])],
    unpairedPlays: [...a.unpairedPlays, ...(s.unpairedPlays ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Probe design and evaluation
// ---------------------------------------------------------------------------

/** Probe order: pairs of anchor and control in random order within each pair (balanced, seeded). */
export function planProbeOrder(nPairs: number, seed: number): ('anchor' | 'control')[] {
  const rng = createRng(seed);
  const out: ('anchor' | 'control')[] = [];
  for (let i = 0; i < nPairs; i++) out.push(...shuffled<'anchor' | 'control'>(['anchor', 'control'], rng));
  return out;
}

export type AnchorVerdict = 'too_few_trials' | 'working' | 'not_distinguishable' | 'weaker_than_control';

export interface AnchorEvaluation {
  verdict: AnchorVerdict;
  anchor: { n: number; meanDelta: number | null; hitRate: number | null; medianLatencyS: number | null };
  control: { n: number; meanDelta: number | null; hitRate: number | null; medianLatencyS: number | null };
  /** Anchor minus control mean delta (signature score units). */
  diff: Interval | null;
  validPairings: number;
  days: number;
  reading: string;
  needsRefresher: boolean;
}

function summarizeTrials(ts: readonly ProbeTrial[]) {
  const deltas = ts.map((t) => t.delta).filter((d): d is number => d !== null);
  const lat = ts.map((t) => t.latencyS).filter((d): d is number => d !== null);
  return {
    n: deltas.length,
    meanDelta: deltas.length ? mean(deltas) : null,
    hitRate: ts.length ? ts.filter((t) => t.reached).length / ts.length : null,
    medianLatencyS: lat.length ? quantile(lat, 0.5) : null,
    deltas,
  };
}

export function evaluateAnchor(a: AnchorRecord, level = TRAINING_PARAMS.ciLevel): AnchorEvaluation {
  const A = summarizeTrials(a.probes.filter((p) => p.cue === 'anchor'));
  const C = summarizeTrials(a.probes.filter((p) => p.cue === 'control'));
  const days = new Set(a.probes.map((p) => p.day)).size;
  const vp = validPairings(a);
  let diff: Interval | null = null;
  if (A.deltas.length >= 2 && C.deltas.length >= 2) {
    const va = variance(A.deltas) / A.deltas.length;
    const vc = variance(C.deltas) / C.deltas.length;
    const se = Math.sqrt(va + vc);
    const df = Math.max(1, (va + vc) ** 2 / ((va * va) / (A.deltas.length - 1) + (vc * vc) / (C.deltas.length - 1)));
    const q = tQuantile(0.5 + level / 2, df);
    const est = (A.meanDelta as number) - (C.meanDelta as number);
    diff = { estimate: est, lo: est - q * se, hi: est + q * se, se, df };
  }
  let verdict: AnchorVerdict;
  let reading: string;
  const enough = A.n >= TRAINING_PARAMS.probeMinTrialsEach && C.n >= TRAINING_PARAMS.probeMinTrialsEach && days >= TRAINING_PARAMS.probeMinDays;
  if (!enough || !diff) {
    verdict = 'too_few_trials';
    reading = `Not enough test trials yet to say whether your anchor works (${A.n} anchor and ${C.n} control trials over ${days} day(s); ${TRAINING_PARAMS.probeMinTrialsEach} of each over ${TRAINING_PARAMS.probeMinDays} days are needed).`;
  } else if (diff.lo > 0) {
    verdict = 'working';
    reading = `Your anchor currently moves you toward your ${a.state} signature more than the neutral control sound does (difference ${diff.estimate.toFixed(2)}, interval ${diff.lo.toFixed(2)} to ${diff.hi.toFixed(2)}). This is a personal experiment, and the link needs occasional practice to stay strong.`;
  } else if (diff.hi < 0) {
    verdict = 'weaker_than_control';
    reading = 'Right now the control sound does as much or more than the anchor. More pairing practice while you are in the state may help, or a new sound.';
  } else {
    verdict = 'not_distinguishable';
    reading = 'So far the anchor and the neutral control sound are within noise of each other. The anchor is not shown to work yet; more pairings and tests will tell.';
  }
  // Refresher: many unpaired plays since the last valid pairing, or a previously working anchor slipping.
  const lastPair = a.pairings.filter((p) => p.valid).at(-1);
  const unpairedSince = lastPair ? a.unpairedPlays.filter((u) => u.day > lastPair.day || (u.day === lastPair.day && u.t > lastPair.t)).length : a.unpairedPlays.length;
  const needsRefresher = unpairedSince >= 3 || (verdict !== 'working' && vp >= TRAINING_PARAMS.anchorMinPairingsBeforeProbe && a.probes.length > 0);
  return {
    verdict,
    anchor: { n: A.n, meanDelta: A.meanDelta, hitRate: A.hitRate, medianLatencyS: A.medianLatencyS },
    control: { n: C.n, meanDelta: C.meanDelta, hitRate: C.hitRate, medianLatencyS: C.medianLatencyS },
    diff,
    validPairings: vp,
    days,
    reading,
    needsRefresher,
  };
}

/** Whether a practice session should include reinforced pairing (about one in three: partial reinforcement). */
export function shouldIncludePairing(sessionsSinceLastPairing: number): boolean {
  return sessionsSinceLastPairing >= 2;
}

/** Whether enough pairings exist for a probe session to be informative. */
export function readyForProbe(a: AnchorRecord): boolean {
  return validPairings(a) >= TRAINING_PARAMS.anchorMinPairingsBeforeProbe;
}
