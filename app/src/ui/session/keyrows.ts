/**
 * Per-second key measures for the session record and the CSV. Each second takes the latest
 * frame values from the frames themselves; a value older than its freshness limit, or null,
 * is stored as null with its reason. Nothing is averaged, filled in or carried over.
 */
import type { Frame, HeartFrame, Measured, SlowFrame } from '../../engine/frames';
import { KEY_COLUMNS, type KeyCell, type KeyRow } from '../../storage/types';

const SLOW_FRESH_S = 1.5;
const HEART_FRESH_S = 3;

const cell = (m: Measured | null | undefined, missing: KeyCell['why'] = 'no_data'): KeyCell =>
  m ? { v: m.v, why: m.v === null && m.why === 'ok' ? 'no_data' : m.why } : { v: null, why: missing };

function bandAt(slow: SlowFrame | null, band: 'alpha' | 'theta' | 'beta'): KeyCell {
  const sp = slow?.spectra.find((s) => s.site === 'temporal');
  return cell(sp?.bands[band].above_bg_db);
}

/**
 * The alpha:theta ratio of the strongest confirmed alpha peak over the strongest confirmed theta
 * peak, with the engine's own distances from 2:1, 3:1 and the golden ratio (the `miss` of the
 * pair's score for each target). Which peaks to look at is a choice of the strongest; the ratio
 * and the distances are the engine's pair score, not computed here.
 */
export function alphaThetaRatio(slow: SlowFrame | null): Record<string, KeyCell> {
  const none = (why: KeyCell['why']): Record<string, KeyCell> => ({
    at_ratio: { v: null, why }, at_miss_2: { v: null, why }, at_miss_3: { v: null, why }, at_miss_phi: { v: null, why },
  });
  if (!slow) return none('no_data');
  const strongest = (band: 'alpha' | 'theta') =>
    slow.tracks
      .filter((t) => t.band === band && t.state === 'confirmed' && t.height_db.v !== null)
      .sort((a, b) => (b.height_db.v as number) - (a.height_db.v as number))[0];
  const al = strongest('alpha');
  const th = strongest('theta');
  if (!al || !th) return none('not_confirmed');
  const pair = slow.pairs.find((p) => (p.lo === th.id && p.hi === al.id) || (p.lo === al.id && p.hi === th.id));
  if (!pair) return none('no_data');
  const lr = pair.log_ratio;
  return {
    at_ratio: lr.v === null ? { v: null, why: lr.why === 'ok' ? 'no_data' : lr.why } : { v: Math.exp(lr.v), why: 'ok' },
    at_miss_2: cell(pair.targets.octave?.miss),
    at_miss_3: cell(pair.targets.ratio_3?.miss),
    at_miss_phi: cell(pair.targets.phi?.miss),
  };
}

