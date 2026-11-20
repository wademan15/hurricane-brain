/**
 * FrameHub: the one place engine frames fan out to the hurricane, the spectrum, the readouts,
 * the sound, the training runner and the storage summaries. It holds the latest frame of each
 * kind (with the wall time it arrived) so a screen that mounts mid-session can show it at once.
 * It never produces, smooths or fills in a frame.
 */
import type { FastFrame, Frame, HeartFrame, SlowFrame } from '../../engine/frames';
import type { FrameSource } from '../../viz';

export interface LatestFrames {
  slow: SlowFrame | null;
  slowAt: number | null;
  fast: FastFrame | null;
  heart: HeartFrame | null;
  heartAt: number | null;
}

export class FrameHub implements FrameSource {
  private readonly listeners = new Set<(f: Frame) => void>();
  private latestFrames: LatestFrames = { slow: null, slowAt: null, fast: null, heart: null, heartAt: null };
  private readonly clock: () => number;

  constructor(clock: () => number = () => performance.now() / 1000) {
    this.clock = clock;
  }

  subscribe(listener: (f: Frame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  latest(): LatestFrames {
    return this.latestFrames;
  }

  emit(f: Frame): void {
    const at = this.clock();
    const l = this.latestFrames;
    if (f.kind === 'slow') this.latestFrames = { ...l, slow: f, slowAt: at };
    else if (f.kind === 'fast') this.latestFrames = { ...l, fast: f };
    else this.latestFrames = { ...l, heart: f, heartAt: at };
    for (const fn of [...this.listeners]) {
      try {
        fn(f);
      } catch (e) {
        // A failing listener must not stop the others (or the sound).
        console.error('frame listener failed', e);
      }
    }
  }

  /** Forget everything (a new link session). Listeners stay. */
  reset(): void {
    this.latestFrames = { slow: null, slowAt: null, fast: null, heart: null, heartAt: null };
  }
}
