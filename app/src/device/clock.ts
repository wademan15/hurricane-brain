/**
 * The session clock (spec section 3).
 *
 *  - EEG time is the EEG sample count: t = index / 256. Index 0 is the first EEG sample of the
 *    session. Indices come from packet counters (with wrap), never from arrival time, while the
 *    link is up. A lost packet is an index jump of exactly the lost samples.
 *  - Arrival times are used for three things only, each documented where it happens:
 *      1. mapping the host clock onto the session clock (for the chest strap, whose beats are
 *         stamped on arrival by the engine contract) and measuring host/headset drift;
 *      2. resolving counter wrap when a gap is longer than the counter's range, and placing
 *         the stream after a reconnect (the gap length is then marked as estimated);
 *      3. keeping the secondary headset streams (optical, motion), which may run on their own
 *         oscillators, from drifting against EEG. Their sample times come from their own sample
 *         count; the rate is trimmed slowly and continuously (no jumps) from the lower envelope
 *         of their arrival times.
 *  All three are deterministic functions of the recorded integer arrival times, so a replay
 *  reproduces them exactly.
 */

export interface SessionClockOptions {
  /** EEG rate when a headset is part of the session; null for a chest-strap-only session. */
  eegRateHz: number | null;
  /** Window over which the lowest-latency packet defines the host offset, seconds. */
  windowS?: number;
  /** Bucket length for the running minimum, seconds. */
  bucketS?: number;
  /** Host time (performance.now(), ms) that arrival time 0 refers to. Shared by all devices. */
  hostOriginMs?: number;
}

interface Bucket {
  id: number;
  min: number;
}

/**
 * Host time <-> session time. In 'eeg' mode the mapping is anchored by EEG packets:
 * offset = arrival - (end index / rate), and the smallest offset over a sliding window is the
 * best estimate of the moment of zero latency. In 'host' mode (no headset) session time is
 * arrival time minus the first chest strap notification's arrival.
 */
export class SessionClock {
  readonly mode: 'eeg' | 'host';
  readonly eegRateHz: number | null;
  private readonly windowS: number;
  private readonly bucketS: number;
  private buckets: Bucket[] = [];
  private history: { t: number; min: number }[] = [];
  private offset: number | null = null;
  private hostOrigin: number | null = null;
  readonly hostOriginMs: number;

  constructor(opts: SessionClockOptions) {
    this.hostOriginMs = opts.hostOriginMs ?? 0;
    this.eegRateHz = opts.eegRateHz;
    this.mode = opts.eegRateHz ? 'eeg' : 'host';
    this.windowS = opts.windowS ?? 30;
    this.bucketS = opts.bucketS ?? 5;
  }

  /**
   * Arrival stamp for a notification received at host time `hostMs` (performance.now()):
   * integer microseconds since the host origin. Quantized here, before any decoding, so that
   * the recorded integer reproduces the live decode exactly.
   */
  stampUs(hostMs: number): number {
    return Math.round((hostMs - this.hostOriginMs) * 1000);
  }

  get anchored(): boolean {
    return this.mode === 'eeg' ? this.offset !== null : this.hostOrigin !== null;
  }

  /** Feed one EEG packet: `endIndex` is the index after its last sample. */
  observeEeg(endIndex: number, tUs: number): void {
    if (this.mode !== 'eeg' || !this.eegRateHz) return;
    const tSec = tUs / 1e6;
    const off = tSec - endIndex / this.eegRateHz;
    const id = Math.floor(tSec / this.bucketS);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.id === id) {
      if (off < last.min) last.min = off;
    } else {
      if (last) {
        this.history.push({ t: (last.id + 0.5) * this.bucketS, min: last.min });
        if (this.history.length > 240) this.history.shift();
      }
      this.buckets.push({ id, min: off });
    }
    const oldest = id - Math.ceil(this.windowS / this.bucketS);
    while (this.buckets.length > 1 && this.buckets[0].id <= oldest) this.buckets.shift();
    let m = Infinity;
    for (const b of this.buckets) if (b.min < m) m = b.min;
    this.offset = m;
  }

  /** Set the origin of a chest-strap-only session. First call wins. */
  anchorHost(tUs: number): void {
    if (this.mode === 'host' && this.hostOrigin === null) this.hostOrigin = tUs / 1e6;
  }

  /** Session time for a host arrival time, or null while unanchored. */
  toSession(tUs: number): number | null {
    if (this.mode === 'eeg') return this.offset === null ? null : tUs / 1e6 - this.offset;
    return this.hostOrigin === null ? null : tUs / 1e6 - this.hostOrigin;
  }

  /** EEG sample index the headset had reached when a packet arriving at `tUs` was sent (upper bound). */
  eegIndexAt(tUs: number): number | null {
    const s = this.toSession(tUs);
    return s === null || !this.eegRateHz ? null : s * this.eegRateHz;
  }

  /**
   * Host clock rate relative to the headset's, parts per million (positive: host runs fast),
   * from the slope of the per-bucket minimum offsets. Null until 2 minutes of history.
   * Diagnostic only: it changes no sample time.
   */
  driftPpm(): number | null {
    const h = this.history;
    if (h.length < 2 || h[h.length - 1].t - h[0].t < 120) return null;
    let st = 0, sm = 0;
    for (const p of h) { st += p.t; sm += p.min; }
    const mt = st / h.length, mm = sm / h.length;
    let num = 0, den = 0;
    for (const p of h) { num += (p.t - mt) * (p.min - mm); den += (p.t - mt) ** 2; }
    return den > 0 ? (num / den) * 1e6 : null;
  }
}

