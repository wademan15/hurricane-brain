/**
 * LinkRecorder: the device layer's Recorder, with one addition: `snapshot()` returns the file
 * so far without ending the recording, so one connection can hold several sessions and be saved
 * after each. It writes the same HBRAW file through the device layer's RecordingWriter and
 * attaches to sources exactly as Recorder does (raw inputs plus decoded events, in arrival order).
 */
import { RecordingWriter, type DeviceSource, type RecordingHeader } from '../../device';

export type LinkRecorderHeader = Omit<RecordingHeader, 'format' | 'version' | 'createdAt'> & { createdAt?: string };

export class LinkRecorder {
  private readonly writer: RecordingWriter;
  private lastTUs = 0;
  private detachers: (() => void)[] = [];
  private closed = false;

  constructor(header: LinkRecorderHeader) {
    this.writer = new RecordingWriter({
      format: 'hurricane-brain-raw',
      version: 1,
      createdAt: header.createdAt ?? new Date().toISOString(),
      clock: header.clock,
      devices: header.devices,
      ...(header.meta ? { meta: header.meta } : {}),
    });
  }

  get byteLength(): number {
    return this.writer.byteLength;
  }

  attach(source: DeviceSource): () => void {
    const offs: (() => void)[] = [];
    const t = () => this.lastTUs;
    const w = (e: Parameters<RecordingWriter['event']>[0]) => this.write(e);
    offs.push(
      source.on('input', (input) => {
        if (this.closed) return;
        this.lastTUs = input.tUs;
        this.writer.input(input);
      }),
      source.on('streams', (streams) => w({ kind: 'streams', tUs: t(), streams })),
      source.on('eeg', (ev) => w({ kind: 'eeg', tUs: t(), ev })),
      source.on('ppg', (ev) => w({ kind: 'ppg', tUs: t(), ev })),
      source.on('motion', (ev) => w({ kind: 'motion', tUs: t(), ev })),
      source.on('rr', (ev) => w({ kind: 'rr', tUs: t(), ev })),
      source.on('heartRate', (ev) => w({ kind: 'heartRate', tUs: t(), ev })),
      source.on('battery', (ev) => w({ kind: 'battery', tUs: t(), ev })),
      source.on('gap', (ev) => w({ kind: 'gap', tUs: t(), ev })),
      source.on('info', (ev) => w({ kind: 'info', tUs: t(), ev })),
    );
    const detach = () => offs.forEach((o) => o());
    this.detachers.push(detach);
    return detach;
  }

  /** Free-form annotation at the time of the latest input (session start and end, markers). */
  note(json: unknown): void {
    this.write({ kind: 'note', tUs: this.lastTUs, json });
  }

  /** The file so far. Recording continues. */
  snapshot(): Uint8Array {
    return this.writer.finish();
  }

  /** Stop recording and return the file. */
  finish(): Uint8Array {
    if (!this.closed) {
      this.detachers.forEach((d) => d());
      this.closed = true;
    }
    return this.writer.finish();
  }

  private write(e: Parameters<RecordingWriter['event']>[0]): void {
    if (!this.closed) this.writer.event(e);
  }
}
