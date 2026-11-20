/**
 * The session runner: a deterministic state machine that executes a SessionPlan.
 *
 * Inputs: measurement frames (in time order) and the session clock (frame times, or
 * `advance(t)` when no frames arrive). User actions (ratings, technique changes, notes, skip,
 * stop) carry their session time.
 *
 * Outputs:
 *  - `output()`: the current block, the continuous reward level 0..1 for the sound and visual
 *    layers (never events: the reward layer swells and recedes), per-target readings, the pacer
 *    rate, the signature reading.
 *  - `drainEvents()`: things the app must do now (show guidance, set the pacer, play the anchor
 *    or control sound, ask for a rating, suggest refitting the headband).
 *  - `markers()`: every block, technique, instruction, anchor and rating event, as frames.ts
 *    Markers, to be written into the session (EngineApi.pushMarker) and stored with raw data.
 *  - `record()`: the Session record.
 *
 * Determinism: no clocks, no Math.random. Block boundaries are scheduled times, not frame
 * arrival times. The same plan, options and frames give an identical record.
 *
 * Reward rules: reward is 0 when the target is null, when gating withholds the moment
 * (artifact, bad contact, muscle), or in feedback-off blocks. Thresholds adapt between blocks
 * only, toward the program's success band. Reward smoothing has one declared time constant,
 * recorded in the session (spec rule 2.8). When reward stops, the level decays with that time
 * constant; it is never held.
 */

import { SCHEMA_VERSION, type FastFrame, type Frame, type HeartFrame, type Marker, type Measured, type Reason, type SlowFrame } from '../engine/frames';
import type { PairingRecord, ProbeTrial } from './anchors';
import { canPair } from './anchors';
import { compileField, type FieldRef, type FrameContext, type FrameKind } from './fields';
import { clamp, mean, quantile } from './math';
import { TRAINING_PARAMS, TRAINING_PARAMS_VERSION } from './params';
import type { PlannedBlock, PlanTarget, RatingKey, SessionPlan, VarValue } from './program';
import { createSignatureDetector, SIGNATURE_CANDIDATE_FIELDS, type Signature, type SignatureDetector, type SignatureReading } from './signatures';
import { computeBlockStats, fitSessionTrend, seriesStats, type BlockStats, type Sample, type SeriesStats } from './stats';
import { getStrategy } from './strategies';

export const SESSION_FORMAT = 'hurricane-brain/session';
export const SESSION_FORMAT_VERSION = 1;

/** The pseudo-field name for the live signature score in stats and baselines. */
export const SIGNATURE_FIELD = 'signature';
const EMG_FIELD = 'quality[*].emg_db';

export type Posture = 'upright' | 'reclined' | 'lying';

export interface CheckIn {
  sleepHours?: number;
  sleepQuality?: number;
  caffeine?: boolean;
  alcohol?: boolean;
  nicotine?: boolean;
  mood?: number;
  energy?: number;
  note?: string;
}

export interface BaselineSummary {
  field: string;
  n: number;
  mean: number;
  sd: number;
  ess: number;
  /** Quantiles at 0.05, 0.10, ..., 0.95. */
  q: number[];
  tMid: number;
  varMean: number;
  tau: number;
  /** Eye condition the baseline was taken in. */
  eyes: 'open' | 'closed' | 'any';
}

export interface RunnerOptions {
  sessionId: string;
  userId: string;
  /** ISO time the session started, supplied by the app (the runner never reads a clock). */
  startedAt: string;
  seed: number;
  headset?: string;
  posture?: Posture;
  checkIn?: CheckIn;
  soundscape?: string;
  /** Baselines from the profile, used when the session has no baseline block for a field. */
  priorBaselines?: Record<string, BaselineSummary>;
  /** Live signature for signature targets, pairing and probes. */
  signature?: Signature | null;
  anchor?: { id: string; controlId: string } | null;
  /** Store 10 s window means of these fields in every block (signature learning). Labelled blocks always store the candidates. */
  windowFields?: string[];
  engineVersion?: string;
  engineParams?: Record<string, number | string | boolean>;
}

export interface WindowMeans {
  t: number;
  values: Record<string, number | null>;
}

export interface BlockRecord {
  index: number;
  id: string;
  kind: PlannedBlock['kind'];
  strategy: string | null;
  /** Technique changes reported during the block. */
  techniques: { t: number; strategy: string }[];
  label: 'state' | 'contrast' | null;
  feedback: boolean;
  eyes: PlannedBlock['eyes'];
  pacerBpm: number | null;
  cue: PlannedBlock['cue'];
  tStart: number;
  tEnd: number;
  plannedS: number;
  tSinceStartS: number;
  position: number;
  /** Fraction of the block's slow frames that passed gating (EEG), or heart frames with values (heart-only). */
  cleanFraction: number;
  excluded: boolean;
  thresholds: Record<string, number | null>;
  success: Record<string, number | null>;
  /** Combined in-target fraction over clean moments. */
  successCombined: number | null;
  stats: Record<string, BlockStats>;
  windows: WindowMeans[];
  rating: Partial<Record<RatingKey, number>> | null;
  signature: { meanScore: number | null; activeFraction: number | null } | null;
  /** Seconds ignored at the start for scoring (e.g. the humming phase). */
  ignoredS: number;
}

export interface ThresholdChange {
  t: number;
  target: string;
  from: number | null;
  to: number;
  reason: 'initial' | 'adapt';
  success: number | null;
}

export interface SessionRecord {
  format: typeof SESSION_FORMAT;
  formatVersion: number;
  id: string;
  userId: string;
  startedAt: string;
  day: string;
  headset: string | null;
  posture: Posture | null;
  soundscape: string | null;
  checkIn: CheckIn;
  seed: number;
  program: { id: string; version: number; name: string; state: string; level: number | null; variables: Record<string, VarValue> };
  targets: { id: string; field: string | null; source: string; direction: 'up' | 'down' }[];
  frameSchema: number;
  engine: { version: string | null; params: Record<string, number | string | boolean> | null };
  training: { paramsVersion: number; params: typeof TRAINING_PARAMS };
  rewardTauS: number;
  tStart: number | null;
  tEnd: number | null;
  baselines: Record<string, BaselineSummary>;
  blocks: BlockRecord[];
  markers: Marker[];
  thresholdHistory: ThresholdChange[];
  anchor: { id: string; controlId: string } | null;
  signatureId: string | null;
  pairings: PairingRecord[];
  controlExposures: { t: number }[];
  probes: ProbeTrial[];
  completed: boolean;
  stoppedEarly: boolean;
}

