/**
 * Personal state signatures (spec 12.1).
 *
 * A signature is learned from blocks the user marked as being in a state ("state") and
 * resting or contrast blocks ("contrast"). It is the small set of fields, brain and heart,
 * that separate the two most reliably for this person, with the range each takes in the state.
 * It makes no claim about what an emotion looks like in general.
 *
 * It earns the label "reliable" only when, on blocks not used to build it (leave one session
 * out), it separates state from contrast better than signatures built from the same blocks with
 * their labels shuffled (permutation test, labels shuffled within each session), across at least
 * 3 sessions on different days. Until then it is "still learning".
 *
 * Live detection uses window means of the same fields, a threshold set from the person's own
 * contrast-window score distribution, dwell and hysteresis (spec 8.4).
 */

import type { Measured } from '../engine/frames';
import { createRng, mean, quantile, shuffled, variance } from './math';
import { TRAINING_PARAMS } from './params';
import type { StateId } from './program';

/** Fields considered for signatures. All are frame fields (fields.ts). */
export const SIGNATURE_CANDIDATE_FIELDS: string[] = [
  'spectra[temporal].bands.alpha.above_bg_db',
  'spectra[temporal].bands.theta.above_bg_db',
  'spectra[temporal].bands.beta.above_bg_db',
  'spectra[frontal].bands.alpha.above_bg_db',
  'diff(spectra[AF8].bands.alpha.above_bg_db, spectra[AF7].bands.alpha.above_bg_db)',
  'spectra[temporal].bg_exponent',
  'quality[*].emg_db',
  'heart.hr_bpm',
  'heart.rmssd_ms',
  'heart.resonance_strength',
];

export interface SignatureBlock {
  sessionId: string;
  /** Calendar day, 'YYYY-MM-DD', for the different-days rule. */
  day: string;
  label: 'state' | 'contrast';
  /** Block-level feature values (mean of the block's clean window means). Null: not measured. */
  features: Record<string, number | null>;
  /** Window means within the block (10 s), used to set live detection thresholds. */
  windows?: Record<string, number | null>[];
}

export interface SignatureField {
  field: string;
  /** +1 if the state is higher than contrast, -1 if lower. */
  direction: 1 | -1;
  stateMean: number;
  contrastMean: number;
  pooledSd: number;
  /** Standardized separation (state - contrast) / pooled SD. */
  d: number;
  /** Fraction of sessions where the state-contrast difference has the same sign as overall. */
  consistency: number;
  /** Range the field takes in the state blocks (10th to 90th percentile). */
  stateRange: [number, number];
  weight: number;
}

export type SignatureStatus = 'still_learning' | 'reliable';

export interface SignatureValidation {
  /** Area under the ROC curve of held-out block scores, state vs contrast. Null when not computable. */
  heldOutAuc: number | null;
  /** Mean and 95th percentile of held-out AUC with labels shuffled within sessions. */
  nullAucMean: number | null;
  nullAuc95: number | null;
  /** Permutation p-value: (1 + #shuffled >= observed) / (1 + permutations). */
  p: number | null;
  permutations: number;
  nSessions: number;
  nDays: number;
  nStateBlocks: number;
  nContrastBlocks: number;
  reasons: string[];
}

