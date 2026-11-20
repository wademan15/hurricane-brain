/**
 * TEST ONLY. Synthetic headset sessions: known sample values encoded into real packet layouts,
 * with arrival times that include bursty latency, optional packet loss, counter wrap and a
 * headset clock that runs off nominal.
 */
import { MuseChar, CLASSIC_EEG_CHARS, CLASSIC_PPG_CHARS } from '../muse/constants';
import type { DeviceInput, RawNotification } from '../types';
import { DeviceSlot } from '../types';
import {
  concatBytes,
  encodeAthenaPacket,
  encodeClassicEeg,
  encodeClassicImu,
  encodeClassicPpg,
  encodeClassicTelemetry,
  type SubpacketSpec,
} from './encoder';

export interface SynthOptions {
  seconds: number;
  /** Raw EEG value for (channel, global sample index). Default: 10 Hz sine. */
  eeg?: (ch: number, idx: number) => number;
  /** Packet ordinals (EEG packets/subpackets, from 0) lost entirely. */
  dropEeg?: Set<number>;
  /** Classic: packet ordinal -> channel whose notification is lost. */
  dropEegChannel?: Map<number, number>;
  /** First EEG counter value (to place a wrap where you want it). */
  startCounter?: number;
  /** Latency of the packet with this ordinal, ms. Default: 15 ms plus a burst every 7th packet. */
  latencyMs?: (ordinal: number) => number;
  /** Headset clock speed relative to nominal (1.001 = 0.1% fast). */
  clockScale?: number;
  ppg?: boolean;
  motion?: boolean;
  /** Arrival-time origin, µs. */
  t0Us?: number;
}

export interface SynthResult {
  inputs: DeviceInput[];
  /** Raw EEG values actually sent, by global sample index (absent = lost). */
  sentEeg: Map<number, number[]>;
  eegChannels: number;
}

const defaultLatency = (k: number) => 15 + (k % 7 === 0 ? 60 : 0) + (k % 3);

export function tenHz(amplitudeRaw: number, midpoint: number) {
  return (ch: number, idx: number) => Math.round(midpoint + amplitudeRaw * Math.sin((2 * Math.PI * 10 * idx) / 256 + ch));
}

function sortInputs(inputs: DeviceInput[]): DeviceInput[] {
  // Stable sort by arrival time (Array.prototype.sort is stable).
  return inputs.sort((a, b) => a.tUs - b.tUs);
}

// One characteristic's notifications arrive in order (BLE): keep each char's times increasing.
const lastByChar = new Map<number, number>();
function raw(char: number, tUs: number, bytes: Uint8Array): RawNotification {
  const t = Math.max(tUs, (lastByChar.get(char) ?? -Infinity) + 50);
  lastByChar.set(char, t);
  return { type: 'raw', slot: DeviceSlot.MUSE, char, tUs: t, bytes };
}

export function synthClassic(o: SynthOptions): SynthResult {
  lastByChar.clear();
  const eeg = o.eeg ?? tenHz(400, 2048);
  const lat = o.latencyMs ?? defaultLatency;
  const scale = o.clockScale ?? 1;
  const t0 = o.t0Us ?? 1_000_000;
  const nPkt = Math.floor((o.seconds * 256) / 12);
  const inputs: DeviceInput[] = [];
  const sentEeg = new Map<number, number[]>();
  const ppg = o.ppg ?? true;
  const motion = o.motion ?? true;
  inputs.push({
    type: 'link', slot: DeviceSlot.MUSE, tUs: t0 - 1000, state: 'connected',
    config: { name: 'Muse-SYNT', protocol: 'classic', preset: ppg ? 'p50' : 'p21', eegChars: CLASSIC_EEG_CHARS.slice(0, 4), ppgChars: ppg ? CLASSIC_PPG_CHARS : [] },
  });
  const genUs = (sampleEndIdx: number, rate: number) => t0 + Math.round(((sampleEndIdx / rate) * 1e6) / scale);
  for (let p = 0; p < nPkt; p++) {
    const seq = ((o.startCounter ?? 0) + p) & 0xffff;
    const tUs = genUs((p + 1) * 12, 256) + Math.round(lat(p) * 1000);
    if (o.dropEeg?.has(p)) continue;
    const vals: number[][] = [0, 1, 2, 3].map((ch) => Array.from({ length: 12 }, (_, s) => eeg(ch, p * 12 + s)));
    for (let ch = 0; ch < 4; ch++) {
      if (o.dropEegChannel?.get(p) === ch) continue;
      inputs.push(raw(CLASSIC_EEG_CHARS[ch], tUs + ch, encodeClassicEeg(seq, vals[ch])));
    }
    if (!o.dropEegChannel?.has(p)) for (let s = 0; s < 12; s++) sentEeg.set(p * 12 + s, vals.map((v) => v[s]));
  }
  if (ppg) {
    const n = Math.floor((o.seconds * 64) / 6);
    for (let p = 0; p < n; p++) {
      const tUs = genUs((p + 1) * 6, 64) + Math.round(lat(p) * 1000) + 5;
      CLASSIC_PPG_CHARS.forEach((c, ch) => {
        inputs.push(raw(c, tUs + ch, encodeClassicPpg(p & 0xffff, Array.from({ length: 6 }, (_, s) => 100000 * (ch + 1) + p * 6 + s))));
      });
    }
  }
  if (motion) {
    const n = Math.floor((o.seconds * 52) / 3);
    for (let p = 0; p < n; p++) {
      const tUs = genUs((p + 1) * 3, 52) + Math.round(lat(p) * 1000) + 7;
      const v = Array.from({ length: 9 }, (_, i) => ((p * 9 + i) % 2000) - 1000);
      inputs.push(raw(MuseChar.ACCEL, tUs, encodeClassicImu(p, v)));
      inputs.push(raw(MuseChar.GYRO, tUs + 1, encodeClassicImu(p + 500, v.map((x) => -x))));
    }
  }
  for (let s = 0; s < o.seconds; s++) inputs.push(raw(MuseChar.TELEMETRY, t0 + s * 1_000_000 + 3, encodeClassicTelemetry(s, 40000)));
  return { inputs: sortInputs(inputs), sentEeg, eegChannels: 4 };
}

