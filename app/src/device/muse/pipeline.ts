/**
 * MusePipeline: raw Muse notifications in, engine-ready samples on the session clock out.
 *
 * No Bluetooth here. The live MuseDevice and the ReplaySource both feed DeviceInput records
 * through this same code, which is what makes a replay identical to the live session.
 */
import type { StreamDescription } from '../../engine/frames';
import { SessionClock, StreamClock, unwrapCounter } from '../clock';
import type {
  DeviceEvents,
  DeviceInput,
  GapCause,
  LinkConfig,
  MuseProtocol,
  RawNotification,
} from '../types';
import { DeviceSlot } from '../types';
import {
  athenaAccelToG,
  athenaBatteryPercent,
  athenaEegToUv,
  athenaGyroToDps,
  athenaRaw,
  splitAthenaNotification,
  type AthenaSubpacket,
} from './athena';
import {
  classicAccelToG,
  classicEegToUv,
  classicGyroToDps,
  parseClassicEeg,
  parseClassicImu,
  parseClassicPpg,
  parseClassicTelemetry,
} from './classic';
import {
  CLASSIC_EEG_CHARS,
  CLASSIC_EEG_NAMES,
  CLASSIC_EEG_SAMPLES_PER_PACKET,
  CLASSIC_IMU_SAMPLES_PER_PACKET,
  CLASSIC_PPG_CHARS,
  CLASSIC_PPG_NAMES,
  CLASSIC_PPG_SAMPLES_PER_PACKET,
  EEG_RATE_HZ,
  MOTION_RATE_HZ,
  MuseChar,
  PPG_RATE_HZ,
  athenaEegNames,
  athenaOpticsNames,
} from './constants';
import { ControlAccumulator, decodeResponseFragment } from './control';

type Out = <K extends keyof DeviceEvents>(type: K, ev: DeviceEvents[K]) => void;

export interface MusePipelineOptions {
  clock: SessionClock;
  /**
   * EEG samples to collect before declaring the stream description. Streams that have not
   * produced data by then are declared absent. Default 512 (2 s).
   */
  settleSamples?: number;
  /** Classic: packets a missing channel may lag before its packet is declared lost. Default 3. */
  reorderWindow?: number;
}

export interface MusePipelineStats {
  notifications: number;
  eegSamples: number;
  eegGapSamples: number;
  ppgGapSamples: number;
  motionGapSamples: number;
  droppedBeforeAnchor: number;
  lateClassicNotifications: number;
  duplicateSubpackets: number;
  malformed: number;
}

// ---------------------------------------------------------------------------
// Classic multi-characteristic reassembly
// ---------------------------------------------------------------------------

interface Frame {
  chans: (number[] | null)[];
  have: number;
  tUs: number;
}

/**
 * Classic sends each channel of a packet on its own characteristic with the same 16-bit index.
 * This collects the channels of each packet and releases whole packets in order. A packet whose
 * channels do not all arrive within `reorderWindow` packets is released as lost.
 */
class ClassicAssembler {
  private frames = new Map<number, Frame>();
  private lastSeen: number | null = null;
  next: number | null = null;
  private readonly nCh: number;
  private readonly reorder: number;
  private readonly onFrame: (pkt: number, chans: number[][], tUs: number) => void;
  private readonly onLost: (pkt: number, partial: boolean) => void;

  constructor(
    nCh: number,
    reorder: number,
    onFrame: (pkt: number, chans: number[][], tUs: number) => void,
    onLost: (pkt: number, partial: boolean) => void,
  ) {
    this.nCh = nCh;
    this.reorder = reorder;
    this.onFrame = onFrame;
    this.onLost = onLost;
  }

