/** Messages between the main thread (audio-engine.ts) and the worklet (worklet.ts). */

import type { AnchorSynthParams } from './anchors.ts';
import type { AudioSettingsPatch } from './settings.ts';
import type { SynthControl, SynthStatus } from './synth-core.ts';

export const PROCESSOR_NAME = 'hurricane-brain-synth';

export type ToWorklet =
  | { type: 'settings'; patch: AudioSettingsPatch }
  | { type: 'control'; control: SynthControl }
  | { type: 'beat'; atS: number; flagged: boolean }
  | { type: 'anchor'; params: AnchorSynthParams }
  | { type: 'anchorStop' };

export type FromWorklet = { type: 'status'; status: SynthStatus };

/** processorOptions passed when the AudioWorkletNode is created. */
export interface WorkletOptions {
  settings: AudioSettingsPatch;
  /** How often the worklet posts a status snapshot, seconds. */
  statusEveryS: number;
}
