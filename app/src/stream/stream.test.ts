import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastFrame, HeartFrame, Measured, SlowFrame, StreamDescription } from '../engine/frames';
import { decodeMessage, encodeBinary, BinaryKind, mv, mvValue, type HeartMsg, type SlowMsg, type BinaryMessage } from './protocol';
import { StreamOut, type SocketLike, type StreamStatus } from './stream-out';

const ok = (v: number): Measured => ({ v, why: 'ok' });
const nul = (why: Measured['why'] = 'warming_up'): Measured => ({ v: null, why });

class FakeSocket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  onmessage: SocketLike['onmessage'] = null;
  sent: (string | ArrayBuffer)[] = [];
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; }
  send(d: string | ArrayBuffer) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

function harness(opts: ConstructorParameters<typeof StreamOut>[0] = {}) {
  const socks: FakeSocket[] = [];
  const out = new StreamOut({ socketFactory: (u) => { const s = new FakeSocket(u); socks.push(s); return s; }, ...opts });
  const statuses: StreamStatus[] = [];
  out.on('status', (s) => statuses.push(s));
  return { out, socks, statuses };
}

const desc: StreamDescription = {
  eeg: { channels: ['TP9', 'AF7', 'AF8', 'TP10'], rate_hz: 256, bits: 12, model: 'muse2' },
  ppg: { channels: ['a', 'b', 'c'], rate_hz: 64 },
  motion: { rate_hz: 52 },
  chest_strap: null,
};

function heartFrame(): HeartFrame {
  return {
    kind: 'heart', schema: 1, t: 12.5, source: 'chest_strap',
    beats: [{ t: 12.1, ibi_ms: 812, flagged: false }],
    hr_bpm: ok(74), rmssd_ms: nul('too_few_beats'), sdnn_ms: nul(), lf_power: nul(), hf_power: nul(),
    resonance_hz: ok(0.1), resonance_strength: ok(0.4), breath_bpm: nul('no_data'), breath_phase: nul(), pacer_adherence: nul('not_available'),
    corrected_fraction: 0, high_hrv: { active: false, for_s: 3, stat: nul(), enter_at: null, exit_at: null }, coupling: [],
  };
}

function slowFrame(): SlowFrame {
  const chance = { closeness: nul(), p: nul(), p_steps: nul() };
  const casc = (target: 'phi' | 'octave') => ({
    target, tracks: [1, 2], steps: 1, skipped: [], closeness: ok(0.9), held_s: 3,
    chance: { a: { closeness: ok(0.3), p: ok(0.04), p_steps: ok(0.1) }, b: chance },
    excess_a: ok(0.8), excess_b: nul('not_available'),
  });
  const tgt = { miss: ok(0.01), closeness: ok(0.99), log_evidence: ok(2), aligned: true };
  const band = { above_bg_db: ok(3), power: nul('insufficient_clean') };
  return {
    kind: 'slow', schema: 1, t: 30, window_s: 8,
    quality: [{ name: 'TP9', usable: true, why: 'ok', mains_uv: null, sd_uv: null, railed: null, emg_db: null, clean_fraction: 1, artifacts: ['blink'] }],
    spectra: [{ site: 'TP9', why: 'ok', f0: 1, df: 0.1, psd: [], flat: [], bg_exponent: nul(), bg_offset: nul(), k: 5,
      bands: { delta: band, theta: band, alpha: band, beta: band, gamma: band } }],
    tracks: [{ id: 1, state: 'confirmed', site: 'TP9', freq: { v: 10, se: 0.05, why: 'ok' }, freq_integrated: ok(10.01), height_db: ok(4), width_hz: nul(), age_s: 5, band: 'alpha', harmonic_of: null }],
    dominant: 1,
    pairs: [{ lo: 1, hi: 2, log_ratio: ok(0.48), harmonic: false, targets: { phi: tgt, octave: { ...tgt, aligned: false }, ratio_3: tgt, control_1_5: tgt, control_1_8: tgt } }],
    cascades: { phi: casc('phi'), octave: casc('octave') },
    states: {
      phi: { target: 'phi', active: true, for_s: 2, stat: ok(0.5), enter_at: 0.4, exit_at: 0.2 },
      octave: { target: 'octave', active: false, for_s: 9, stat: nul(), enter_at: null, exit_at: null },
      both: { active: false, for_s: 9 },
    },
    hemispheres: [], front_back: [], mains_hz: 50, iaf_hz: null,
    band_edges: { delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 45] },
  };
}

