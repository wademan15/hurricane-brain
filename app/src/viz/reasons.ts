import type { Reason } from '../engine/frames.ts';

/** Plain-language text for each null reason. Shown on calm water and in readouts. */
export const REASON_TEXT: Record<Reason, string> = {
  ok: 'measured',
  warming_up: 'warming up: not enough data yet',
  no_data: 'no data',
  gap: 'packets lost in this window',
  bad_contact: 'poor sensor contact',
  artifact: 'movement or muscle artifact',
  insufficient_clean: 'not enough clean signal in this window',
  bad_fit: 'background fit failed',
  not_confirmed: 'no confirmed peak',
  weak: 'too weak for a meaningful reading',
  lost_lock: 'tracker lost lock',
  unresolved: 'uncertainty too large to score',
  too_few_beats: 'too few heartbeats yet',
  too_many_corrections: 'too many corrected heartbeats',
  not_available: 'not available',
};

/**
 * Reasons the visualizer itself adds on top of engine reasons:
 *  - stale: frames stopped arriving (older than the stale limit in params.ts)
 *  - no_cascade: there are confirmed tracks but no golden ratio cascade, so no spiral forms
 *  - no_beat: no heartbeat received yet
 *  - not_combined: the golden ratio and octave states are not both active
 */
export type VizReason = Reason | 'stale' | 'no_cascade' | 'no_beat' | 'not_combined';

export function reasonText(why: VizReason): string {
  if (why === 'stale') return 'no data: frames stopped arriving';
  if (why === 'no_cascade') return 'no golden ratio cascade';
  if (why === 'no_beat') return 'no heartbeat received';
  if (why === 'not_combined') return 'golden ratio and octave are not aligned at the same time';
  return REASON_TEXT[why];
}
