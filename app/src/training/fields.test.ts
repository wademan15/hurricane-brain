import { describe, expect, it } from 'vitest';
import { compileField, FieldPathError, isValidField, resolveField, type FrameContext } from './fields';
import { fastFrame, heartFrame, slowFrame } from './test-fixtures';

const ctx = (over: Partial<FrameContext> = {}): FrameContext => ({
  now: 10,
  slow: slowFrame(10, { bands: { alpha: 4, theta: 1 }, sites: { AF8: { alpha: 3 }, AF7: { alpha: 1 } }, emgDb: 2, alphaTrack: { freq: 10, height: 7 }, phiExcess: 0.4, phiSteps: 2, hemiMatch: 0.8 }),
  fast: fastFrame(10, { alphaHeight: 6.5 }),
  heart: heartFrame(10, { rmssd: 55 }),
  ...over,
});

describe('fields', () => {
  it('resolves the documented paths', () => {
    const c = ctx();
    expect(resolveField('spectra[temporal].bands.alpha.above_bg_db', c).v).toBe(4);
    expect(resolveField('track[alpha].height_db', c).v).toBe(7);
    expect(resolveField('track[alpha].freq_integrated', c).v).toBe(10);
    expect(resolveField('cascades.phi.steps', c).v).toBe(2);
    expect(resolveField('cascades.phi.excess_a', c).v).toBe(0.4);
    expect(resolveField('states.phi.active', c).v).toBe(0);
    expect(resolveField('heart.rmssd_ms', c).v).toBe(55);
    expect(resolveField('heart.resonance_strength', c).v).toBe(0.3);
    expect(resolveField('quality[*].emg_db', c).v).toBe(2);
    expect(resolveField('hemispheres[alpha].match', c).v).toBe(0.8);
    expect(resolveField('fast.track[alpha].height_db', c).v).toBe(6.5);
    expect(resolveField('diff(spectra[AF8].bands.alpha.above_bg_db, spectra[AF7].bands.alpha.above_bg_db)', c).v).toBe(2);
    expect(resolveField('diff(spectra[temporal].bands.theta.above_bg_db, spectra[temporal].bands.alpha.above_bg_db)', c).v).toBe(-3);
  });

  it('null stays null with a reason, and stale frames are not held', () => {
    const c = ctx({ slow: slowFrame(10, { bands: { alpha: null } }) });
    const m = resolveField('spectra[temporal].bands.alpha.above_bg_db', c);
    expect(m.v).toBeNull();
    expect(m.why).not.toBe('ok');
    expect(resolveField('track[theta].height_db', ctx()).why).toBe('not_confirmed');
    expect(resolveField('spectra[temporal].bands.alpha.above_bg_db', { ...ctx(), now: 12 }).why).toBe('no_data');
    expect(resolveField('heart.rmssd_ms', { ...ctx(), heart: null }).why).toBe('no_data');
    expect(resolveField('quality[*].emg_db', ctx({ slow: slowFrame(10, { usable: false }) })).v).toBeNull();
    expect(resolveField('fast.track[alpha].height_db', ctx({ fast: fastFrame(10, { alphaHeight: 6, locked: false }) })).why).toBe('lost_lock');
    expect(resolveField('diff(heart.rmssd_ms, spectra[temporal].bands.alpha.above_bg_db)', ctx({ heart: heartFrame(10, { rmssd: null }) })).v).toBeNull();
  });

  it('rejects unknown paths', () => {
    expect(isValidField('spectra[temporal].bands.kappa.above_bg_db')).toBe(false);
    expect(isValidField('track[alpha].nope')).toBe(false);
    expect(isValidField('heart.mood')).toBe(false);
    expect(() => compileField('nothing')).toThrow(FieldPathError);
    expect(compileField('fast.track[alpha].height_db').clock).toBe('fast');
    expect(compileField('heart.coupling[alpha.above_bg_db@temporal].correlation.p').clock).toBe('heart');
  });
});