describe('protocol', () => {
  it('round trips binary EEG exactly', () => {
    const s = new Float32Array([1.5, -2.25, 3, 4, 5, 6, 7, 8]);
    const m = decodeMessage(encodeBinary(BinaryKind.EEG, 123456789, 4, s)) as BinaryMessage;
    expect(m.type).toBe('eeg');
    expect(m.position).toBe(123456789);
    expect(m.nChannels).toBe(4);
    expect(m.nSamples).toBe(2);
    expect(Array.from(m.samples)).toEqual(Array.from(s));
  });
  it('keeps NaN in binary samples as NaN, not zero', () => {
    const m = decodeMessage(encodeBinary(BinaryKind.PPG, 1.25, 1, new Float32Array([NaN, 2]))) as BinaryMessage;
    expect(m.type).toBe('ppg');
    expect(Number.isNaN(m.samples[0])).toBe(true);
  });
  it('rejects bad binary', () => {
    expect(() => decodeMessage(new ArrayBuffer(4))).toThrow();
    const b = new Uint8Array(encodeBinary(BinaryKind.EEG, 0, 1, new Float32Array([1])));
    b[0] = 0;
    expect(() => decodeMessage(b)).toThrow(/magic/);
    b[0] = 0x48; b[1] = 9;
    expect(() => decodeMessage(b)).toThrow(/version/);
  });
  it('mv: null becomes the reason, never 0', () => {
    expect(mv(ok(0))).toBe(0);
    expect(mv(nul('bad_fit'))).toBe('bad_fit');
    expect(mv({ v: null, why: 'ok' })).toBe('not_available');
    expect(mv({ v: NaN, why: 'ok' })).toBe('not_available');
    expect(mvValue('bad_fit')).toBeNull();
    expect(mvValue(0)).toBe(0);
  });
  it('slow frame round trips through JSON with nulls kept as reasons', () => {
    const { out, socks } = harness();
    out.connect('ws://localhost:8765');
    socks[0]!.open();
    out.handleFrame(slowFrame());
    const m = decodeMessage(socks[0]!.sent.at(-1) as string) as SlowMsg;
    expect(m.type).toBe('slow');
    expect(m.tracks[0]!.freq).toBe(10);
    expect(m.tracks[0]!.freq_se).toBe(0.05);
    expect(m.tracks[0]!.width_hz).toBe('warming_up');
    expect(m.bands[0]!.power).toBe('insufficient_clean');
    expect(m.cascades.phi.chance_a.p).toBe(0.04);
    expect(m.cascades.phi.excess_b).toBe('not_available');
    expect(m.pairs[0]!.octave.aligned).toBe(false);
    expect(m.states.both).toEqual({ active: false, for_s: 9 });
    expect(m.iaf_hz).toBeNull();
    expect(JSON.stringify(m)).not.toContain('"psd"');
  });
  it('heart and fast frames encode', () => {
    const { out, socks } = harness();
    out.connect('ws://x:1');
    socks[0]!.open();
    out.handleFrame(heartFrame());
    const h = decodeMessage(socks[0]!.sent.at(-1) as string) as HeartMsg;
    expect(h.hr_bpm).toBe(74);
    expect(h.rmssd_ms).toBe('too_few_beats');
    const fast: FastFrame = { kind: 'fast', schema: 1, t: 1, artifact: false, tracks: [{ id: 1, freq: ok(10), amp_uv: nul(), height_db: ok(3), phase: ok(0.1), locked: true, delay_s: 0.1 }] };
    out.handleFrame(fast);
    const f = decodeMessage(socks[0]!.sent.at(-1) as string);
    expect(f.type).toBe('fast');
  });
});

