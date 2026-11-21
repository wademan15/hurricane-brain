/**
 * The per-user profile and calibration store model, the profiling session design, and
 * recommendations.
 *
 * Principles (research R8; design 5):
 *  - Questionnaire answers are only a starting guess for what to try first. Every conclusion
 *    (the strength labels) comes from measured response: labels are computed from a skeptical
 *    data-only estimate shrunk toward zero, never toward the questionnaire guess.
 *  - One block proves nothing. Labels need several clean blocks across sessions, and "strong"
 *    also needs the person's ranking of techniques to replicate between sessions.
 *  - Order is counterbalanced (Williams Latin square) and effects are corrected for time in session.
 *  - Exploration never stops: Thompson sampling keeps trying uncertain techniques.
 *
 * Everything here is pure: functions take a profile and return a new one. Storage belongs to
 * the storage layer; profiles stay on the device (CLAUDE.md rule 8).
 */

import { evaluateAnchor, type AnchorRecord, type SessionReach } from './anchors';
import { createRng, deriveSeed, mean, normalCdf, normalQuantile, quantile, shuffled, type Rng } from './math';
import { TRAINING_PARAMS } from './params';
import type { SafetyFlag, StateId } from './program';
import { getProgram, PROGRAMS } from './programs';
import { SIGNATURE_FIELD, type BaselineSummary, type BlockRecord, type CheckIn, type Posture, type SessionRecord } from './runner';
import { compareTechniques, meanDifference, seFromInterval, type Comparison } from './stats';
import type { Signature, SignatureBlock } from './signatures';
import { CORE_STRATEGIES, getStrategy, STRATEGIES, type TraitId } from './strategies';

export const PROFILE_FORMAT = 'hurricane-brain/profile';
export const PROFILE_FORMAT_VERSION = 1;

