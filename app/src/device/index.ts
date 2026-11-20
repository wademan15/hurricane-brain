/**
 * Device layer public API. See README.md in this folder.
 */
import type { StreamDescription } from '../engine/frames';

export * from './types';
export { SessionClock, StreamClock, unwrapCounter } from './clock';
export type { SessionClockOptions, CounterStep } from './clock';
export { bluetoothAvailable, describeError } from './ble';
export type { BleSourceOptions, ReconnectPolicy, BluetoothLike, Timers } from './ble';
export { MuseDevice } from './muse/MuseDevice';
export type { MuseDeviceOptions } from './muse/MuseDevice';
export { MusePipeline } from './muse/pipeline';
export { PolarH10 } from './polar/PolarH10';
export type { PolarH10Options } from './polar/PolarH10';
export { ChestStrapPipeline } from './polar/pipeline';
export { parseHeartRateMeasurement } from './polar/hrm';
export { Recorder } from './recording/recorder';
export { ReplaySource } from './recording/replay';
export type { ReplayOptions } from './recording/replay';
export { readRecording, RecordingWriter, FORMAT_VERSION } from './recording/format';
export type { RecordingHeader, RecordedEvent, ParsedRecording } from './recording/format';

/**
 * Combine the partial descriptions of several sources (headset + chest strap) into the one
 * StreamDescription the engine is configured with. Later non-null parts win.
 */
export function mergeStreams(...parts: (StreamDescription | null | undefined)[]): StreamDescription {
  const out: StreamDescription = { eeg: null, ppg: null, motion: null, chest_strap: null };
  for (const p of parts) {
    if (!p) continue;
    if (p.eeg) out.eeg = p.eeg;
    if (p.ppg) out.ppg = p.ppg;
    if (p.motion) out.motion = p.motion;
    if (p.chest_strap) out.chest_strap = p.chest_strap;
  }
  return out;
}
