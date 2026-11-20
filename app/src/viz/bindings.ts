/**
 * The hurricane binding table (spec 9.1), as code.
 *
 * `computeVisualState(prev, frames, now)` maps the latest engine frames to every visual parameter
 * of the hurricane. It is a pure function: the same inputs give the same output.
 *
 * Each parameter reads exactly one frame field, and carries its provenance:
 *   value     the drawn value, in the field's own units, after the declared ramp (params.ts)
 *   target    the value the ramp is heading to: the measured field value, or null
 *   field     the frame field path it reads
 *   measured  the raw measured number from the latest frame, or null
 *   se        its standard error, where the engine gives one
 *   why       'ok', or the reason the field is null
 *
 * Time rules:
 *  - The only smoothing is the declared linear ramp (VIZ_SMOOTHING.RAMP_S): from the drawn value
 *    to the latest measured value, ending exactly on it. Never past it, never ahead of the latest
 *    frame. When frames stop changing, every parameter stops changing within RAMP_S.
 *  - Rotation phase advances at a rate proportional to the measured dominant frequency. When
 *    that frequency is null, rotation stops at once. It does not coast or spin down.
 *  - Frames older than the stale limit are treated as null ('stale'): the storm dissolves to calm.
 */
import type { Cascade, HeartFrame, Measured, SlowFrame, Track } from '../engine/frames.ts';
import type { FrameSnapshot } from './frameStore.ts';
import {
  brightnessFromDb,
  clamp,
  eyeClarityFromHeld,
  bothClarityFromHeld,
  pulseEnvelope,
  rotationRevPerS,
  symmetryOffsetFromMatch,
  TAU,
  windingFromExcess,
  wrapAngle,
} from './geometry.ts';
import {
  VIZ_GEOMETRY,
  VIZ_MAPPING,
  VIZ_REDUCED_MOTION,
  VIZ_SMOOTHING,
  type ChanceDriver,
  type Motion,
} from './params.ts';
import { reasonText, type VizReason } from './reasons.ts';

export interface Bound {
  key: string;
  /** What the user sees, in words. */
  label: string;
  value: number | null;
  target: number | null;
  field: string;
  measured: number | null;
  se: number | null;
  unit: string;
  why: VizReason;
}

export type StormMode = 'calm' | 'bands' | 'storm';

/** Viewer preferences. Neither changes what is measured; they choose which field or how gently. */
export interface VizOptions {
  /** Which chance level's excess drives winding, rings and the combined state. Default 'a'. */
  chance: ChanceDriver;
  /** 'reduced' honours prefers-reduced-motion. Default 'full'. */
  motion: Motion;
}

export const DEFAULT_VIZ_OPTIONS: VizOptions = { chance: 'a', motion: 'full' };

/** One linear ramp: drawn value goes from `from` to `to` over RAMP_S starting at `t0`. */
interface Ramp {
  from: number;
  to: number;
  t0: number;
}

export interface VisualState {
  now: number;
  options: VizOptions;
  /** What the latest frames support. The picture fades between modes over RAMP_S. */
  mode: StormMode;
  /** Text shown over calm water, or null when there is structure. */
  message: string | null;
  /** Reason behind the message. */
  messageWhy: VizReason | null;

  rotation: Bound;
  /** Rotation phase, radians. Integrated from `rotation`; not itself a measurement. */
  rotationPhase: number;
  /**
   * Rotation rate in rev/s, ramped (0 when rotation is null). Used only to soften fine texture at
   * high rotation speed (photosensitivity). The phase itself stops at once on null.
   */
  motionRate: number;
  armCount: Bound;
  /** One per arm slot (MAX_ARMS). Slot i is cascade member i, lowest frequency first. */
  arms: Bound[];
  /** Track id behind each arm slot, or null. */
  armTracks: (number | null)[];
  winding: Bound;
  ring: Bound;
  /** Unorganized bands: confirmed tracks that are not arms. One per slot (MAX_BANDS). */
  bandCount: Bound;
  bands: Bound[];
  bandTracks: (number | null)[];
  eye: Bound;
  /** Combined state: golden ratio and octave aligned at once (slow.states.both.active), 1 or 0. */
  combined: Bound;
  /** Strength of the combined look: the smaller of the two excess values. */
  combinedStrength: Bound;
  /** Clarity of the shared eye wall: slow.states.both.for_s. */
  combinedHeld: Bound;
  symmetry: Bound;
  pulse: Bound;
  swell: Bound;
  /** 0..1, ramped availability of the breath phase. The swell fades out when it goes null. */
  swellAmount: number;
  /** Drawn breath phase, radians. Frozen where it was while the breath phase is null. */
  swellPhase: number;