export type RunnerEvent =
  | { type: 'block_start'; t: number; block: PlannedBlock }
  | { type: 'block_end'; t: number; blockIndex: number }
  | { type: 'instruction'; t: number; text: string; blockIndex: number }
  | { type: 'pacer'; t: number; bpm: number | null }
  | { type: 'play_anchor'; t: number; anchorId: string; mode: 'pairing' | 'probe' }
  | { type: 'play_control'; t: number; controlId: string; mode: 'exposure' | 'probe' }
  | { type: 'rating_request'; t: number; blockIndex: number; keys: RatingKey[] }
  | { type: 'tether'; t: number; text: string }
  | { type: 'check_fit'; t: number }
  | { type: 'session_end'; t: number; completed: boolean };

export interface TargetReading {
  id: string;
  value: Measured;
  threshold: number | null;
  /** 0..1 for this target, 0 when gated or null. */
  reward: number;
  inTarget: boolean | null;
}

export interface RunnerOutput {
  phase: 'ready' | 'running' | 'finished';
  t: number | null;
  blockIndex: number | null;
  block: PlannedBlock | null;
  blockElapsedS: number | null;
  blockRemainingS: number | null;
  feedback: boolean;
  reward: {
    /** Smoothed level 0..1 that the reward layer follows (time constant `tauS`). */
    level: number;
    /** Unsmoothed reward at the latest evaluation. */
    raw: number;
    tauS: number;
    gated: boolean;
    why: Reason | 'muscle' | 'feedback_off' | 'no_threshold' | null;
  };
  targets: TargetReading[];
  pacerBpm: number | null;
  signature: SignatureReading | null;
}

interface FieldTrack {
  ref: FieldRef;
  isHeart: boolean;
}

interface BlockState {
  plan: PlannedBlock;
  tStart: number;
  tEnd: number;
  samples: Map<string, Sample[]>;
  combined: { t: number; in: boolean | null }[];
  successSamples: Map<string, { t: number; v: number; in: boolean }[]>;
  slowFrames: number;
  slowClean: number;
  heartFrames: number;
  heartWithValue: number;
  cuesSent: Set<number>;
  thresholds: Record<string, number | null>;
  rating: Partial<Record<RatingKey, number>> | null;
  techniques: { t: number; strategy: string }[];
  winStart: number;
  windows: WindowMeans[];
  winSamples: Map<string, number[]>;
  sigScores: { t: number; v: number }[];
  sigActive: number;
  sigTotal: number;
  pairsThisBlock: number;
  exposureDone: boolean;
  probe: { cueT: number; cue: 'anchor' | 'control' | 'none'; pre: number | null; post: number[]; latency: number | null } | null;
  ignoredS: number;
}

const QS = Array.from({ length: 19 }, (_, i) => (i + 1) * 0.05);

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function clockDt(kind: FrameKind): number {
  return kind === 'fast' ? 1 / 32 : kind === 'slow' ? 0.25 : 1;
}
function clockFloor(kind: FrameKind): number {
  return kind === 'fast' ? TRAINING_PARAMS.fastCorrelationFloorS : kind === 'slow' ? TRAINING_PARAMS.slowCorrelationFloorS : TRAINING_PARAMS.heartCorrelationFloorS;
}

function medianSpacing(samples: readonly Sample[], fallback: number): number {
  if (samples.length < 3) return fallback;
  const d: number[] = [];
  for (let i = 1; i < samples.length; i++) d.push(samples[i].t - samples[i - 1].t);
  const m = quantile(d, 0.5);
  return m > 0 ? m : fallback;
}

export interface SessionRunner {
  start(t: number): void;
  push(frame: Frame): void;
  advance(t: number): void;
  output(): RunnerOutput;
  drainEvents(): RunnerEvent[];
  markers(): Marker[];
  /** Ratings for the most recent block that asked for them (or the current block). */
  rate(t: number, ratings: Partial<Record<RatingKey, number>>): void;
  /** The user switched technique mid-block. */
  setTechnique(t: number, strategy: string): void;
  /** A free-text report or note from the user. */
  report(t: number, text: string): void;
  /** An on-demand anchor play outside pairing (counted as unpaired by the profile). */
  noteUnpairedAnchor(t: number): void;
  skipBlock(t: number): void;
  stop(t: number): void;
  isFinished(): boolean;
  record(): SessionRecord;
}

