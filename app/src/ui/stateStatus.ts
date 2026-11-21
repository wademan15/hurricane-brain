/**
 * What a state badge may say. The engine keeps a state active for a dwell (5 s) after its statistic
 * has dropped, so `active` can be true while the measured statistic is null or already under the
 * exit level. The picture and the sound follow the statistic, so the badge says "fading" then, not
 * "holding" with a running timer. Nothing here is computed from signal: it only compares two fields
 * the engine already supplies (`stat` against `exit_at`).
 */
import type { AlignedState, SlowFrame } from '../engine/frames';
import type { Live } from './components/LiveReadout';
import { CHILD_LINES } from './copy';

export type StateStatus = 'holding' | 'fading' | 'not';

export function alignedStatus(s: AlignedState): StateStatus {
  if (!s.active) return 'not';
  if (s.stat.v === null) return 'fading';
  if (s.exit_at !== null && s.stat.v < s.exit_at) return 'fading';
  return 'holding';
}

/** The combined state is the conjunction of two states: it is holding only while both are holding. */
export function bothStatus(st: SlowFrame['states']): StateStatus {
  if (!st.both.active) return 'not';
  return alignedStatus(st.phi) === 'holding' && alignedStatus(st.octave) === 'holding' ? 'holding' : 'fading';
}

export function statusesOf(st: SlowFrame['states']): { phi: StateStatus; octave: StateStatus; both: StateStatus } {
  return { phi: alignedStatus(st.phi), octave: alignedStatus(st.octave), both: bothStatus(st) };
}

/** One plain sentence about what is happening, from the engine's own states and signal summary. Nothing here is a number. */
export function plainSentence(live: Live, sigLevel: string): { icon: 'phi' | 'octave' | 'both' | null; word: string; line: string } {
  const f = live.slow;
  if (!f) return { icon: null, word: 'Not measured', line: CHILD_LINES.nodata };
  const x = statusesOf(f.states);
  if (x.both === 'holding') return { icon: 'both', word: 'Both at once: holding', line: CHILD_LINES.both };
  if (x.phi === 'holding') return { icon: 'phi', word: 'Golden ratio: holding', line: CHILD_LINES.phi };
  if (x.octave === 'holding') return { icon: 'octave', word: 'Octave: holding', line: CHILD_LINES.octave };
  // active in the engine's exit dwell, but the measured value has already dropped: not "holding"
  if (x.both === 'fading') return { icon: 'both', word: 'Both at once: fading', line: CHILD_LINES.fading };
  if (x.phi === 'fading') return { icon: 'phi', word: 'Golden ratio: fading', line: CHILD_LINES.fading };
  if (x.octave === 'fading') return { icon: 'octave', word: 'Octave: fading', line: CHILD_LINES.fading };
  if (sigLevel === 'poor' || sigLevel === 'none') return { icon: null, word: 'Waiting for a clear signal', line: CHILD_LINES.nosignal };
  return { icon: null, word: 'Nothing holding right now', line: CHILD_LINES.quiet };
}