export interface Signature {
  id: string;
  state: StateId;
  fields: SignatureField[];
  status: SignatureStatus;
  validation: SignatureValidation;
  detection: {
    enter: number;
    exit: number;
    dwellS: number;
    windowS: number;
    /** Share of contrast windows whose score reached the entry threshold. */
    contrastExceedFraction: number | null;
    /** Estimated false entries per 10 minutes of contrast (non-state) time. */
    falseEntriesPer10Min: number | null;
  };
  /** Each validation run appends here. */
  history: { at: string; status: SignatureStatus; heldOutAuc: number | null; p: number | null; nSessions: number; nDays: number }[];
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export interface FitOptions {
  candidates?: string[];
  maxFields?: number;
  minAbsD?: number;
}

/** Fit signature fields from labelled blocks. Null when nothing separates. */
export function fitSignatureFields(blocks: readonly SignatureBlock[], opts: FitOptions = {}): SignatureField[] | null {
  const cands = opts.candidates ?? Array.from(new Set(blocks.flatMap((b) => Object.keys(b.features))));
  const maxFields = opts.maxFields ?? TRAINING_PARAMS.signatureMaxFields;
  const minAbsD = opts.minAbsD ?? 0.5;
  const scored: SignatureField[] = [];
  for (const f of cands) {
    const st: number[] = [];
    const ct: number[] = [];
    const perSession = new Map<string, { s: number[]; c: number[] }>();
    for (const b of blocks) {
      const v = b.features[f];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      (b.label === 'state' ? st : ct).push(v);
      const e = perSession.get(b.sessionId) ?? { s: [], c: [] };
      (b.label === 'state' ? e.s : e.c).push(v);
      perSession.set(b.sessionId, e);
    }
    if (st.length < 2 || ct.length < 2) continue;
    const ms = mean(st);
    const mc = mean(ct);
    const pooled = Math.sqrt(((st.length - 1) * variance(st) + (ct.length - 1) * variance(ct)) / (st.length + ct.length - 2));
    if (!(pooled > 0)) continue;
    const d = (ms - mc) / pooled;
    let agree = 0;
    let both = 0;
    for (const e of perSession.values()) {
      if (!e.s.length || !e.c.length) continue;
      both++;
      if (Math.sign(mean(e.s) - mean(e.c)) === Math.sign(d)) agree++;
    }
    const consistency = both ? agree / both : 0;
    scored.push({
      field: f,
      direction: d >= 0 ? 1 : -1,
      stateMean: ms,
      contrastMean: mc,
      pooledSd: pooled,
      d,
      consistency,
      stateRange: [quantile(st, 0.1), quantile(st, 0.9)],
      weight: Math.abs(d) * consistency,
    });
  }
  const chosen = scored
    .filter((s) => Math.abs(s.d) >= minAbsD && s.consistency > 0.5)
    .sort((a, b) => b.weight - a.weight || a.field.localeCompare(b.field))
    .slice(0, maxFields);
  return chosen.length ? chosen : null;
}

/** Score a feature vector: weighted mean of standardized distances past the state/contrast midpoint. */
export function scoreFeatures(fields: readonly SignatureField[], values: Record<string, number | null | undefined>, minFieldFraction = TRAINING_PARAMS.signatureMinFieldFraction): number | null {
  let sw = 0;
  let s = 0;
  let present = 0;
  for (const f of fields) {
    const v = values[f.field];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    present++;
    const mid = 0.5 * (f.stateMean + f.contrastMean);
    s += f.weight * f.direction * ((v - mid) / f.pooledSd);
    sw += f.weight;
  }
  if (!fields.length || present / fields.length < minFieldFraction || !(sw > 0)) return null;
  return s / sw;
}

/** Mann-Whitney AUC: probability a state score exceeds a contrast score. */
export function auc(stateScores: readonly number[], contrastScores: readonly number[]): number | null {
  if (!stateScores.length || !contrastScores.length) return null;
  let wins = 0;
  for (const a of stateScores) for (const b of contrastScores) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (stateScores.length * contrastScores.length);
}

/** Leave-one-session-out AUC. */
function heldOutAuc(blocks: readonly SignatureBlock[], opts: FitOptions): number | null {
  const sessions = Array.from(new Set(blocks.map((b) => b.sessionId)));
  const ss: number[] = [];
  const cs: number[] = [];
  for (const s of sessions) {
    const train = blocks.filter((b) => b.sessionId !== s);
    const test = blocks.filter((b) => b.sessionId === s);
    const fields = fitSignatureFields(train, opts);
    if (!fields) continue;
    for (const b of test) {
      const sc = scoreFeatures(fields, b.features);
      if (sc === null) continue;
      (b.label === 'state' ? ss : cs).push(sc);
    }
  }
  return auc(ss, cs);
}

export interface LearnOptions extends FitOptions {
  id: string;
  state: StateId;
  /** ISO time for the history entry (passed in: the training layer never reads the clock). */
  at: string;
  seed: number;
  permutations?: number;
  previous?: Signature | null;
}

/** Learn and validate a signature. Always returns a signature when anything separates; status says whether it is reliable. */
export function learnSignature(blocks: readonly SignatureBlock[], opts: LearnOptions): Signature | null {
  const P = opts.permutations ?? TRAINING_PARAMS.signaturePermutations;
  const sessionsWithBoth = Array.from(new Set(blocks.map((b) => b.sessionId))).filter(
    (s) => blocks.some((b) => b.sessionId === s && b.label === 'state') && blocks.some((b) => b.sessionId === s && b.label === 'contrast'),
  );
  const usable = blocks.filter((b) => sessionsWithBoth.includes(b.sessionId));
  const nDays = new Set(usable.map((b) => b.day)).size;
  const fields = fitSignatureFields(usable, opts);
  if (!fields) return null;

  const reasons: string[] = [];
  let obs: number | null = null;
  let nullMean: number | null = null;
  let null95: number | null = null;
  let p: number | null = null;
  if (sessionsWithBoth.length >= 2) {
    obs = heldOutAuc(usable, opts);
    if (obs !== null) {
      const rng = createRng(opts.seed);
      const nulls: number[] = [];
      let atLeast = 0;
      for (let i = 0; i < P; i++) {
        const perm: SignatureBlock[] = [];
        for (const s of sessionsWithBoth) {
          const bs = usable.filter((b) => b.sessionId === s);
          const labels = shuffled(bs.map((b) => b.label), rng);
          bs.forEach((b, j) => perm.push({ ...b, label: labels[j] }));
        }
        const a = heldOutAuc(perm, opts);
        const val = a ?? 0.5;
        nulls.push(val);
        if (val >= obs) atLeast++;
      }
      nullMean = mean(nulls);
      null95 = quantile(nulls, 0.95);
      p = (1 + atLeast) / (1 + P);
    }
  }
  if (sessionsWithBoth.length < TRAINING_PARAMS.signatureMinSessions) reasons.push(`needs state and contrast blocks in at least ${TRAINING_PARAMS.signatureMinSessions} sessions (has ${sessionsWithBoth.length})`);
  if (nDays < TRAINING_PARAMS.signatureMinSessions) reasons.push(`needs sessions on at least ${TRAINING_PARAMS.signatureMinSessions} different days (has ${nDays})`);
  if (obs === null) reasons.push('held-out separation not yet computable');
  else if (obs < TRAINING_PARAMS.signatureMinAuc) reasons.push(`held-out separation ${obs.toFixed(2)} is below ${TRAINING_PARAMS.signatureMinAuc}`);
  if (p !== null && p > TRAINING_PARAMS.signatureMaxP) reasons.push(`not better than shuffled labels (p = ${p.toFixed(3)})`);
  const status: SignatureStatus = reasons.length === 0 ? 'reliable' : 'still_learning';

  // Live thresholds from contrast windows (fallback: contrast blocks).
  const contrastScores: number[] = [];
  for (const b of usable.filter((x) => x.label === 'contrast')) {
    const ws = b.windows?.length ? b.windows : [b.features];
    for (const w of ws) {
      const sc = scoreFeatures(fields, w);
      if (sc !== null) contrastScores.push(sc);
    }
  }
  const enter = contrastScores.length ? Math.max(quantile(contrastScores, TRAINING_PARAMS.signatureEnterQuantile), 0) : 0.5;
  let exit = contrastScores.length ? quantile(contrastScores, TRAINING_PARAMS.signatureExitQuantile) : 0;
  if (exit >= enter) exit = enter - 0.25;
  const exceed = contrastScores.length ? contrastScores.filter((s) => s >= enter).length / contrastScores.length : null;
  // Each window is windowS long; a false entry needs a window above threshold (dwell is shorter than a window).
  const falseRate = exceed === null ? null : exceed * (600 / TRAINING_PARAMS.signatureWindowS);

  const validation: SignatureValidation = {
    heldOutAuc: obs, nullAucMean: nullMean, nullAuc95: null95, p, permutations: P,
    nSessions: sessionsWithBoth.length, nDays,
    nStateBlocks: usable.filter((b) => b.label === 'state').length,
    nContrastBlocks: usable.filter((b) => b.label === 'contrast').length,
    reasons,
  };
  return {
    id: opts.id,
    state: opts.state,
    fields,
    status,
    validation,
    detection: { enter, exit, dwellS: TRAINING_PARAMS.signatureDwellS, windowS: TRAINING_PARAMS.signatureWindowS, contrastExceedFraction: exceed, falseEntriesPer10Min: falseRate },
    history: [...(opts.previous?.history ?? []), { at: opts.at, status, heldOutAuc: obs, p, nSessions: sessionsWithBoth.length, nDays }],
  };
}

/** Plain-language reading of a signature's status. */
export function describeSignature(sig: Signature): string {
  if (sig.status === 'reliable') {
    return `Your ${sig.state} signature is reliable: on sessions it had not seen, it told your ${sig.state} blocks from your contrast blocks ${Math.round((sig.validation.heldOutAuc ?? 0) * 100)}% of the time, better than chance by a clear margin.`;
  }
  return `Still learning your ${sig.state} signature. ${sig.validation.reasons.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Live detection
// ---------------------------------------------------------------------------

export interface SignatureReading {
  score: Measured;
  active: boolean;
  /** Seconds in the current state (active or not); 0 while the score is null. */
  forS: number;
}

export interface SignatureDetector {
  /** Feed the latest field values at time t (clean values only; pass null for gated or missing). */
  update(t: number, values: Record<string, number | null>): SignatureReading;
  readonly fields: string[];
}

export function createSignatureDetector(sig: Signature): SignatureDetector {
  const W = sig.detection.windowS;
  const hist = new Map<string, { t: number; v: number }[]>();
  for (const f of sig.fields) hist.set(f.field, []);
  let active = false;
  let since: number | null = null;
  let aboveSince: number | null = null;
  return {
    fields: sig.fields.map((f) => f.field),
    update(t, values) {
      const means: Record<string, number | null> = {};
      for (const f of sig.fields) {
        const h = hist.get(f.field) as { t: number; v: number }[];
        const v = values[f.field];
        if (v !== null && v !== undefined && Number.isFinite(v)) h.push({ t, v });
        while (h.length && h[0].t <= t - W) h.shift();
        means[f.field] = h.length ? mean(h.map((x) => x.v)) : null;
      }
      const score = scoreFeatures(sig.fields, means);
      if (score === null) {
        active = false;
        since = null;
        aboveSince = null;
        return { score: { v: null, se: null, why: 'insufficient_clean' }, active: false, forS: 0 };
      }
      if (since === null) since = t;
      if (!active) {
        if (score >= sig.detection.enter) {
          if (aboveSince === null) aboveSince = t;
          if (t - aboveSince >= sig.detection.dwellS) {
            active = true;
            since = t;
          }
        } else aboveSince = null;
      } else if (score < sig.detection.exit) {
        active = false;
        since = t;
        aboveSince = null;
      }
      return { score: { v: score, se: null, why: 'ok' }, active, forS: t - since };
    },
  };
}
