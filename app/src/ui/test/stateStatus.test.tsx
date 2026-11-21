import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { slowFrame } from '../../training/test-fixtures';
import type { AlignedState, SlowFrame } from '../../engine/frames';
import { alignedStatus, bothStatus, plainSentence } from '../stateStatus';
import { StateStrip } from '../components/Cascades';
import type { Live } from '../components/LiveReadout';

const m = (v: number | null) => ({ v, why: v === null ? 'no_data' : 'ok' }) as AlignedState['stat'];
const st = (active: boolean, stat: number | null, exit: number | null = 0.3): AlignedState => ({ target: 'phi', active, for_s: 5, stat: m(stat), enter_at: 0.5, exit_at: exit });

describe('state status during the engine exit dwell', () => {
  it('holding only while active and the statistic is at or above the exit level', () => {
    expect(alignedStatus(st(true, 0.6))).toBe('holding');
    expect(alignedStatus(st(true, 0.3))).toBe('holding');
    expect(alignedStatus(st(true, 0.29))).toBe('fading');
    expect(alignedStatus(st(true, null))).toBe('fading');
    expect(alignedStatus(st(false, 0.1))).toBe('not');
    expect(alignedStatus(st(true, 0.1, null))).toBe('holding'); // no exit level in force: nothing to compare with
  });
  it('the combined state is holding only while both parts are', () => {
    const f = slowFrame(10, { bands: { alpha: 3, theta: 1, beta: 0 }, alphaTrack: { freq: 10, height: 8 }, phiExcess: 0.2, octaveExcess: 0.1, phiSteps: 1 });
    const mk = (phi: AlignedState, oct: AlignedState, both: boolean): SlowFrame['states'] => ({ phi, octave: { ...oct, target: 'octave' }, both: { active: both, for_s: 4 } }) as SlowFrame['states'];
    expect(bothStatus(mk(st(true, 0.6), st(true, 0.6), true))).toBe('holding');
    expect(bothStatus(mk(st(true, 0.6), st(true, 0.1), true))).toBe('fading');
    expect(bothStatus(mk(st(true, 0.6), st(true, 0.6), false))).toBe('not');
    expect(f.states).toBeTruthy();
  });
  it('the badge says Fading, with no running timer, and Holding with its timer otherwise', () => {
    const base = slowFrame(10, { bands: { alpha: 3, theta: 1, beta: 0 }, alphaTrack: { freq: 10, height: 8 }, phiExcess: 0.2, octaveExcess: 0.1, phiSteps: 1 });
    const live = (phiStat: number | null): Live => ({
      slow: { ...base, states: { phi: st(true, phiStat), octave: { ...st(false, 0), target: 'octave' }, both: { active: false, for_s: 0 } } } as SlowFrame,
      heart: null, slowStale: false, heartStale: false,
    });
    const fading = renderToStaticMarkup(<StateStrip live={live(0.1)} />);
    expect(fading).toContain('Fading');
    expect(fading).not.toMatch(/Holding/);
    expect(fading).toContain('state-badge phi fade');
    const nullStat = renderToStaticMarkup(<StateStrip live={live(null)} />);
    expect(nullStat).toContain('Fading');
    const holding = renderToStaticMarkup(<StateStrip live={live(0.7)} />);
    expect(holding).toMatch(/Holding 0:0\d/);
  });
  it('the kid screen says fading in plain words, never holding, while the measure has dropped', () => {
    const base = slowFrame(10, { bands: { alpha: 3, theta: 1, beta: 0 }, alphaTrack: { freq: 10, height: 8 }, phiExcess: 0.2, octaveExcess: 0.1, phiSteps: 1 });
    const mk = (stat: number | null): Live => ({
      slow: { ...base, states: { phi: st(true, stat), octave: { ...st(false, 0), target: 'octave' }, both: { active: false, for_s: 0 } } } as SlowFrame,
      heart: null, slowStale: false, heartStale: false,
    });
    expect(plainSentence(mk(0.1), 'good').word).toBe('Golden ratio: fading');
    expect(plainSentence(mk(0.1), 'good').line).toMatch(/easing off/);
    expect(plainSentence(mk(0.7), 'good').word).toBe('Golden ratio: holding');
  });
});
