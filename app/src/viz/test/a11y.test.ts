/**
 * Accessibility text: the one-sentence description, the keyboard parts, readout wording, and the
 * engine's revised meaning of excess (0 unless fewer than 5 in 100 chance draws do as well;
 * excess_b null with a reason until chance B is available).
 */
import { describe, expect, it } from 'vitest';
import type { Frame } from '../../engine/frames.ts';
import { computeVisualState, toUniforms, type VisualState, type VizOptions } from '../bindings.ts';
import { applyFrame, EMPTY_SNAPSHOT, type FrameSnapshot } from '../frameStore.ts';
import { describeState, fmtBound, fmtMeasured, listParts, readoutFor, chanceLines } from '../readout.ts';
import { VIZ_SMOOTHING } from '../params.ts';
import {
  allNullSlow,
  bandsOnly,
  cascade,
  combinedFrame,
  m,
  octaveCascadeFrame,
  phiCascadeFrame,
} from './fixtures.ts';

function settle(make: (t: number) => Frame, until = 2, opts?: VizOptions): VisualState {
  let snap: FrameSnapshot = EMPTY_SNAPSHOT;
  let s: VisualState | null = null;
  for (let i = 0; i / 60 <= until; i++) {
    const now = i / 60;
    if (i % 15 === 0) snap = applyFrame(snap, make(now), now, VIZ_SMOOTHING.PULSE_MIN_INTERVAL_S);
    s = computeVisualState(s, snap, now, opts);
  }
  return s!;
}

describe('one-sentence description of the measured state', () => {
  it('names each state in words', () => {
    expect(describeState(settle((t) => allNullSlow(t)))).toBe('Hurricane: Calm water: poor sensor contact.');
    expect(describeState(settle((t) => phiCascadeFrame(t)))).toBe(
      'Hurricane: golden ratio chain of 4 peaks, holding; octave: none.');
    expect(describeState(settle((t) => octaveCascadeFrame(t)))).toBe(
      'Hurricane: golden ratio: none; octave chain of 3 peaks, holding; 3 rhythms outside the golden ratio chain.');
    expect(describeState(settle((t) => combinedFrame(t)))).toBe(
      'Hurricane: golden ratio chain of 4 peaks, holding; octave chain of 3 peaks, holding; both at once; 2 rhythms outside the golden ratio chain.');
    expect(describeState(settle((t) => bandsOnly(t)))).toBe(
      'Hurricane: golden ratio: none; octave: none; 3 rhythms outside the golden ratio chain.');
  });

  it('does not change when only numbers change (held time, rotation, heights)', () => {
    const a = describeState(settle((t) => phiCascadeFrame(t, 3, 10)));
    const b = describeState(settle((t) => {
      const f = phiCascadeFrame(t, 2, 55);
      f.tracks[0].height_db = m(9);
      return f;
    }));
    expect(b).toBe(a);
  });
});

describe('keyboard parts: every part reachable, named with its measurement', () => {
  it('golden ratio storm: eye, eye wall, each arm, whole storm', () => {
    const ps = listParts(settle((t) => phiCascadeFrame(t)));
    expect(ps.map((p) => p.key)).toEqual(['eye', 'eyewall', 'arm:0', 'arm:1', 'arm:2', 'arm:3', 'storm']);
    expect(ps.find((p) => p.key === 'eye')!.name).toBe('Eye: golden ratio cascade held 40 s');
    expect(ps.find((p) => p.key === 'arm:2')!.name).toBe('Spiral arm 3, track 3: 11.00 ± 0.40 dB above background');
    expect(ps.find((p) => p.key === 'storm')!.name).toMatch(/rotation 9\.950 ± 0\.050 Hz/);
  });

  it('combined state adds the shared eye wall and the crossings; octave adds rings; bands are listed', () => {
    const keys = listParts(settle((t) => combinedFrame(t))).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['combined-wall', 'bead', 'ring', 'band:0', 'band:1']));
    expect(keys).not.toContain('eyewall');
    const names = listParts(settle((t) => combinedFrame(t))).map((p) => p.name);
    expect(names).toContain('Shared eye wall, both at once: for 30 s');
  });

  it('calm water is one part with the reason', () => {
    expect(listParts(settle((t) => allNullSlow(t)))).toEqual([
      { key: 'calm', name: 'Calm water: Calm water: poor sensor contact' },
    ]);
  });

  it('every listed part opens a readout for that part', () => {
    const s = settle((t) => combinedFrame(t));
    for (const p of listParts(s)) {
      const r = readoutFor(s, p.key);
      expect(r.key).toBe(p.key);
      expect(r.bindings.length).toBeGreaterThan(0);
    }
  });
});

describe('truthful wording', () => {
  it('left and right match says the locking part is inflated by the shared reference', () => {
    const s = settle((t) => phiCascadeFrame(t));
    expect(s.symmetry.label).toBe('Left and right match (frequency and balance; locking is inflated by the shared reference)');
    expect(readoutFor(s, 'storm').summary).toMatch(/one reference electrode \(the shared reference\)/);
    expect(readoutFor(s, 'storm').summary).toMatch(/not a measure of synchrony/);
  });

  it('new excess meaning: an octave chain as common as 30 in 100 has excess 0, so no ring is drawn', () => {
    const make = (t: number) => {
      const f = phiCascadeFrame(t);
      f.cascades.octave = cascade('octave', [1, 3], 0, 10);
      f.cascades.octave.closeness = m(0.97, 0.01);
      f.cascades.octave.chance.a.p = m(0.3, 0.03);
      return f;
    };
    const s = settle(make);
    expect(toUniforms(s).ring).toBe(0);
    expect(fmtBound(s.ring)).toBe('0.000 ± 0.040 beyond chance (0 unless fewer than 5 in 100 chance draws do as well, 1 = exact; not a probability)');
    const oct = chanceLines(s).find((l) => l.startsWith('Octave'))!;
    expect(oct).toMatch(/^Octave: as often as this by chance: 30 in 100/);
  });

  it('excess_b null with a reason: readout says so, and with chance B driving, no structure forms', () => {
    const make = (t: number) => {
      const f = combinedFrame(t);
      f.cascades.phi.excess_b = { v: null, why: 'warming_up' };
      f.cascades.octave.excess_b = { v: null, why: 'warming_up' };
      return f;
    };
    const a = settle(make);
    const r = readoutFor(a, 'eye');
    expect(fmtMeasured(r.alignment![0].excessB)).toBe('not measured (warming up: not enough data yet)');
    const b = settle(make, 2, { chance: 'b', motion: 'full' });
    expect(toUniforms(b).armCount).toBe(0);
    expect(toUniforms(b).ring).toBe(0);
    expect(toUniforms(b).both).toBe(0);
    expect(b.combinedStrength.why).toBe('warming_up');
  });
});
