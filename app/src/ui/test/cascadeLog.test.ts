import { describe, expect, it } from 'vitest';
import type { SlowFrame } from '../../engine/frames';
import { slowFrame } from '../../training/test-fixtures';
import { alphaThetaRatio, KeyRowSampler } from '../session/keyrows';
import { CascadeLogger } from '../session/cascadeLog';

const M = (v: number | null, why: 'ok' | 'unresolved' = 'ok') => ({ v, se: null, why });

/** A slow frame with chosen states and cascade members. */
function frame(t: number, on: { phi?: boolean; octave?: boolean }, over: { phiSteps?: number } = {}): SlowFrame {
  const f = slowFrame(t, { alphaTrack: { freq: 12.04, height: 8 }, thetaTrack: { freq: 7.44, height: 6 }, phiExcess: 0.4 });
  const phi = !!on.phi;
  const oct = !!on.octave;
  f.states = {
    phi: { ...f.states.phi, active: phi, for_s: 1 },
    octave: { ...f.states.octave, active: oct, for_s: 1 },
    both: { active: phi && oct, for_s: 1 },
  };
  f.cascades.phi = { ...f.cascades.phi, tracks: phi ? [2, 1] : [], steps: over.phiSteps ?? (phi ? 1 : 0), held_s: 5 };
  f.cascades.octave = { ...f.cascades.octave, tracks: oct ? [2, 1] : [], steps: oct ? 1 : 0, held_s: 3 };
  return f;
}

describe('cascade event log', () => {
  it('logs nothing when no state was ever active', () => {
    const log = new CascadeLogger();
    for (let t = 0.25; t < 5; t += 0.25) log.push(frame(t, {}));
    expect(log.finish()).toEqual([]);
  });

  it('logs a golden ratio event with start, duration, members, measured ratio and chance', () => {
    const log = new CascadeLogger();
    for (let t = 0.25; t <= 2; t += 0.25) log.push(frame(t, {}));
    for (let t = 2.25; t <= 6; t += 0.25) log.push(frame(t, { phi: true }));
    for (let t = 6.25; t <= 8; t += 0.25) log.push(frame(t, {}));
    const ev = log.finish();
    expect(ev).toHaveLength(1);
    const e = ev[0];
    expect(e.kind).toBe('phi');
    expect(e.tStart).toBeCloseTo(2.25);
    expect(e.tEnd).toBeCloseTo(6);
    expect(e.durationS).toBeCloseTo(3.75);
    const p = e.parts[0];
    expect(p.target).toBe('phi');
    expect(p.members.map((m) => [m.band, m.freqHz.v])).toEqual([['theta', 7.44], ['alpha', 12.04]]);
    expect(p.ratios[0].v).toBeCloseTo(12.04 / 7.44, 6);
    expect(p.chanceA.why).toBeDefined();
    expect(p.closeness.v).not.toBeUndefined();
  });

  it('logs both at once as its own event with both cascades, beside the single ones', () => {
    const log = new CascadeLogger();
    for (let t = 0.25; t <= 3; t += 0.25) log.push(frame(t, { phi: true }));
    for (let t = 3.25; t <= 6; t += 0.25) log.push(frame(t, { phi: true, octave: true }));
    for (let t = 6.25; t <= 7; t += 0.25) log.push(frame(t, { octave: true }));
    const ev = log.finish();
    expect(ev.map((e) => e.kind).sort()).toEqual(['both', 'octave', 'phi']);
    const both = ev.find((e) => e.kind === 'both');
    expect(both?.parts.map((p) => p.target)).toEqual(['phi', 'octave']);
    expect(both?.tStart).toBeCloseTo(3.25);
    expect(both?.tEnd).toBeCloseTo(6);
  });

  it('a gap in the frames ends the event at the last frame that showed it, and an open event is closed at the end', () => {
    const log = new CascadeLogger();
    for (let t = 0.25; t <= 2; t += 0.25) log.push(frame(t, { phi: true }));
    log.push(frame(9, { phi: true })); // 7 s of nothing
    for (let t = 9.25; t <= 10; t += 0.25) log.push(frame(t, { phi: true }));
    const ev = log.finish();
    expect(ev).toHaveLength(2);
    expect(ev[0].tEnd).toBeCloseTo(2);
    expect(ev[1].tStart).toBeCloseTo(9);
  });

  it('a member frequency that was not measured is stored as null with its reason, never as a number', () => {
    const log = new CascadeLogger();
    const f = frame(1, { phi: true });
    f.tracks[0].freq_integrated = M(null, 'unresolved');
    log.push(f);
    const e = log.finish()[0];
    const nulls = e.parts[0].members.filter((m) => m.freqHz.v === null);
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls[0].freqHz.why).toBe('unresolved');
    expect(e.parts[0].ratios[0].v).toBeNull();
  });
});

describe('alpha:theta ratio columns', () => {
  it('are the engine pair score for the strongest alpha and theta peaks, with distances from 2:1, 3:1 and the golden ratio', () => {
    const f = slowFrame(1, { alphaTrack: { freq: 12, height: 8 }, thetaTrack: { freq: 6, height: 6 } });
    const tgt = (miss: number | null) => ({ miss: M(miss), closeness: M(0.5), log_evidence: M(0), aligned: false });
    f.pairs = [{ lo: 2, hi: 1, log_ratio: M(Math.log(2)), harmonic: false, targets: { phi: tgt(0.21), octave: tgt(0), ratio_3: tgt(-0.4), control_1_5: tgt(0.3), control_1_8: tgt(0.1) } }];
    const c = alphaThetaRatio(f);
    expect(c.at_ratio.v).toBeCloseTo(2);
    expect(c.at_miss_2.v).toBe(0);
    expect(c.at_miss_3.v).toBe(-0.4);
    expect(c.at_miss_phi.v).toBe(0.21);
  });

  it('are null with a reason when a peak is missing or the pair is not scored', () => {
    const none = alphaThetaRatio(slowFrame(1, { alphaTrack: { freq: 10, height: 8 } }));
    for (const k of ['at_ratio', 'at_miss_2', 'at_miss_3', 'at_miss_phi']) {
      expect(none[k].v).toBeNull();
      expect(none[k].why).toBe('not_confirmed');
    }
    expect(alphaThetaRatio(null).at_ratio).toEqual({ v: null, why: 'no_data' });
  });

  it('reach the per-second rows with the state columns', () => {
    const s = new KeyRowSampler();
    s.start(0);
    for (let t = 0.25; t <= 2.01; t += 0.25) s.push(frame(t, { phi: true }));
    const row = s.rows[1];
    expect(row.cells.phi_active.v).toBe(1);
    expect(row.cells.oct_active.v).toBe(0);
    expect(row.cells.both_active.v).toBe(0);
    expect(row.cells.phi_for_s.v).toBe(1);
    expect(row.cells.at_ratio.why).toBeDefined();
  });
});