  /** The frames this state was computed from (for readouts). Null when stale. */
  slow: SlowFrame | null;
  heart: HeartFrame | null;

  ramps: Readonly<Record<string, Ramp>>;
}

// ---------------------------------------------------------------------------
// Ramps
// ---------------------------------------------------------------------------

function rampValue(r: Ramp, now: number, T: number): number {
  if (T <= 0) return r.to;
  const u = (now - r.t0) / T;
  if (u >= 1) return r.to;
  if (u <= 0) return r.from;
  return r.from + (r.to - r.from) * u;
}

function rampDone(r: Ramp, now: number, T: number): boolean {
  return now - r.t0 >= T;
}

interface RampCtx {
  prev: Readonly<Record<string, Ramp>>;
  next: Record<string, Ramp>;
  now: number;
  T: number;
}

/** Advance the ramp for `key` toward `target`. Returns the drawn value now. */
function ramp(ctx: RampCtx, key: string, target: number, rest: number): { value: number; done: boolean } {
  const old = ctx.prev[key] ?? { from: rest, to: rest, t0: -Infinity };
  let r = old;
  if (old.to !== target) {
    r = { from: rampValue(old, ctx.now, ctx.T), to: target, t0: ctx.now };
  }
  ctx.next[key] = r;
  return { value: rampValue(r, ctx.now, ctx.T), done: rampDone(r, ctx.now, ctx.T) };
}

/** Angular ramp: takes the short way round. Returns a wrapped angle. */
function rampAngle(ctx: RampCtx, key: string, target: number): { value: number; done: boolean } {
  const old = ctx.prev[key];
  if (!old) {
    const r = { from: target, to: target, t0: -Infinity };
    ctx.next[key] = r;
    return { value: wrapAngle(target), done: true };
  }
  let r = old;
  if (wrapAngle(target - old.to) !== 0) {
    const cur = rampValue(old, ctx.now, ctx.T);
    r = { from: cur, to: cur + wrapAngle(target - cur), t0: ctx.now };
  }
  ctx.next[key] = r;
  return { value: wrapAngle(rampValue(r, ctx.now, ctx.T)), done: rampDone(r, ctx.now, ctx.T) };
}

// ---------------------------------------------------------------------------
// Field reading
// ---------------------------------------------------------------------------

interface FieldRead {
  field: string;
  measured: number | null;
  se: number | null;
  why: VizReason;
}

function fromMeasured(field: string, m: Measured | undefined, fallbackWhy: VizReason): FieldRead {
  if (!m) return { field, measured: null, se: null, why: fallbackWhy };
  if (m.v === null || !Number.isFinite(m.v)) {
    return { field, measured: null, se: null, why: m.why === 'ok' ? fallbackWhy : m.why };
  }
  return { field, measured: m.v, se: m.se ?? null, why: 'ok' };
}

function nullRead(field: string, why: VizReason): FieldRead {
  return { field, measured: null, se: null, why };
}

/**
 * Bind one field. `rest` is the drawn value that means "absent"; when the field goes null the
 * drawn value ramps to `rest` and then reports null.
 */
function bind(ctx: RampCtx, key: string, label: string, unit: string, read: FieldRead, rest: number): Bound {
  const target = read.measured;
  const r = ramp(ctx, key, target ?? rest, rest);
  return {
    key,
    label,
    value: target === null && r.done ? null : r.value,
    target,
    field: read.field,
    measured: read.measured,
    se: read.se,
    unit,
    why: read.why,
  };
}

/** Why there are no confirmed tracks, in the most specific terms the frame gives. */
export function calmReason(slow: SlowFrame): VizReason {
  if (slow.quality.length > 0 && slow.quality.every((q) => !q.usable)) {
    const counts = new Map<VizReason, number>();
    for (const q of slow.quality) if (q.why !== 'ok') counts.set(q.why, (counts.get(q.why) ?? 0) + 1);
    let best: VizReason = 'bad_contact';
    let n = 0;
    for (const [k, c] of counts) if (c > n) { best = k; n = c; }
    return best;
  }
  if (slow.spectra.length > 0 && slow.spectra.every((s) => s.why !== 'ok')) {
    return slow.spectra[0].why;
  }
  return 'not_confirmed';
}

