/**
 * Typed field paths over the measurement frames (app/src/engine/frames.ts).
 *
 * A training target, a block statistic or a signature names a field by a path string,
 * for example:
 *
 *   spectra[temporal].bands.alpha.above_bg_db     band power above background at a site
 *   spectra[AF8].bg_exponent                      aperiodic exponent at a channel
 *   quality[*].emg_db                             mean muscle level over usable channels
 *   quality[frontal].emg_db                       mean over usable AF7/AF8
 *   track[alpha].height_db                        strongest confirmed alpha track
 *   track[dominant].freq_integrated               the dominant track
 *   cascades.phi.steps | cascades.octave.excess_a | cascades.phi.chance.a.p
 *   states.phi.active | states.octave.stat
 *   hemispheres[alpha].match | front_back[theta].balance
 *   iaf_hz
 *   fast.track[alpha].height_db | fast.track[alpha].freq | fast.artifact
 *   heart.rmssd_ms | heart.resonance_strength | heart.high_hrv.active
 *   diff(spectra[temporal].bands.theta.above_bg_db, spectra[temporal].bands.alpha.above_bg_db)
 *
 * `diff(A, B)` is A minus B with standard errors combined in quadrature. It is the only
 * combination offered; it never fills a missing value (null if either side is null).
 *
 * The resolver returns `Measured`. Null stays null, with the engine's reason. A value whose
 * frame is older than its freshness limit (params.ts) is null with reason 'no_data': the
 * training layer never holds a value past its stated hold time (spec rule 2.1).
 */

import type { BandName, FastFrame, HeartFrame, Measured, Reason, SiteComparison, SlowFrame, Track } from '../engine/frames';
import { TRAINING_PARAMS } from './params';

export type FrameKind = 'slow' | 'fast' | 'heart';

/** The latest frame of each kind, and the time at which the field is read. */
export interface FrameContext {
  now: number;
  slow: SlowFrame | null;
  fast: FastFrame | null;
  heart: HeartFrame | null;
}

export interface FieldRef {
  /** The canonical path string. */
  path: string;
  /** Frame kinds the field reads. A sample of the field is taken when one of these arrives. */
  kinds: FrameKind[];
  /** The kind whose arrival defines a new sample (the fastest kind it reads). */
  clock: FrameKind;
  /** Display unit. */
  unit: string;
  /** True for 0/1 fields (states, flags). */
  boolean: boolean;
  resolve(ctx: FrameContext): Measured;
}

export class FieldPathError extends Error {}

