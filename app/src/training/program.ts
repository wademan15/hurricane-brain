/**
 * The training program format. A program is data, not code (spec section 12).
 *
 * A Program is plain JSON: it can be stored, versioned, shipped as a file and validated.
 * `validateProgram` checks it against the frame contract and the app's rules.
 * `instantiateProgram` turns a program plus the user's variable choices and profile hints
 * into a SessionPlan: a flat, concrete list of blocks that the runner executes.
 */

import { compileField, FieldPathError, substitutePath } from './fields';
import { STRATEGIES } from './strategies';
import { TRAINING_PARAMS } from './params';

export const PROGRAM_FORMAT = 'hurricane-brain/program';
export const PROGRAM_FORMAT_VERSION = 1;

export type EvidenceGrade = 'A' | 'A-B' | 'B' | 'B-C' | 'C' | 'C-D' | 'D';
export type StateId = string;
export type VarValue = number | string | boolean;
/** A number, or a reference to a numeric program variable. */
export type Num = number | { var: string };

export type ProgramFamily =
  | 'stillness' | 'alpha' | 'theta' | 'alpha_theta' | 'sleep_onset' | 'alignment' | 'hemisphere'
  | 'asymmetry' | 'heart' | 'brain_heart' | 'emotion' | 'signature' | 'anchor' | 'profiling' | 'calibration';

export interface Evidence {
  grade: EvidenceGrade;
  /** Plain-language statement of what is and is not established. */
  summary: string;
  /** Author-year citations, as in the research brief (to verify before marketing use). */
  sources: string[];
}

export interface VariableSpec {
  id: string;
  label: string;
  description: string;
  kind: 'number' | 'choice' | 'boolean';
  default: VarValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string | number; label: string }[];
}

export type ThresholdInitial =
  /** Threshold at quantile q of the baseline distribution (q = 0.3 means 70% of baseline is above, for 'up'). */
  | { rule: 'baseline_quantile'; q: number }
  /** Baseline mean plus k baseline standard deviations (k may be negative). */
  | { rule: 'baseline_mean_plus_sd'; k: number }
  /** A fixed value in the field's units (for counts such as cascade steps, or 0..1 states). */
  | { rule: 'absolute'; value: number };

export interface ThresholdSpec {
  initial: ThresholdInitial;
  adapt: {
    enabled: boolean;
    /** 'level' takes the success band from the ladder level; otherwise an explicit band. */
    band: 'level' | [number, number];
  };
  /** Reward ramp width above threshold in baseline SDs, or an absolute width with spanAbs. */
  spanSd?: number;
  spanAbs?: number;
  /** Absolute limits on the threshold. */
  floor?: number;
  ceiling?: number;
}

export interface TargetSpec {
  id: string;
  label: string;
  /** 'field' reads a frame field path; 'signature' reads the live personal signature score. */
  source: 'field' | 'signature';
  /** Field path (fields.ts). May contain ${var} placeholders bound to choice variables. */
  field?: string;
  direction: 'up' | 'down';
  weight: number;
  threshold: ThresholdSpec;
}

export interface GatingSpec {
  /** EEG channels whose quality gates reward. Empty for heart-only programs. */
  channels: string[];
  /** 'all': every listed channel usable; 'any': at least one. */
  channelRule: 'all' | 'any';
  minCleanFraction: Num;
  /** Withhold reward while the fast frame flags an artifact. */
  fastArtifact: boolean;
  /** Withhold reward when mean EMG rises this many dB over the person's baseline. Null: off. */
  maxEmgRiseDb: Num | null;
  /** Heart programs: reward is withheld while heart variability fields are null (they are then). */
  heart: boolean;
}

export type SoundElement =
  | 'base_soundscape' | 'reward_layer' | 'tracking_tone' | 'alpha_warmth' | 'alpha_texture' | 'theta_texture'
  | 'phi_bloom' | 'octave_bloom' | 'thinning' | 'heartbeat' | 'breath_pacer' | 'fade_on_target' | 'anchor' | 'control_sound';