export function createSessionRunner(plan: SessionPlan, opts: RunnerOptions): SessionRunner {
  const P = TRAINING_PARAMS;
  // ---- Fields
  const sig = opts.signature ?? null;
  const detector: SignatureDetector | null = sig ? createSignatureDetector(sig) : null;
  const windowFieldSet = new Set<string>(opts.windowFields ?? []);
  if (plan.blocks.some((b) => b.label)) for (const f of [...SIGNATURE_CANDIDATE_FIELDS, ...(sig?.fields.map((x) => x.field) ?? [])]) windowFieldSet.add(f);
  const trackedPaths = new Set<string>([...plan.statFields, ...windowFieldSet, ...plan.watches.flatMap((w) => w.when.map((c) => c.field)), ...(detector?.fields ?? [])]);
  const usesEeg = plan.gating.channels.length > 0;
  if (usesEeg) trackedPaths.add(EMG_FIELD);
  const tracks = new Map<string, FieldTrack>();
  for (const p of trackedPaths) {
    const ref = compileField(p);
    tracks.set(p, { ref, isHeart: ref.kinds.every((k) => k === 'heart') });
  }
  const targetRefs = new Map<string, FieldRef>();
  for (const t of plan.targets) if (t.field) targetRefs.set(t.id, compileField(t.field));
  const emgRef = compileField(EMG_FIELD);

  // ---- State
  let phase: RunnerOutput['phase'] = 'ready';
  let sessionStart: number | null = null;
  let tNow: number | null = null;
  let tEnd: number | null = null;
  let stoppedEarly = false;
  let blockIdx = -1;
  let cur: BlockState | null = null;
  const finished: { state: BlockState; record: BlockRecord }[] = [];
  const ctx: FrameContext = { now: 0, slow: null, fast: null, heart: null };
  const events: RunnerEvent[] = [];
  const markerList: Marker[] = [];
  const baselines: Record<string, BaselineSummary> = {};
  const baselineStats: Record<string, SeriesStats> = {};
  const thresholds: Record<string, number | null> = {};
  for (const t of plan.targets) thresholds[t.id] = null;
  const thresholdHistory: ThresholdChange[] = [];
  let level = 0;
  let raw = 0;
  let lastEvalT: number | null = null;
  let gatedWhy: RunnerOutput['reward']['why'] = null;
  let gatedSince: number | null = null;
  let checkFitSent = false;
  let lastReadings: TargetReading[] = plan.targets.map((t) => ({ id: t.id, value: { v: null, se: null, why: 'warming_up' }, threshold: null, reward: 0, inTarget: null }));
  let sigReading: SignatureReading | null = null;
  const sigHistory: { t: number; v: number }[] = [];
  let lastPairT: number | null = null;
  const pairings: PairingRecord[] = [];
  let pendingPair: { t: number; score: number | null; active: number; total: number } | null = null;
  const exposures: { t: number }[] = [];
  const probes: ProbeTrial[] = [];
  const watchState = new Map<string, number | null>(plan.watches.map((w) => [w.id, null]));
  const watchFired = new Set<string>();
  let lastRatingBlock: number | null = null;
  const day = dayOf(opts.startedAt);

  const mark = (m: Marker) => markerList.push(m);

  // ---- Baselines and thresholds
  const baselineFor = (field: string): BaselineSummary | null => baselines[field] ?? opts.priorBaselines?.[field] ?? null;

  const initialThreshold = (t: PlanTarget): number | null => {
    const init = t.initial;
    if (init.rule === 'absolute') return init.value;
    const b = baselineFor(t.field ?? SIGNATURE_FIELD);
    if (!b) return null;
    let v: number;
    if (init.rule === 'baseline_quantile') {
      const q = t.direction === 'up' ? init.q : 1 - init.q;
      v = interpQ(b.q, q);
    } else v = t.direction === 'up' ? b.mean + init.k * b.sd : b.mean - init.k * b.sd;
    return limit(t, v);
  };
  const limit = (t: PlanTarget, v: number) => {
    let x = v;
    if (t.floor !== null) x = Math.max(t.floor, x);
    if (t.ceiling !== null) x = Math.min(t.ceiling, x);
    return x;
  };
  const spanOf = (t: PlanTarget): number => {
    if (t.spanAbs !== null) return t.spanAbs;
    const b = baselineFor(t.field ?? SIGNATURE_FIELD);
    const sd = b ? b.sd : 1;
    return Math.max((t.spanSd ?? 1) * sd, P.minBaselineSd);
  };
  const ensureThresholds = (at: number) => {
    for (const t of plan.targets) {
      if (thresholds[t.id] !== null) continue;
      const v = initialThreshold(t);
      if (v !== null) {
        thresholds[t.id] = v;
        thresholdHistory.push({ t: at, target: t.id, from: null, to: v, reason: 'initial', success: null });
        mark({ t: at, type: 'note', label: 'threshold', data: { target: t.id, value: v, reason: 'initial' } });
      }
    }
  };

  // ---- Gating
  const gate = (): { ok: boolean; why: RunnerOutput['reward']['why'] } => {
    const g = plan.gating;
    if (g.fastArtifact && ctx.fast && ctx.now - ctx.fast.t <= P.staleFastS && ctx.fast.artifact) return { ok: false, why: 'artifact' };
    if (g.channels.length) {
      const s = ctx.slow;
      if (!s || ctx.now - s.t > P.staleSlowS) return { ok: false, why: 'no_data' };
      const okCh = g.channels.map((name) => {
        const q = s.quality.find((x) => x.name === name);
        return !!q && q.usable && q.clean_fraction >= g.minCleanFraction;
      });
      const pass = g.channelRule === 'all' ? okCh.every(Boolean) : okCh.some(Boolean);
      if (!pass) {
        const anyArtifact = s.quality.some((q) => g.channels.includes(q.name) && q.artifacts.length > 0);
        return { ok: false, why: anyArtifact ? 'artifact' : 'bad_contact' };
      }
      if (g.maxEmgRiseDb !== null) {
        const b = baselineFor(EMG_FIELD);
        const emg = emgRef.resolve(ctx);
        if (b && emg.v !== null && emg.v > b.mean + g.maxEmgRiseDb) return { ok: false, why: 'muscle' };
      }
    }
    return { ok: true, why: null };
  };

  // ---- Blocks
  const newBlockState = (b: PlannedBlock, t0: number): BlockState => ({
    plan: b,
    tStart: t0,
    tEnd: t0 + b.durationS,
    samples: new Map(Array.from(tracks.keys()).map((k) => [k, [] as Sample[]])),
    combined: [],
    successSamples: new Map(plan.targets.map((t) => [t.id, [] as { t: number; v: number; in: boolean }[]])),
    slowFrames: 0,
    slowClean: 0,
    heartFrames: 0,
    heartWithValue: 0,
    cuesSent: new Set(),
    thresholds: {},
    rating: null,
    techniques: [],
    winStart: t0,
    windows: [],
    winSamples: new Map(),
    sigScores: [],
    sigActive: 0,
    sigTotal: 0,
    pairsThisBlock: 0,
    exposureDone: false,
    probe: null,
    ignoredS: b.strategy ? (getStrategy(b.strategy)?.scoring?.ignoreFirstS ?? 0) : 0,
  });

  const startBlock = (i: number, t0: number) => {
    blockIdx = i;
    const b = plan.blocks[i];
    if (b.feedback) ensureThresholds(t0);
    cur = newBlockState(b, t0);
    cur.thresholds = { ...thresholds };
    const data = { index: b.index, id: b.id, kind: b.kind, strategy: b.strategy, feedback: b.feedback, eyes: b.eyes, label: b.label, pacerBpm: b.pacerBpm, cue: b.cue, task: b.task };
    mark({ t: t0, type: 'block_start', label: b.id, data });
    if (b.kind === 'baseline') mark({ t: t0, type: 'baseline_start', label: b.id, data: { eyes: b.eyes } });
    if (b.strategy) mark({ t: t0, type: 'technique', label: b.strategy, data: { blockIndex: b.index } });
    mark({ t: t0, type: 'instruction', label: b.guidance.title, data: { text: b.guidance.start, blockIndex: b.index } });
    events.push({ type: 'block_start', t: t0, block: b });
    events.push({ type: 'instruction', t: t0, text: b.guidance.start, blockIndex: b.index });
    const prevPacer = i > 0 ? plan.blocks[i - 1].pacerBpm : null;
    if (b.pacerBpm !== prevPacer || i === 0) {
      events.push({ type: 'pacer', t: t0, bpm: b.pacerBpm });
      if (b.pacerBpm !== null || i > 0) mark({ t: t0, type: 'note', label: 'pacer', data: { bpm: b.pacerBpm } });
    }
    if (b.kind === 'probe' && b.cue && opts.anchor) {
      const pre = sigHistory.filter((s) => s.t > t0 - P.probePreS && s.t <= t0).map((s) => s.v);
      cur.probe = { cueT: t0, cue: b.cue, pre: pre.length ? mean(pre) : null, post: [], latency: null };
      if (b.cue === 'anchor') {
        events.push({ type: 'play_anchor', t: t0, anchorId: opts.anchor.id, mode: 'probe' });
        mark({ t: t0, type: 'anchor_play', label: 'anchor', data: { cue: 'anchor', mode: 'probe', anchorId: opts.anchor.id } });
      } else if (b.cue === 'control') {
        events.push({ type: 'play_control', t: t0, controlId: opts.anchor.controlId, mode: 'probe' });
        mark({ t: t0, type: 'anchor_play', label: 'control', data: { cue: 'control', mode: 'probe', controlId: opts.anchor.controlId } });
      } else mark({ t: t0, type: 'note', label: 'probe_no_cue', data: {} });
    }
    // A new block resets the reward target but not the smoothed level: it decays by its time constant.
    checkFitSent = false;
    gatedSince = null;
  };

  const closeWindow = (st: BlockState, tw: number) => {
    if (!windowFieldSet.size && !st.plan.label) return;
    const fields = windowFieldSet.size ? Array.from(windowFieldSet) : [];
    if (!fields.length) return;
    const values: Record<string, number | null> = {};
    for (const f of fields) {
      const xs = st.winSamples.get(f) ?? [];
      values[f] = xs.length ? mean(xs) : null;
    }
    st.windows.push({ t: tw, values });
    st.winSamples = new Map();
  };

  const finalizePending = (t: number) => {
    if (pendingPair && t >= pendingPair.t + P.anchorSoundS) {
      const frac = pendingPair.total ? pendingPair.active / pendingPair.total : 0;
      pairings.push({ sessionId: opts.sessionId, day, t: pendingPair.t, scoreAtOnset: pendingPair.score, presentFraction: frac, valid: frac >= P.anchorPairPresentFraction });
      mark({ t: pendingPair.t + P.anchorSoundS, type: 'note', label: 'pairing_result', data: { presentFraction: frac, valid: frac >= P.anchorPairPresentFraction } });
      pendingPair = null;
    }
  };

  const endBlock = (tEndBlock: number) => {
    if (!cur) return;
    const st = cur;
    st.tEnd = tEndBlock;
    finalizePending(tEndBlock + P.anchorSoundS); // a pairing cut by the block end is judged on what was observed
    if (st.winSamples.size) closeWindow(st, tEndBlock);
    const b = st.plan;
    // Baseline
    if (b.kind === 'baseline') {
      for (const [path, samples] of st.samples) {
        const kind = tracks.get(path)?.ref.clock ?? 'slow';
        const s = seriesStats(samples, medianSpacing(samples, clockDt(kind)), clockFloor(kind));
        if (s) {
          const vals = samples.filter((x) => x.clean && x.v !== null).map((x) => x.v as number);
          baselines[path] = { field: path, n: s.n, mean: s.mean, sd: Math.max(s.sd, P.minBaselineSd), ess: s.ess, q: QS.map((q) => quantile(vals, q)), tMid: s.tMid, varMean: s.varMean, tau: s.tau, eyes: b.eyes };
          baselineStats[path] = s;
        }
      }
      if (st.sigScores.length >= 3) {
        const s = st.sigScores.map((x) => x.v);
        baselines[SIGNATURE_FIELD] = { field: SIGNATURE_FIELD, n: s.length, mean: mean(s), sd: Math.max(Math.sqrt(s.reduce((a, x) => a + (x - mean(s)) ** 2, 0) / (s.length - 1)), P.minBaselineSd), ess: s.length, q: QS.map((q) => quantile(s, q)), tMid: 0.5 * (st.tStart + tEndBlock), varMean: 0, tau: 1, eyes: b.eyes };
      }
      mark({ t: tEndBlock, type: 'baseline_end', label: b.id, data: { fields: Object.keys(baselines).length } });
    }
    // Success per target and adaptation (between blocks only)
    const success: Record<string, number | null> = {};
    for (const t of plan.targets) {
      const xs = st.successSamples.get(t.id) ?? [];
      success[t.id] = xs.length ? xs.filter((x) => x.in).length / xs.length : null;
      const thr = thresholds[t.id];
      if (b.kind === 'train' && b.feedback && t.adapt.enabled && thr !== null && xs.length >= P.adaptMinSamples) {
        const s = success[t.id] as number;
        // Inside the success band the threshold moves gently toward the band centre; outside it,
        // with the full gain. Either way the step is capped in baseline SDs.
        {
          const gain = s < t.adapt.lo || s > t.adapt.hi ? t.adapt.gain : t.adapt.gain / 2;
          const vals = xs.map((x) => x.v);
          const ideal = t.direction === 'up' ? quantile(vals, 1 - t.adapt.center) : quantile(vals, t.adapt.center);
          const sd = baselineFor(t.field ?? SIGNATURE_FIELD)?.sd ?? Math.abs(ideal - thr);
          const maxStep = t.adapt.maxStepSd * Math.max(sd, P.minBaselineSd);
          const step = clamp(gain * (ideal - thr), -maxStep, maxStep);
          const next = limit(t, thr + step);
          if (next !== thr) {
            thresholds[t.id] = next;
            thresholdHistory.push({ t: tEndBlock, target: t.id, from: thr, to: next, reason: 'adapt', success: s });
            mark({ t: tEndBlock, type: 'note', label: 'threshold', data: { target: t.id, from: thr, to: next, reason: 'adapt', success: s } });
          }
        }
      }
    }
    const comb = st.combined.filter((c) => c.in !== null);
    // Probe
    if (st.probe && opts.anchor) {
      const pr = st.probe;
      const post = pr.post;
      const postMean = post.length ? mean(post) : null;
      probes.push({
        sessionId: opts.sessionId, day, t: pr.cueT, cue: pr.cue, preScore: pr.pre, postMean,
        delta: postMean !== null && pr.pre !== null ? postMean - pr.pre : null,
        latencyS: pr.latency, reached: pr.latency !== null,
      });
    }
    const cleanFraction = usesEeg
      ? clamp(st.slowClean / Math.max(1, Math.round(b.durationS / 0.25)), 0, 1)
      : clamp(st.heartWithValue / Math.max(1, Math.round(b.durationS)), 0, 1);
    const record: BlockRecord = {
      index: b.index, id: b.id, kind: b.kind, strategy: b.strategy, techniques: st.techniques, label: b.label, feedback: b.feedback, eyes: b.eyes,
      pacerBpm: b.pacerBpm, cue: b.cue, tStart: st.tStart, tEnd: tEndBlock, plannedS: b.durationS,
      tSinceStartS: st.tStart - (sessionStart as number), position: b.index,
      cleanFraction, excluded: cleanFraction < P.minBlockCleanFraction,
      thresholds: st.thresholds, success, successCombined: comb.length ? comb.filter((c) => c.in).length / comb.length : null,
      stats: {}, windows: st.windows, rating: st.rating,
      signature: detector ? { meanScore: st.sigScores.length ? mean(st.sigScores.map((x) => x.v)) : null, activeFraction: st.sigTotal ? st.sigActive / st.sigTotal : null } : null,
      ignoredS: st.ignoredS,
    };
    finished.push({ state: st, record });
    computeStatsFor(finished.length - 1);
    mark({ t: tEndBlock, type: 'block_end', label: b.id, data: { index: b.index, cleanFraction, success: record.successCombined } });
    events.push({ type: 'block_end', t: tEndBlock, blockIndex: b.index });
    if (b.ratings.length) {
      lastRatingBlock = finished.length - 1;
      events.push({ type: 'rating_request', t: tEndBlock, blockIndex: b.index, keys: b.ratings });
    }
    cur = null;
  };

  /** Block statistics; `trendRests` limits the session trend to rests known so far. */
  const computeStatsFor = (fi: number, allRests = false) => {
    const { state: st, record } = finished[fi];
    const rests = finished.filter((f, j) => (allRests || j <= fi) && (f.record.kind === 'rest' || f.record.kind === 'baseline') && !f.record.excluded);
    // Reference: strategy and probe blocks compare with the preceding rest; others with the session baseline.
    let prevRest: { state: BlockState; record: BlockRecord } | null = null;
    for (let j = fi - 1; j >= 0; j--) {
      const k = finished[j].record.kind;
      if (k === 'rest' || k === 'baseline') {
        prevRest = finished[j];
        break;
      }
    }
    const stats: Record<string, BlockStats> = {};
    const fieldList = [...plan.statFields, ...(detector ? [SIGNATURE_FIELD] : [])];
    for (const path of fieldList) {
      const kind: FrameKind = path === SIGNATURE_FIELD ? 'slow' : (tracks.get(path)?.ref.clock ?? 'slow');
      const all: Sample[] = path === SIGNATURE_FIELD ? st.sigScores.map((x) => ({ t: x.t, v: x.v, clean: true })) : (st.samples.get(path) ?? []);
      const samples = all.filter((s) => s.t >= st.tStart + st.ignoredS);
      const dt = medianSpacing(samples, clockDt(kind));
      const floor = clockFloor(kind);
      let reference: { stats: SeriesStats; kind: string } | null = null;
      if (record.kind !== 'baseline') {
        if ((record.kind === 'strategy' || record.kind === 'probe' || record.label) && prevRest) {
          const s = seriesStats(prevRest.state.samples.get(path) ?? [], dt, floor);
          if (s) reference = { stats: s, kind: 'preceding_rest' };
        }
        if (!reference && baselineStats[path]) reference = { stats: baselineStats[path], kind: 'baseline' };
        if (!reference && opts.priorBaselines?.[path]) {
          const b = opts.priorBaselines[path];
          reference = { stats: { n: b.n, mean: b.mean, sd: b.sd, tau: b.tau, ess: b.ess, varMean: b.varMean, tMid: b.tMid }, kind: 'profile' };
        }
      }
      const restStats = rests.map((r) => seriesStats(r.state.samples.get(path) ?? [], dt, floor)).filter((x): x is SeriesStats => x !== null);
      const trend = reference && reference.kind !== 'profile' && restStats.length >= 2 ? fitSessionTrend(restStats) : null;
      const target = plan.targets.find((t) => t.field === path);
      let threshold: { value: number; direction: 'up' | 'down' } | null = null;
      if (target && record.thresholds[target.id] !== null && record.thresholds[target.id] !== undefined) {
        threshold = { value: record.thresholds[target.id] as number, direction: target.direction };
      } else if (reference) {
        const down = /emg_db|hr_bpm/.test(path);
        threshold = { value: down ? reference.stats.mean - reference.stats.sd : reference.stats.mean + reference.stats.sd, direction: down ? 'down' : 'up' };
      }
      stats[path] = computeBlockStats({ field: path, samples, tStart: st.tStart, durationS: Math.max(record.tEnd - st.tStart - st.ignoredS, 0.25), dt, floorS: floor, reference, trend, threshold, sessionStart: sessionStart as number, position: record.position });
    }
    record.stats = stats;
  };

  const advanceInternal = (t: number) => {
    if (phase === 'ready') {
      start(t);
    }
    if (phase !== 'running') return;
    while (cur && t >= cur.tEnd) {
      const endT = cur.tEnd;
      tNow = endT;
      endBlock(endT);
      if (blockIdx + 1 < plan.blocks.length) startBlock(blockIdx + 1, endT);
      else finish(endT, true);
    }
    if (!cur) return;
    tNow = Math.max(tNow ?? t, t);
    // Scheduled cues
    const b = cur.plan;
    (b.guidance.cues ?? []).forEach((c, i) => {
      if (!cur || cur.cuesSent.has(i) || cur.tStart + c.atS > t) return;
      cur.cuesSent.add(i);
      const at = cur.tStart + c.atS;
      events.push({ type: 'instruction', t: at, text: c.text, blockIndex: b.index });
      mark({ t: at, type: 'instruction', label: 'cue', data: { text: c.text, blockIndex: b.index } });
    });
    // Control exposure halfway through the block
    if (b.anchor === 'control_exposure' && opts.anchor && !cur.exposureDone && t >= cur.tStart + b.durationS / 2) {
      cur.exposureDone = true;
      const at = cur.tStart + b.durationS / 2;
      exposures.push({ t: at });
      events.push({ type: 'play_control', t: at, controlId: opts.anchor.controlId, mode: 'exposure' });
      mark({ t: at, type: 'anchor_play', label: 'control', data: { cue: 'control', mode: 'exposure', controlId: opts.anchor.controlId } });
    }
    // Window means
    if (cur && t - cur.winStart >= P.signatureWindowS) {
      const tw = cur.winStart + P.signatureWindowS;
      closeWindow(cur, tw);
      cur.winStart = tw;
    }
  };

  function start(t: number) {
    if (phase !== 'ready') return;
    phase = 'running';
    sessionStart = t;
    tNow = t;
    mark({ t, type: 'note', label: 'session_start', data: { program: plan.programId, version: plan.programVersion, level: plan.level, variables: plan.variables, posture: opts.posture ?? null, headset: opts.headset ?? null, rewardTauS: plan.rewardTauS, frameSchema: SCHEMA_VERSION } });
    if (plan.blocks.length) startBlock(0, t);
    else finish(t, true);
  }

  function finish(t: number, completed: boolean) {
    if (phase === 'finished') return;
    if (cur) endBlock(t);
    finalizePending(Infinity);
    // Final statistics with the whole session's rest trend.
    for (let i = 0; i < finished.length; i++) computeStatsFor(i, true);
    phase = 'finished';
    tEnd = t;
    stoppedEarly = !completed;
    events.push({ type: 'pacer', t, bpm: null });
    events.push({ type: 'session_end', t, completed });
    mark({ t, type: 'note', label: 'session_end', data: { completed } });
  }

  const evaluate = (frame: Frame) => {
    if (!cur) return;
    const st = cur;
    const b = st.plan;
    const t = frame.t;
    const g = gate();
    // Samples
    for (const [path, tr] of tracks) {
      if (tr.ref.clock !== frame.kind) continue;
      const m = tr.ref.resolve(ctx);
      const clean = tr.isHeart ? true : g.ok;
      (st.samples.get(path) as Sample[]).push({ t, v: m.v, clean });
      if (windowFieldSet.has(path) && clean && m.v !== null) {
        const arr = st.winSamples.get(path) ?? [];
        arr.push(m.v);
        st.winSamples.set(path, arr);
      }
    }
    if (frame.kind === 'slow') {
      st.slowFrames++;
      if (g.ok) st.slowClean++;
    }
    if (frame.kind === 'heart') {
      st.heartFrames++;
      const first = plan.targets.find((x) => x.field?.startsWith('heart.'))?.field ?? plan.statFields.find((f) => f.startsWith('heart.'));
      if (first && compileField(first).resolve(ctx).v !== null) st.heartWithValue++;
    }
    // Signature detector on slow and heart frames
    if (detector && (frame.kind === 'slow' || frame.kind === 'heart')) {
      const vals: Record<string, number | null> = {};
      for (const f of detector.fields) {
        const tr = tracks.get(f) as FieldTrack;
        const m = tr.ref.resolve(ctx);
        vals[f] = tr.isHeart || g.ok ? m.v : null;
      }
      sigReading = detector.update(t, vals);
      if (frame.kind === 'slow') {
        if (sigReading.score.v !== null) {
          st.sigScores.push({ t, v: sigReading.score.v });
          sigHistory.push({ t, v: sigReading.score.v });
          while (sigHistory.length && sigHistory[0].t < t - P.probePreS - 1) sigHistory.shift();
        }
        st.sigTotal++;
        if (sigReading.active) st.sigActive++;
        if (pendingPair) {
          pendingPair.total++;
          if (sigReading.active) pendingPair.active++;
        }
        if (st.probe && t <= st.probe.cueT + P.probePostS) {
          if (sigReading.score.v !== null) st.probe.post.push(sigReading.score.v);
          if (st.probe.latency === null && sigReading.active) st.probe.latency = t - st.probe.cueT;
        }
      }
      finalizePending(t);
      if (b.anchor === 'pair' && opts.anchor && !pendingPair && canPair({ active: sigReading.active, forS: sigReading.forS, now: t, lastPairT, pairsThisBlock: st.pairsThisBlock })) {
        pendingPair = { t, score: sigReading.score.v, active: 0, total: 0 };
        lastPairT = t;
        st.pairsThisBlock++;
        events.push({ type: 'play_anchor', t, anchorId: opts.anchor.id, mode: 'pairing' });
        mark({ t, type: 'anchor_play', label: 'anchor', data: { cue: 'anchor', mode: 'pairing', anchorId: opts.anchor.id, score: sigReading.score.v } });
      }
    }
    // Watches (slow clock)
    if (frame.kind === 'slow') {
      for (const w of plan.watches) {
        const allTrue = w.when.every((c) => {
          const m = (tracks.get(c.field) as FieldTrack).ref.resolve(ctx);
          if (m.v === null || !g.ok) return false;
          let ref: number | null = c.value;
          if (c.baselineSd !== null) {
            const bl = baselineFor(c.field);
            if (!bl) return false;
            ref = bl.mean + c.baselineSd * bl.sd;
          }
          if (ref === null) return false;
          return c.op === 'below' ? m.v < ref : m.v > ref;
        });
        const since = watchState.get(w.id) ?? null;
        if (allTrue) {
          if (since === null) watchState.set(w.id, t);
          else if (t - since >= w.forS && !watchFired.has(w.id)) {
            watchFired.add(w.id);
            events.push(w.event === 'tether' ? { type: 'tether', t, text: w.text } : { type: 'instruction', t, text: w.text, blockIndex: b.index });
            mark({ t, type: 'instruction', label: w.event, data: { watch: w.id, text: w.text } });
          }
        } else {
          watchState.set(w.id, null);
          watchFired.delete(w.id);
        }
      }
    }
    // Reward: evaluate when a frame of a target's clock arrives.
    const relevant = plan.targets.some((x) => (x.source === 'signature' ? frame.kind === 'slow' || frame.kind === 'heart' : targetRefs.get(x.id)?.clock === frame.kind));
    if (!relevant) return;
    const readings: TargetReading[] = [];
    let gatedAny: RunnerOutput['reward']['why'] = null;
    for (const x of plan.targets) {
      const isHeart = x.field?.startsWith('heart.') ?? false;
      const m: Measured = x.source === 'signature' ? (sigReading?.score ?? { v: null, se: null, why: 'warming_up' }) : (targetRefs.get(x.id) as FieldRef).resolve(ctx);
      const thr = thresholds[x.id];
      let r = 0;
      let inT: boolean | null = null;
      const gated = !isHeart && x.source === 'field' && !g.ok;
      if (gated) gatedAny = g.why;
      else if (m.v === null) gatedAny = gatedAny ?? m.why;
      else if (thr === null) gatedAny = gatedAny ?? 'no_threshold';
      else {
        const span = spanOf(x);
        r = x.direction === 'up' ? clamp((m.v - thr) / span, 0, 1) : clamp((thr - m.v) / span, 0, 1);
        inT = x.direction === 'up' ? m.v >= thr : m.v <= thr;
        (st.successSamples.get(x.id) as { t: number; v: number; in: boolean }[]).push({ t, v: m.v, in: inT });
      }
      readings.push({ id: x.id, value: m, threshold: thr, reward: r, inTarget: inT });
    }
    let combined: number;
    let combinedIn: boolean | null;
    const valid = readings.every((r) => r.inTarget !== null);
    if (plan.combine === 'all') {
      combined = valid ? Math.min(...readings.map((r) => r.reward)) : 0;
      combinedIn = valid ? readings.every((r) => r.inTarget) : null;
    } else if (plan.combine === 'any') {
      combined = Math.max(0, ...readings.map((r) => r.reward));
      combinedIn = readings.some((r) => r.inTarget === true) ? true : valid ? false : null;
    } else {
      const ok = readings.map((r, i) => ({ r, w: plan.targets[i].weight })).filter((x) => x.r.inTarget !== null);
      const sw = ok.reduce((a, x) => a + x.w, 0);
      combined = sw > 0 && ok.length === readings.length ? ok.reduce((a, x) => a + x.w * x.r.reward, 0) / sw : 0;
      combinedIn = ok.length === readings.length && sw > 0 ? ok.reduce((a, x) => a + x.w * (x.r.inTarget ? 1 : 0), 0) / sw >= 0.5 : null;
    }
    st.combined.push({ t, in: combinedIn });
    lastReadings = readings;
    const out = b.feedback ? combined : 0;
    gatedWhy = !b.feedback ? 'feedback_off' : gatedAny;
    raw = out;
    const dt = lastEvalT === null ? 0 : Math.max(0, t - lastEvalT);
    const a = plan.rewardTauS > 0 ? 1 - Math.exp(-dt / plan.rewardTauS) : 1;
    level = lastEvalT === null ? 0 : level + a * (out - level);
    lastEvalT = t;
    // Check fit after sustained gating
    if (gatedAny === 'artifact' || gatedAny === 'bad_contact' || gatedAny === 'muscle' || gatedAny === 'no_data') {
      if (gatedSince === null) gatedSince = t;
      if (!checkFitSent && b.kind !== 'settle' && b.kind !== 'calibration' && t - gatedSince >= P.checkFitAfterS) {
        checkFitSent = true;
        events.push({ type: 'check_fit', t });
        mark({ t, type: 'note', label: 'check_fit', data: { why: gatedAny } });
      }
    } else gatedSince = null;
  };

  const api: SessionRunner = {
    start,
    push(frame) {
      if (phase === 'finished') return;
      advanceInternal(frame.t);
      if (phase !== 'running') return;
      ctx.now = frame.t;
      if (frame.kind === 'slow') ctx.slow = frame as SlowFrame;
      else if (frame.kind === 'fast') ctx.fast = frame as FastFrame;
      else ctx.heart = frame as HeartFrame;
      evaluate(frame);
    },
    advance(t) {
      if (phase === 'finished') return;
      advanceInternal(t);
      ctx.now = Math.max(ctx.now, t);
    },
    output() {
      const b = cur?.plan ?? null;
      return {
        phase,
        t: tNow,
        blockIndex: b ? b.index : null,
        block: b,
        blockElapsedS: cur && tNow !== null ? tNow - cur.tStart : null,
        blockRemainingS: cur && tNow !== null ? cur.tEnd - tNow : null,
        feedback: b?.feedback ?? false,
        reward: { level, raw, tauS: plan.rewardTauS, gated: raw === 0 && gatedWhy !== null, why: gatedWhy },
        targets: lastReadings,
        pacerBpm: b?.pacerBpm ?? null,
        signature: sigReading,
      };
    },
    drainEvents() {
      return events.splice(0, events.length);
    },
    markers() {
      return markerList.slice().sort((a, b) => a.t - b.t);
    },
    rate(t, ratings) {
      const target = lastRatingBlock !== null ? finished[lastRatingBlock].record : null;
      const clean: Partial<Record<RatingKey, number>> = {};
      for (const [k, v] of Object.entries(ratings)) if (typeof v === 'number' && v >= 1 && v <= 5) clean[k as RatingKey] = v;
      if (target) target.rating = { ...(target.rating ?? {}), ...clean };
      else if (cur) cur.rating = { ...(cur.rating ?? {}), ...clean };
      mark({ t, type: 'report', label: 'rating', data: { blockIndex: target ? target.index : (cur?.plan.index ?? null), ...clean } });
    },
    setTechnique(t, strategy) {
      if (cur) cur.techniques.push({ t, strategy });
      mark({ t, type: 'technique', label: strategy, data: { blockIndex: cur?.plan.index ?? null, reported: true } });
    },
    report(t, text) {
      mark({ t, type: 'report', label: 'note', data: { text, blockIndex: cur?.plan.index ?? null } });
    },
    noteUnpairedAnchor(t) {
      mark({ t, type: 'anchor_play', label: 'anchor', data: { cue: 'anchor', mode: 'on_demand' } });
    },
    skipBlock(t) {
      if (!cur || phase !== 'running') return;
      mark({ t, type: 'note', label: 'skip', data: { blockIndex: cur.plan.index } });
      const i = blockIdx;
      endBlock(t);
      if (i + 1 < plan.blocks.length) startBlock(i + 1, t);
      else finish(t, true);
    },
    stop(t) {
      if (phase === 'ready') start(t);
      if (phase !== 'running') return;
      mark({ t, type: 'note', label: 'stop', data: { blockIndex: cur?.plan.index ?? null } });
      finish(t, false);
    },
    isFinished() {
      return phase === 'finished';
    },
    record() {
      return {
        format: SESSION_FORMAT,
        formatVersion: SESSION_FORMAT_VERSION,
        id: opts.sessionId,
        userId: opts.userId,
        startedAt: opts.startedAt,
        day,
        headset: opts.headset ?? null,
        posture: opts.posture ?? null,
        soundscape: opts.soundscape ?? null,
        checkIn: opts.checkIn ?? {},
        seed: opts.seed,
        program: { id: plan.programId, version: plan.programVersion, name: plan.programName, state: plan.state, level: plan.level, variables: plan.variables },
        targets: plan.targets.map((t) => ({ id: t.id, field: t.field, source: t.source, direction: t.direction })),
        frameSchema: SCHEMA_VERSION,
        engine: { version: opts.engineVersion ?? null, params: opts.engineParams ?? null },
        training: { paramsVersion: TRAINING_PARAMS_VERSION, params: TRAINING_PARAMS },
        rewardTauS: plan.rewardTauS,
        tStart: sessionStart,
        tEnd,
        baselines: { ...baselines },
        blocks: finished.map((f) => f.record),
        markers: api.markers(),
        thresholdHistory: thresholdHistory.slice(),
        anchor: opts.anchor ?? null,
        signatureId: sig?.id ?? null,
        pairings: pairings.slice(),
        controlExposures: exposures.slice(),
        probes: probes.slice(),
        completed: phase === 'finished' && !stoppedEarly,
        stoppedEarly,
      };
    },
  };
  return api;
}

