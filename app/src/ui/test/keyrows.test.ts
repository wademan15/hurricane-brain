import { describe, expect, it } from 'vitest';
import { heartFrame, slowFrame } from '../../training/test-fixtures';
import { buildCells, KEY_COLUMN_IDS, KeyRowSampler } from '../session/keyrows';

describe('per-second key measures', () => {
  it('takes values from frames and keeps nulls as null with their reason', () => {
    const s = new KeyRowSampler();
    s.start(0);
    for (let t = 0.25; t <= 3.01; t += 0.25) s.push(slowFrame(t, { bands: { alpha: 4 }, alphaTrack: { freq: 10, height: 6 } }));
    expect(s.rows.map((r) => r.t)).toEqual([0, 1, 2, 3]);
    expect(s.rows[1].cells.alpha_db.v).toBeCloseTo(4);
    expect(s.rows[1].cells.dominant_hz.v).toBeCloseTo(10);
    // no heart source: null with a reason, not zero
    expect(s.rows[1].cells.hr_bpm).toEqual({ v: null, why: 'no_data' });
    // no runner: null with a reason
    expect(s.rows[1].cells.reward).toEqual({ v: null, why: 'no_runner' });
  });

  it('a gap in the stream gives null rows, not the frame that ended the gap', () => {
    const s = new KeyRowSampler();
    s.start(0);
    s.push(slowFrame(0.5, { bands: { alpha: 4 } }));
    s.push(slowFrame(6.0, { bands: { alpha: 4 } }));
    const byT = Object.fromEntries(s.rows.map((r) => [r.t, r.cells.alpha_db.v]));
    expect(byT[1]).toBeCloseTo(4); // 0.5 s old: fresh
    expect(byT[3]).toBeNull(); // 2.5 s old: stale
    expect(byT[5]).toBeNull();
  });

  it('a null band stays null with the engine reason', () => {
    const s = new KeyRowSampler();
    s.start(0);
    s.push(slowFrame(0.5, { bands: { alpha: null } }));
    s.push(slowFrame(1.5, { bands: { alpha: null } }));
    expect(s.rows[1].cells.alpha_db.v).toBeNull();
    expect(s.rows[1].cells.alpha_db.why).toBe('insufficient_clean');
  });

  it('heart values come only from heart frames', () => {
    const s = new KeyRowSampler();
    s.start(0);
    s.push(heartFrame(0.5, { hr: 64, rmssd: null }));
    s.push(heartFrame(1.5, { hr: 64, rmssd: null }));
    expect(s.rows[1].cells.hr_bpm.v).toBe(64);
    expect(s.rows[1].cells.rmssd_ms.v).toBeNull();
  });

  it('records the fixed-edge band columns beside the individual-alpha ones, and says when they are not available', () => {
    const f = slowFrame(0.5, { bands: { alpha: 4, theta: 2, beta: 1 } });
    const none = buildCells(f, null, null);
    expect(none.alpha_fixed_db).toEqual({ v: null, why: 'not_available' });
    for (const sp of f.spectra) sp.bands_fixed = { ...sp.bands, alpha: { ...sp.bands.alpha, above_bg_db: { v: 3.5, se: null, why: 'ok' } } };
    const c = buildCells(f, null, null);
    expect(c.alpha_db.v).toBe(4);
    expect(c.alpha_fixed_db).toEqual({ v: 3.5, why: 'ok' });
    expect(c.theta_fixed_db.v).toBe(2);
    expect(KEY_COLUMN_IDS).toEqual(expect.arrayContaining(['alpha_fixed_db', 'theta_fixed_db', 'beta_fixed_db']));
  });
});