export type VisualElement =
  | 'hurricane_rotation' | 'spiral_arms' | 'winding' | 'rings' | 'arm_brightness' | 'eye_clarity' | 'symmetry'
  | 'eyewall_pulse' | 'slow_swell' | 'scattered_cloud' | 'pacer_visual' | 'signature_meter' | 'quality_panel';

export interface Binding<E extends string> {
  element: E;
  /** Field the element reads (spec 9.1), or 'reward' for the runner's reward level. */
  reads: string;
  note?: string;
}

export interface Bindings {
  sound: Binding<SoundElement>[];
  visual: Binding<VisualElement>[];
  /** Fields always displayed beside the feedback (rule 3: golden ratio with octave and chance). */
  display: string[];
}

export type BlockKind = 'settle' | 'baseline' | 'rest' | 'strategy' | 'train' | 'transfer' | 'probe' | 'rating' | 'calibration';
export type RatingKey = 'ease' | 'depth' | 'pleasantness' | 'emotion_intensity' | 'calm' | 'alertness';
export type StrategyRef = string | 'profile_best' | 'user_choice' | { slot: number };

export interface Guidance {
  title: string;
  start: string;
  /** Cues during the block. `sparse` cues remain at ladder level 2; none remain at level 3+. */
  cues?: { atS: number; text: string; sparse?: boolean }[];
  end?: string;
}

export interface BlockSpec {
  id: string;
  kind: BlockKind;
  durationS: Num;
  feedback: boolean;
  eyes: 'open' | 'closed' | 'any';
  strategy?: StrategyRef;
  /** Signature learning label for emotional/state blocks. */
  label?: 'state' | 'contrast';
  guidance: Guidance;
  /** Breath pacer rate, breaths/min; 'resonance' uses the person's measured rate. Absent: pacer off. */
  pacer?: Num | 'resonance';
  /** Probe blocks: which cue is played at the block start. 'slot' takes the next from the probe order. */
  cue?: 'anchor' | 'control' | 'none' | 'slot';
  /** Pairing blocks pair the anchor while the signature is detected; exposure blocks play the control sound once. */
  anchor?: 'pair' | 'control_exposure';
  ratings?: RatingKey[];
  /** Calibration task tag (artifact calibration, eyes open/closed rest). */
  task?: string;
}

export interface BlockGroup {
  repeat: Num;
  blocks: BlockItem[];
  /** Include the group only when this strategy slot is filled (profiling sessions). */
  whenSlot?: number;
}
export type BlockItem = BlockSpec | BlockGroup;

export interface WatchSpec {
  id: string;
  /** All conditions must hold for `forS` seconds. Values relative to baseline when `baselineSd` is set. */
  when: { field: string; op: 'below' | 'above'; baselineSd?: number; value?: number }[];
  forS: number;
  event: 'tether' | 'cue';
  text: string;
  /** Boolean variable that switches this watch on or off. */
  enabledBy?: string;
}

export interface Program {
  format: typeof PROGRAM_FORMAT;
  formatVersion: number;
  id: string;
  version: number;
  name: string;
  family: ProgramFamily;
  state: StateId;
  summary: string;
  description: string;
  evidence: Evidence;
  experimental: boolean;
  requires: { eeg: boolean; heart: 'none' | 'optional' | 'required'; signature: boolean; anchor: boolean; recommendedHeadsets?: string[] };
  unlock?: { afterProgram?: string; level?: number; excludeIf?: SafetyFlag[] };
  targets: TargetSpec[];
  combine: 'all' | 'mean' | 'any';
  rewardTauS: Num;
  gating: GatingSpec;
  blocks: BlockItem[];
  bindings: Bindings;
  /** Extra fields to compute block statistics for (targets are always included). */
  observe: string[];
  variables: VariableSpec[];
  /** Uses the shared five-level ladder (design 6.1): guidance, transfer and success band by level. */
  ladder: boolean;
  strategies: { recommended: string[]; usesProfile: boolean };
  watches: WatchSpec[];
  contraindications: string[];
  safetyNotes: string[];
}