export function buildCells(slow: SlowFrame | null, heart: HeartFrame | null, reward: number | null): Record<string, KeyCell> {
  const c: Record<string, KeyCell> = {};
  c.alpha_db = bandAt(slow, 'alpha');
  c.theta_db = bandAt(slow, 'theta');
  c.beta_db = bandAt(slow, 'beta');
  const dom = slow?.dominant != null ? slow.tracks.find((t) => t.id === slow.dominant) : undefined;
  c.dominant_hz = dom ? cell(dom.freq_integrated) : { v: null, why: slow ? 'not_confirmed' : 'no_data' };
  const phi = slow?.cascades.phi;
  const oct = slow?.cascades.octave;
  c.phi_closeness = cell(phi?.closeness);
  c.phi_chance_a = cell(phi?.chance.a.closeness);
  c.phi_excess_a = cell(phi?.excess_a);
  c.phi_excess_b = cell(phi?.excess_b);
  c.phi_steps = phi ? { v: phi.steps, why: 'ok' } : { v: null, why: 'no_data' };
  c.oct_closeness = cell(oct?.closeness);
  c.oct_chance_a = cell(oct?.chance.a.closeness);
  c.oct_excess_a = cell(oct?.excess_a);
  c.oct_excess_b = cell(oct?.excess_b);
  c.oct_steps = oct ? { v: oct.steps, why: 'ok' } : { v: null, why: 'no_data' };
  const st = slow?.states;
  const flag = (b: boolean | undefined): KeyCell => (b === undefined ? { v: null, why: 'no_data' } : { v: b ? 1 : 0, why: 'ok' });
  const secs = (x: number | undefined): KeyCell => (x === undefined ? { v: null, why: 'no_data' } : { v: x, why: 'ok' });
  c.phi_active = flag(st?.phi.active);
  c.phi_for_s = secs(st?.phi.for_s);
  c.oct_active = flag(st?.octave.active);
  c.oct_for_s = secs(st?.octave.for_s);
  c.both_active = flag(st?.both.active);
  c.both_for_s = secs(st?.both.for_s);
  Object.assign(c, alphaThetaRatio(slow));
  if (slow && slow.quality.length) {
    c.usable_channels = { v: slow.quality.filter((q) => q.usable).length, why: 'ok' };
    c.clean_fraction = { v: slow.quality.reduce((a, q) => a + q.clean_fraction, 0) / slow.quality.length, why: 'ok' };
    const emg = slow.quality.filter((q) => q.usable && q.emg_db !== null).map((q) => q.emg_db as number);
    c.emg_db = emg.length ? { v: emg.reduce((a, b) => a + b, 0) / emg.length, why: 'ok' } : { v: null, why: 'bad_contact' };
  } else {
    c.usable_channels = { v: null, why: 'no_data' };
    c.clean_fraction = { v: null, why: 'no_data' };
    c.emg_db = { v: null, why: 'no_data' };
  }
  c.hr_bpm = cell(heart?.hr_bpm);
  c.rmssd_ms = cell(heart?.rmssd_ms);
  c.sdnn_ms = cell(heart?.sdnn_ms);
  c.lf_power = cell(heart?.lf_power);
  c.hf_power = cell(heart?.hf_power);
  c.resonance_hz = cell(heart?.resonance_hz);
  c.resonance_strength = cell(heart?.resonance_strength);
  c.breath_bpm = cell(heart?.breath_bpm);
  c.pacer_adherence = cell(heart?.pacer_adherence);
  c.reward = reward === null ? { v: null, why: 'no_runner' } : { v: reward, why: 'ok' };
  return c;
}

export class KeyRowSampler {
  readonly rows: KeyRow[] = [];
  private slow: SlowFrame | null = null;
  private heart: HeartFrame | null = null;
  private nextSecond: number | null = null;
  private lastT = -Infinity;
  block: string | null = null;
  reward: number | null = null;

  /** Start sampling from this session time (whole seconds from here on). */
  start(t: number): void {
    this.nextSecond = Math.ceil(t);
  }

  push(f: Frame): void {
    if (f.kind === 'fast') return;
    if (f.t < this.lastT) return; // frames are in time order; ignore a stray earlier one
    this.lastT = f.t;
    // Rows for the seconds this frame has passed use the frames received before it, so a gap
    // in the stream shows as null rows rather than as the frame that ended the gap.
    if (this.nextSecond !== null) {
      let t: number = this.nextSecond;
      while (f.t >= t) {
        const slow = this.slow && t - this.slow.t <= SLOW_FRESH_S ? this.slow : null;
        const heart = this.heart && t - this.heart.t <= HEART_FRESH_S ? this.heart : null;
        this.rows.push({ t, block: this.block, cells: buildCells(slow, heart, this.reward) });
        t += 1;
      }
      this.nextSecond = t;
    }
    if (f.kind === 'slow') this.slow = f;
    else this.heart = f;
  }
}

export const KEY_COLUMN_IDS = KEY_COLUMNS.map((c) => c.id);