export interface AthenaSynthOptions extends SynthOptions {
  eegChannels?: 4 | 8;
  opticsChannels?: 4 | 8 | 16;
}

/**
 * Athena: subpackets from all sensors, generated at their rates, grouped into packets by a
 * ~47 ms window (sizes stay under 255 bytes), one or two packets per notification.
 */
export function synthAthena(o: AthenaSynthOptions): SynthResult {
  lastByChar.clear();
  const nCh = o.eegChannels ?? 8;
  const spp = nCh === 8 ? 2 : 4;
  const eeg = o.eeg ?? tenHz(2000, 8192);
  const lat = o.latencyMs ?? defaultLatency;
  const scale = o.clockScale ?? 1;
  const t0 = o.t0Us ?? 1_000_000;
  const ppg = o.ppg ?? true;
  const motion = o.motion ?? true;
  const optCh = o.opticsChannels ?? 16;
  const optSpp = optCh === 4 ? 3 : optCh === 8 ? 2 : 1;
  const sentEeg = new Map<number, number[]>();
  type Item = { genS: number; spec: SubpacketSpec; ordinal: number; eeg: boolean };
  const items: Item[] = [];
  const nSub = Math.floor((o.seconds * 256) / spp);
  for (let k = 0; k < nSub; k++) {
    const vals: number[] = [];
    for (let s = 0; s < spp; s++) for (let ch = 0; ch < nCh; ch++) vals.push(eeg(ch, k * spp + s));
    const genS = ((k + 1) * spp) / 256 / scale;
    if (!o.dropEeg?.has(k)) {
      for (let s = 0; s < spp; s++) sentEeg.set(k * spp + s, vals.slice(s * nCh, (s + 1) * nCh));
      items.push({ genS, ordinal: k, eeg: true, spec: { tag: nCh === 8 ? 0x12 : 0x11, counter: ((o.startCounter ?? 0) + k) & 0xff, raw: vals } });
    }
  }
  if (ppg) {
    const n = Math.floor((o.seconds * 64) / optSpp);
    for (let k = 0; k < n; k++) {
      const vals = Array.from({ length: optCh * optSpp }, (_, i) => (k * 31 + i * 1000) % 1048576);
      items.push({ genS: ((k + 1) * optSpp) / 64 / scale, ordinal: k, eeg: false, spec: { tag: optCh === 4 ? 0x34 : optCh === 8 ? 0x35 : 0x36, counter: k & 0xff, raw: vals } });
    }
  }
  if (motion) {
    const n = Math.floor((o.seconds * 52) / 3);
    for (let k = 0; k < n; k++) {
      const vals = Array.from({ length: 18 }, (_, i) => ((k * 18 + i) % 4000) - 2000);
      items.push({ genS: ((k + 1) * 3) / 52 / scale, ordinal: k, eeg: false, spec: { tag: 0x47, counter: k & 0xff, raw: vals } });
    }
  }
  for (let s = 1; s < o.seconds; s += 5) items.push({ genS: s, ordinal: 0, eeg: false, spec: { tag: 0x98, counter: s & 0xff, raw: [Math.round(77.5 * 256)] } });
  items.sort((a, b) => a.genS - b.genS);

  const inputs: DeviceInput[] = [{
    type: 'link', slot: DeviceSlot.MUSE, tUs: t0 - 1000, state: 'connected',
    config: { name: 'MuseS-SYNT', protocol: 'athena', preset: 'p1041' },
  }];
  let pktCounter = 0;
  let i = 0;
  let notif = 0;
  while (i < items.length) {
    const windowEnd = items[i].genS + 0.047;
    const packets: Uint8Array[] = [];
    let latestGen = items[i].genS;
    let firstEegOrdinal = -1;
    while (i < items.length && items[i].genS <= windowEnd && packets.length < 2) {
      const subs: SubpacketSpec[] = [];
      let size = 9;
      while (i < items.length && items[i].genS <= windowEnd) {
        const len = 5 + (items[i].spec.tag === 0x98 ? 20 : encodeLen(items[i].spec.tag));
        if (size + len > 250) break;
        size += len;
        if (items[i].eeg && firstEegOrdinal < 0) firstEegOrdinal = items[i].ordinal;
        latestGen = items[i].genS;
        subs.push(items[i++].spec);
      }
      packets.push(encodeAthenaPacket(pktCounter++, subs));
    }
    const k = firstEegOrdinal >= 0 ? firstEegOrdinal : notif;
    const tUs = t0 + Math.round(latestGen * 1e6) + Math.round(lat(k) * 1000);
    inputs.push(raw(MuseChar.ATHENA_DATA, tUs, concatBytes(packets)));
    notif++;
  }
  return { inputs: sortInputs(inputs), sentEeg, eegChannels: nCh };
}

function encodeLen(tag: number): number {
  return tag === 0x11 || tag === 0x12 ? 28 : tag === 0x34 ? 30 : tag === 0x35 || tag === 0x36 ? 40 : tag === 0x47 ? 36 : 24;
}