const BANDS: readonly BandName[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const CHANNEL_GROUPS: Record<string, string[]> = {
  frontal: ['AF7', 'AF8'],
  temporal: ['TP9', 'TP10'],
};

const nul = (why: Reason): Measured => ({ v: null, se: null, why });
const ok = (v: number, se: number | null = null): Measured => ({ v, se, why: 'ok' });
const fromNumber = (v: number | null): Measured => (v === null || !Number.isFinite(v) ? nul('not_available') : ok(v));
const fromBool = (b: boolean): Measured => ok(b ? 1 : 0);
const copy = (m: Measured): Measured => ({ v: m.v, se: m.se ?? null, why: m.v === null ? (m.why === 'ok' ? 'not_available' : m.why) : 'ok' });

function freshSlow(ctx: FrameContext): SlowFrame | Measured {
  if (!ctx.slow) return nul('no_data');
  if (ctx.now - ctx.slow.t > TRAINING_PARAMS.staleSlowS) return nul('no_data');
  return ctx.slow;
}
function freshFast(ctx: FrameContext): FastFrame | Measured {
  if (!ctx.fast) return nul('no_data');
  if (ctx.now - ctx.fast.t > TRAINING_PARAMS.staleFastS) return nul('no_data');
  return ctx.fast;
}
function freshHeart(ctx: FrameContext): HeartFrame | Measured {
  if (!ctx.heart) return nul('no_data');
  if (ctx.now - ctx.heart.t > TRAINING_PARAMS.staleHeartS) return nul('no_data');
  return ctx.heart;
}
const isMeasured = (x: unknown): x is Measured => typeof x === 'object' && x !== null && 'why' in x && 'v' in x && !('kind' in x);

/** Strongest confirmed or fading, non-harmonic track with this band label, or the dominant track. */
export function selectTrack(slow: SlowFrame, sel: string): Track | null {
  if (sel === 'dominant') return slow.dominant === null ? null : slow.tracks.find((t) => t.id === slow.dominant) ?? null;
  if (/^\d+$/.test(sel)) return slow.tracks.find((t) => t.id === Number(sel)) ?? null;
  let best: Track | null = null;
  for (const t of slow.tracks) {
    if (t.band !== sel || t.state === 'new' || t.harmonic_of !== null) continue;
    const h = t.height_db.v;
    if (h === null) continue;
    if (!best || h > (best.height_db.v as number)) best = t;
  }
  return best;
}

function parseSelector(raw: string, allowed: readonly string[] | null, what: string): string {
  const s = raw.trim();
  if (allowed && !allowed.includes(s) && !/^\d+$/.test(s)) throw new FieldPathError(`unknown ${what} '${s}'`);
  return s;
}

const TRACK_FIELDS = ['freq', 'freq_integrated', 'height_db', 'width_hz', 'age_s'] as const;
const FAST_TRACK_FIELDS = ['freq', 'amp_uv', 'height_db'] as const;
const COMPARISON_FIELDS = ['freq_diff', 'balance', 'locking_excess', 'match'] as const;
const HEART_MEASURED = ['hr_bpm', 'rmssd_ms', 'sdnn_ms', 'lf_power', 'hf_power', 'resonance_hz', 'resonance_strength', 'breath_bpm', 'pacer_adherence'] as const;
const QUALITY_FIELDS = ['emg_db', 'sd_uv', 'mains_uv', 'railed', 'clean_fraction'] as const;

const UNITS: Record<string, string> = {
  above_bg_db: 'dB', power: 'µV²', bg_exponent: '', bg_offset: '', emg_db: 'dB', sd_uv: 'µV', mains_uv: 'µV', railed: '', clean_fraction: '',
  freq: 'Hz', freq_integrated: 'Hz', height_db: 'dB', width_hz: 'Hz', age_s: 's', amp_uv: 'µV', steps: 'steps', held_s: 's', closeness: '',
  excess_a: '', excess_b: '', p: '', p_steps: '', active: '', for_s: 's', stat: '', freq_diff: 'Hz', balance: '', locking_excess: '', match: '',
  hr_bpm: 'bpm', rmssd_ms: 'ms', sdnn_ms: 'ms', lf_power: 'ms²', hf_power: 'ms²', resonance_hz: 'Hz', resonance_strength: '', breath_bpm: '/min',
  pacer_adherence: '', corrected_fraction: '', iaf_hz: 'Hz', artifact: '',
};

function unitOf(path: string): string {
  const last = path.split('.').pop() ?? '';
  return UNITS[last] ?? '';
}

function compareSel(list: SiteComparison[], slow: SlowFrame, sel: string): SiteComparison | null {
  const track = selectTrack(slow, sel);
  if (!track) return null;
  return list.find((c) => c.track === track.id) ?? null;
}

function splitDiff(inner: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  throw new FieldPathError(`diff() needs two arguments: '${inner}'`);
}

const cache = new Map<string, FieldRef>();

/** Parse and compile a field path. Throws FieldPathError for an unknown path. */
export function compileField(path: string): FieldRef {
  const key = path.replace(/\s+/g, '');
  const hit = cache.get(key);
  if (hit) return hit;
  const ref = compileUncached(key);
  cache.set(key, ref);
  return ref;
}

/** True if the path compiles. */
export function isValidField(path: string): boolean {
  try {
    compileField(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a path against a frame context. Convenience over compileField(path).resolve(ctx). */
export function resolveField(path: string, ctx: FrameContext): Measured {
  return compileField(path).resolve(ctx);
}

function slowRef(path: string, unit: string, boolean: boolean, f: (s: SlowFrame) => Measured): FieldRef {
  return {
    path, kinds: ['slow'], clock: 'slow', unit, boolean,
    resolve(ctx) {
      const s = freshSlow(ctx);
      return isMeasured(s) ? s : f(s);
    },
  };
}

function compileUncached(path: string): FieldRef {
  let m: RegExpMatchArray | null;

  // diff(A, B)
  if ((m = path.match(/^diff\((.*)\)$/))) {
    const [a, b] = splitDiff(m[1]).map(compileField);
    const kinds = Array.from(new Set([...a.kinds, ...b.kinds]));
    const clock: FrameKind = kinds.includes('fast') ? 'fast' : kinds.includes('slow') ? 'slow' : 'heart';
    return {
      path, kinds, clock, unit: a.unit, boolean: false,
      resolve(ctx) {
        const x = a.resolve(ctx);
        const y = b.resolve(ctx);
        if (x.v === null) return nul(x.why);
        if (y.v === null) return nul(y.why);
        const se = x.se != null && y.se != null ? Math.hypot(x.se, y.se) : null;
        return ok(x.v - y.v, se);
      },
    };
  }

  // spectra[SITE].bands.BAND.(above_bg_db|power)
  if ((m = path.match(/^spectra\[([^\]]+)\]\.bands\.(\w+)\.(above_bg_db|power)$/))) {
    const site = parseSelector(m[1], null, 'site');
    const band = parseSelector(m[2], BANDS, 'band') as BandName;
    const which = m[3] as 'above_bg_db' | 'power';
    return slowRef(path, unitOf(path), false, (s) => {
      const sp = s.spectra.find((x) => x.site === site);
      if (!sp) return nul('not_available');
      if (sp.why !== 'ok') return nul(sp.why);
      return copy(sp.bands[band][which]);
    });
  }
  // spectra[SITE].(bg_exponent|bg_offset)
  if ((m = path.match(/^spectra\[([^\]]+)\]\.(bg_exponent|bg_offset)$/))) {
    const site = m[1];
    const which = m[2] as 'bg_exponent' | 'bg_offset';
    return slowRef(path, unitOf(path), false, (s) => {
      const sp = s.spectra.find((x) => x.site === site);
      if (!sp) return nul('not_available');
      if (sp.why !== 'ok') return nul(sp.why);
      return copy(sp[which]);
    });
  }
  // quality[CH|*|frontal|temporal].FIELD
  if ((m = path.match(/^quality\[([^\]]+)\]\.(\w+)$/))) {
    const sel = m[1];
    const which = parseSelector(m[2], QUALITY_FIELDS, 'quality field') as (typeof QUALITY_FIELDS)[number];
    return slowRef(path, unitOf(path), false, (s) => {
      const members = sel === '*' ? s.quality : s.quality.filter((q) => (CHANNEL_GROUPS[sel] ?? [sel]).includes(q.name));
      if (!members.length) return nul('not_available');
      const vals: number[] = [];
      let why: Reason = 'bad_contact';
      for (const q of members) {
        if (!q.usable) {
          why = q.why === 'ok' ? 'bad_contact' : q.why;
          continue;
        }
        const v = q[which];
        if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
        else why = 'not_available';
      }
      if (!vals.length) return nul(why);
      let sum = 0;
      for (const v of vals) sum += v;
      return ok(sum / vals.length);
    });
  }
  // track[SEL].FIELD
  if ((m = path.match(/^track\[([^\]]+)\]\.(\w+)$/))) {
    const sel = parseSelector(m[1], [...BANDS, 'dominant'], 'track selector');
    const which = parseSelector(m[2], TRACK_FIELDS, 'track field') as (typeof TRACK_FIELDS)[number];
    return slowRef(path, unitOf(path), false, (s) => {
      const t = selectTrack(s, sel);
      if (!t) return nul('not_confirmed');
      return which === 'age_s' ? ok(t.age_s) : copy(t[which]);
    });
  }
  if (path === 'track_count') {
    return slowRef(path, 'tracks', false, (s) => ok(s.tracks.filter((t) => t.state !== 'new').length));
  }
  if (path === 'iaf_hz') return slowRef(path, 'Hz', false, (s) => fromNumber(s.iaf_hz));
  // cascades.T.FIELD and cascades.T.chance.(a|b).FIELD
  if ((m = path.match(/^cascades\.(phi|octave)\.(steps|held_s|closeness|excess_a|excess_b)$/))) {
    const target = m[1] as 'phi' | 'octave';
    const which = m[2];
    return slowRef(path, unitOf(path), false, (s) => {
      const c = s.cascades[target];
      if (which === 'steps') return ok(c.steps);
      if (which === 'held_s') return ok(c.held_s);
      return copy(c[which as 'closeness' | 'excess_a' | 'excess_b']);
    });
  }
  if ((m = path.match(/^cascades\.(phi|octave)\.chance\.(a|b)\.(closeness|p|p_steps)$/))) {
    const target = m[1] as 'phi' | 'octave';
    const ab = m[2] as 'a' | 'b';
    const which = m[3] as 'closeness' | 'p' | 'p_steps';
    return slowRef(path, unitOf(path), false, (s) => copy(s.cascades[target].chance[ab][which]));
  }
  // states.T.FIELD
  if ((m = path.match(/^states\.(phi|octave)\.(active|for_s|stat)$/))) {
    const target = m[1] as 'phi' | 'octave';
    const which = m[2];
    return slowRef(path, unitOf(path), which === 'active', (s) => {
      const st = s.states[target];
      if (which === 'active') return fromBool(st.active);
      if (which === 'for_s') return ok(st.for_s);
      return copy(st.stat);
    });
  }
  // hemispheres[SEL].FIELD, front_back[SEL].FIELD
  if ((m = path.match(/^(hemispheres|front_back)\[([^\]]+)\]\.(\w+)$/))) {
    const list = m[1] as 'hemispheres' | 'front_back';
    const sel = parseSelector(m[2], [...BANDS, 'dominant'], 'track selector');
    const which = parseSelector(m[3], COMPARISON_FIELDS, 'comparison field') as (typeof COMPARISON_FIELDS)[number];
    return slowRef(path, unitOf(path), false, (s) => {
      const c = compareSel(s[list], s, sel);
      if (!c) return nul('not_confirmed');
      return copy(c[which]);
    });
  }
  // fast.track[SEL].FIELD
  if ((m = path.match(/^fast\.track\[([^\]]+)\]\.(\w+)$/))) {
    const sel = parseSelector(m[1], [...BANDS, 'dominant'], 'track selector');
    const which = parseSelector(m[2], FAST_TRACK_FIELDS, 'fast track field') as (typeof FAST_TRACK_FIELDS)[number];
    return {
      path, kinds: ['fast', 'slow'], clock: 'fast', unit: unitOf(path), boolean: false,
      resolve(ctx) {
        const f = freshFast(ctx);
        if (isMeasured(f)) return f;
        const s = freshSlow(ctx);
        if (isMeasured(s)) return s;
        const t = selectTrack(s, sel);
        if (!t) return nul('not_confirmed');
        const ft = f.tracks.find((x) => x.id === t.id);
        if (!ft) return nul('not_confirmed');
        if (!ft.locked) return nul('lost_lock');
        return copy(ft[which]);
      },
    };
  }
  if (path === 'fast.artifact') {
    return {
      path, kinds: ['fast'], clock: 'fast', unit: '', boolean: true,
      resolve(ctx) {
        const f = freshFast(ctx);
        return isMeasured(f) ? f : fromBool(f.artifact);
      },
    };
  }
  // heart.FIELD
  if ((m = path.match(/^heart\.high_hrv\.(active|for_s|stat)$/))) {
    const which = m[1];
    return {
      path, kinds: ['heart'], clock: 'heart', unit: unitOf(path), boolean: which === 'active',
      resolve(ctx) {
        const h = freshHeart(ctx);
        if (isMeasured(h)) return h;
        if (h.source === 'none') return nul('no_data');
        if (which === 'active') return fromBool(h.high_hrv.active);
        if (which === 'for_s') return ok(h.high_hrv.for_s);
        return copy(h.high_hrv.stat);
      },
    };
  }
  if ((m = path.match(/^heart\.(\w+)$/))) {
    const which = m[1];
    if (which !== 'corrected_fraction' && !(HEART_MEASURED as readonly string[]).includes(which)) throw new FieldPathError(`unknown heart field '${which}'`);
    return {
      path, kinds: ['heart'], clock: 'heart', unit: unitOf(path), boolean: false,
      resolve(ctx) {
        const h = freshHeart(ctx);
        if (isMeasured(h)) return h;
        if (h.source === 'none') return nul('no_data');
        if (which === 'corrected_fraction') return ok(h.corrected_fraction);
        return copy(h[which as (typeof HEART_MEASURED)[number]]);
      },
    };
  }
  throw new FieldPathError(`unknown field path '${path}'`);
}

/** Substitute `${var}` placeholders in a path with variable values. */
export function substitutePath(path: string, vars: Record<string, string | number | boolean>): string {
  return path.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new FieldPathError(`unbound variable '${name}' in '${path}'`);
    return String(vars[name]);
  });
}