  /**
   * Returns 'late' for a notification of a packet already released, 'restart' when the counter
   * jumps far backwards (the caller resets and re-feeds), else 'ok'.
   */
  push(ch: number, seq: number, values: number[], tUs: number, estimate: number | null): 'ok' | 'late' | 'restart' {
    let pkt: number;
    if (this.lastSeen === null) {
      pkt = seq;
    } else {
      const M = 65536;
      let d = (((seq - this.lastSeen) % M) + M) % M;
      if (d >= M / 2) d -= M;
      pkt = this.lastSeen + d;
      if (estimate !== null && estimate - pkt > M / 2) pkt += Math.round((estimate - pkt) / M) * M;
      if (d < -4 * this.reorder - 16) return 'restart';
    }
    if (this.lastSeen === null || pkt > this.lastSeen) this.lastSeen = pkt;
    if (this.next !== null && pkt < this.next) return 'late';
    let f = this.frames.get(pkt);
    if (!f) {
      f = { chans: new Array(this.nCh).fill(null), have: 0, tUs };
      this.frames.set(pkt, f);
    }
    if (f.chans[ch] === null) f.have++;
    f.chans[ch] = values;
    f.tUs = tUs; // the packet is complete when its last channel arrives
    this.drain();
    return 'ok';
  }

