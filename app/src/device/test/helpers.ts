/** TEST ONLY. Run inputs through the pipelines and collect what comes out. */
import { SessionClock } from '../clock';
import { MusePipeline } from '../muse/pipeline';
import { ChestStrapPipeline } from '../polar/pipeline';
import type { DeviceEvents, DeviceInput } from '../types';

export type Collected = { [K in keyof DeviceEvents]: DeviceEvents[K][] };

export function emptyCollected(): Collected {
  return { status: [], streams: [], eeg: [], ppg: [], motion: [], rr: [], heartRate: [], battery: [], gap: [], info: [], error: [], input: [] };
}

export function runPipelines(inputs: DeviceInput[], opts: { eegRateHz?: number | null; settleSamples?: number } = {}) {
  const got = emptyCollected();
  const out = <K extends keyof DeviceEvents>(type: K, ev: DeviceEvents[K]) => (got[type] as DeviceEvents[K][]).push(ev);
  const clock = new SessionClock({ eegRateHz: opts.eegRateHz === undefined ? 256 : opts.eegRateHz });
  const muse = new MusePipeline(out, { clock, settleSamples: opts.settleSamples });
  const strap = new ChestStrapPipeline(out, clock);
  for (const i of inputs) {
    muse.push(i);
    strap.push(i);
  }
  return { got, clock, muse, strap };
}

/** EEG events -> map from sample index to channel values (asserting no index is emitted twice). */
export function eegByIndex(events: DeviceEvents['eeg'][]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const e of events) {
    for (let s = 0; s < e.nSamples; s++) {
      const idx = e.firstIndex + s;
      if (m.has(idx)) throw new Error(`index ${idx} emitted twice`);
      m.set(idx, Array.from(e.samples.subarray(s * e.nChannels, (s + 1) * e.nChannels)));
    }
  }
  return m;
}

/** Frequency of the strongest component between lo and hi Hz, from samples at known indices. */
export function peakFrequency(byIndex: Map<number, number[]>, ch: number, rate: number, lo: number, hi: number, step = 0.0005): number {
  const idx = [...byIndex.keys()].sort((a, b) => a - b);
  const x = idx.map((i) => byIndex.get(i)![ch]);
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  let best = lo, bestP = -1;
  for (let f = lo; f <= hi; f += step) {
    let re = 0, im = 0;
    for (let k = 0; k < idx.length; k++) {
      const ph = (2 * Math.PI * f * idx[k]) / rate;
      re += (x[k] - mean) * Math.cos(ph);
      im += (x[k] - mean) * Math.sin(ph);
    }
    const p = re * re + im * im;
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}