describe('StreamOut', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does nothing before connect()', () => {
    const { out, socks } = harness();
    out.setStreams(desc);
    out.handleEeg(0, new Float32Array(4));
    out.handleFrame(heartFrame());
    expect(socks.length).toBe(0);
    expect(out.status.state).toBe('idle');
    expect(out.stats.dropped).toBe(0);
  });

  it('rejects a bad URL without opening a socket', () => {
    const { out, socks } = harness();
    out.connect('http://localhost:8765');
    expect(socks.length).toBe(0);
    expect(out.status.state).toBe('error');
  });

  it('sends hello then streams on open, and the data afterwards', () => {
    const { out, socks, statuses } = harness();
    out.setStreams(desc);
    out.connect('ws://localhost:8765');
    expect(statuses.map((s) => s.state)).toEqual(['connecting']);
    const s = socks[0]!;
    expect(s.binaryType).toBe('arraybuffer');
    s.open();
    expect(statuses.at(-1)!.state).toBe('open');
    expect((decodeMessage(s.sent[0] as string) as { type: string }).type).toBe('hello');
    expect((decodeMessage(s.sent[1] as string) as { type: string }).type).toBe('streams');
    out.handleEeg(10, new Float32Array(8));
    const e = decodeMessage(s.sent[2] as ArrayBuffer) as BinaryMessage;
    expect(e.type).toBe('eeg');
    expect(e.position).toBe(10);
    expect(e.nSamples).toBe(2);
    out.handleMotion(1, new Float32Array([0, 0, 1]), [1, 2, 3]);
    out.handleRr(2, [800, 810]);
    out.handleBattery(80);
    out.handleMarker({ t: 3, type: 'note', label: 'hi' });
    out.handlePpg(4, new Float32Array(3));
    expect(out.stats.dropped).toBe(0);
    expect(out.stats.sent).toBe(8);
  });

  it('drops and counts while not open', () => {
    const { out, socks } = harness();
    out.connect('ws://localhost:8765');
    out.handleMotion(1, [0, 0, 0], [0, 0, 0]);
    expect(out.stats.droppedNotOpen).toBe(1);
    socks[0]!.open();
    out.handleMotion(1, [0, 0, 0], [0, 0, 0]);
    expect(out.stats.dropped).toBe(1);
  });

  it('drops and counts when the buffer is backed up, then recovers', () => {
    const { out, socks } = harness({ maxBufferedBytes: 1000 });
    out.connect('ws://localhost:8765');
    const s = socks[0]!;
    s.open();
    s.bufferedAmount = 5000;
    out.handleRr(1, [800]);
    out.handleRr(2, [800]);
    expect(out.stats.droppedBackedUp).toBe(2);
    const sentBefore = s.sent.length;
    s.bufferedAmount = 0;
    out.handleRr(3, [800]);
    expect(s.sent.length).toBe(sentBefore + 1);
  });

  it('never throws into the caller when send throws', () => {
    const { out, socks } = harness();
    out.connect('ws://localhost:8765');
    const s = socks[0]!;
    s.open();
    s.send = () => { throw new Error('boom'); };
    expect(() => out.handleRr(1, [800])).not.toThrow();
    expect(out.stats.dropped).toBe(1);
  });

  it('reconnects with exponential backoff and resends streams', () => {
    const { out, socks, statuses } = harness({ backoff: { baseMs: 100, maxMs: 350 } });
    out.setStreams(desc);
    out.connect('ws://localhost:8765');
    socks[0]!.drop();
    expect(out.status).toMatchObject({ state: 'error', attempt: 1, retryInMs: 100 });
    vi.advanceTimersByTime(99);
    expect(socks.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(socks.length).toBe(2);
    expect(out.status.state).toBe('connecting');
    socks[1]!.drop();
    expect(out.status).toMatchObject({ attempt: 2, retryInMs: 200 });
    vi.advanceTimersByTime(200);
    socks[2]!.drop();
    expect(out.status).toMatchObject({ attempt: 3, retryInMs: 350 }); // capped
    vi.advanceTimersByTime(350);
    socks[3]!.open();
    expect(out.status).toEqual({ state: 'open' });
    expect(socks[3]!.sent.length).toBe(2); // hello + streams
    // attempt counter reset after success
    socks[3]!.drop();
    expect(out.status).toMatchObject({ attempt: 1, retryInMs: 100 });
    expect(statuses.some((s) => s.state === 'error')).toBe(true);
  });

  it('disconnect cancels a pending reconnect and goes idle', () => {
    const { out, socks } = harness();
    out.connect('ws://localhost:8765');
    socks[0]!.drop();
    out.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(socks.length).toBe(1);
    expect(out.status.state).toBe('idle');
    out.handleRr(1, [800]);
    expect(out.stats.dropped).toBe(0);
  });

  it('a late close from a replaced socket is ignored', () => {
    const { out, socks } = harness();
    out.connect('ws://localhost:8765');
    out.connect('ws://localhost:9999');
    expect(socks[0]!.closed).toBe(true);
    socks[0]!.onclose?.({ code: 1006 });
    expect(socks.length).toBe(2);
    expect(out.status.state).toBe('connecting');
  });

  it('autoReconnect false stays in error', () => {
    const { out, socks } = harness({ autoReconnect: false });
    out.connect('ws://localhost:8765');
    socks[0]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(socks.length).toBe(1);
    expect(out.status.state).toBe('error');
  });

  it('factory throwing becomes an error status', () => {
    const out = new StreamOut({ socketFactory: () => { throw new Error('blocked'); } });
    expect(() => out.connect('ws://localhost:8765')).not.toThrow();
    expect(out.status).toMatchObject({ state: 'error', reason: 'blocked' });
    out.disconnect();
  });
});