function interpQ(q: number[], p: number): number {
  // q holds quantiles at 0.05..0.95; clamp outside.
  const pos = clamp(p / 0.05 - 1, 0, q.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return q[lo] + (q[hi] - q[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------
// Session record validation
// ---------------------------------------------------------------------------

export interface SessionIssue {
  path: string;
  message: string;
}

export function validateSession(r: SessionRecord): SessionIssue[] {
  const out: SessionIssue[] = [];
  const err = (path: string, message: string) => out.push({ path, message });
  if (r.format !== SESSION_FORMAT) err('format', 'wrong format');
  if (r.formatVersion !== SESSION_FORMAT_VERSION) err('formatVersion', 'unsupported version');
  for (const k of ['id', 'userId', 'startedAt'] as const) if (!r[k]) err(k, 'missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day)) err('day', 'must be YYYY-MM-DD');
  if (!Number.isFinite(r.seed)) err('seed', 'missing seed');
  if (!(r.rewardTauS >= 0)) err('rewardTauS', 'must be declared');
  if (r.frameSchema !== SCHEMA_VERSION) err('frameSchema', `expected ${SCHEMA_VERSION}`);
  let prevEnd = r.tStart ?? -Infinity;
  r.blocks.forEach((b, i) => {
    const at = `blocks[${i}]`;
    if (b.index !== i) err(at, 'index out of order');
    if (!(b.tEnd >= b.tStart)) err(at, 'ends before it starts');
    if (b.tStart < prevEnd - 1e-9) err(at, 'overlaps the previous block');
    prevEnd = b.tEnd;
    if (!(b.cleanFraction >= 0 && b.cleanFraction <= 1)) err(at, 'cleanFraction outside 0..1');
    if (b.feedback && b.kind !== 'train') err(at, 'feedback outside a train block');
    for (const [k, v] of Object.entries(b.thresholds)) if (v !== null && !Number.isFinite(v)) err(`${at}.thresholds.${k}`, 'not finite');
    for (const [k, s] of Object.entries(b.stats)) {
      if (s.fractionInTarget !== null && !(s.fractionInTarget >= 0 && s.fractionInTarget <= 1)) err(`${at}.stats.${k}`, 'fractionInTarget outside 0..1');
      if (s.effect && !(s.effect.diff.lo <= s.effect.diff.estimate && s.effect.diff.estimate <= s.effect.diff.hi)) err(`${at}.stats.${k}`, 'interval does not contain its estimate');
    }
    if (b.rating) for (const [k, v] of Object.entries(b.rating)) if (!(typeof v === 'number' && v >= 1 && v <= 5)) err(`${at}.rating.${k}`, 'ratings are 1..5');
  });
  for (let i = 1; i < r.markers.length; i++) if (r.markers[i].t < r.markers[i - 1].t) err(`markers[${i}]`, 'markers out of time order');
  const starts = r.markers.filter((m) => m.type === 'block_start').length;
  const ends = r.markers.filter((m) => m.type === 'block_end').length;
  if (starts !== r.blocks.length || ends !== r.blocks.length) err('markers', 'every block needs a block_start and block_end marker');
  for (const p of r.pairings) if (!(p.presentFraction >= 0 && p.presentFraction <= 1)) err('pairings', 'presentFraction outside 0..1');
  try {
    JSON.parse(JSON.stringify(r));
  } catch {
    err('', 'not JSON-serializable');
  }
  return out;
}