export type SafetyFlag = 'epilepsy' | 'trauma_dissociation' | 'psychosis_bipolar' | 'driving' | 'breathing_condition' | 'pregnancy' | 'heart_condition';

// ---------------------------------------------------------------------------
// The ladder (design 6.1)
// ---------------------------------------------------------------------------

export interface LadderLevel {
  level: 1 | 2 | 3 | 4 | 5;
  name: string;
  guidance: 'full' | 'sparse' | 'none';
  /** Success fraction the threshold adapts toward. */
  successCenter: number;
  /** Criterion to advance: met in 2 of the last 3 sessions. */
  advance: { minFractionInTarget?: number; maxLatencyS?: number; transferRatio?: number; daysInRow?: number };
}

export const LADDER: LadderLevel[] = [
  { level: 1, name: 'Guided', guidance: 'full', successCenter: 0.72, advance: { minFractionInTarget: 0.6 } },
  { level: 2, name: 'Sparse', guidance: 'sparse', successCenter: 0.68, advance: { minFractionInTarget: 0.6, maxLatencyS: 90 } },
  { level: 3, name: 'Silent', guidance: 'none', successCenter: 0.65, advance: { minFractionInTarget: 0.65, maxLatencyS: 60 } },
  { level: 4, name: 'Transfer', guidance: 'none', successCenter: 0.65, advance: { transferRatio: 0.75 } },
  { level: 5, name: 'Everyday', guidance: 'none', successCenter: 0.62, advance: { maxLatencyS: 60, daysInRow: 3 } },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

const ID_RE = /^[a-z][a-z0-9_]*$/;
/** Words that would make a medical claim in user-facing text (CLAUDE.md rule 7). */
const MEDICAL_RE = /\b(cures?|curing|heals?|healing|diagnos\w*|treat|treats|treating|treatment|therap\w*|disorders?|patients?|clinically proven)\b/i;
/** Rhythmic entrainment is excluded (rule 6). */
const ENTRAIN_RE = /\b(binaural|monaural|isochronic|entrain\w*)\b/i;
/** Targets that cannot be trained honestly on a Muse (research R2.2): gamma, waking delta, SMR. */
const FORBIDDEN_TARGET_RE = /(bands\.(gamma|delta)\.|track\[(gamma|delta)\]|smr)/i;

function isGroup(b: BlockItem): b is BlockGroup {
  return (b as BlockGroup).repeat !== undefined;
}

function flattenSpecs(items: BlockItem[], out: BlockSpec[] = []): BlockSpec[] {
  for (const it of items) {
    if (isGroup(it)) flattenSpecs(it.blocks, out);
    else out.push(it);
  }
  return out;
}

/** All value combinations of the choice variables referenced in a templated path. */
function pathExpansions(path: string, vars: VariableSpec[]): string[] {
  const names = Array.from(new Set(Array.from(path.matchAll(/\$\{(\w+)\}/g), (m) => m[1])));
  let combos: Record<string, VarValue>[] = [{}];
  for (const n of names) {
    const v = vars.find((x) => x.id === n);
    if (!v) throw new FieldPathError(`unbound variable '${n}'`);
    const values: VarValue[] = v.kind === 'choice' ? (v.options ?? []).map((o) => o.value) : [v.default];
    combos = combos.flatMap((c) => values.map((val) => ({ ...c, [n]: val })));
  }
  return combos.map((c) => substitutePath(path, c));
}

function collectText(p: Program): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [
    { path: 'name', text: p.name },
    { path: 'summary', text: p.summary },
    { path: 'description', text: p.description },
    { path: 'evidence.summary', text: p.evidence.summary },
  ];
  p.safetyNotes.forEach((t, i) => out.push({ path: `safetyNotes[${i}]`, text: t }));
  p.contraindications.forEach((t, i) => out.push({ path: `contraindications[${i}]`, text: t }));
  p.variables.forEach((v, i) => out.push({ path: `variables[${i}]`, text: `${v.label} ${v.description} ${(v.options ?? []).map((o) => o.label).join(' ')}` }));
  p.watches.forEach((w, i) => out.push({ path: `watches[${i}].text`, text: w.text }));
  flattenSpecs(p.blocks).forEach((b) => {
    const g = b.guidance;
    out.push({ path: `blocks.${b.id}.guidance`, text: [g.title, g.start, g.end ?? '', ...(g.cues ?? []).map((c) => c.text)].join(' ') });
  });
  return out;
}

