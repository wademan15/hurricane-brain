/**
 * Holds the latest engine frames for the visualizer, stamped with the wall-clock time they
 * arrived. It keeps no history beyond what the bindings need: the latest slow frame, the latest
 * heart frame, and the most recent heartbeat (for the eye-wall pulse).
 *
 * Fast frames are accepted and ignored: no hurricane element is bound to a fast-frame field
 * (spec 9.1). They are listed here so a combined frame stream can be passed straight in.
 */
import type { Beat, Frame, HeartFrame, SlowFrame } from '../engine/frames.ts';

/** Anything that can deliver engine frames. The engine worker wrapper implements this. */
export interface FrameSource {
  /** Calls `listener` for every frame, in time order. Returns an unsubscribe function. */
  subscribe(listener: (frame: Frame) => void): () => void;
}

export interface ReceivedBeat {
  beat: Beat;
  /** Wall-clock seconds at which the visualizer received it. */
  receivedAt: number;
}

/** An immutable view of what has arrived. */
export interface FrameSnapshot {
  slow: SlowFrame | null;
  /** Wall-clock seconds the slow frame arrived. */
  slowAt: number | null;
  heart: HeartFrame | null;
  heartAt: number | null;
  /** The most recent heartbeat that started a pulse. */
  lastBeat: ReceivedBeat | null;
}

export const EMPTY_SNAPSHOT: FrameSnapshot = {
  slow: null,
  slowAt: null,
  heart: null,
  heartAt: null,
  lastBeat: null,
};

/**
 * Fold one frame into a snapshot. Pure: returns a new snapshot.
 *
 * Beats: each beat is used once, identified by its session time. A heart frame that repeats an
 * old beat does not pulse again. When one frame carries several new beats, they are shown as a
 * single pulse for the newest one (they arrived together, so showing them apart would invent
 * timing). A beat arriving sooner than `minPulseIntervalS` after the previous pulse start does not
 * start a new pulse (photosensitivity, see params.ts).
 */
export function applyFrame(
  snap: FrameSnapshot,
  frame: Frame,
  receivedAt: number,
  minPulseIntervalS: number,
): FrameSnapshot {
  if (frame.kind === 'slow') {
    return { ...snap, slow: frame, slowAt: receivedAt };
  }
  if (frame.kind === 'heart') {
    let lastBeat = snap.lastBeat;
    const lastT = lastBeat ? lastBeat.beat.t : -Infinity;
    let newest: Beat | null = null;
    for (const b of frame.beats) {
      if (b.t > lastT && (newest === null || b.t > newest.t)) newest = b;
    }
    if (newest) {
      const tooSoon = lastBeat !== null && receivedAt - lastBeat.receivedAt < minPulseIntervalS;
      if (!tooSoon) lastBeat = { beat: newest, receivedAt };
      // A suppressed beat still counts as seen, so it can never fire later.
      else lastBeat = { beat: newest, receivedAt: lastBeat!.receivedAt };
    }
    return { ...snap, heart: frame, heartAt: receivedAt, lastBeat };
  }
  return snap;
}

/** A mutable holder around `applyFrame`, for the React view. */
export class FrameStore {
  private snap: FrameSnapshot = EMPTY_SNAPSHOT;
  private readonly minPulseIntervalS: number;
  private readonly clock: () => number;

  constructor(minPulseIntervalS: number, clock: () => number) {
    this.minPulseIntervalS = minPulseIntervalS;
    this.clock = clock;
  }

  push(frame: Frame): void {
    this.snap = applyFrame(this.snap, frame, this.clock(), this.minPulseIntervalS);
  }

  snapshot(): FrameSnapshot {
    return this.snap;
  }
}
