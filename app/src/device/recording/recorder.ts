/**
 * Recorder: captures every decoder input (raw notification bytes with characteristic id and
 * integer-microsecond arrival time, and link changes) plus the decoded samples, into one HBRAW
 * file. Attach it to every source of a session; JavaScript delivers their events one at a time,
 * so the file holds them in the exact order the decoders saw them.
 */
import type { DeviceSource } from '../types';
import { RecordingWriter, type RecordingHeader } from './format';

export interface RecorderOptions {
  /** Also store decoded samples. Default true. */
  decoded?: boolean;
}

export class Recorder {
  private readonly writer: RecordingWriter;
  private readonly decoded: boolean;
  private lastTUs = 0;
  private detachers: (() => void)[] = [];
  private finished: Uint8Array | null = null;

  constructor(header: Omit<RecordingHeader, 'format' | 'version' | 'createdAt'> & { createdAt?: string }, opts: RecorderOptions = {}) {
    this.writer = new RecordingWriter({
      format: 'hurricane-brain-raw',
      version: 1,
      createdAt: header.createdAt ?? new Date().toISOString(),
      clock: header.clock,
      devices: header.devices,
      ...(header.meta ? { meta: header.meta } : {}),
    });
    this.decoded = opts.decoded ?? true;
  }

  get byteLength(): number {
    return this.writer.byteLength;
  }

  attach(source: DeviceSource): () => void {
    const offs: (() => void)[] = [];
    offs.push(
      source.on('input', (input) => {
        if (this.finished) return;
        this.lastTUs = input.tUs;
        this.writer.input(input);
      }),
    );
    if (this.decoded) {
      const t = () => this.lastTUs;
      offs.push(source.on('streams', (streams) => this.write({ kind: 'streams', tUs: t(), streams })));
      offs.push(source.on('eeg', (ev) => this.write({ kind: 'eeg', tUs: t(), ev })));
      offs.push(source.on('ppg', (ev) => this.write({ kind: 'ppg', tUs: t(), ev })));
      offs.push(source.on('motion', (ev) => this.write({ kind: 'motion', tUs: t(), ev })));
      offs.push(source.on('rr', (ev) => this.write({ kind: 'rr', tUs: t(), ev })));
      offs.push(source.on('heartRate', (ev) => this.write({ kind: 'heartRate', tUs: t(), ev })));
      offs.push(source.on('battery', (ev) => this.write({ kind: 'battery', tUs: t(), ev })));
      offs.push(source.on('gap', (ev) => this.write({ kind: 'gap', tUs: t(), ev })));
      offs.push(source.on('info', (ev) => this.write({ kind: 'info', tUs: t(), ev })));
    }
    const detach = () => offs.forEach((o) => o());
    this.detachers.push(detach);
    return detach;
  }

  /** Free-form annotation at the time of the latest input. */
  note(json: unknown): void {
    this.write({ kind: 'note', tUs: this.lastTUs, json });
  }

  private write(e: Parameters<RecordingWriter['event']>[0]): void {
    if (!this.finished) this.writer.event(e);
  }

  /** Stop recording and return the file bytes. Further calls return the same bytes. */
  finish(): Uint8Array {
    if (!this.finished) {
      this.detachers.forEach((d) => d());
      this.finished = this.writer.finish();
    }
    return this.finished;
  }
}
