/**
 * "Good to go" for the headband fit: every channel the engine reports must stay usable for a
 * number of seconds in a row. Time is the engine's own frame time. A frame with an unusable
 * channel starts the count again; so does a gap in the frames. Nothing is assumed in between.
 */
import { useEffect, useRef, useState } from 'react';
import type { SlowFrame } from '../../engine/frames';
import { useServices } from './app';

export interface FitHold {
  /** Frame time at which the current run of all-usable frames began, or null. */
  goodSinceT: number | null;
  /** Seconds of frame time the current run has lasted. */
  goodForS: number;
  lastT: number | null;
}

export const NO_HOLD: FitHold = { goodSinceT: null, goodForS: 0, lastT: null };

/** A slow frame is expected four times a second; a longer silence breaks the run. */
export const FIT_GAP_S = 2;

export function allUsable(slow: SlowFrame | null | undefined): boolean {
  return !!slow && slow.quality.length > 0 && slow.quality.every((q) => q.usable);
}

export function stepFitHold(prev: FitHold, slow: SlowFrame): FitHold {
  if (prev.lastT !== null && slow.t < prev.lastT) return prev;
  const gap = prev.lastT !== null && slow.t - prev.lastT > FIT_GAP_S;
  if (!allUsable(slow)) return { goodSinceT: null, goodForS: 0, lastT: slow.t };
  const since = prev.goodSinceT === null || gap ? slow.t : prev.goodSinceT;
  return { goodSinceT: since, goodForS: slow.t - since, lastT: slow.t };
}

/** Follows the hub's slow frames; also returns the latest slow frame for display. */
export function useFitHold(requiredS: number): { slow: SlowFrame | null; hold: FitHold; good: boolean } {
  const { controller } = useServices();
  const [slow, setSlow] = useState<SlowFrame | null>(controller.hub.latest().slow);
  const holdRef = useRef<FitHold>(NO_HOLD);
  const [hold, setHold] = useState<FitHold>(NO_HOLD);
  useEffect(() => {
    const first = controller.hub.latest().slow;
    if (first) {
      holdRef.current = stepFitHold(NO_HOLD, first);
      setHold(holdRef.current);
    }
    return controller.hub.subscribe((f) => {
      if (f.kind !== 'slow') return;
      holdRef.current = stepFitHold(holdRef.current, f);
      setSlow(f);
      setHold(holdRef.current);
    });
  }, [controller]);
  return { slow, hold, good: hold.goodSinceT !== null && hold.goodForS >= requiredS };
}
