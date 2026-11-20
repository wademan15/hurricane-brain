import { describe, expect, it } from 'vitest';
import { slowFrame } from '../../training/test-fixtures';
import type { Measured } from '../../engine/frames';
import { fmtDuration, measuredLine, NOT_MEASURED, reasonPlain, showMeasured, showNumber, summarizeSignal } from '../measured';

describe('null display', () => {
  it('a null value is "not measured" with its reason, never 0 and never a number', () => {
    const m: Measured = { v: null, se: null, why: 'bad_contact' };
    const s = showMeasured(m, 'Hz');
    expect(s.measured).toBe(false);
    expect(s.text).toBe(NOT_MEASURED);
    expect(s.reason).toBe('poor sensor contact');
    expect(measuredLine(m, 'Hz')).toBe('not measured (poor sensor contact)');
    expect(s.text).not.toMatch(/\d/);
  });

  it('zero is a real measurement and is shown as one', () => {
    const s = showMeasured({ v: 0, se: 0.1, why: 'ok' }, 'dB');
    expect(s.measured).toBe(true);
    expect(s.text).toMatch(/^0/);
  });

  it('shows a measured value with its uncertainty and unit', () => {
    expect(showMeasured({ v: 10.213, se: 0.05, why: 'ok' }, 'Hz').text).toBe('10.213 ± 0.050 Hz');
  });

  it('a missing frame is not measured and says nothing arrived', () => {
    expect(showMeasured(undefined).reason).toBe('nothing received yet');
    expect(showMeasured(null).measured).toBe(false);
  });

  it('a value flagged ok but null still shows as not measured', () => {
    const s = showMeasured({ v: null, se: null, why: 'ok' });
    expect(s.measured).toBe(false);
    expect(s.reason).toBeTruthy();
  });

  it('NaN and infinity are not shown as numbers', () => {
    expect(showMeasured({ v: Number.NaN, se: null, why: 'ok' }).measured).toBe(false);
    expect(showNumber(Number.POSITIVE_INFINITY).measured).toBe(false);
    expect(showNumber(null).text).toBe(NOT_MEASURED);
    expect(showNumber(undefined).measured).toBe(false);
  });

  it('scale converts units for display only (hertz to breaths a minute)', () => {
    expect(showMeasured({ v: 0.1, se: null, why: 'ok' }, 'breaths/min', 60).text).toBe('6 breaths/min');
  });

  it('every engine reason has plain words', () => {
    for (const why of ['warming_up', 'no_data', 'gap', 'bad_contact', 'artifact', 'insufficient_clean', 'bad_fit', 'not_confirmed', 'weak', 'lost_lock', 'unresolved', 'too_few_beats', 'too_many_corrections', 'not_available', 'stale', 'no_frame'] as const) {
      expect(reasonPlain(why).length).toBeGreaterThan(3);
    }
  });

  it('durations that are not known are not shown as 0:00', () => {
    expect(fmtDuration(null)).toMatch(/^not measured \(/);
    expect(fmtDuration(125)).toBe('2:05');
  });
});

describe('signal summary', () => {
  it('says why when channels are not usable', () => {
    const s = summarizeSignal(slowFrame(1, { usable: false }));
    expect(s.level).toBe('poor');
    expect(s.text).toMatch(/not usable/);
    expect(s.channels[0].fix).toMatch(/sensor/i);
  });
  it('good when all channels are usable', () => {
    expect(summarizeSignal(slowFrame(1)).level).toBe('good');
  });
  it('no frame is not measured', () => {
    const s = summarizeSignal(null);
    expect(s.level).toBe('none');
    expect(s.text).toMatch(/not measured/);
  });
});
