/**
 * TEST TOOLING. Builds a stored session (the app's StoredSession shape) from a recording by running
 * it through the real wasm engine in Node and through the same classes the app's controller uses
 * (KeyRowSampler for the per-second rows, CascadeLogger for the event log). The Playwright script
 * puts it into the built app's IndexedDB so History can be looked at without a headset.
 * Run: cd app && npx vitest run e2e/make-session.test.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { ReplaySource } from '../src/device/recording/replay';
import { DEFAULT_AUDIO_SETTINGS } from '../src/audio/settings';
import { CascadeLogger } from '../src/ui/session/cascadeLog';
import { KeyRowSampler } from '../src/ui/session/keyrows';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..', 'src', 'wasm', 'pkg');

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

it('make seed session', async () => {
  const name = 'phi3_10db';
  const fr = await frames(join(here, 'out', 'recordings', `${name}.hbraw`));
  const sampler = new KeyRowSampler();
  const log = new CascadeLogger();
  sampler.start(0);
  for (const f of fr) {
    if (f.kind === 'slow') log.push(f);
    sampler.push(f);
  }
  const tEnd = fr[fr.length - 1].t;
  const stored = {
    id: 's_seed_phi3', kind: 'free', startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:02:00.000Z', programId: null, programName: 'Free session (recorded)',
    state: null, recordingId: null, tStart: 0, tEnd, record: null, keyRows: sampler.rows,
    settings: { audio: DEFAULT_AUDIO_SETTINGS, viz: { quality: 'medium', rampS: 0.5, slowStaleS: 1, heartStaleS: 2.5 }, mains: 'auto', chanceDriver: 'a', responseSpeed: 'steady', harmonicsCount: false, reducedMotion: 'system', soundOnly: false, ageGroup: null, engine: { version: 'seed', params: null }, engineOverrides: {}, appVersion: '1.1.0' },
    completed: true, profileId: 'PROFILE', cascadeEvents: log.finish(),
    journal: { note: 'Felt settled after a minute. A little sleepy at the end.', mood: 4, ease: 3, depth: 4, tags: ['relaxed', 'sleepy'], writtenAt: '2026-11-20T10:03:00.000Z' },
    notes: [],
  };
  mkdirSync(join(here, 'out', 'seed'), { recursive: true });
  writeFileSync(join(here, 'out', 'seed', 'session.json'), JSON.stringify(stored));
  console.log('events', stored.cascadeEvents.length, 'rows', stored.keyRows.length);
});
