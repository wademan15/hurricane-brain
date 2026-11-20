/**
 * ChestStrapPipeline: raw heart rate notifications in, RR intervals on the session clock out.
 *
 * Engine contract (frames.ts): pushRr(t, rrMs) with t = session time the notification arrived.
 * In a session with a headset, session time is anchored by EEG (SessionClock 'eeg' mode); a
 * notification that arrives before the first EEG packet is held until the clock is anchored and
 * dropped if it then lies before session time 0 (counted in stats). In a strap-only session the
 * first notification sets the origin.
 */
import type { SessionClock } from '../clock';
import type { DeviceEvents, DeviceInput, RawNotification } from '../types';
import { DeviceSlot } from '../types';
import { BATTERY_LEVEL, HEART_RATE_MEASUREMENT, parseHeartRateMeasurement } from './hrm';

type Out = <K extends keyof DeviceEvents>(type: K, ev: DeviceEvents[K]) => void;

export interface ChestStrapStats {
  notifications: number;
  beats: number;
  heldBeforeAnchor: number;
  droppedBeforeZero: number;
  malformed: number;
}

export class ChestStrapPipeline {
  private readonly out: Out;
  private readonly clock: SessionClock;
  private held: RawNotification[] = [];
  private described = false;
  private name: string | null = null;
  readonly stats: ChestStrapStats = { notifications: 0, beats: 0, heldBeforeAnchor: 0, droppedBeforeZero: 0, malformed: 0 };

  constructor(out: Out, clock: SessionClock) {
    this.out = out;
    this.clock = clock;
  }

  push(input: DeviceInput): void {
    if (input.slot !== DeviceSlot.CHEST_STRAP) return;
    if (input.type === 'link') {
      if (input.state === 'connected' && input.config) this.name = input.config.name;
      return;
    }
    if (input.char === BATTERY_LEVEL) {
      if (input.bytes.length >= 1) {
        this.out('battery', { slot: DeviceSlot.CHEST_STRAP, t: this.clock.toSession(input.tUs), percent: input.bytes[0] });
      }
      return;
    }
    if (input.char !== HEART_RATE_MEASUREMENT) return;
    this.stats.notifications++;
    this.clock.anchorHost(input.tUs);
    if (!this.clock.anchored) {
      this.held.push(input);
      this.stats.heldBeforeAnchor++;
      return;
    }
    this.flushHeld();
    this.decode(input);
  }

  /** Release held notifications once the session clock is anchored (on the next notification). */
  private flushHeld(): void {
    if (!this.clock.anchored || this.held.length === 0) return;
    const h = this.held;
    this.held = [];
    for (const n of h) this.decode(n);
  }

  private decode(n: RawNotification): void {
    const m = parseHeartRateMeasurement(n.bytes);
    if (!m) return void this.stats.malformed++;
    const t = this.clock.toSession(n.tUs)!;
    if (t < 0) return void this.stats.droppedBeforeZero++;
    if (!this.described) {
      this.described = true;
      this.out('streams', { eeg: null, ppg: null, motion: null, chest_strap: { name: this.name ?? 'Heart rate strap' } });
    }
    this.out('heartRate', { t, bpm: m.bpm, contact: m.contact });
    if (m.rrMs.length) {
      this.stats.beats += m.rrMs.length;
      this.out('rr', { t, rrMs: Float32Array.from(m.rrMs) });
    }
  }
}