/** Validate a program. Returns an empty list when it is valid. */
export function validateProgram(p: Program): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message });

  if (p.format !== PROGRAM_FORMAT) err('format', `must be '${PROGRAM_FORMAT}'`);
  if (p.formatVersion !== PROGRAM_FORMAT_VERSION) err('formatVersion', `must be ${PROGRAM_FORMAT_VERSION}`);
  if (!ID_RE.test(p.id)) err('id', 'must be snake_case');
  if (!(Number.isInteger(p.version) && p.version >= 1)) err('version', 'must be a positive integer');
  for (const k of ['name', 'summary', 'description'] as const) if (!p[k]?.trim()) err(k, 'must not be empty');
  if (!['A', 'A-B', 'B', 'B-C', 'C', 'C-D', 'D'].includes(p.evidence?.grade)) err('evidence.grade', 'invalid grade');
  if (!p.evidence?.summary?.trim()) err('evidence.summary', 'must state the evidence honestly');

  // Variables
  const varIds = new Set<string>();
  p.variables.forEach((v, i) => {
    const at = `variables[${i}]`;
    if (!ID_RE.test(v.id)) err(at, `id '${v.id}' must be snake_case`);
    if (varIds.has(v.id)) err(at, `duplicate variable '${v.id}'`);
    varIds.add(v.id);
    if (v.kind === 'number') {
      if (typeof v.default !== 'number' || v.min === undefined || v.max === undefined) err(at, 'number variables need numeric default, min and max');
      else if (v.default < v.min || v.default > v.max) err(at, 'default outside [min, max]');
    } else if (v.kind === 'choice') {
      if (!v.options?.length) err(at, 'choice variables need options');
      else if (!v.options.some((o) => o.value === v.default)) err(at, 'default is not one of the options');
    } else if (v.kind === 'boolean') {
      if (typeof v.default !== 'boolean') err(at, 'boolean default must be boolean');
    }
  });
  const numVar = (n: Num, at: string) => {
    if (typeof n === 'number') {
      if (!Number.isFinite(n)) err(at, 'not a finite number');
      return;
    }
    const v = p.variables.find((x) => x.id === n.var);
    if (!v) err(at, `unknown variable '${n.var}'`);
    else if (v.kind !== 'number') err(at, `variable '${n.var}' is not numeric`);
  };

  // Targets
  if (!p.targets.length && p.family !== 'calibration' && p.family !== 'profiling' && p.family !== 'anchor' && p.family !== 'emotion') err('targets', 'a training program needs at least one target');
  const targetIds = new Set<string>();
  p.targets.forEach((t, i) => {
    const at = `targets[${i}]`;
    if (!ID_RE.test(t.id) || targetIds.has(t.id)) err(at, `bad or duplicate id '${t.id}'`);
    targetIds.add(t.id);
    if (!(t.weight > 0)) err(at, 'weight must be positive');
    if (t.source === 'field') {
      if (!t.field) err(at, 'field targets need a field');
      else {
        try {
          for (const path of pathExpansions(t.field, p.variables)) {
            compileField(path);
            if (FORBIDDEN_TARGET_RE.test(path)) err(at, `'${path}' cannot be trained honestly on this headset (gamma, waking delta and SMR are not offered)`);
          }
        } catch (e) {
          err(at, (e as Error).message);
        }
      }
    } else if (t.source === 'signature') {
      if (!p.requires.signature) err(at, 'signature targets need requires.signature');
    } else err(at, 'unknown source');
    const init = t.threshold.initial;
    if (init.rule === 'baseline_quantile' && !(init.q > 0 && init.q < 1)) err(at, 'baseline quantile must be in (0, 1)');
    if (t.threshold.adapt.band !== 'level') {
      const [lo, hi] = t.threshold.adapt.band;
      if (!(lo > 0 && hi < 1 && lo < hi)) err(at, 'success band must satisfy 0 < lo < hi < 1');
    }
    if (t.threshold.spanSd !== undefined && !(t.threshold.spanSd > 0)) err(at, 'spanSd must be positive');
    if (t.threshold.spanAbs !== undefined && !(t.threshold.spanAbs > 0)) err(at, 'spanAbs must be positive');
  });
  numVar(p.rewardTauS, 'rewardTauS');
  numVar(p.gating.minCleanFraction, 'gating.minCleanFraction');
  if (p.gating.maxEmgRiseDb !== null) numVar(p.gating.maxEmgRiseDb, 'gating.maxEmgRiseDb');
  if (p.requires.eeg && !p.gating.channels.length && p.targets.some((t) => t.source === 'field' && !t.field?.startsWith('heart.'))) {
    err('gating.channels', 'EEG targets need gating channels');
  }

  // Observed fields and bindings
  const checkPath = (path: string, at: string) => {
    if (path === 'reward' || path === 'signature' || path === 'pacer') return;
    try {
      for (const x of pathExpansions(path, p.variables)) compileField(x);
    } catch (e) {
      err(at, (e as Error).message);
    }
  };
  p.observe.forEach((f, i) => checkPath(f, `observe[${i}]`));
  p.bindings.sound.forEach((b, i) => checkPath(b.reads, `bindings.sound[${i}]`));
  p.bindings.visual.forEach((b, i) => checkPath(b.reads, `bindings.visual[${i}]`));
  p.bindings.display.forEach((f, i) => checkPath(f, `bindings.display[${i}]`));
  p.watches.forEach((w, i) => {
    w.when.forEach((c, j) => checkPath(c.field, `watches[${i}].when[${j}]`));
    if (w.enabledBy && p.variables.find((v) => v.id === w.enabledBy)?.kind !== 'boolean') err(`watches[${i}]`, 'enabledBy must name a boolean variable');
  });

  // Rule 3: golden ratio alignment is always shown beside octave alignment and the chance level.
  const allPaths = [
    ...p.targets.map((t) => t.field ?? ''),
    ...p.bindings.sound.map((b) => b.reads),
    ...p.bindings.visual.map((b) => b.reads),
    ...p.bindings.display,
  ];
  if (allPaths.some((x) => /\.phi\./.test(x))) {
    if (!p.bindings.display.some((x) => /\.octave\./.test(x))) err('bindings.display', 'golden ratio alignment must be shown beside octave alignment (rule 3)');
    if (!p.bindings.display.some((x) => /chance|excess_/.test(x))) err('bindings.display', 'golden ratio alignment must be shown with its chance level (rule 3)');
  }

  // Blocks
  const specs = flattenSpecs(p.blocks);
  const blockIds = new Set<string>();
  let sawBaseline = false;
  const needsBaseline = p.targets.some((t) => t.threshold.initial.rule !== 'absolute');
  const strategyIds = new Set(STRATEGIES.map((s) => s.id));
  for (const b of specs) {
    const at = `blocks.${b.id}`;
    if (!ID_RE.test(b.id)) err(at, 'block id must be snake_case');
    if (blockIds.has(b.id)) err(at, 'duplicate block id');
    blockIds.add(b.id);
    numVar(b.durationS, `${at}.durationS`);
    if (typeof b.durationS === 'number' && !(b.durationS > 0)) err(at, 'duration must be positive');
    if (b.kind === 'baseline') sawBaseline = true;
    if (b.feedback && b.kind !== 'train') err(at, 'only train blocks give feedback (transfer, strategy sampler, baseline and probe blocks are feedback-off)');
    if (b.feedback && needsBaseline && !sawBaseline) err(at, 'a feedback block comes before any baseline block');
    if (b.feedback && !p.targets.length) err(at, 'feedback needs a target');
    if (typeof b.strategy === 'string' && !['profile_best', 'user_choice'].includes(b.strategy) && !strategyIds.has(b.strategy)) err(at, `unknown strategy '${b.strategy}'`);
    if (b.pacer !== undefined && b.pacer !== 'resonance') numVar(b.pacer, `${at}.pacer`);
    if (b.anchor === 'pair' && !p.requires.anchor) err(at, 'pairing blocks need requires.anchor');
    if (b.anchor === 'pair' && !p.requires.signature) err(at, 'pairing is gated by the signature: requires.signature');
    if (b.cue && b.cue !== 'none' && !p.requires.anchor) err(at, 'cue blocks need requires.anchor');
    if (!b.guidance?.title?.trim() || !b.guidance.start?.trim()) err(at, 'every block needs guidance text');
  }
  if (!specs.length) err('blocks', 'no blocks');
  const groups = (items: BlockItem[], at: string) => {
    items.forEach((it, i) => {
      if (isGroup(it)) {
        numVar(it.repeat, `${at}[${i}].repeat`);
        groups(it.blocks, `${at}[${i}].blocks`);
      }
    });
  };
  groups(p.blocks, 'blocks');
  p.strategies.recommended.forEach((s, i) => {
    if (!strategyIds.has(s)) err(`strategies.recommended[${i}]`, `unknown strategy '${s}'`);
  });

  // Text rules: no medical claims, no entrainment.
  for (const { path, text } of collectText(p)) {
    if (MEDICAL_RE.test(text)) err(path, `medical wording is not allowed: '${text.match(MEDICAL_RE)?.[0]}'`);
  }
  const entrainHaystack = JSON.stringify({ b: p.bindings, s: p.strategies, blocks: specs.map((b) => b.strategy ?? '') });
  if (ENTRAIN_RE.test(entrainHaystack)) err('bindings', 'rhythmic entrainment is excluded from this app (rule 6)');

  // Round trip: a program must be plain JSON.
  try {
    if (JSON.stringify(JSON.parse(JSON.stringify(p))) !== JSON.stringify(p)) err('', 'not JSON-serializable');
  } catch {
    err('', 'not JSON-serializable');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

export interface PlanTarget {
  id: string;
  label: string;
  source: 'field' | 'signature';
  /** Concrete field path, or null for signature targets. */
  field: string | null;
  direction: 'up' | 'down';
  weight: number;
  initial: ThresholdInitial;
  adapt: { enabled: boolean; lo: number; hi: number; center: number; gain: number; maxStepSd: number };
  spanSd: number | null;
  spanAbs: number | null;
  floor: number | null;
  ceiling: number | null;
}

export interface PlannedBlock {
  index: number;
  id: string;
  kind: BlockKind;
  durationS: number;
  feedback: boolean;
  eyes: 'open' | 'closed' | 'any';
  strategy: string | null;
  label: 'state' | 'contrast' | null;
  guidance: Guidance;
  pacerBpm: number | null;
  cue: 'anchor' | 'control' | 'none' | null;
  anchor: 'pair' | 'control_exposure' | null;
  ratings: RatingKey[];
  task: string | null;
}

export interface PlanWatch {
  id: string;
  when: { field: string; op: 'below' | 'above'; baselineSd: number | null; value: number | null }[];
  forS: number;
  event: 'tether' | 'cue';
  text: string;
}

export interface SessionPlan {
  programId: string;
  programVersion: number;
  programName: string;
  state: StateId;
  level: number | null;
  variables: Record<string, VarValue>;
  targets: PlanTarget[];
  combine: 'all' | 'mean' | 'any';
  rewardTauS: number;
  gating: { channels: string[]; channelRule: 'all' | 'any'; minCleanFraction: number; fastArtifact: boolean; maxEmgRiseDb: number | null; heart: boolean };
  blocks: PlannedBlock[];
  /** All fields that get block statistics: targets plus observe. */
  statFields: string[];
  bindings: Bindings;
  watches: PlanWatch[];
}

export interface InstantiateOptions {
  /** Variable values chosen by the user; missing ones take defaults. */
  values?: Record<string, VarValue>;
  /** Ladder level 1-5 for ladder programs (default 1). */
  level?: number;
  /** Profile hints. */
  bestStrategy?: string;
  userStrategy?: string;
  /** Strategies for { slot: n } blocks, in slot order (from profile.planDiscoverySession). */
  strategySlots?: string[];
  /** Personal resonance breathing rate, breaths/min. */
  resonanceBpm?: number;
  /** Probe cue order for 'slot' cues (from anchors.planProbeOrder). */
  probeOrder?: ('anchor' | 'control')[];
}

export class ProgramError extends Error {}

export function instantiateProgram(p: Program, opts: InstantiateOptions = {}): SessionPlan {
  const issues = validateProgram(p);
  if (issues.length) throw new ProgramError(`invalid program ${p.id}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);

  const values: Record<string, VarValue> = {};
  for (const v of p.variables) {
    const given = opts.values?.[v.id];
    const val = given === undefined ? v.default : given;
    if (v.kind === 'number') {
      if (typeof val !== 'number' || val < (v.min as number) || val > (v.max as number)) throw new ProgramError(`variable ${v.id} out of range: ${String(val)}`);
    } else if (v.kind === 'choice') {
      if (!v.options?.some((o) => o.value === val)) throw new ProgramError(`variable ${v.id}: '${String(val)}' is not an option`);
    } else if (typeof val !== 'boolean') throw new ProgramError(`variable ${v.id} must be boolean`);
    values[v.id] = val;
  }
  for (const k of Object.keys(opts.values ?? {})) if (!(k in values)) throw new ProgramError(`unknown variable '${k}'`);

  const num = (n: Num): number => (typeof n === 'number' ? n : (values[n.var] as number));
  const level = p.ladder ? Math.min(5, Math.max(1, Math.round(opts.level ?? 1))) : null;
  const ladder = level ? LADDER[level - 1] : null;

  const targets: PlanTarget[] = p.targets.map((t) => {
    const band = t.threshold.adapt.band;
    const [lo, hi] = band === 'level' ? [TRAINING_PARAMS.successBandLo, TRAINING_PARAMS.successBandHi] : band;
    const center = band === 'level' ? (ladder?.successCenter ?? (lo + hi) / 2) : (lo + hi) / 2;
    return {
      id: t.id,
      label: t.label,
      source: t.source,
      field: t.source === 'field' && t.field ? substitutePath(t.field, values) : null,
      direction: t.direction,
      weight: t.weight,
      initial: t.threshold.initial,
      adapt: { enabled: t.threshold.adapt.enabled, lo, hi, center, gain: TRAINING_PARAMS.adaptGain, maxStepSd: TRAINING_PARAMS.adaptMaxStepSd },
      spanSd: t.threshold.spanAbs !== undefined ? null : (t.threshold.spanSd ?? TRAINING_PARAMS.rewardSpanSd),
      spanAbs: t.threshold.spanAbs ?? null,
      floor: t.threshold.floor ?? null,
      ceiling: t.threshold.ceiling ?? null,
    };
  });

  let probeIdx = 0;
  const blocks: PlannedBlock[] = [];
  let trainCount = 0;
  const idCounts = new Map<string, number>();
  const expand = (items: BlockItem[]) => {
    for (const it of items) {
      if (isGroup(it)) {
        if (it.whenSlot !== undefined && opts.strategySlots?.[it.whenSlot] === undefined) continue;
        const n = Math.max(0, Math.round(num(it.repeat)));
        for (let i = 0; i < n; i++) expand(it.blocks);
        continue;
      }
      let strategy: string | null = null;
      if (typeof it.strategy === 'string') {
        strategy = it.strategy === 'profile_best' ? (opts.bestStrategy ?? 'none') : it.strategy === 'user_choice' ? (opts.userStrategy ?? opts.bestStrategy ?? 'none') : it.strategy;
      } else if (it.strategy) {
        strategy = opts.strategySlots?.[it.strategy.slot] ?? null;
        if (strategy === null) continue; // fewer strategies than slots: the slot's blocks are skipped
      }
      let cue: PlannedBlock['cue'] = null;
      if (it.cue === 'slot') {
        cue = opts.probeOrder?.[probeIdx++] ?? 'none';
      } else if (it.cue) cue = it.cue;

      let feedback = it.feedback;
      let kind: BlockKind = it.kind;
      let guidance: Guidance = it.guidance;
      if (ladder && it.kind === 'train') {
        trainCount++;
        if (ladder.level === 4 && trainCount % 2 === 0) {
          feedback = false;
          kind = 'transfer';
          guidance = { ...guidance, start: `${guidance.start} The sound stays neutral for this block. Carry on as if it were still with you.` };
        }
      }
      if (ladder && (kind === 'train' || kind === 'transfer')) {
        const cues = ladder.guidance === 'full' ? guidance.cues : ladder.guidance === 'sparse' ? guidance.cues?.filter((c) => c.sparse) : [];
        guidance = { ...guidance, cues };
      }
      let durationS = num(it.durationS);
      if (ladder?.level === 5 && (kind === 'train' || kind === 'transfer')) durationS = Math.min(durationS, 180);

      const seen = (idCounts.get(it.id) ?? 0) + 1;
      idCounts.set(it.id, seen);
      blocks.push({
        index: blocks.length,
        id: seen === 1 ? it.id : `${it.id}_${seen}`,
        kind,
        durationS,
        feedback,
        eyes: it.eyes,
        strategy,
        label: it.label ?? null,
        guidance,
        pacerBpm: it.pacer === undefined ? null : it.pacer === 'resonance' ? (opts.resonanceBpm ?? 6.0) : num(it.pacer),
        cue,
        anchor: it.anchor ?? null,
        ratings: it.ratings ?? [],
        task: it.task ?? null,
      });
    }
  };
  expand(p.blocks);

  const statFields = Array.from(new Set([
    ...targets.filter((t) => t.field).map((t) => t.field as string),
    ...p.observe.map((f) => substitutePath(f, values)),
  ]));

  const watches: PlanWatch[] = p.watches
    .filter((w) => !w.enabledBy || values[w.enabledBy] === true)
    .map((w) => ({
      id: w.id,
      forS: w.forS,
      event: w.event,
      text: w.text,
      when: w.when.map((c) => ({ field: substitutePath(c.field, values), op: c.op, baselineSd: c.baselineSd ?? null, value: c.value ?? null })),
    }));

  const sub = <E extends string>(b: Binding<E>): Binding<E> => ({ ...b, reads: b.reads.includes('${') ? substitutePath(b.reads, values) : b.reads });

  return {
    programId: p.id,
    programVersion: p.version,
    programName: p.name,
    state: p.state.includes('${') ? substitutePath(p.state, values) : p.state,
    level,
    variables: values,
    targets,
    combine: p.combine,
    rewardTauS: num(p.rewardTauS),
    gating: {
      channels: p.gating.channels,
      channelRule: p.gating.channelRule,
      minCleanFraction: num(p.gating.minCleanFraction),
      fastArtifact: p.gating.fastArtifact,
      maxEmgRiseDb: p.gating.maxEmgRiseDb === null ? null : num(p.gating.maxEmgRiseDb),
      heart: p.gating.heart,
    },
    blocks,
    statFields,
    bindings: {
      sound: p.bindings.sound.map(sub),
      visual: p.bindings.visual.map(sub),
      display: p.bindings.display.map((d) => (d.includes('${') ? substitutePath(d, values) : d)),
    },
    watches,
  };
}
