/**
 * Skeptic fake test, step 1: lab fixtures -> HBRAW recordings as a Muse 2 (Classic) would have made them.
 *
 * Fixture microvolts -> 12-bit raw (uV = 0.48828125 * (raw - 2048)) -> real Classic EEG packets
 * (device/test/encoder via synthClassic) -> ReplaySource (the real MusePipeline decode path) -> Recorder.
 * Session start/end notes are added exactly as the app writes them for a free session.
 * Quantisation to 12 bits (0.488 uV steps, clipped at +-1000 uV) is expected and is part of the test.
 *
 * Run: cd app && npx vitest run e2e/make-recordings.test.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { Recorder } from '../src/device/recording/recorder';
import { ReplaySource } from '../src/device/recording/replay';
import { RecordingWriter } from '../src/device/recording/format';
import { synthClassic } from '../src/device/test/synth';
import { CLASSIC_EEG_MIDPOINT, CLASSIC_EEG_SCALE_UV } from '../src/device/muse/constants';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '..', '..', 'lab', 'fixtures');
const outDir = join(here, 'out', 'recordings');
const FS = 256;

const NAMES = ['phi3_10db', 'phi5_15db', 'octave3_10db', 'background_only', 'white_noise', 'random_bands', 'harmonic_8hz', 'artifact_blinks', 'artifact_jaw_clench', 'nearmiss_1.8_10db',
  // second run additions
  'phi2_6db', 'phi3_3db', 'phi3_10db_phase_randomized', 'phi3_10db_loss1pct', 'form_dissolve_120s', 'drift_band_edge', 'artifact_railed_mains60', 'nearmiss_1.5_10db', 'nearmiss_1.55_10db', 'nearmiss_1.7_10db'];

function load(name: string, dir = fixtures): { x: Float32Array; n: number; nch: number } {
  const b = readFileSync(join(dir, `${name}.f32`));
  const x = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return { x, n: x.length / 4, nch: 4 };
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(n: number, rnd: () => number): Int32Array {
  const p = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}
/** Per channel seeded permutation of samples (blockLen 1) or of whole blocks (blockLen > 1). */
function shuffleFixture(x: Float32Array, n: number, blockLen: number, seed: number): Float32Array {
  const out = new Float32Array(x.length);
  const rnd = mulberry32(seed);
  for (let ch = 0; ch < 4; ch++) {
    const nb = Math.floor(n / blockLen);
    const perm = shuffled(nb, rnd);
    for (let b = 0; b < nb; b++) {
      for (let k = 0; k < blockLen; k++) out[(b * blockLen + k) * 4 + ch] = x[(perm[b] * blockLen + k) * 4 + ch];
    }
    for (let i = nb * blockLen; i < n; i++) out[i * 4 + ch] = x[i * 4 + ch]; // tail stays
  }
  return out;
}