/** The measure each state is profiled on, and which way is "toward the state". */
export const STATE_METRICS: Record<string, { field: string; direction: 1 | -1; label: string }> = {
  alpha_ec: { field: 'spectra[temporal].bands.alpha.above_bg_db', direction: 1, label: 'calm alpha' },
  alpha_eo: { field: 'spectra[temporal].bands.alpha.above_bg_db', direction: 1, label: 'open-eyed alpha' },
  stillness: { field: 'quality[*].emg_db', direction: -1, label: 'stillness' },
  alpha_theta: { field: 'diff(spectra[temporal].bands.theta.above_bg_db, spectra[temporal].bands.alpha.above_bg_db)', direction: 1, label: 'deep states' },
  theta: { field: 'spectra[temporal].bands.theta.above_bg_db', direction: 1, label: 'theta' },
  calm_heart: { field: 'heart.resonance_strength', direction: 1, label: 'heart resonance' },
  high_hrv: { field: 'heart.rmssd_ms', direction: 1, label: 'heart variability' },
  golden: { field: 'cascades.phi.excess_a', direction: 1, label: 'golden ratio alignment' },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Questionnaire {
  /** Imagery vividness, mean of a 4-item short form, 1..5. */
  imagery?: number;
  /** "When you picture an apple, do you see anything?" answered no. */
  aphantasia?: boolean;
  /** Absorption, 1..5. */
  absorption?: number;
  /** Noticing breath and heartbeat, 1..5. */
  interoception?: number;
  meditation?: 'none' | 'some' | 'regular' | 'years';
  /** GAD-2 total, 0..6. */
  anxiety?: number;
  /** Thinks in words, 1..5. */
  verbal?: number;
  chronotype?: 'morning' | 'neither' | 'evening';
  /** Sense of control with technology, 1..5. */
  techControl?: number;
}

export type SafetyAnswers = Partial<Record<SafetyFlag, boolean>>;

export interface CalibrationRecord {
  sessionId: string;
  at: string;
  /** Individual alpha frequency from eyes-closed rest (pass to EngineApi.setIaf). */
  iafHz: number | null;
  iafSe: number | null;
  alphaWidthHz: number | null;
  /** Eyes-closed minus eyes-open alpha above background, dB. */
  alphaReactivityDb: number | null;
  /** Low reactivity: steer toward stillness, breath and heart goals, kindly. */
  lowAlpha: boolean | null;
  thetaPeakHz: number | null;
  /** Alpha peak / theta peak; feeds golden ratio work. */
  alphaThetaRatio: number | null;
  aperiodicExponent: number | null;
  emgBaselineDb: number | null;
  /** Agreement of the two eyes-closed rests, dB difference. */
  stabilityDb: number | null;
  eyesOpen: Record<string, BaselineSummary>;
  eyesClosed: Record<string, BaselineSummary>;
}

export interface BlockEffectEntry {
  sessionId: string;
  day: string;
  blockIndex: number;
  position: number;
  tSinceStartS: number;
  /** Standardized effect toward the state (sign-corrected), and its standard error. */
  d: number;
  se: number;
  cleanFraction: number;
  ease: number | null;
  posture: Posture | null;
  feedback: boolean;
}

export type StrategyLabel = 'strong' | 'promising' | 'unclear' | 'not_now';

export interface StrategyEstimate {
  state: StateId;
  strategy: string;
  /** Data-only estimate (skeptical prior centred on zero). */
  mean: number;
  sd: number;
  lo: number;
  hi: number;
  nBlocks: number;
  nSessions: number;
  label: StrategyLabel;
  /** Questionnaire starting guess (used only to choose what to try). */
  priorGuess: number;
  reading: string;
  history: BlockEffectEntry[];
}

export interface SessionSummary {
  sessionId: string;
  day: string;
  startedAt: string;
  programId: string;
  level: number | null;
  state: string;
  posture: Posture | null;
  soundscape: string | null;
  checkIn: CheckIn;
  cleanFraction: number | null;
  fractionInTarget: number | null;
  medianLatencyS: number | null;
  /** Transfer block success divided by mean feedback-block success. */
  transferRatio: number | null;
  /** Signature reached: detected in state blocks with the state rated 4 or 5. */
  signatureReached: boolean | null;
  ratings: { depth: number | null; ease: number | null; pleasantness: number | null };
}

export interface ResonanceResult {
  sessionId: string;
  at: string;
  bpm: number;
  candidates: { bpm: number; lfPower: number | null; resonanceStrength: number | null; adherence: number | null; usable: boolean }[];
  /** Rates within noise of the chosen one. */
  withinNoise: number[];
  reading: string;
}

export interface UserProfile {
  format: typeof PROFILE_FORMAT;
  formatVersion: number;
  userId: string;
  createdAt: string;
  seed: number;
  safety: SafetyAnswers;
  questionnaire: Questionnaire | null;
  calibrations: CalibrationRecord[];
  /** Latest resting baselines per field and eye condition key 'field|eyes'. */
  baselines: Record<string, BaselineSummary & { at: string }>;
  estimates: StrategyEstimate[];
  sessions: SessionSummary[];
  /** Labelled blocks kept for signature learning, per state. */
  signatureBlocks: Record<string, SignatureBlock[]>;
  signatures: Signature[];
  anchors: AnchorRecord[];
  resonance: ResonanceResult | null;
  programs: Record<string, { level: number; history: { sessionId: string; day: string; met: boolean }[] }>;
  discoverySessions: number;
}

export function createProfile(userId: string, createdAt: string, seed: number, safety: SafetyAnswers = {}, questionnaire: Questionnaire | null = null): UserProfile {
  return {
    format: PROFILE_FORMAT, formatVersion: PROFILE_FORMAT_VERSION, userId, createdAt, seed, safety, questionnaire,
    calibrations: [], baselines: {}, estimates: [], sessions: [], signatureBlocks: {}, signatures: [], anchors: [], resonance: null, programs: {}, discoverySessions: 0,
  };
}

export function parseProfile(json: string): UserProfile {
  const p = JSON.parse(json) as UserProfile;
  if (p.format !== PROFILE_FORMAT) throw new Error('not a Hurricane Brain profile');
  if (p.formatVersion !== PROFILE_FORMAT_VERSION) throw new Error(`unsupported profile version ${p.formatVersion}`);
  return p;
}

// ---------------------------------------------------------------------------
// Questionnaire prior
// ---------------------------------------------------------------------------

function traitScore(q: Questionnaire, t: TraitId): number {
  switch (t) {
    case 'imagery': return q.imagery === undefined ? 0 : (q.imagery - 3) / 2;
    case 'aphantasia': return q.aphantasia ? 1 : 0;
    case 'absorption': return q.absorption === undefined ? 0 : (q.absorption - 3) / 2;
    case 'interoception': return q.interoception === undefined ? 0 : (q.interoception - 3) / 2;
    case 'meditation': return q.meditation === undefined ? 0 : { none: -1, some: 0, regular: 0.5, years: 1 }[q.meditation];
    case 'anxiety': return q.anxiety === undefined ? 0 : (q.anxiety - 3) / 3;
    case 'verbal': return q.verbal === undefined ? 0 : (q.verbal - 3) / 2;
  }
}

/** Starting guess for a strategy's effect, in standardized units, from the questionnaire. Never a conclusion. */
export function priorGuess(q: Questionnaire | null, strategyId: string): number {
  const s = getStrategy(strategyId);
  if (!q || !s) return 0;
  let g = 0;
  for (const h of s.suits) g += (h.trait === 'aphantasia' ? 0.4 : 0.1) * h.sign * traitScore(q, h.trait);
  return Math.max(-0.4, Math.min(0.3, g));
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/** DerSimonian-Laird between-block variance, floored at the assumed heterogeneity when few blocks. */
function heterogeneity(entries: readonly BlockEffectEntry[]): number {
  const het0 = TRAINING_PARAMS.blockHeterogeneitySd ** 2;
  if (entries.length < 3) return het0;
  const w = entries.map((e) => 1 / (e.se * e.se));
  const sw = w.reduce((a, b) => a + b, 0);
  const m = entries.reduce((a, e, i) => a + w[i] * e.d, 0) / sw;
  const qStat = entries.reduce((a, e, i) => a + w[i] * (e.d - m) ** 2, 0);
  const c = sw - w.reduce((a, b) => a + b * b, 0) / sw;
  const tau2 = c > 0 ? Math.max(0, (qStat - (entries.length - 1)) / c) : 0;
  // With few blocks, never claim less heterogeneity than half the assumed value.
  return entries.length >= 8 ? tau2 : Math.max(tau2, het0 / 2);
}

function posterior(entries: readonly BlockEffectEntry[], priorMean: number): { mean: number; sd: number } {
  const het = heterogeneity(entries);
  let prec = 1 / TRAINING_PARAMS.priorEffectSd ** 2;
  let s = priorMean * prec;
  for (const e of entries) {
    const w = 1 / (e.se * e.se + het);
    prec += w;
    s += w * e.d;
  }
  return { mean: s / prec, sd: Math.sqrt(1 / prec) };
}

export function estimateStrategy(state: StateId, strategy: string, entries: readonly BlockEffectEntry[], q: Questionnaire | null, rankingReliable: boolean | null): StrategyEstimate {
  const usable = entries.filter((e) => e.cleanFraction >= TRAINING_PARAMS.minBlockCleanFraction);
  const post = posterior(usable, 0);
  const z = normalQuantile(0.5 + TRAINING_PARAMS.ciLevel / 2);
  const lo = post.mean - z * post.sd;
  const hi = post.mean + z * post.sd;
  const nSessions = new Set(usable.map((e) => e.sessionId)).size;
  const meaningful = TRAINING_PARAMS.meaningfulEffect;
  const pPositive = 1 - normalCdf(-post.mean / post.sd);
  let label: StrategyLabel = 'unclear';
  if (usable.length >= TRAINING_PARAMS.minBlocksForLabel && hi < meaningful) label = 'not_now';
  else if (usable.length >= TRAINING_PARAMS.minBlocksForLabel && nSessions >= TRAINING_PARAMS.minSessionsForStrong && lo > 0 && post.mean >= meaningful && rankingReliable !== false) label = 'strong';
  else if (usable.length >= 2 && pPositive >= 0.8 && post.mean >= meaningful * 0.67) label = 'promising';
  const name = getStrategy(strategy)?.name ?? strategy;
  const metric = STATE_METRICS[state]?.label ?? state;
  const reading = {
    strong: `${name} reliably moved your ${metric} in your sessions so far.`,
    promising: `${name} looks promising for your ${metric}; a few more blocks will tell.`,
    unclear: usable.length < 2 ? `Not enough clean blocks of ${name} yet.` : `${name}: the effect on your ${metric} is unclear so far, within noise.`,
    not_now: `${name} has not moved your ${metric} in your sessions so far. That is common, and it may change as your practice grows.`,
  }[label];
  return { state, strategy, mean: post.mean, sd: post.sd, lo, hi, nBlocks: usable.length, nSessions, label, priorGuess: priorGuess(q, strategy), reading, history: entries.slice() };
}

/** Spearman rank correlation. */
function spearman(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const rank = (xs: number[]) => {
    const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** Test-retest agreement of strategy rankings between odd and even sessions. Null: not enough data. */
export function rankingReliability(estimates: readonly StrategyEstimate[], state: StateId): number | null {
  const a: number[] = [];
  const b: number[] = [];
  for (const e of estimates.filter((x) => x.state === state)) {
    const sessions = Array.from(new Set(e.history.map((h) => h.sessionId)));
    if (sessions.length < 2) continue;
    const odd = e.history.filter((h) => sessions.indexOf(h.sessionId) % 2 === 0).map((h) => h.d);
    const even = e.history.filter((h) => sessions.indexOf(h.sessionId) % 2 === 1).map((h) => h.d);
    if (!odd.length || !even.length) continue;
    a.push(mean(odd));
    b.push(mean(even));
  }
  return spearman(a, b);
}

/** Compare two strategies for a state, with the honest "within noise" verdict. */
export function compareStrategies(profile: UserProfile, state: StateId, a: string, b: string): Comparison | null {
  const ea = profile.estimates.find((e) => e.state === state && e.strategy === a);
  const eb = profile.estimates.find((e) => e.state === state && e.strategy === b);
  if (!ea || !eb) return null;
  const ok = (e: BlockEffectEntry) => e.cleanFraction >= TRAINING_PARAMS.minBlockCleanFraction;
  return compareTechniques(ea.history.filter(ok).map((h) => ({ estimate: h.d, se: h.se, sessionId: h.sessionId })), eb.history.filter(ok).map((h) => ({ estimate: h.d, se: h.se, sessionId: h.sessionId })));
}

// ---------------------------------------------------------------------------
// Ingesting a session
// ---------------------------------------------------------------------------

function blockEntry(rec: SessionRecord, blk: BlockRecord, field: string, dir: 1 | -1): BlockEffectEntry | null {
  const s = blk.stats[field];
  if (!s?.effect) return null;
  const e = s.effect;
  const se = seFromInterval(e.dLo, e.dHi, e.diff.df);
  if (!(se > 0) || !Number.isFinite(e.d)) return null;
  return {
    sessionId: rec.id, day: rec.day, blockIndex: blk.index, position: blk.position, tSinceStartS: blk.tSinceStartS,
    d: dir * e.d, se, cleanFraction: Math.min(blk.cleanFraction, s.cleanFraction), ease: blk.rating?.ease ?? null, posture: rec.posture, feedback: blk.feedback,
  };
}

function median(xs: number[]): number | null {
  return xs.length ? quantile(xs, 0.5) : null;
}

export function calibrationFromSession(rec: SessionRecord): CalibrationRecord {
  const eo = rec.blocks.filter((b) => b.kind === 'baseline' && b.eyes === 'open');
  const ec = rec.blocks.filter((b) => b.kind === 'baseline' && b.eyes === 'closed');
  const m = (bs: BlockRecord[], f: string) => {
    const xs = bs.map((b) => b.stats[f]?.mean).filter((x): x is number => x !== null && x !== undefined);
    return xs.length ? mean(xs) : null;
  };
  const alpha = 'spectra[temporal].bands.alpha.above_bg_db';
  const ecA = m(ec, alpha);
  const eoA = m(eo, alpha);
  const iaf = m(ec, 'track[alpha].freq_integrated');
  const theta = m(ec, 'track[theta].freq_integrated');
  const iafSds = ec.map((b) => b.stats['track[alpha].freq_integrated']).filter((s) => s && s.sd !== null && s.ess !== null).map((s) => (s.sd as number) / Math.sqrt(s.ess as number));
  const reactivity = ecA !== null && eoA !== null ? ecA - eoA : null;
  const ecMeans = ec.map((b) => b.stats[alpha]?.mean).filter((x): x is number => x !== null && x !== undefined);
  const summ = (bs: BlockRecord[]): Record<string, BaselineSummary> => {
    const out: Record<string, BaselineSummary> = {};
    for (const b of bs) for (const [f, s] of Object.entries(b.stats)) {
      if (s.mean === null || s.sd === null) continue;
      out[f] = { field: f, n: s.n, mean: s.mean, sd: s.sd, ess: s.ess ?? 1, q: [], tMid: b.tStart + (b.tEnd - b.tStart) / 2, varMean: (s.sd * s.sd) / Math.max(s.ess ?? 1, 1), tau: s.ess ? s.n / s.ess : 1, eyes: b.eyes };
    }
    return out;
  };
  return {
    sessionId: rec.id, at: rec.startedAt,
    iafHz: iaf, iafSe: iafSds.length ? Math.sqrt(mean(iafSds.map((x) => x * x)) / iafSds.length) : null,
    alphaWidthHz: m(ec, 'track[alpha].width_hz'),
    alphaReactivityDb: reactivity, lowAlpha: reactivity === null ? null : reactivity < TRAINING_PARAMS.lowAlphaReactivityDb,
    thetaPeakHz: theta, alphaThetaRatio: iaf !== null && theta !== null && theta > 0 ? iaf / theta : null,
    aperiodicExponent: m(ec, 'spectra[temporal].bg_exponent'),
    emgBaselineDb: m(eo, 'quality[*].emg_db'),
    stabilityDb: ecMeans.length >= 2 ? Math.abs(ecMeans[0] - ecMeans[ecMeans.length - 1]) : null,
    eyesOpen: summ(eo), eyesClosed: summ(ec),
  };
}

/** Choose the personal resonance breathing rate from a resonance-finding session. */
export function findResonanceRate(rec: SessionRecord): ResonanceResult | null {
  const trials = rec.blocks.filter((b) => b.pacerBpm !== null && b.kind === 'strategy' && !b.excluded);
  if (!trials.length) return null;
  const lf = 'heart.lf_power';
  const rs = 'heart.resonance_strength';
  const ad = 'heart.pacer_adherence';
  const cands = trials.map((b) => {
    const adherence = b.stats[ad]?.mean ?? null;
    return { bpm: b.pacerBpm as number, lfPower: b.stats[lf]?.mean ?? null, resonanceStrength: b.stats[rs]?.mean ?? null, adherence, usable: (adherence === null || adherence >= TRAINING_PARAMS.resonanceMinAdherence) && b.stats[lf]?.mean != null, block: b };
  });
  const usable = cands.filter((c) => c.usable);
  if (!usable.length) return null;
  usable.sort((a, b) => (b.lfPower as number) - (a.lfPower as number) || (b.resonanceStrength ?? 0) - (a.resonanceStrength ?? 0));
  const best = usable[0];
  const within: number[] = [];
  const toSeries = (b: BlockRecord) => {
    const s = b.stats[lf];
    return s && s.mean !== null && s.sd !== null && s.ess ? { n: s.n, mean: s.mean, sd: s.sd, tau: s.n / s.ess, ess: s.ess, varMean: (s.sd * s.sd) / s.ess, tMid: b.tStart } : null;
  };
  const bs = toSeries(best.block);
  for (const c of usable.slice(1)) {
    const cs = toSeries(c.block);
    if (bs && cs && meanDifference(bs, cs).lo <= 0) within.push(c.bpm);
  }
  const reading = within.length
    ? `Your heart rhythm swung most strongly at ${best.bpm} breaths a minute, but ${within.join(' and ')} were within noise of it. Any of these suits you; ${best.bpm} is used for now and can be rechecked.`
    : `Your heart rhythm swung most strongly at ${best.bpm} breaths a minute. That is your resonance rate for now.`;
  return { sessionId: rec.id, at: rec.startedAt, bpm: best.bpm, candidates: cands.map(({ block: _b, ...c }) => c), withinNoise: within, reading };
}

function summarizeSession(rec: SessionRecord, sig: Signature | null): SessionSummary {
  const train = rec.blocks.filter((b) => b.kind === 'train' && !b.excluded);
  const transfer = rec.blocks.filter((b) => b.kind === 'transfer' && !b.excluded);
  const fit = train.map((b) => b.successCombined).filter((x): x is number => x !== null);
  const lat: number[] = [];
  for (const b of train) for (const t of rec.targets) if (t.field && b.stats[t.field]?.timeToTargetS != null) lat.push(b.stats[t.field].timeToTargetS as number);
  const tr = transfer.map((b) => b.successCombined).filter((x): x is number => x !== null);
  const r = (k: 'depth' | 'ease' | 'pleasantness') => {
    const xs = rec.blocks.map((b) => b.rating?.[k]).filter((x): x is number => typeof x === 'number');
    return xs.length ? mean(xs) : null;
  };
  let reached: boolean | null = null;
  const stateBlocks = rec.blocks.filter((b) => b.label === 'state' && b.signature);
  if (sig && stateBlocks.length) {
    reached = stateBlocks.some((b) => (b.signature?.activeFraction ?? 0) > 0.25 && (b.rating?.emotion_intensity ?? 0) >= 4);
  }
  return {
    sessionId: rec.id, day: rec.day, startedAt: rec.startedAt, programId: rec.program.id, level: rec.program.level, state: rec.program.state,
    posture: rec.posture, soundscape: rec.soundscape, checkIn: rec.checkIn,
    cleanFraction: rec.blocks.length ? mean(rec.blocks.map((b) => b.cleanFraction)) : null,
    fractionInTarget: fit.length ? mean(fit) : null,
    medianLatencyS: median(lat),
    transferRatio: tr.length && fit.length && mean(fit) > 0 ? mean(tr) / mean(fit) : null,
    signatureReached: reached,
    ratings: { depth: r('depth'), ease: r('ease'), pleasantness: r('pleasantness') },
  };
}

/** Whether a session met its ladder level's criterion (design 6.1). */
function metCriterion(s: SessionSummary, level: number): boolean {
  const c = { 1: { f: 0.6 }, 2: { f: 0.6, l: 90 }, 3: { f: 0.65, l: 60 }, 4: { t: 0.75 }, 5: { l: 60 } }[level as 1 | 2 | 3 | 4 | 5] as { f?: number; l?: number; t?: number };
  if (c.f !== undefined && !(s.fractionInTarget !== null && s.fractionInTarget >= c.f)) return false;
  if (c.l !== undefined && !(s.medianLatencyS !== null && s.medianLatencyS <= c.l)) return false;
  if (c.t !== undefined && !(s.transferRatio !== null && s.transferRatio >= c.t)) return false;
  return true;
}

/**
 * Fold a finished session into the profile. Pure: returns a new profile.
 * `signatureBlocks` from labelled blocks are accumulated for signature learning; call
 * learnSignature (signatures.ts) with profile.signatureBlocks[state] to refresh a signature.
 */
export function ingestSession(profile: UserProfile, rec: SessionRecord): UserProfile {
  const p: UserProfile = JSON.parse(JSON.stringify(profile)) as UserProfile;
  const sig = rec.signatureId ? (p.signatures.find((s) => s.id === rec.signatureId) ?? null) : null;

  // Strategy effects: technique blocks (Discovery) and practice blocks with a named strategy.
  for (const blk of rec.blocks) {
    if (!blk.strategy || blk.excluded) continue;
    if (blk.kind !== 'strategy' && blk.kind !== 'train' && blk.kind !== 'transfer') continue;
    if (blk.techniques.length) continue; // the user switched technique: not attributable
    for (const [state, m] of Object.entries(STATE_METRICS)) {
      if ((state === 'alpha_ec' && blk.eyes !== 'closed') || (state === 'alpha_eo' && blk.eyes !== 'open')) continue;
      const entry = blockEntry(rec, blk, m.field, m.direction);
      if (!entry) continue;
      let est = p.estimates.find((e) => e.state === state && e.strategy === blk.strategy);
      if (!est) {
        est = estimateStrategy(state, blk.strategy, [], p.questionnaire, null);
        p.estimates.push(est);
      }
      est.history.push(entry);
    }
  }
  // Re-estimate every touched state with the ranking reliability check.
  for (const state of new Set(p.estimates.map((e) => e.state))) {
    const rel = rankingReliability(p.estimates, state);
    const reliable = rel === null ? null : rel >= TRAINING_PARAMS.minRankReliability;
    p.estimates = p.estimates.map((e) => (e.state === state ? estimateStrategy(state, e.strategy, e.history, p.questionnaire, reliable) : e));
  }

  // Baselines
  for (const [f, b] of Object.entries(rec.baselines)) {
    if (f === SIGNATURE_FIELD) continue;
    p.baselines[`${f}|${b.eyes}`] = { ...b, at: rec.startedAt };
  }
  // Calibration
  if (rec.program.id === 'calibration') p.calibrations.push(calibrationFromSession(rec));
  // Resonance
  if (rec.program.id === 'hrv_resonance_finding') {
    const r = findResonanceRate(rec);
    if (r) p.resonance = r;
  }
  if (rec.program.id === 'discovery_sampler') p.discoverySessions += 1;

  // Signature blocks
  for (const blk of rec.blocks) {
    if (!blk.label || blk.excluded || !blk.windows.length) continue;
    const features: Record<string, number | null> = {};
    const fields = Object.keys(blk.windows[0].values);
    for (const f of fields) {
      const xs = blk.windows.map((w) => w.values[f]).filter((x): x is number => x !== null);
      features[f] = xs.length ? mean(xs) : null;
    }
    const list = p.signatureBlocks[rec.program.state] ?? [];
    list.push({ sessionId: rec.id, day: rec.day, label: blk.label, features, windows: blk.windows.map((w) => w.values) });
    p.signatureBlocks[rec.program.state] = list;
  }

  // Anchors
  if (rec.anchor) {
    p.anchors = p.anchors.map((a) => a.id !== rec.anchor?.id ? a : {
      ...a,
      pairings: [...a.pairings, ...rec.pairings],
      controlExposures: [...a.controlExposures, ...rec.controlExposures.map((e) => ({ sessionId: rec.id, day: rec.day, t: e.t }))],
      probes: [...a.probes, ...rec.probes],
      unpairedPlays: [...a.unpairedPlays, ...rec.markers.filter((m) => m.type === 'anchor_play' && m.data?.mode === 'on_demand').map((m) => ({ sessionId: rec.id, day: rec.day, t: m.t }))],
    });
  }

  // Session summary and ladder
  const summary = summarizeSession(rec, sig);
  p.sessions.push(summary);
  if (rec.program.level !== null) {
    const entry = p.programs[rec.program.id] ?? { level: rec.program.level, history: [] };
    entry.history.push({ sessionId: rec.id, day: rec.day, met: metCriterion(summary, entry.level) });
    const last3 = entry.history.slice(-3);
    if (last3.filter((h) => h.met).length >= 2 && entry.level < 5) {
      // Advance: met in 2 of the last 3 sessions. The new level starts a fresh history.
      entry.level += 1;
      entry.history = [];
    }
    p.programs[rec.program.id] = entry;
  }
  return p;
}

/** Sessions reaching the state, for anchor eligibility. */
export function signatureReach(profile: UserProfile, state: StateId): SessionReach[] {
  return profile.sessions.filter((s) => s.state === state && s.signatureReached !== null).map((s) => ({ sessionId: s.sessionId, day: s.day, reached: s.signatureReached as boolean }));
}

// ---------------------------------------------------------------------------
// Profiling session design
// ---------------------------------------------------------------------------

/** First Discovery session for everyone (design 5.4). */
export const FIRST_DISCOVERY = ['none', 'breath_resonance', 'body_scan', 'visual_calm', 'mantra_silent'];

/** Strategies a person should not be offered given their safety answers. */
export function excludedStrategies(safety: SafetyAnswers): Set<string> {
  const out = new Set<string>();
  if (safety.breathing_condition || safety.heart_condition) {
    out.add('breath_resonance');
    out.add('appreciation_heart');
  }
  if (safety.trauma_dissociation) out.add('visual_drift');
  return out;
}

/** Williams design row: a balanced Latin square ordering for n items (first-order carryover balanced for even n). */
export function williamsRow(n: number, row: number): number[] {
  // Williams sequence 0, 1, n-1, 2, n-2, ... shifted by the row. For odd n the full balance
  // needs 2n rows; across sessions the rows cycle, which is the practical compromise.
  const seq = [0];
  for (let k = 1, lo = 1, hi = n - 1; k < n; k++) seq.push(k % 2 === 1 ? lo++ : hi--);
  return seq.map((x) => (x + row) % n);
}

export interface DiscoveryPlan {
  sessionIndex: number;
  strategies: string[];
  design: { kind: 'williams'; row: number; seed: number };
  reason: string;
}

/**
 * Plan the next Discovery session: which techniques, in which order. Pass the result's
 * strategies as InstantiateOptions.strategySlots for the 'discovery_sampler' program.
 */
export function planDiscoverySession(profile: UserProfile, state: StateId = 'alpha_ec', perSession = 5): DiscoveryPlan {
  const idx = profile.discoverySessions;
  const seed = deriveSeed(profile.seed, `discovery:${idx}`);
  const rng = createRng(seed);
  const excluded = excludedStrategies(profile.safety);
  let chosen: string[];
  let reason: string;
  if (idx === 0) {
    chosen = FIRST_DISCOVERY.filter((s) => !excluded.has(s));
    reason = 'Broad first look: rest, breath, body, imagery and a silent word.';
  } else {
    const counts = (s: string) => profile.estimates.find((e) => e.state === state && e.strategy === s)?.nBlocks ?? 0;
    const core = CORE_STRATEGIES.filter((s) => !excluded.has(s));
    const owed = core.filter((s) => counts(s) < TRAINING_PARAMS.discoveryRepeats).sort((a, b) => counts(a) - counts(b) || a.localeCompare(b));
    chosen = owed.slice(0, perSession);
    if (chosen.length < perSession) {
      const extra = STRATEGIES.filter((s) => s.serves.includes(state) && !excluded.has(s.id) && !chosen.includes(s.id) && s.family !== 'emotional_recall' && s.family !== 'movement' && s.eyes !== 'open');
      const scored = extra.map((s) => ({ id: s.id, draw: thompsonDraw(profile, state, s.id, rng) })).sort((a, b) => b.draw - a.draw);
      chosen.push(...scored.slice(0, perSession - chosen.length).map((x) => x.id));
    }
    // Always keep 'none' as the reference technique when there is room.
    if (!chosen.includes('none') && chosen.length < 6) chosen.push('none');
    reason = owed.length ? 'Completing the core techniques so each is tried at least twice.' : 'Exploring further techniques where your profile is still uncertain.';
  }
  const items = shuffled(chosen, rng);
  const row = idx % items.length;
  const order = williamsRow(items.length, row).map((i) => items[i]);
  return { sessionIndex: idx, strategies: order, design: { kind: 'williams', row, seed }, reason };
}

function thompsonDraw(profile: UserProfile, state: StateId, strategy: string, rng: Rng): number {
  const e = profile.estimates.find((x) => x.state === state && x.strategy === strategy);
  const post = posterior(e?.history.filter((h) => h.cleanFraction >= TRAINING_PARAMS.minBlockCleanFraction) ?? [], priorGuess(profile.questionnaire, strategy));
  return post.mean + post.sd * rng.normal();
}

export interface Recommendation {
  strategy: string;
  mode: 'best_so_far' | 'exploring';
  reading: string;
}

/** What to practise next for a state: Thompson sampling, with an exploration floor. */
export function recommendNext(profile: UserProfile, state: StateId, seed: number): Recommendation | null {
  const rng = createRng(seed);
  const excluded = excludedStrategies(profile.safety);
  const cands = STRATEGIES.filter((s) => s.serves.includes(state) && !excluded.has(s.id));
  if (!cands.length) return null;
  const best = profile.estimates.filter((e) => e.state === state).sort((a, b) => b.mean - a.mean)[0];
  if (rng.next() < TRAINING_PARAMS.minExploreProbability || !best) {
    // Explore: the most uncertain candidate, ties broken by the starting guess.
    const sdOf = (id: string) => profile.estimates.find((e) => e.state === state && e.strategy === id)?.sd ?? TRAINING_PARAMS.priorEffectSd;
    const pick = cands.slice().sort((a, b) => sdOf(b.id) - sdOf(a.id) || priorGuess(profile.questionnaire, b.id) - priorGuess(profile.questionnaire, a.id) || a.id.localeCompare(b.id))[0];
    return { strategy: pick.id, mode: 'exploring', reading: `Trying ${pick.name} to learn more about what suits you.` };
  }
  const draws = cands.map((s) => ({ s, d: thompsonDraw(profile, state, s.id, rng) })).sort((a, b) => b.d - a.d);
  const pick = draws[0].s;
  const est = profile.estimates.find((e) => e.state === state && e.strategy === pick.id);
  const mode = est && est.label !== 'unclear' && pick.id === best.strategy ? 'best_so_far' : 'exploring';
  return { strategy: pick.id, mode, reading: est ? est.reading : `Trying ${pick.name}: not measured for you yet.` };
}

/** The best measured strategy for a state, for 'profile_best' blocks. Falls back to 'none'. */
export function bestStrategy(profile: UserProfile, state: StateId): string {
  const ranked = profile.estimates.filter((e) => e.state === state && (e.label === 'strong' || e.label === 'promising')).sort((a, b) => b.mean - a.mean);
  return ranked[0]?.strategy ?? 'none';
}

export interface ProgramSuggestion {
  programId: string;
  reason: string;
}

/** Programs to suggest, including the non-responder pathway (design 6.3). */
export function recommendPrograms(profile: UserProfile): ProgramSuggestion[] {
  const out: ProgramSuggestion[] = [];
  const cal = profile.calibrations.at(-1);
  if (!cal) return [{ programId: 'calibration', reason: 'Start with calibration so everything else is set to your own signals.' }];
  if (profile.discoverySessions < 5) out.push({ programId: 'discovery_sampler', reason: `Discovery session ${profile.discoverySessions + 1} of about 5: learning which techniques move your brain.` });
  if (!profile.programs['stillness_soft_landing']) out.push({ programId: 'stillness_soft_landing', reason: 'Everyone\'s first program: quick to feel, and it cleans the signal for the rest.' });
  const alphaEst = profile.estimates.filter((e) => e.state === 'alpha_ec');
  const anyGood = alphaEst.some((e) => e.label === 'strong' || e.label === 'promising');
  const alphaSessions = profile.sessions.filter((s) => s.programId === 'alpha_eyes_closed');
  const flat = alphaSessions.length >= 5 && (alphaSessions.slice(-5).map((s) => s.fractionInTarget ?? 0).reduce((a, b) => a + b, 0) / 5) < 0.5;
  const poorSignal = profile.sessions.slice(-5).some((s) => (s.cleanFraction ?? 1) < 0.7);
  if (cal.lowAlpha || (profile.discoverySessions >= 5 && !anyGood) || flat) {
    if (poorSignal) out.push({ programId: 'stillness_soft_landing', reason: 'Signal quality has been low in recent sessions; a better fit and a soft face often change everything.' });
    out.push({ programId: 'hrv_resonance_finding', reason: 'Some brains show the alpha rhythm less, which is common and not a problem. Heart resonance works for almost everyone.' });
    out.push({ programId: 'stillness_soft_landing', reason: 'Stillness training works for everyone, whatever their alpha.' });
  } else {
    out.push({ programId: 'alpha_eyes_closed', reason: anyGood ? `Practise with your best approach: ${getStrategy(bestStrategy(profile, 'alpha_ec'))?.name ?? 'simply resting'}.` : 'Calm Alpha, using what Discovery has found so far.' });
  }
  if (!profile.resonance) out.push({ programId: 'hrv_resonance_finding', reason: 'With a chest strap, find your personal breathing rate.' });
  // Anchors needing a refresher
  for (const a of profile.anchors) if (!a.retired && evaluateAnchor(a).needsRefresher) out.push({ programId: 'anchor_pairing', reason: `Your ${a.state} anchor would benefit from a refresher pairing session.` });
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.programId) ? false : (seen.add(s.programId), true))).filter((s) => {
    const prog = getProgram(s.programId);
    return !!prog && !(prog.unlock?.excludeIf ?? []).some((f) => profile.safety[f]);
  });
}

/** How the person's sense of a technique compares with what their measurements showed (design 5.7). */
export function subjectiveVsMeasured(profile: UserProfile, state: StateId): { strategy: string; meanEase: number | null; meanEffect: number; n: number }[] {
  return profile.estimates.filter((e) => e.state === state).map((e) => {
    const eases = e.history.map((h) => h.ease).filter((x): x is number => x !== null);
    return { strategy: e.strategy, meanEase: eases.length ? mean(eases) : null, meanEffect: e.mean, n: e.nBlocks };
  });
}

/** Programs available to this person given safety answers and unlocks. */
export function availablePrograms(profile: UserProfile): string[] {
  return PROGRAMS.filter((p) => {
    if ((p.unlock?.excludeIf ?? []).some((f) => profile.safety[f])) return false;
    if (p.unlock?.afterProgram) {
      const lvl = profile.programs[p.unlock.afterProgram]?.level ?? 0;
      if (lvl < (p.unlock.level ?? 1)) return false;
    }
    if (p.requires.signature && !profile.signatures.some((s) => s.status === 'reliable')) return false;
    if (p.requires.anchor && !profile.anchors.some((a) => !a.retired)) return false;
    return true;
  }).map((p) => p.id);
}
