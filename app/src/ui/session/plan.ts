/**
 * Turning "run this program with these choices" into the concrete, storable description of a
 * session (SessionSpec): what to instantiate and what to give the runner. The spec is written
 * into the recording, so a replay rebuilds the same plan and the runner gives the same record.
 */
import {
  bestStrategy, deriveSeed, getProgram, planDiscoverySession, planProbeOrder,
  type BaselineSummary, type CheckIn, type InstantiateOptions, type Posture, type RunnerOptions, type UserProfile, type VarValue,
} from '../../training';

export interface ProgramRequest {
  programId: string;
  values?: Record<string, VarValue>;
  /** Overrides the profile's ladder level. */
  level?: number;
  /** Strategy for 'user_choice' blocks. */
  userStrategy?: string;
  posture?: Posture;
  checkIn?: CheckIn;
  /** Anchor to use for pairing and probe programs. */
  anchorId?: string;
}

export interface SessionSpec {
  kind: 'program' | 'free';
  programId: string | null;
  instantiate: InstantiateOptions | null;
  /** Everything the runner needs except frames. JSON-safe. */
  runner: RunnerOptions | null;
}

function resolveState(state: string, values: Record<string, VarValue>): string {
  return state.replace(/\$\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? ''));
}

/** Prior baselines for the runner from the profile's stored resting baselines (eyes closed first). */
export function priorBaselines(profile: UserProfile): Record<string, BaselineSummary> {
  const out: Record<string, BaselineSummary> = {};
  const order: Record<string, number> = { closed: 0, any: 1, open: 2 };
  const best: Record<string, number> = {};
  for (const [key, b] of Object.entries(profile.baselines)) {
    const field = key.slice(0, key.lastIndexOf('|'));
    const rank = order[b.eyes] ?? 3;
    if (best[field] === undefined || rank < best[field]) {
      best[field] = rank;
      const { at: _at, ...summary } = b;
      out[field] = summary;
    }
  }
  return out;
}

export interface PrepareContext {
  profile: UserProfile;
  startedAtIso: string;
  sessionId: string;
  headset: string | null;
  engine: { version: string | null; params: Record<string, number | string | boolean> | null };
}

export function prepareProgramSession(req: ProgramRequest, ctx: PrepareContext): SessionSpec {
  const program = getProgram(req.programId);
  if (!program) throw new Error(`unknown program '${req.programId}'`);
  const { profile } = ctx;
  const values: Record<string, VarValue> = {};
  for (const v of program.variables) values[v.id] = req.values?.[v.id] ?? v.default;
  const stateId = resolveState(program.state, values);
  const instantiate: InstantiateOptions = {
    values: req.values ?? {},
    level: program.ladder ? (req.level ?? profile.programs[program.id]?.level ?? 1) : undefined,
    bestStrategy: bestStrategy(profile, stateId),
    resonanceBpm: profile.resonance?.bpm,
  };
  if (req.userStrategy) instantiate.userStrategy = req.userStrategy;
  const seed = deriveSeed(profile.seed, `session:${profile.sessions.length}:${program.id}`);
  if (program.id === 'discovery_sampler') {
    instantiate.strategySlots = planDiscoverySession(profile).strategies;
  }
  if (program.id === 'anchor_probe') {
    const pairs = Number(values.probe_pairs ?? 3);
    instantiate.probeOrder = planProbeOrder(pairs, seed);
  }
  const signature = program.requires.signature || program.requires.anchor
    ? (profile.signatures.find((s) => s.state === stateId && s.status === 'reliable') ?? profile.signatures.find((s) => s.state === stateId) ?? null)
    : null;
  let anchor: RunnerOptions['anchor'] = null;
  if (program.requires.anchor) {
    const a = profile.anchors.find((x) => !x.retired && (req.anchorId ? x.id === req.anchorId : x.state === stateId));
    if (a) anchor = { id: a.id, controlId: a.control.id };
  }
  const runner: RunnerOptions = {
    sessionId: ctx.sessionId,
    userId: profile.userId,
    startedAt: ctx.startedAtIso,
    seed,
    priorBaselines: priorBaselines(profile),
    signature,
    anchor,
    ...(ctx.headset ? { headset: ctx.headset } : {}),
    ...(req.posture ? { posture: req.posture } : {}),
    ...(req.checkIn ? { checkIn: req.checkIn } : {}),
    ...(ctx.engine.version ? { engineVersion: ctx.engine.version } : {}),
    ...(ctx.engine.params ? { engineParams: ctx.engine.params } : {}),
  };
  return { kind: 'program', programId: program.id, instantiate, runner };
}

export function freeSessionSpec(): SessionSpec {
  return { kind: 'free', programId: null, instantiate: null, runner: null };
}

export function newSessionId(now: Date, random: () => number, programId: string | null): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const salt = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `s_${stamp}_${programId ?? 'free'}_${salt}`;
}