export type CounterStepKind = 'next' | 'gap' | 'dup' | 'back';

export interface CounterStep {
  kind: CounterStepKind;
  /** The counter unwrapped onto a continuous packet number. */
  unwrapped: number;
  /** Packets lost before this one (kind 'gap'). */
  missing: number;
}

/**
 * Unwrap a modular packet counter.
 *
 * `last` is the previous unwrapped value. `estimate` (optional) is where the packet number
 * should be judging by arrival time; it only chooses between candidates that the counter
 * itself allows (last + d + k*modulus, or a step backwards), so it resolves wrap ambiguity
 * for gaps longer than the counter's range and never shifts a counted value.
 * `step` is how much the counter advances per packet (1 for every stream we have seen).
 */
export function unwrapCounter(last: number, counter: number, modulus: number, estimate?: number | null, step = 1): CounterStep {
  const lastMod = ((last % modulus) + modulus) % modulus;
  const d = (((counter - lastMod) % modulus) + modulus) % modulus;
  let target: number;
  if (estimate === undefined || estimate === null || !Number.isFinite(estimate)) {
    target = d === 0 ? last : d > modulus / 2 ? last + d - modulus : last + d;
  } else {
    // Candidates: one step back (last + d - modulus), or forward by d + k*modulus.
    const kFwd = Math.max(0, Math.round((estimate - (last + d)) / modulus));
    const fwd = last + d + kFwd * modulus;
    const back = last + d - modulus;
    target = Math.abs(back - estimate) < Math.abs(fwd - estimate) ? back : fwd;
    if (d === 0 && kFwd === 0) target = last;
  }
  if (target === last) return { kind: 'dup', unwrapped: last, missing: 0 };
  if (target < last) return { kind: 'back', unwrapped: target, missing: 0 };
  const delta = target - last;
  if (delta === step) return { kind: 'next', unwrapped: target, missing: 0 };
  // With step > 1, a delta that is not a multiple of the step is still a forward move.
  return { kind: 'gap', unwrapped: target, missing: Math.max(0, Math.round(delta / step) - 1) };
}

export interface StreamClockOptions {
  /** Maximum deviation of the trimmed rate from nominal, as a fraction. */
  maxDeviation?: number;
  /** Length of one trimming window, seconds (two halves of half this). */
  windowS?: number;
}

/**
 * Sample clock for a secondary stream (optical, motion). t(i) = anchorT + (i - anchorIdx) * sps.
 * Starts at the nominal rate, anchored so the first packet's last sample ends at its arrival.
 * Every window it measures the lowest arrival residual in each half-window and trims
 * seconds-per-sample to cancel the drift and half the offset, re-anchoring at the current
 * sample so the mapping stays continuous and monotonic.
 */
export class StreamClock {
  readonly nominalHz: number;
  private sps: number;
  private anchorIdx = 0;
  private anchorT = 0;
  private started = false;
  private readonly maxDev: number;
  private readonly windowS: number;
  private winStart: number | null = null;
  private m1 = Infinity;
  private m2 = Infinity;
  /** Number of rate trims applied (diagnostic). */
  trims = 0;

  constructor(nominalHz: number, opts: StreamClockOptions = {}) {
    this.nominalHz = nominalHz;
    this.sps = 1 / nominalHz;
    this.maxDev = opts.maxDeviation ?? 0.02;
    this.windowS = opts.windowS ?? 10;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Current rate estimate, Hz. */
  get rateHz(): number {
    return 1 / this.sps;
  }

  start(firstIdx: number, nSamples: number, arrivalSession: number): void {
    this.anchorIdx = firstIdx;
    this.anchorT = arrivalSession - nSamples * this.sps;
    this.started = true;
  }

  timeOf(idx: number): number {
    return this.anchorT + (idx - this.anchorIdx) * this.sps;
  }

  indexAt(t: number): number {
    return this.anchorIdx + (t - this.anchorT) / this.sps;
  }

  /** Feed a packet whose last sample is `endIdx - 1`, arriving at session time `arrival`. */
  observe(endIdx: number, arrival: number): void {
    if (!this.started) return;
    const r = arrival - this.timeOf(endIdx);
    if (this.winStart === null) this.winStart = arrival;
    const half = this.windowS / 2;
    const age = arrival - this.winStart;
    if (age < half) {
      if (r < this.m1) this.m1 = r;
      return;
    }
    if (age < this.windowS) {
      if (r < this.m2) this.m2 = r;
      return;
    }
    // Window complete: trim, then start a new window with this packet.
    if (Number.isFinite(this.m1) && Number.isFinite(this.m2)) {
      const drift = (this.m2 - this.m1) / half; // seconds of residual gained per second
      const e = 0.5 * drift + (0.5 * this.m2) / this.windowS;
      const next = this.sps * (1 + e);
      const lo = (1 - this.maxDev) / this.nominalHz;
      const hi = (1 + this.maxDev) / this.nominalHz;
      const clamped = Math.min(hi, Math.max(lo, next));
      if (clamped !== this.sps) {
        this.anchorT = this.timeOf(endIdx);
        this.anchorIdx = endIdx;
        this.sps = clamped;
        this.trims++;
      }
    }
    this.winStart = arrival;
    this.m1 = arrival - this.timeOf(endIdx);
    this.m2 = Infinity;
  }
}