function confirmedTracks(slow: SlowFrame): Track[] {
  return slow.tracks.filter((t) => t.state === 'confirmed');
}

/** Cascade members that are present as confirmed tracks, lowest frequency first (engine order). */
function cascadeMembers(c: Cascade, confirmed: Track[]): Track[] {
  const out: Track[] = [];
  for (const id of c.tracks) {
    const t = confirmed.find((x) => x.id === id);
    if (t) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The binding table
// ---------------------------------------------------------------------------

export function computeVisualState(
  prev: VisualState | null,
  frames: FrameSnapshot,
  now: number,
  options: VizOptions = DEFAULT_VIZ_OPTIONS,
): VisualState {
  const { chance, motion } = options;
  const exKey = chance === 'a' ? 'excess_a' : 'excess_b';
  const chanceName = chance === 'a' ? 'chance A' : 'chance B';
  const ctx: RampCtx = { prev: prev?.ramps ?? {}, next: {}, now, T: VIZ_SMOOTHING.RAMP_S };

  const slowFresh =
    frames.slow !== null && frames.slowAt !== null && now - frames.slowAt <= VIZ_SMOOTHING.SLOW_STALE_S;
  const heartFresh =
    frames.heart !== null && frames.heartAt !== null && now - frames.heartAt <= VIZ_SMOOTHING.HEART_STALE_S;
  const slow = slowFresh ? frames.slow : null;
  const heart = heartFresh ? frames.heart : null;
  const slowMissing: VizReason = frames.slow === null ? 'no_data' : 'stale';
  const heartMissing: VizReason = frames.heart === null ? 'no_data' : 'stale';

  const confirmed = slow ? confirmedTracks(slow) : [];
  const calmWhy: VizReason = slow ? (confirmed.length > 0 ? 'ok' : calmReason(slow)) : slowMissing;

  // --- Golden ratio cascade: arms, winding, eye --------------------------------------------
  const phi = slow?.cascades.phi;
  const members = phi ? cascadeMembers(phi, confirmed) : [];
  const phiExcess = phi
    ? fromMeasured(`slow.cascades.phi.${exKey}`, phi[exKey], 'not_available')
    : nullRead(`slow.cascades.phi.${exKey}`, calmWhy);
  const stormForms = members.length >= 2 && phiExcess.measured !== null;
  const noStormWhy: VizReason =
    calmWhy !== 'ok' ? calmWhy : members.length < 2 ? 'no_cascade' : phiExcess.why;

  const mode: StormMode = stormForms ? 'storm' : confirmed.length > 0 ? 'bands' : 'calm';

  const armCount = bind(
    ctx, 'armCount', 'Number of spiral arms', 'arms',
    stormForms
      ? { field: 'slow.cascades.phi.tracks.length', measured: members.length, se: null, why: 'ok' }
      : nullRead('slow.cascades.phi.tracks.length', noStormWhy),
    0,
  );

  const arms: Bound[] = [];
  const armTracks: (number | null)[] = [];
  for (let i = 0; i < VIZ_GEOMETRY.MAX_ARMS; i++) {
    const t = stormForms ? members[i] : undefined;
    const read = t
      ? fromMeasured(`slow.tracks[id=${t.id}].height_db`, t.height_db, 'not_available')
      : nullRead(`slow.cascades.phi.tracks[${i}].height_db`, stormForms ? 'not_available' : noStormWhy);
    arms.push(bind(ctx, `arm.${i}`, `Brightness of arm ${i + 1}`, 'dB', read, 0));
    armTracks.push(t ? t.id : null);
  }

  const winding = bind(
    ctx, 'winding', `How tightly the arms wind (golden ratio alignment beyond ${chanceName})`, '0..1',
    stormForms ? phiExcess : { ...phiExcess, measured: null, se: null, why: noStormWhy },
    0,
  );

  const eye = bind(
    ctx, 'eye', 'Clarity of the eye (time the cascade has held)', 's',
    stormForms && phi
      ? { field: 'slow.cascades.phi.held_s', measured: phi.held_s, se: null, why: 'ok' }
      : nullRead('slow.cascades.phi.held_s', noStormWhy),
    0,
  );

  // --- Octave ring ---------------------------------------------------------------------------
  const oct = slow?.cascades.octave;
  const octExcess = oct && confirmed.length > 0
    ? fromMeasured(`slow.cascades.octave.${exKey}`, oct[exKey], 'not_available')
    : nullRead(`slow.cascades.octave.${exKey}`, calmWhy);
  const ring = bind(ctx, 'ring', `Ring structure (octave alignment beyond ${chanceName})`, '0..1', octExcess, 0);

  // --- Combined state: golden ratio and octave at once ------------------------------------
  const both = slow?.states.both;
  const bothActive = both?.active === true;
  const notBothWhy: VizReason = calmWhy !== 'ok' ? calmWhy : 'not_combined';
  const combined = bind(
    ctx, 'combined', 'Combined state (golden ratio and octave aligned at once)', 'on/off',
    slow && both
      ? { field: 'slow.states.both.active', measured: bothActive ? 1 : 0, se: null, why: 'ok' }
      : nullRead('slow.states.both.active', slow ? 'not_available' : slowMissing),
    0,
  );
  const minField = `min(slow.cascades.phi.${exKey}, slow.cascades.octave.${exKey})`;
  const combinedStrength = bind(
    ctx, 'combinedStrength', `Strength of the combined look (the weaker of the two alignments beyond ${chanceName})`, '0..1',
    bothActive && phiExcess.measured !== null && octExcess.measured !== null
      ? {
          field: minField,
          measured: Math.min(phiExcess.measured, octExcess.measured),
          se: phiExcess.measured <= octExcess.measured ? phiExcess.se : octExcess.se,
          why: 'ok',
        }
      : nullRead(minField, bothActive ? (phiExcess.measured === null ? phiExcess.why : octExcess.why) : notBothWhy),
    0,
  );
  const combinedHeld = bind(
    ctx, 'combinedHeld', 'Clarity of the shared eye wall (time in the combined state)', 's',
    bothActive && both
      ? { field: 'slow.states.both.for_s', measured: both.for_s, se: null, why: 'ok' }
      : nullRead('slow.states.both.for_s', notBothWhy),
    0,
  );

  // --- Unorganized bands: confirmed tracks that are not arms ------------------------------
  const memberIds = new Set(stormForms ? members.map((m) => m.id) : []);
  const bandSource = confirmed.filter((t) => !memberIds.has(t.id));
  const bandCount = bind(
    ctx, 'bandCount', 'Bands of unorganized cloud', 'tracks',
    slow
      ? { field: 'slow.tracks[state=confirmed].length', measured: Math.min(bandSource.length, VIZ_GEOMETRY.MAX_BANDS), se: null, why: 'ok' }
      : nullRead('slow.tracks[state=confirmed].length', calmWhy),
    0,
  );
  const bands: Bound[] = [];
  const bandTracks: (number | null)[] = [];
  for (let j = 0; j < VIZ_GEOMETRY.MAX_BANDS; j++) {
    const t = bandSource[j];
    const read = t
      ? fromMeasured(`slow.tracks[id=${t.id}].height_db`, t.height_db, 'not_available')
      : nullRead(`slow.tracks[band ${j}].height_db`, calmWhy === 'ok' ? 'not_confirmed' : calmWhy);
    bands.push(bind(ctx, `band.${j}`, `Brightness of cloud band ${j + 1}`, 'dB', read, 0));
    bandTracks.push(t ? t.id : null);
  }

  // --- Rotation: dominant confirmed track's frequency ------------------------------------
  let rotRead: FieldRead;
  if (!slow) rotRead = nullRead('slow.tracks[id=dominant].freq', slowMissing);
  else if (slow.dominant === null) rotRead = nullRead('slow.tracks[id=dominant].freq', calmWhy === 'ok' ? 'no_dominant' : calmWhy);
  else {
    const dom = confirmed.find((t) => t.id === slow.dominant);
    rotRead = dom
      ? fromMeasured(`slow.tracks[id=${dom.id}].freq`, dom.freq, 'not_available')
      : nullRead(`slow.tracks[id=${slow.dominant}].freq`, 'not_confirmed');
  }
  let rotation: Bound;
  if (rotRead.measured === null) {
    // Stops at once: no coasting, no spin-down. Clear the ramp so a later value starts fresh.
    rotation = {
      key: 'rotation', label: 'Rotation speed (frequency of the strongest confirmed track)',
      value: null, target: null, field: rotRead.field, measured: null, se: null, unit: 'Hz', why: rotRead.why,
    };
  } else {
    const hadValue = prev !== null && prev.rotation.value !== null;
    const r = hadValue
      ? ramp(ctx, 'rotation', rotRead.measured, rotRead.measured)
      : ramp({ ...ctx, prev: {} }, 'rotation', rotRead.measured, rotRead.measured);
    rotation = {
      key: 'rotation', label: 'Rotation speed (frequency of the strongest confirmed track)',
      value: r.value, target: rotRead.measured, field: rotRead.field, measured: rotRead.measured,
      se: rotRead.se, unit: 'Hz', why: 'ok',
    };
  }
  let rotationPhase = prev?.rotationPhase ?? 0;
  if (prev && rotation.value !== null && prev.rotation.value !== null) {
    // Integrate with the rate at the start of the step (both ends are measured values).
    const dt = clamp(now - prev.now, 0, 0.1);
    rotationPhase = (rotationPhase + TAU * rotationRevPerS(prev.rotation.value, motion) * dt) % TAU;
  }
  const motionRate = ramp(
    ctx, 'motionRate', rotation.value === null ? 0 : rotationRevPerS(rotation.value, motion), 0,
  ).value;

  // --- Hemisphere symmetry ----------------------------------------------------------------
  let symRead: FieldRead;
  if (!slow) symRead = nullRead('slow.hemispheres[track=dominant].match', slowMissing);
  else if (slow.dominant === null) symRead = nullRead('slow.hemispheres[track=dominant].match', calmWhy === 'ok' ? 'no_dominant' : calmWhy);
  else {
    const h = slow.hemispheres.find((x) => x.track === slow.dominant);
    symRead = h
      ? fromMeasured(`slow.hemispheres[track=${slow.dominant}].match`, h.match, 'not_available')
      : nullRead(`slow.hemispheres[track=${slow.dominant}].match`, 'not_available');
  }
  // Rest value 1 = no mismatch drawn. Null draws the halves aligned and the readout says "not measured".
  const symmetry = bind(ctx, 'symmetry', 'Left and right match (frequency and balance; locking is inflated by the shared reference)', '0..1', symRead, 1);

  // --- Heart: pulse and swell -------------------------------------------------------------
  const lb = frames.lastBeat;
  const pb = frames.prevBeat;
  const pulseS = motion === 'reduced' ? VIZ_REDUCED_MOTION.PULSE_S : VIZ_SMOOTHING.PULSE_S;
  // The larger of the newest and the previous pulse, so a new beat never cuts a fading one short.
  const env = Math.max(
    lb ? pulseEnvelope(now - lb.receivedAt, pulseS) : 0,
    pb ? pulseEnvelope(now - pb.receivedAt, pulseS) : 0,
  );
  const pulse: Bound = {
    key: 'pulse',
    label: 'Pulse through the eye wall (detected heartbeat)',
    value: env,
    target: env,
    field: lb ? `heart.beats[t=${lb.beat.t.toFixed(3)}]` : 'heart.beats[]',
    measured: lb ? lb.beat.ibi_ms : null,
    se: null,
    unit: 'ms since previous beat',
    why: lb ? 'ok' : frames.heart === null ? 'no_data' : 'no_beat',
  };

  const breathRead = heart
    ? fromMeasured('heart.breath_phase', heart.breath_phase, 'not_available')
    : nullRead('heart.breath_phase', heartMissing);
  let swell: Bound;
  if (breathRead.measured !== null) {
    const a = rampAngle(ctx, 'swell', breathRead.measured);
    swell = {
      key: 'swell', label: 'Slow swell (measured breathing rhythm)', value: a.value, target: breathRead.measured,
      field: breathRead.field, measured: breathRead.measured, se: breathRead.se, unit: 'rad', why: 'ok',
    };
  } else {
    // Freeze the phase where it was while the amplitude fades out; report null.
    const old = ctx.prev['swell'];
    if (old) {
      const cur = rampValue(old, now, ctx.T);
      ctx.next['swell'] = { from: cur, to: cur, t0: -Infinity };
    }
    swell = {
      key: 'swell', label: 'Slow swell (measured breathing rhythm)',
      value: null, target: null, field: breathRead.field, measured: null, se: null, unit: 'rad', why: breathRead.why,
    };
  }
  const swellAmount = ramp(ctx, 'swellAmount', breathRead.measured !== null ? 1 : 0, 0).value;
  const swellPhase = swell.value ?? (ctx.next['swell'] ? wrapAngle(ctx.next['swell'].to) : 0);

  const message = mode === 'calm' ? calmMessage(calmWhy) : null;

  return {
    now,
    options,
    mode,
    message,
    messageWhy: mode === 'calm' ? calmWhy : null,
    rotation,
    rotationPhase,
    motionRate,
    armCount,
    arms,
    armTracks,
    winding,
    ring,
    bandCount,
    bands,
    bandTracks,
    eye,
    combined,
    combinedStrength,
    combinedHeld,
    symmetry,
    pulse,
    swell,
    swellAmount,
    swellPhase,
    slow,
    heart,
    ramps: ctx.next,
  };
}

export function calmMessage(why: VizReason): string {
  if (why === 'no_data' || why === 'stale') return 'No data';
  return `Calm water: ${reasonText(why)}`;
}

// ---------------------------------------------------------------------------
// Shader uniforms
// ---------------------------------------------------------------------------

export interface HurricaneUniforms {
  /** Rotation phase, radians. */
  rotation: number;
  /** Arm count, fractional while ramping. */
  armCount: number;
  /** Per arm slot, 0..1. */
  armBrightness: number[];
  /** Log-spiral winding coefficient b = cot(pitch). */
  winding: number;
  bandCount: number;
  bandBrightness: number[];
  /** Octave ring strength 0..1. */
  ring: number;
  /** Eye clarity 0..1. */
  eye: number;
  /** Left/right angular offset, radians. */
  symmetry: number;
  /** Heartbeat pulse 0..1. */
  pulse: number;
  /** Scale of the whole picture (breath swell), around 1. */
  swell: number;
  /** Combined state strength 0..1: arms and rings interlock (beads, shared eye wall). */
  both: number;
  /** Clarity of the shared eye wall in the combined state 0..1. */
  bothEye: number;
  /** Rotation rate, rev/s (ramped). Softens fine rotating texture so nothing flickers above 3 Hz. */
  rotRate: number;
}

const v0 = (b: Bound, rest: number): number => (b.value === null ? rest : b.value);

/** The display mappings from bound field values to shader uniforms (all in geometry.ts). */
export function toUniforms(s: VisualState): HurricaneUniforms {
  const reduced = s.options.motion === 'reduced';
  return {
    rotation: s.rotationPhase,
    armCount: clamp(v0(s.armCount, 0), 0, VIZ_GEOMETRY.MAX_ARMS),
    armBrightness: s.arms.map((a) => brightnessFromDb(v0(a, 0))),
    winding: windingFromExcess(v0(s.winding, 0)),
    bandCount: clamp(v0(s.bandCount, 0), 0, VIZ_GEOMETRY.MAX_BANDS),
    bandBrightness: s.bands.map((b) => brightnessFromDb(v0(b, 0))),
    ring: clamp(v0(s.ring, 0), 0, 1),
    eye: eyeClarityFromHeld(v0(s.eye, 0)),
    symmetry: symmetryOffsetFromMatch(v0(s.symmetry, 1)),
    pulse: (s.pulse.value ?? 0) * (reduced ? VIZ_REDUCED_MOTION.PULSE_GAIN_SCALE : 1),
    swell: 1 + VIZ_MAPPING.SWELL_AMPLITUDE * (reduced ? VIZ_REDUCED_MOTION.SWELL_SCALE : 1) * s.swellAmount * Math.cos(s.swellPhase),
    both: clamp(v0(s.combined, 0), 0, 1) * clamp(v0(s.combinedStrength, 0), 0, 1),
    bothEye: clamp(v0(s.combined, 0), 0, 1) * bothClarityFromHeld(v0(s.combinedHeld, 0)),
    rotRate: s.motionRate,
  };
}
