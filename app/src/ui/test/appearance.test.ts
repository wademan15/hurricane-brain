import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, DEFAULT_APP_SETTINGS, migrateSettings, resolveAppearance } from '../../storage';
import { CHANCE_WORDS, CLOSENESS_WORDS, EXCESS_WORDS, alignmentWords } from '../words';
import { THEMES, layoutOf } from '../themes';
import type { Cascade } from '../../engine/frames';

const m = (v: number | null) => ({ v, why: v === null ? 'no_data' : 'ok' });
const cascade = (close: number | null, excess: number | null): Cascade =>
  ({ closeness: m(close), excess_a: m(excess), excess_b: m(excess) }) as unknown as Cascade;

describe('appearance defaults and migration', () => {
  it('has the four themes, each with a layout, and the documented defaults', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['still-water', 'dawn-journal', 'calm-instrument', 'night-garden']);
    expect(THEMES.map((t) => layoutOf(t.id))).toEqual(['centred', 'window', 'grid', 'tile']);
    expect(DEFAULT_APPEARANCE).toMatchObject({ theme: 'still-water', mode: 'system', session: 'dark', dim: '30', readouts: 'standard', showNumbers: true, textSize: 'device', highContrast: false, reduceColour: false, kidView: 'auto', lock: false });
  });
  it('a child profile defaults to Night Garden, and own choices win', () => {
    expect(resolveAppearance('child', {}, undefined).theme).toBe('night-garden');
    expect(resolveAppearance('adult', {}, undefined).theme).toBe('still-water');
    expect(resolveAppearance('child', {}, { theme: 'calm-instrument' }).theme).toBe('calm-instrument');
  });
  it('moves the round-3 global look settings into the base, and is idempotent', () => {
    const old = { ...DEFAULT_APP_SETTINGS, theme: 'light', textSize: 'large', childView: 'on', showFieldNames: true } as never;
    const once = migrateSettings(old) as typeof DEFAULT_APP_SETTINGS;
    expect(once.appearanceBase).toEqual({ mode: 'light', textSize: 'larger', kidView: 'on', technicalNames: true });
    expect('theme' in once).toBe(false);
    expect(migrateSettings(once)).toEqual(once);
  });
});

describe('words for the numbers', () => {
  it('thresholds are ordered highest first', () => {
    for (const t of [EXCESS_WORDS, CLOSENESS_WORDS, CHANCE_WORDS]) expect(t.map((x) => x.min)).toEqual([...t.map((x) => x.min)].sort((a, b) => b - a));
  });
  it('turns measured values into words that keep the chance comparison', () => {
    expect(alignmentWords(cascade(0.8, 0.6), 'a')).toBe('high, well above chance');
    expect(alignmentWords(cascade(0.2, 0), 'a')).toBe('low, not above chance');
  });
  it('a null is not measured with its reason, never a word for a value', () => {
    expect(alignmentWords(cascade(null, null), 'a')).toMatch(/^not measured \(/);
    expect(alignmentWords(null, 'a')).toMatch(/^not measured/);
  });
});
