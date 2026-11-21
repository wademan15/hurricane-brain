/**
 * Words for the numbers (Settings, Appearance, "Show numbers" off). Every word is derived from a
 * measured value by the thresholds below, the only place they live. A null stays "not measured"
 * with its reason. The words say how a reading compares with chance, not what it means.
 */
import type { Cascade, Measured } from '../engine/frames';
import { showMeasured } from './measured';

/** "Beyond chance" (the engine's excess: 0 unless fewer than 5 in 100 chance draws do as well). Highest first. */
export const EXCESS_WORDS: { min: number; word: string }[] = [
  { min: 0.5, word: 'well above chance' },
  { min: 0.2, word: 'above chance' },
  { min: 0.0001, word: 'a little above chance' },
];
export const NOT_ABOVE_CHANCE = 'not above chance';

/** How strong the alignment reading is on its own (closeness 0 to 1). Highest first. */
export const CLOSENESS_WORDS: { min: number; word: string }[] = [
  { min: 0.7, word: 'high' },
  { min: 0.35, word: 'medium' },
  { min: 0, word: 'low' },
];

/** The chance level (what chance draws typically reach), 0 to 1. Highest first. */
export const CHANCE_WORDS: { min: number; word: string }[] = [
  { min: 0.5, word: 'high' },
  { min: 0.2, word: 'moderate' },
  { min: 0, word: 'low' },
];

const pick = (table: { min: number; word: string }[], v: number): string => (table.find((t) => v >= t.min) ?? table[table.length - 1]).word;

const nm = (m: Measured | null | undefined): string => {
  const s = showMeasured(m);
  return `not measured (${s.reason})`;
};

/** Alignment as a word, with how it compares with chance when the engine could say. */
export function alignmentWords(c: Cascade | null, driver: 'a' | 'b'): string {
  if (!c) return 'not measured (nothing received yet)';
  const close = c.closeness;
  if (close.v === null) return nm(close);
  const ex = driver === 'a' ? c.excess_a : c.excess_b;
  const level = pick(CLOSENESS_WORDS, close.v);
  if (ex.v === null) return `${level}, chance not measured yet`;
  const vs = ex.v > 0 ? pick(EXCESS_WORDS, ex.v) : NOT_ABOVE_CHANCE;
  return `${level}, ${vs}`;
}

/** The chance level as a word. */
export function chanceWords(m: Measured | null | undefined): string {
  if (m === null || m === undefined) return 'not measured (nothing received yet)';
  if (m.v === null) return nm(m);
  return pick(CHANCE_WORDS, m.v);
}
