/**
 * AudioWorkletProcessor hosting SynthCore. Loaded by audio-engine.ts as a separately bundled
 * module (Vite `?worker&url`), so it may import the core.
 *
 * All parameter changes arrive as control targets and are ramped per sample inside the core:
 * no zipper noise, no clicks.
 */

import { type FromWorklet, PROCESSOR_NAME, type ToWorklet, type WorkletOptions } from './messages.ts';
import { SynthCore } from './synth-core.ts';

// AudioWorkletGlobalScope is not in TypeScript's DOM lib. Minimal ambient declarations.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void;

class HurricaneSynthProcessor extends AudioWorkletProcessor {
  private core: SynthCore;
  private statusEvery: number;
  private sinceStatus = 0;
  private alive = true;

  constructor(options: { processorOptions?: unknown }) {
    super(options);
    const o = (options.processorOptions ?? {}) as Partial<WorkletOptions>;
    this.core = new SynthCore(sampleRate, o.settings ?? {});
    this.statusEvery = Math.max(128, Math.round((o.statusEveryS ?? 0.1) * sampleRate));
    this.port.onmessage = (e: MessageEvent<ToWorklet | { type: 'dispose' }>) => this.onMessage(e.data);
  }

  private onMessage(m: ToWorklet | { type: 'dispose' }): void {
    switch (m.type) {
      case 'settings':
        this.core.setSettings(m.patch);
        break;
      case 'control':
        this.core.setControl(m.control);
        break;
      case 'beat':
        this.core.scheduleBeat(m.atS, m.flagged);
        break;
      case 'anchor':
        this.core.playAnchor(m.params);
        break;
      case 'anchorStop':
        this.core.stopAnchor();
        break;
      case 'dispose':
        this.alive = false;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return this.alive;
    const l = out[0];
    const r = out.length > 1 ? out[1] : null;
    this.core.render(l, r);
    this.sinceStatus += l.length;
    if (this.sinceStatus >= this.statusEvery) {
      this.sinceStatus = 0;
      const msg: FromWorklet = { type: 'status', status: this.core.status() };
      this.port.postMessage(msg);
    }
    return this.alive;
  }
}

registerProcessor(PROCESSOR_NAME, HurricaneSynthProcessor);
