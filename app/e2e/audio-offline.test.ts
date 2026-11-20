/**
 * Offline audio path of the fake test. The built app does not expose AudioEngine.getDebug() on window,
 * so: recording (HBRAW) -> ReplaySource (real decode) -> wasm engine in Node (same push calls as the app's
 * controller) -> frames -> FrameBinder + SynthCore (the worklet's own DSP) rendered at 48 kHz.
 * Reports, per recording, RMS of the full mix, the tone layer alone, the bloom layer alone and the
 * peak golden ratio / octave bloom amounts of any voice, every 10 s, plus whether the output was ever non-silent.
 * Run: cd app && npx vitest run e2e/audio-offline.test.ts
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { ReplaySource } from '../src/device/recording/replay';
import { FrameBinder } from '../src/audio/bindings';
import { SynthCore } from '../src/audio/synth-core';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..', 'src', 'wasm', 'pkg');
const recDir = join(here, 'out', 'recordings');
const SR = 48000;

async function frames(file: string) {
  const wasm = await import(join(pkg, 'hb_wasm.js'));
  wasm.initSync({ module: readFileSync(join(pkg, 'hb_wasm_bg.wasm')) });
  const src = new ReplaySource(new Uint8Array(readFileSync(file)), { speed: 'fast' });
  let session: any = null;
  const out: any[] = [];
  const drain = () => { if (session && session.pending() > 0) for (const f of JSON.parse(session.drain())) out.push(f); };
  src.on('streams', (s: any) => {
    if (!session) session = new wasm.HbSession(JSON.stringify({ streams: s, params: null, seed: 1, mains_hz: null }));
  });
  src.on('eeg', (e: any) => { session.pushEeg(e.firstIndex, e.samples); drain(); });
  await src.start();
  session.free();
  return out;
}

function rms(x: Float32Array, a: number, b: number) {
  let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function render(fr: any[], seconds: number, gains: Record<string, number>, probe: boolean) {
  const settings = { gains: { tones: 1, bed: 1, bloom: 1, heart: 1, breath: 1, anchor: 1, ...gains } } as any;
  const core = new SynthCore(SR, settings);
  const binder = new FrameBinder(settings);
  const total = Math.round(seconds * SR);
  const L = new Float32Array(total), R = new Float32Array(total);
  const per: { t: number; maxPhi: number; maxOct: number; voices: number; bed: boolean }[] = [];
  let k = 0, curPhi = 0, curOct = 0, curV = 0, curBed = false;
  for (let pos = 0; pos < total; pos += 128) {
    const t = pos / SR;
    while (k < fr.length && fr[k].t <= t) {
      const o = binder.handleFrame(fr[k], core.timeS);
      core.setControl(o.control);
      for (const b of o.beats) core.scheduleBeat(b.atS, b.flagged);
      k++;
    }
    core.render(L, R, pos, Math.min(128, total - pos));
    if (probe && pos % (SR / 4) < 128) {
      const st = core.status();
      curPhi = Math.max(curPhi, ...st.voices.map((v) => v.phi), 0);
      curOct = Math.max(curOct, ...st.voices.map((v) => v.octave), 0);
      curV = Math.max(curV, st.voices.length);
      curBed = curBed || st.bed.gate > 0.01;
      if (Math.floor(t) % 10 === 9 && pos % SR >= SR - 128 - SR / 4) { per.push({ t: Math.floor(t) + 1, maxPhi: curPhi, maxOct: curOct, voices: curV, bed: curBed }); curPhi = curOct = curV = 0; curBed = false; }
    }
  }
  return { L, per };
}

it('audio offline', async () => {
  const names = readdirSync(recDir).filter((f) => f.endsWith('.hbraw')).map((f) => f.slice(0, -6));
  const report: Record<string, any> = {};
  for (const name of names) {
    const fr = await frames(join(recDir, `${name}.hbraw`));
    const slow = fr.filter((f) => f.kind === 'slow');
    const seconds = Math.ceil(fr[fr.length - 1].t) + 1;
    const full = render(fr, seconds, {}, true);
    const tones = render(fr, seconds, { bed: 0, bloom: 0, heart: 0, breath: 0, anchor: 0 }, false);
    const bloom = render(fr, seconds, { tones: 0, bed: 0, heart: 0, breath: 0, anchor: 0 }, false);
    const rows: any[] = [];
    for (let a = 0; a < seconds; a += 10) {
      const b = Math.min(seconds, a + 10);
      const p = full.per.find((q) => q.t === b) ?? { maxPhi: 0, maxOct: 0, voices: 0, bed: false };
      rows.push({ from: a, to: b, rmsFull: rms(full.L, a * SR, b * SR), rmsTones: rms(tones.L, a * SR, b * SR), rmsBloom: rms(bloom.L, a * SR, b * SR), maxPhiBloom: p.maxPhi, maxOctBloom: p.maxOct, maxVoices: p.voices, bedOn: p.bed });
    }
    let peak = 0; for (const x of full.L) peak = Math.max(peak, Math.abs(x));
    // frame-side facts
    const last = slow[slow.length - 1];
    const maxPhiSteps = Math.max(...slow.map((f) => f.cascades.phi.steps));
    const maxOctSteps = Math.max(...slow.map((f) => f.cascades.octave.steps));
    const phiActive = slow.filter((f) => f.states.phi.active).length, octActive = slow.filter((f) => f.states.octave.active).length;
    const maxConfirmed = Math.max(...slow.map((f) => f.tracks.filter((t: any) => t.state === 'confirmed').length));
    report[name] = { seconds, peak, maxPhiSteps, maxOctSteps, phiActiveSlowFrames: phiActive, octActiveSlowFrames: octActive, slowFrames: slow.length, maxConfirmed, rows };
    console.log(name, 'peak', peak.toFixed(4), 'phiSteps', maxPhiSteps, 'octSteps', maxOctSteps, 'confirmedMax', maxConfirmed, 'phiActive', phiActive, 'octActive', octActive);
    for (const r of rows) console.log('  ', r.from, '-', r.to, 'full', r.rmsFull.toExponential(2), 'tones', r.rmsTones.toExponential(2), 'bloom', r.rmsBloom.toExponential(2), 'phi', r.maxPhiBloom.toFixed(2), 'oct', r.maxOctBloom.toFixed(2), 'voices', r.maxVoices, 'bed', r.bedOn);
  }
  writeFileSync(join(here, 'out', 'audio-offline.json'), JSON.stringify(report, null, 1));
}, 1_800_000);
