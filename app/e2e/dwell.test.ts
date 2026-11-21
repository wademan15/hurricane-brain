/** Fake test 3, check (d): exit dwell. Frames where a state is active while its statistic is null or at/below the
 *  exit level; what the audio control (FrameBinder) does in those frames, and how long the dwell lasted.
 *  Run: cd app && npx vitest run e2e/dwell.test.ts   Output: out/dwell3.json */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { ReplaySource } from '../src/device/recording/replay';
import { FrameBinder } from '../src/audio/bindings';
import { SynthCore } from '../src/audio/synth-core';
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..', 'src', 'wasm', 'pkg');
async function frames(file: string) {
  const wasm = await import(join(pkg, 'hb_wasm.js'));
  wasm.initSync({ module: readFileSync(join(pkg, 'hb_wasm_bg.wasm')) });
  const src = new ReplaySource(new Uint8Array(readFileSync(file)), { speed: 'fast' });
  let session: any = null; const out: any[] = [];
  const drain = () => { if (session && session.pending() > 0) for (const f of JSON.parse(session.drain())) out.push(f); };
  src.on('streams', (s: any) => { if (!session) session = new wasm.HbSession(JSON.stringify({ streams: s, params: null, seed: 1, mains_hz: null })); });
  src.on('eeg', (e: any) => { session.pushEeg(e.firstIndex, e.samples); drain(); });
  await src.start(); session.free(); return out;
}
it('dwell', async () => {
  const rep: any = {};
  for (const n of ['both_phi_octave_12db', 'phi5_15db', 'octave3_10db', 'phi3_10db', 'form_dissolve_120s']) {
    const fr = await frames(join(here, 'out', 'recordings', n + '.hbraw'));
    const settings = { gains: { tones: 1, bed: 1, bloom: 1, heart: 1, breath: 1, anchor: 1 } } as any;
    const binder = new FrameBinder(settings); const core = new SynthCore(48000, settings);
    const res: any = {}; let sample: any = null; const trace: any[] = [];
    const runs: Record<string, any[]> = { phi: [], octave: [], both: [] }; const open: Record<string, any> = {};
    for (const f of fr) {
      const o: any = binder.handleFrame(f, core.timeS);
      if (!f.states) continue;
      if (n === 'both_phi_octave_12db' && f.t >= 68 && f.t <= 86 && Math.abs(f.t * 2 - Math.round(f.t * 2)) < 0.01) trace.push({ t: f.t, phi: f.states.phi, oct: f.states.octave, both: f.states.both, cas: f.cascades });
      if (!sample) sample = Object.keys(f.states.phi);
      const vs = (o.control.voices || []).filter((v: any) => v.on);
      const bl = { phi: Math.max(0, ...vs.map((v: any) => v.phi)), octave: Math.max(0, ...vs.map((v: any) => v.octave)), both: Math.max(0, ...vs.map((v: any) => v.both ?? 0)) };
      for (const k of ['phi', 'octave', 'both']) {
        const s = f.states[k]; const stat = s.stat === null || s.stat === undefined ? null : (typeof s.stat === 'object' ? (s.stat.v ?? null) : s.stat);
        const dw = s.active && k !== 'both' && s.exit_at !== undefined && (stat === null || stat === undefined || (s.exit_at !== null && s.exit_at !== undefined && stat < s.exit_at));
        if (dw && !open[k]) open[k] = { start: f.t, frames: 0, maxBloom: 0, statSeen: [] as any[] };
        if (open[k]) { if (dw) { open[k].frames++; open[k].statSeen.push([+f.t.toFixed(2), stat === null ? null : +stat.toFixed(2), +bl[k as 'phi'].toFixed(3)]); open[k].maxBloom = Math.max(open[k].maxBloom, bl[k as 'phi']); } else { open[k].end = f.t; open[k].endedActive = s.active; runs[k].push(open[k]); open[k] = null; } }
      }
    }
    for (const k of Object.keys(open)) if (open[k]) { open[k].end = fr[fr.length - 1].t; open[k].endedActive = true; runs[k].push(open[k]); }
    rep[n] = { trace, fields: sample, nFrames: fr.length, runsActiveWithNullStat: runs };
  }
  writeFileSync(join(here, 'out', 'dwell3.json'), JSON.stringify(rep, null, 1));
}, 600000);