  private drain(): void {
    if (this.next === null) {
      let first: number | null = null;
      for (const [p, f] of this.frames) if (f.have === this.nCh && (first === null || p < first)) first = p;
      if (first === null) return;
      for (const p of [...this.frames.keys()]) if (p < first) this.frames.delete(p);
      this.next = first;
    }
    for (;;) {
      const f = this.frames.get(this.next);
      if (f && f.have === this.nCh) {
        this.frames.delete(this.next);
        this.onFrame(this.next, f.chans as number[][], f.tUs);
        this.next++;
        continue;
      }
      let maxComplete = -Infinity;
      for (const [p, fr] of this.frames) if (fr.have === this.nCh && p > maxComplete) maxComplete = p;
      if (maxComplete >= this.next + this.reorder) {
        this.frames.delete(this.next);
        this.onLost(this.next, !!f);
        this.next++;
        continue;
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Secondary stream bookkeeping
// ---------------------------------------------------------------------------

/** Where a counter-driven stream is, within one connection. */
interface CounterState {
  last: number | null;
  /** Session sample index of packet `segPkt`. */
  segIdx: number;
  segPkt: number;
}

interface ImuSide {
  counter: number | null; // unwrapped packet number
  local: number; // samples received this connection, plus gaps
  offset: number | null; // motion index = local + offset
  deltas: number[];
  step: number | null;
}

// ---------------------------------------------------------------------------

export class MusePipeline {
  private readonly clock: SessionClock;
  private readonly out: Out;
  private readonly settleSamples: number;
  private readonly reorder: number;

  private protocol: MuseProtocol | null = null;
  private config: LinkConfig | null = null;
  private name: string | null = null;
  private connections = 0;
  private control = new ControlAccumulator();

  // Session-wide stream positions (survive reconnects).
  private eegNext: number | null = null;
  private eegChannels: number | null = null;
  private ppgNext: number | null = null;
  private ppgChannels: number | null = null;
  private motionNext: number | null = null;
  private ppgClock = new StreamClock(PPG_RATE_HZ);
  private motionClock = new StreamClock(MOTION_RATE_HZ);

  // Per-connection state.
  private needEegResync = false;
  private eegResyncCause: GapCause = 'reconnect';
  private eegSeg: CounterState = { last: null, segIdx: 0, segPkt: 0 };
  private athenaCounters = new Map<number, CounterState>();
  private eegAsm: ClassicAssembler | null = null;
  private ppgAsm: ClassicAssembler | null = null;
  private ppgSeg: { segIdx: number; segPkt: number } | null = null;
  private imu: { acc: ImuSide; gyro: ImuSide } = { acc: newImuSide(), gyro: newImuSide() };
  private motionBuf = new Map<number, { acc?: number[]; gyro?: number[] }>();
  private pendingEegGapCause: GapCause | null = null;
  private pendingPpgGapCause: GapCause | null = null;
  private pendingMotionGapCause: GapCause | null = null;

  // Output gating until the description is known.
  private description: StreamDescription | null = null;
  private queued: [keyof DeviceEvents, DeviceEvents[keyof DeviceEvents]][] = [];
  private queuedEegSamples = 0;
  private sawPpg: number | null = null;
  private sawMotion = false;
  private reportedMismatch = false;

  readonly stats: MusePipelineStats = {
    notifications: 0,
    eegSamples: 0,
    eegGapSamples: 0,
    ppgGapSamples: 0,
    motionGapSamples: 0,
    droppedBeforeAnchor: 0,
    lateClassicNotifications: 0,
    duplicateSubpackets: 0,
    malformed: 0,
  };

  constructor(out: Out, opts: MusePipelineOptions) {
    this.out = out;
    this.clock = opts.clock;
    this.settleSamples = opts.settleSamples ?? 512;
    this.reorder = opts.reorderWindow ?? 3;
  }

  get streams(): StreamDescription | null {
    return this.description;
  }
  get connectedProtocol(): MuseProtocol | null {
    return this.protocol;
  }
  /** Current rate estimates of the secondary streams against EEG (diagnostic). */
  get secondaryRates(): { ppgHz: number; motionHz: number } {
    return { ppgHz: this.ppgClock.rateHz, motionHz: this.motionClock.rateHz };
  }

  push(input: DeviceInput): void {
    if (input.slot !== DeviceSlot.MUSE) return;
    if (input.type === 'link') {
      if (input.state === 'connected') this.onConnected(input.config ?? { name: null });
      else this.onDisconnected();
      return;
    }
    this.stats.notifications++;
    if (input.char === MuseChar.CONTROL) return this.onControl(input);
    if (this.protocol === 'athena') {
      if (input.char === MuseChar.ATHENA_DATA || input.char === MuseChar.ATHENA_DATA_2) this.onAthena(input);
      return;
    }
    if (this.protocol === 'classic') this.onClassic(input);
  }

  // ---- link -----------------------------------------------------------------

  private onConnected(config: LinkConfig): void {
    this.connections++;
    this.config = config;
    this.protocol = config.protocol ?? 'classic';
    this.name = config.name;
    this.control = new ControlAccumulator();
    this.athenaCounters.clear();
    this.eegSeg = { last: null, segIdx: 0, segPkt: 0 };
    this.needEegResync = this.eegNext !== null;
    this.eegResyncCause = 'reconnect';
    this.ppgSeg = null;
    this.imu = { acc: newImuSide(), gyro: newImuSide() };
    this.motionBuf.clear();
    if (this.protocol === 'classic') {
      const eegChars = config.eegChars ?? CLASSIC_EEG_CHARS.slice(0, 4);
      const ppgChars = config.ppgChars ?? [];
      this.eegAsm = new ClassicAssembler(
        eegChars.length,
        this.reorder,
        (pkt, chans, tUs) => this.classicEegFrame(pkt, chans, tUs),
        (_pkt, partial) => {
          this.pendingEegGapCause = partial ? 'reassembly' : 'counter';
        },
      );
      this.ppgAsm = ppgChars.length
        ? new ClassicAssembler(
            ppgChars.length,
            this.reorder,
            (pkt, chans, tUs) => this.classicPpgFrame(pkt, chans, tUs),
            (_pkt, partial) => {
              this.pendingPpgGapCause = partial ? 'reassembly' : 'counter';
            },
          )
        : null;
    } else {
      this.eegAsm = null;
      this.ppgAsm = null;
    }
  }

  private onDisconnected(): void {
    // Nothing to reset: per-connection state is rebuilt on the next 'connected'. Notifications
    // that arrive between the two are still decoded with the old connection's state.
  }

  // ---- control ----------------------------------------------------------------

  private onControl(n: RawNotification): void {
    for (const json of this.control.push(decodeResponseFragment(n.bytes))) {
      this.out('info', { slot: DeviceSlot.MUSE, json });
      const bp = json.bp;
      if (typeof bp === 'number' && Number.isFinite(bp)) {
        this.out('battery', { slot: DeviceSlot.MUSE, t: this.clock.toSession(n.tUs), percent: bp });
      }
    }
  }

  // ---- EEG (shared) ---------------------------------------------------------------

  /**
   * Place an EEG block on the session clock. `pktStart` is the packet's index in the current
   * connection's counter-derived numbering; returns the session index of its first sample.
   */
  private eegIndexFor(unwrapped: number, nSamples: number, tUs: number, spp: number): number {
    if (this.eegNext === null) {
      this.eegSeg = { last: unwrapped, segIdx: 0, segPkt: unwrapped };
      return 0;
    }
    if (this.needEegResync) {
      // After a reconnect or counter restart the counter says nothing about the time between.
      // Place the block by arrival time; never before the next expected index.
      const est = this.clock.eegIndexAt(tUs);
      const start = est === null ? this.eegNext : Math.max(this.eegNext, Math.floor(est) - nSamples);
      this.eegSeg = { last: unwrapped, segIdx: start, segPkt: unwrapped };
      this.needEegResync = false;
      if (start > this.eegNext) this.pendingEegGapCause = this.eegResyncCause;
      return start;
    }
    return this.eegSeg.segIdx + (unwrapped - this.eegSeg.segPkt) * spp;
  }

  private emitEeg(firstIndex: number, nCh: number, nSamples: number, samples: Float32Array, tUs: number, estimatedGap = false): void {
    if (this.eegChannels === null) this.eegChannels = nCh;
    if (nCh !== this.eegChannels) {
      this.mismatch(`EEG channel count changed from ${this.eegChannels} to ${nCh}; data dropped`);
      return;
    }
    if (this.eegNext !== null && firstIndex > this.eegNext) {
      const cause = this.pendingEegGapCause ?? 'counter';
      const missing = firstIndex - this.eegNext;
      this.stats.eegGapSamples += missing;
      this.queueOrEmit('gap', {
        stream: 'eeg',
        cause,
        at: this.eegNext,
        samples: missing,
        estimated: estimatedGap || cause === 'reconnect' || cause === 'restart',
      });
    } else if (this.eegNext !== null && firstIndex < this.eegNext) {
      // Overlap can only come from a bad resync estimate; drop the overlapping part.
      const skip = this.eegNext - firstIndex;
      if (skip >= nSamples) return;
      samples = samples.slice(skip * nCh);
      nSamples -= skip;
      firstIndex = this.eegNext;
    }
    this.pendingEegGapCause = null;
    this.clock.observeEeg(firstIndex + nSamples, tUs);
    this.eegNext = firstIndex + nSamples;
    this.stats.eegSamples += nSamples;
    this.queueOrEmit('eeg', { firstIndex, nSamples, nChannels: nCh, samples });
  }

  // ---- Classic ---------------------------------------------------------------------

  private onClassic(n: RawNotification): void {
    const cfg = this.config!;
    const eegChars = cfg.eegChars ?? CLASSIC_EEG_CHARS.slice(0, 4);
    const eegCh = eegChars.indexOf(n.char);
    if (eegCh >= 0) {
      const p = parseClassicEeg(n.bytes);
      if (!p) return void this.stats.malformed++;
      this.feedClassic(this.eegAsm!, eegCh, p.seq, p.raw, n.tUs, 'eeg');
      return;
    }
    const ppgCh = (cfg.ppgChars ?? []).indexOf(n.char);
    if (ppgCh >= 0 && this.ppgAsm) {
      const p = parseClassicPpg(n.bytes);
      if (!p) return void this.stats.malformed++;
      this.feedClassic(this.ppgAsm, ppgCh, p.seq, p.raw, n.tUs, 'ppg');
      return;
    }
    if (n.char === MuseChar.ACCEL || n.char === MuseChar.GYRO) {
      const p = parseClassicImu(n.bytes);
      if (!p) return void this.stats.malformed++;
      const isAcc = n.char === MuseChar.ACCEL;
      const vals = p.raw.map(isAcc ? classicAccelToG : classicGyroToDps);
      this.classicImu(isAcc ? 'acc' : 'gyro', p.seq, vals, n.tUs);
      return;
    }
    if (n.char === MuseChar.TELEMETRY) {
      const t = parseClassicTelemetry(n.bytes);
      if (!t) return void this.stats.malformed++;
      this.out('battery', { slot: DeviceSlot.MUSE, t: this.clock.toSession(n.tUs), percent: t.batteryPercent });
    }
  }

  private feedClassic(asm: ClassicAssembler, ch: number, seq: number, raw: number[], tUs: number, kind: 'eeg' | 'ppg'): void {
    let estimate: number | null = null;
    if (kind === 'eeg' && this.eegNext !== null && asm.next !== null && !this.needEegResync) {
      const idx = this.clock.eegIndexAt(tUs);
      if (idx !== null) estimate = asm.next + (idx - this.eegNext) / CLASSIC_EEG_SAMPLES_PER_PACKET;
    }
    const r = asm.push(ch, seq, raw, tUs, estimate);
    if (r === 'late') this.stats.lateClassicNotifications++;
    if (r === 'restart') {
      // Counter went far backwards: firmware restarted streaming. Start a new segment.
      const fresh = new ClassicAssembler(
        kind === 'eeg' ? (this.config!.eegChars ?? CLASSIC_EEG_CHARS.slice(0, 4)).length : (this.config!.ppgChars ?? []).length,
        this.reorder,
        kind === 'eeg' ? (p, c, t) => this.classicEegFrame(p, c, t) : (p, c, t) => this.classicPpgFrame(p, c, t),
        kind === 'eeg'
          ? (_p, partial) => { this.pendingEegGapCause = partial ? 'reassembly' : 'counter'; }
          : (_p, partial) => { this.pendingPpgGapCause = partial ? 'reassembly' : 'counter'; },
      );
      if (kind === 'eeg') {
        this.eegAsm = fresh;
        this.needEegResync = this.eegNext !== null;
        this.eegResyncCause = 'restart';
      } else {
        this.ppgAsm = fresh;
        this.ppgSeg = null;
      }
      fresh.push(ch, seq, raw, tUs, null);
    }
  }

  private classicEegFrame(pkt: number, chans: number[][], tUs: number): void {
    const nCh = chans.length;
    const n = CLASSIC_EEG_SAMPLES_PER_PACKET;
    const first = this.eegIndexFor(pkt, n, tUs, n);
    const samples = new Float32Array(n * nCh);
    for (let s = 0; s < n; s++) for (let c = 0; c < nCh; c++) samples[s * nCh + c] = classicEegToUv(chans[c][s]);
    this.emitEeg(first, nCh, n, samples, tUs);
  }

  private classicPpgFrame(pkt: number, chans: number[][], tUs: number): void {
    const n = CLASSIC_PPG_SAMPLES_PER_PACKET;
    const nCh = chans.length;
    const arrival = this.clock.toSession(tUs);
    if (arrival === null) return void this.stats.droppedBeforeAnchor++;
    if (!this.ppgSeg) this.ppgSeg = { segIdx: this.placeSecondary('ppg', n, arrival), segPkt: pkt };
    const first = this.ppgSeg.segIdx + (pkt - this.ppgSeg.segPkt) * n;
    const samples = new Float32Array(n * nCh);
    for (let s = 0; s < n; s++) for (let c = 0; c < nCh; c++) samples[s * nCh + c] = chans[c][s];
    this.emitPpg(first, nCh, n, samples, arrival);
  }

  /** First sample index of a secondary stream's first packet in this connection. */
  private placeSecondary(kind: 'ppg' | 'motion', nSamples: number, arrival: number): number {
    const clock = kind === 'ppg' ? this.ppgClock : this.motionClock;
    const next = kind === 'ppg' ? this.ppgNext : this.motionNext;
    if (!clock.isStarted || next === null) {
      clock.start(0, nSamples, arrival);
      return 0;
    }
    const start = Math.max(next, Math.floor(clock.indexAt(arrival)) - nSamples);
    if (start > next) {
      const cause: GapCause = this.connections > 1 ? 'reconnect' : 'restart';
      if (kind === 'ppg') this.pendingPpgGapCause = cause;
      else this.pendingMotionGapCause = cause;
    }
    return start;
  }

  private emitPpg(firstIdx: number, nCh: number, n: number, samples: Float32Array, arrival: number): void {
    if (this.ppgChannels === null) this.ppgChannels = nCh;
    if (nCh !== this.ppgChannels) {
      this.mismatch(`optical channel count changed from ${this.ppgChannels} to ${nCh}; data dropped`);
      return;
    }
    if (this.ppgNext !== null && firstIdx < this.ppgNext) {
      const skip = this.ppgNext - firstIdx;
      if (skip >= n) return;
      samples = samples.slice(skip * nCh);
      n -= skip;
      firstIdx = this.ppgNext;
    }
    if (this.ppgNext !== null && firstIdx > this.ppgNext) {
      const cause = this.pendingPpgGapCause ?? 'counter';
      this.stats.ppgGapSamples += firstIdx - this.ppgNext;
      this.queueOrEmit('gap', {
        stream: 'ppg',
        cause,
        at: this.ppgClock.timeOf(this.ppgNext),
        samples: firstIdx - this.ppgNext,
        estimated: cause === 'reconnect' || cause === 'restart',
      });
    }
    this.pendingPpgGapCause = null;
    this.ppgClock.observe(firstIdx + n, arrival);
    this.ppgNext = firstIdx + n;
    if (this.sawPpg === null) this.sawPpg = nCh;
    this.queueOrEmit('ppg', { t: this.ppgClock.timeOf(firstIdx), nSamples: n, nChannels: nCh, samples });
  }

  /** Classic accelerometer / gyroscope: separate characteristics, paired by sample position. */
  private classicImu(side: 'acc' | 'gyro', seq: number, vals: number[], tUs: number): void {
    const arrival = this.clock.toSession(tUs);
    if (arrival === null) return void this.stats.droppedBeforeAnchor++;
    const st = this.imu[side];
    const other = this.imu[side === 'acc' ? 'gyro' : 'acc'];
    const n = CLASSIC_IMU_SAMPLES_PER_PACKET;
    if (st.counter === null) {
      st.counter = seq;
      st.local = 0;
    } else {
      const raw = (((seq - (st.counter % 65536)) % 65536) + 65536) % 65536;
      if (st.step === null) {
        // Learn how far the counter moves per packet from the first deltas (unverified on
        // hardware for the IMU characteristics; see NOTES). No gaps are reported meanwhile.
        if (raw > 0 && raw < 64) st.deltas.push(raw);
        if (st.deltas.length >= 4) st.step = mode(st.deltas);
        st.counter += raw === 0 ? 0 : raw;
        st.local += n;
      } else {
        const step = unwrapCounter(st.counter, seq, 65536, null, st.step);
        if (step.kind === 'dup') return void this.stats.duplicateSubpackets++;
        if (step.kind === 'back') {
          // restart: re-align this side below
          st.offset = null;
          st.local = 0;
          st.counter = seq;
        } else {
          st.local += (step.missing + 1) * n;
          st.counter = step.unwrapped;
        }
      }
    }
    if (st.offset === null) {
      if (other.offset !== null) {
        // Align with the other side: this packet's end is taken to coincide with the other
        // side's latest end (both come from one IMU). Error at most one packet.
        const otherEnd = other.local + n + other.offset;
        st.offset = otherEnd - (st.local + n);
      } else {
        st.offset = this.placeSecondary('motion', n, arrival) - st.local;
      }
    }
    const first = st.local + st.offset;
    for (let s = 0; s < n; s++) {
      const idx = first + s;
      if (this.motionNext !== null && idx < this.motionNext) continue;
      const e = this.motionBuf.get(idx) ?? {};
      e[side] = vals.slice(s * 3, s * 3 + 3);
      this.motionBuf.set(idx, e);
    }
    this.drainMotion(first + n, arrival);
  }

  private drainMotion(newestEnd: number, arrival: number): void {
    const keys = [...this.motionBuf.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const e = this.motionBuf.get(k)!;
      if (e.acc && e.gyro) {
        this.motionBuf.delete(k);
        this.emitMotion(k, e.acc, e.gyro, arrival);
      } else if (k < newestEnd - 2 * CLASSIC_IMU_SAMPLES_PER_PACKET) {
        this.motionBuf.delete(k); // its partner never came: lost
      } else {
        break;
      }
    }
  }

  private emitMotion(idx: number, acc: number[], gyro: number[], arrival: number): void {
    if (this.motionNext !== null && idx < this.motionNext) return;
    if (this.motionNext !== null && idx > this.motionNext) {
      const missing = idx - this.motionNext;
      const cause = this.pendingMotionGapCause ?? 'counter';
      this.stats.motionGapSamples += missing;
      this.queueOrEmit('gap', {
        stream: 'motion',
        cause,
        at: this.motionClock.timeOf(this.motionNext),
        samples: missing,
        estimated: cause === 'reconnect' || cause === 'restart',
      });
    }
    this.pendingMotionGapCause = null;
    this.motionClock.observe(idx + 1, arrival);
    this.motionNext = idx + 1;
    this.sawMotion = true;
    this.queueOrEmit('motion', {
      t: this.motionClock.timeOf(idx),
      acc: Float32Array.from(acc),
      gyro: Float32Array.from(gyro),
    });
  }

  // ---- Athena ------------------------------------------------------------------

  private onAthena(n: RawNotification): void {
    const split = splitAthenaNotification(n.bytes);
    if (split.droppedBytes || split.unknownTags.length) this.stats.malformed++;
    // Contiguous EEG subpackets of one notification go out as one block.
    let block: { first: number; nCh: number; values: number[]; n: number } | null = null;
    const flush = () => {
      if (!block) return;
      this.emitEeg(block.first, block.nCh, block.n, Float32Array.from(block.values), n.tUs);
      block = null;
    };
    for (const sp of split.subpackets) {
      const kind = sp.info.kind;
      if (kind === 'eeg') {
        const placed = this.athenaEegIndex(sp, n.tUs, () => (block ? block.first + block.n : this.eegNext));
        if (placed === null) continue;
        const raw = athenaRaw(sp);
        const uv = raw.map(athenaEegToUv);
        if (block && block.first + block.n === placed && block.nCh === sp.info.channels) {
          block.values.push(...uv);
          block.n += sp.info.samples;
        } else {
          flush();
          block = { first: placed, nCh: sp.info.channels, values: uv, n: sp.info.samples };
        }
        // keep the clock-based estimate current for the next subpacket of this notification
        continue;
      }
      if (kind === 'optics') {
        flush();
        this.athenaOptics(sp, n.tUs);
      } else if (kind === 'imu') {
        flush();
        this.athenaImu(sp, n.tUs);
      } else if (kind === 'battery') {
        const raw = athenaRaw(sp);
        if (raw.length) {
          this.out('battery', {
            slot: DeviceSlot.MUSE,
            t: this.clock.toSession(n.tUs),
            percent: Math.min(100, Math.max(0, athenaBatteryPercent(raw[0]))),
          });
        }
      }
      // drlref (0x53): decoded by athenaRaw for recordings/diagnostics, not an engine input.
    }
    flush();
  }

  /** Session index of an Athena EEG subpacket's first sample, or null to drop it. */
  private athenaEegIndex(sp: AthenaSubpacket, tUs: number, nextIdx: () => number | null): number | null {
    const spp = sp.info.samples;
    const st = this.athenaCounters.get(sp.tag);
    if (!st || st.last === null) {
      const first = this.eegIndexFor(sp.counter, spp, tUs, spp);
      this.athenaCounters.set(sp.tag, { last: sp.counter, segIdx: first, segPkt: sp.counter });
      this.eegSeg = { last: sp.counter, segIdx: first, segPkt: sp.counter };
      return first;
    }
    const next = nextIdx();
    const idxNow = this.clock.eegIndexAt(tUs);
    const estimate = idxNow !== null && next !== null ? st.last + 1 + Math.max(0, idxNow - next) / spp : null;
    const step = unwrapCounter(st.last, sp.counter, 256, estimate);
    if (step.kind === 'dup') {
      this.stats.duplicateSubpackets++;
      return null;
    }
    if (step.kind === 'back') {
      // Counter restarted (preset change or firmware restart): new segment, placed by arrival.
      this.needEegResync = true;
      this.eegResyncCause = 'restart';
      const first = this.eegIndexFor(sp.counter, spp, tUs, spp);
      this.athenaCounters.set(sp.tag, { last: sp.counter, segIdx: first, segPkt: sp.counter });
      return first;
    }
    st.last = step.unwrapped;
    if (step.kind === 'gap') this.pendingEegGapCause = 'counter';
    return st.segIdx + (step.unwrapped - st.segPkt) * spp;
  }

  private athenaCounter(sp: AthenaSubpacket, kind: 'ppg' | 'motion', arrival: number): { first: number } | null {
    const spp = sp.info.samples;
    const st = this.athenaCounters.get(sp.tag);
    const clock = kind === 'ppg' ? this.ppgClock : this.motionClock;
    if (!st || st.last === null) {
      const first = this.placeSecondary(kind, spp, arrival);
      this.athenaCounters.set(sp.tag, { last: sp.counter, segIdx: first, segPkt: sp.counter });
      return { first };
    }
    const estimate = st.last + 1 + Math.max(0, clock.indexAt(arrival) - (kind === 'ppg' ? this.ppgNext ?? 0 : this.motionNext ?? 0)) / spp;
    const step = unwrapCounter(st.last, sp.counter, 256, estimate);
    if (step.kind === 'dup') {
      this.stats.duplicateSubpackets++;
      return null;
    }
    if (step.kind === 'back') {
      const first = this.placeSecondary(kind, spp, arrival);
      this.athenaCounters.set(sp.tag, { last: sp.counter, segIdx: first, segPkt: sp.counter });
      return { first };
    }
    st.last = step.unwrapped;
    return { first: st.segIdx + (step.unwrapped - st.segPkt) * spp };
  }

  private athenaOptics(sp: AthenaSubpacket, tUs: number): void {
    const arrival = this.clock.toSession(tUs);
    if (arrival === null) return void this.stats.droppedBeforeAnchor++;
    const placed = this.athenaCounter(sp, 'ppg', arrival);
    if (!placed) return;
    const raw = athenaRaw(sp);
    this.emitPpg(placed.first, sp.info.channels, sp.info.samples, Float32Array.from(raw), arrival);
  }

  private athenaImu(sp: AthenaSubpacket, tUs: number): void {
    const arrival = this.clock.toSession(tUs);
    if (arrival === null) return void this.stats.droppedBeforeAnchor++;
    const placed = this.athenaCounter(sp, 'motion', arrival);
    if (!placed) return;
    const raw = athenaRaw(sp);
    for (let s = 0; s < 3; s++) {
      const acc = [0, 1, 2].map((a) => athenaAccelToG(raw[s * 6 + a]));
      const gyro = [3, 4, 5].map((a) => athenaGyroToDps(raw[s * 6 + a]));
      this.emitMotion(placed.first + s, acc, gyro, arrival);
    }
  }

  // ---- description gating ----------------------------------------------------------

  private queueOrEmit<K extends keyof DeviceEvents>(type: K, ev: DeviceEvents[K]): void {
    if (this.description) {
      if (type === 'ppg' && !this.description.ppg) return; // appeared after the description: not declared
      if (type === 'motion' && !this.description.motion) return;
      this.out(type, ev);
      return;
    }
    this.queued.push([type, ev]);
    if (type === 'eeg') this.queuedEegSamples += (ev as DeviceEvents['eeg']).nSamples;
    if (this.queuedEegSamples >= this.settleSamples) this.declare();
  }

  /** Decide the stream description from what actually arrived, then release the queue. */
  private declare(): void {
    const athena = this.protocol === 'athena';
    const nEeg = this.eegChannels ?? 4;
    const eegNames = athena
      ? athenaEegNames(nEeg)
      : (this.config?.eegChars ?? CLASSIC_EEG_CHARS.slice(0, 4)).map((c) => CLASSIC_EEG_NAMES[CLASSIC_EEG_CHARS.indexOf(c)]);
    const ppgNames =
      this.sawPpg === null
        ? null
        : athena
          ? athenaOpticsNames(this.sawPpg)
          : (this.config?.ppgChars ?? []).map((c) => CLASSIC_PPG_NAMES[CLASSIC_PPG_CHARS.indexOf(c)]);
    this.description = {
      eeg: {
        channels: eegNames,
        rate_hz: EEG_RATE_HZ,
        bits: athena ? 14 : 12,
        model: `${athena ? 'Muse S Athena' : 'Muse (classic protocol)'}${this.name ? ` ${this.name}` : ''}`,
      },
      ppg: ppgNames ? { channels: ppgNames, rate_hz: PPG_RATE_HZ } : null,
      motion: this.sawMotion ? { rate_hz: MOTION_RATE_HZ } : null,
      chest_strap: null,
    };
    this.out('streams', this.description);
    const q = this.queued;
    this.queued = [];
    for (const [type, ev] of q) this.queueOrEmit(type, ev as never);
  }

  private mismatch(message: string): void {
    if (this.reportedMismatch) return;
    this.reportedMismatch = true;
    this.out('error', { slot: DeviceSlot.MUSE, message });
  }
}

function newImuSide(): ImuSide {
  return { counter: null, local: 0, offset: null, deltas: [], step: null };
}

function mode(xs: number[]): number {
  const counts = new Map<number, number>();
  let best = xs[0], bestN = 0;
  for (const x of xs) {
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
    if (c > bestN || (c === bestN && x < best)) { best = x; bestN = c; }
  }
  return best;
}