async function toRecording(name: string, x: Float32Array, n: number): Promise<{ bytes: Uint8Array; clipped: number; seconds: number; dropped: number }> {
  const seconds = Math.floor((n - 11) / FS); // whole 12-sample packets
  let clipped = 0;
  const raw = (ch: number, idx: number) => {
    const uv = x[idx * 4 + ch];
    let r = Math.round(uv / CLASSIC_EEG_SCALE_UV) + CLASSIC_EEG_MIDPOINT;
    if (r < 0) { r = 0; clipped++; } else if (r > 4095) { r = 4095; clipped++; }
    return r;
  };
  const dropEeg = new Set<number>();
  for (let p = 0; p * 12 < n; p++) if (Number.isNaN(x[p * 12 * 4])) dropEeg.add(p);
  const rawSafe = (ch: number, idx: number) => (Number.isNaN(x[idx * 4 + ch]) ? 2048 : raw(ch, idx));
  const syn = synthClassic({ seconds: seconds + 1, eeg: rawSafe, dropEeg, ppg: false, motion: false, t0Us: 1_000_000, latencyMs: () => 15 });
  // 1) the raw notifications as a first file
  const hdr = { clock: { eegRateHz: 256 as number | null, settleSamples: 256 }, devices: [{ slot: 0 as const, kind: 'muse' as const, name: 'Muse-2 (synthetic)' }] };
  const w = new RecordingWriter({ format: 'hurricane-brain-raw', version: 1, createdAt: '2026-01-01T00:00:00.000Z', ...hdr, meta: { seed: 1, mains_hz: null, engineOverrides: {}, heartOnly: false, source: `lab/fixtures/${name}` } });
  for (const i of syn.inputs) w.input(i);
  const first = w.finish();
  // 2) through the real decode path into a Recorder, as the app records a live session
  const rec = new Recorder({ ...hdr, createdAt: '2026-01-01T00:00:00.000Z', meta: { seed: 1, mains_hz: null, engineOverrides: {}, heartOnly: false, source: `lab/fixtures/${name}` } });
  const src = new ReplaySource(first, { speed: 'fast' });
  rec.attach(src);
  let started = false;
  const id = `s_e2e_${name}`;
  src.on('input', (i) => {
    if (started || i.type !== 'raw') return;
    started = true;
    rec.note({ type: 'session_start', id, t: 0, spec: { kind: 'free', programId: null, instantiate: null, runner: null }, startedAt: '2026-01-01T00:00:00.000Z', programName: 'Free session' });
  });
  await src.start();
  rec.note({ type: 'session_end', id, t: seconds, completed: true });
  return { bytes: rec.finish(), clipped, seconds, dropped: dropEeg.size };
}

it('make recordings', async () => {
  mkdirSync(outDir, { recursive: true });
  const index: Record<string, unknown> = {};
  const jobs: { name: string; src: string; x: Float32Array; n: number; note: string }[] = [];
  for (const nm of NAMES) { const f = load(nm); jobs.push({ name: nm, src: nm, x: f.x, n: f.n, note: 'fixture as is' }); }
  const base = load('phi3_10db');
  jobs.push({ name: 'phi3_10db_shuffled_samples', src: 'phi3_10db', x: shuffleFixture(base.x, base.n, 1, 20260101), n: base.n, note: 'per-channel seeded permutation of samples (seed 20260101)' });
  jobs.push({ name: 'phi3_10db_shuffled_2s_blocks', src: 'phi3_10db', x: shuffleFixture(base.x, base.n, 512, 20260102), n: base.n, note: 'per-channel seeded permutation of 2 s (512-sample) blocks (seed 20260102)' });
  jobs.push({ name: 'phi3_10db_shuffled_20ms_blocks', src: 'phi3_10db', x: shuffleFixture(base.x, base.n, 5, 20260103), n: base.n, note: 'per-channel seeded permutation of 5-sample (about 20 ms) blocks (seed 20260103): sub-cycle, must be calm' });
  const both = load('both_phi_octave_12db', join(here, 'out', 'fixtures-extra'));
  jobs.push({ name: 'both_phi_octave_12db', src: 'both_phi_octave_12db', x: both.x, n: both.n, note: 'golden ratio cascade 3.0/4.85/7.85 Hz plus octave cascade 6.2/12.4/24.8 Hz, 12 dB', dir: join(here, 'out', 'fixtures-extra') } as any);
  for (const j of jobs) {
    const r = await toRecording(j.name, j.x, j.n);
    writeFileSync(join(outDir, `${j.name}.hbraw`), r.bytes);
    const truth = JSON.parse(readFileSync(join((j as any).dir ?? fixtures, `${j.src}.json`), 'utf8'));
    index[j.name] = { bytes: r.bytes.length, seconds: r.seconds, clippedSamples: r.clipped, droppedPackets: r.dropped, note: j.note, kind: truth.kind, truth: { schedule: truth.truth?.schedule, phi_freqs: truth.truth?.phi_freqs, octave_freqs: truth.truth?.octave_freqs, cascade_freqs: truth.truth?.cascade_freqs, ratio: truth.truth?.ratio, n_members: truth.truth?.n_members, peaks: (truth.truth?.peaks ?? []).map((p: { f0: number; snr_db: number }) => ({ f0: p.f0, snr_db: p.snr_db })) } };
    console.log(j.name, r.bytes.length, 'bytes', r.seconds, 's', 'clipped', r.clipped);
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 1));
}, 600_000);
