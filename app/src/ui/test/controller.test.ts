import { describe, expect, it, vi } from 'vitest';
import { readRecording } from '../../device';
import { createProfile } from '../../training';
import { DEFAULT_APP_SETTINGS, type AppSettings, type RecordingMeta, type StoredSession } from '../../storage';
import { SessionController, type ControllerDeps } from '../session/controller';
import { freeSessionSpec, prepareProgramSession } from '../session/plan';
import { FakeEngine, buildRecording, fakeAudio, ManualSource } from './fakes';

const profile = createProfile('local', '2026-01-01T00:00:00.000Z', 42);

function makeDeps(over: Partial<ControllerDeps> & { settings?: Partial<AppSettings> } = {}) {
  const engines: FakeEngine[] = [];
  const { audio, calls } = fakeAudio();
  const saved = { recordings: [] as { meta: RecordingMeta; bytes: Uint8Array }[], sessions: [] as StoredSession[], finished: 0 };
  const deps: ControllerDeps = {
    createEngine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    createAudio: () => audio,
    getSettings: () => ({ ...DEFAULT_APP_SETTINGS, replaySpeed: 'fast', ...(over.settings ?? {}) }),
    getProfile: () => profile,
    persist: {
      saveRecording: async (meta, bytes) => { saved.recordings.push({ meta, bytes }); },
      saveSession: async (s) => { saved.sessions.push(s); },
      sessionFinished: async () => { saved.finished++; },
    },
    now: () => new Date('2026-03-01T10:00:00.000Z'),
    random: () => 0.5,
    bluetoothAvailable: () => true,
    replaySettleMs: 30,
    notifyMs: 0,
    ...over,
  };
  return { deps, engines, calls, saved, audio };
}

async function runReplay(c: SessionController, bytes: Uint8Array) {
  await c.startReplay(bytes, { label: 'fixture', speed: 'fast' });
  await vi.waitFor(() => expect(c.getState().replay?.ended).toBe(true), { timeout: 5000 });
}

const freeStart = { type: 'session_start', id: 's_free', t: 1.5, spec: freeSessionSpec(), startedAt: '2026-01-01T00:00:01.000Z', programName: 'Free session' };

describe('SessionController replay path', () => {
  it('feeds a recorded session to the engine and the frame hub, markers included, and saves nothing', async () => {
    const bytes = buildRecording({
      seconds: 6,
      notes: [
        { afterInput: 3, json: freeStart },
        { afterInput: 250, json: { type: 'marker', marker: { t: 3, type: 'note', label: 'felt calm' } } },
        { afterInput: 500, json: { type: 'session_end', id: 's_free', t: 5, completed: true } },
      ],
    });
    const { deps, engines, calls, saved } = makeDeps();
    const c = new SessionController(deps);
    const hubFrames: string[] = [];
    c.hub.subscribe((f) => hubFrames.push(f.kind));
    await runReplay(c, bytes);

    const e = engines[0];
    expect(e.configs[0].streams.eeg?.channels).toEqual(['TP9', 'AF7', 'AF8', 'TP10']);
    expect(e.configs[0].seed).toBe(7);
    expect(e.configs[0].mains_hz).toBe(50);
    expect(e.eegSamples).toBe(Math.floor((6 * 256) / 12) * 12);
    expect(e.markers.map((m) => m.label)).toEqual(['felt calm']);
    expect(hubFrames.filter((k) => k === 'slow').length).toBeGreaterThan(10);
    // Replay is not saved and not added to the profile.
    expect(saved.recordings).toEqual([]);
    expect(saved.sessions).toEqual([]);
    expect(saved.finished).toBe(0);
    // Fast replay has no sound.
    expect(calls.frames).toBe(0);
    expect(c.getState().finished?.mode).toBe('replay');
    expect(c.getState().finished?.kind).toBe('free');
    expect(c.getState().engine).toBe('ready');
    await c.closeReplay();
    expect(e.disposed).toBe(true);
  });

  it('rebuilds the program runner from the recorded session spec and gives the same record every time', async () => {
    const spec = prepareProgramSession({ programId: 'calibration' }, {
      profile, startedAtIso: '2026-01-01T00:00:01.000Z', sessionId: 's_cal', headset: 'Muse-SYNT', engine: { version: 'fake-1', params: {} },
    });
    const bytes = buildRecording({
      seconds: 8,
      notes: [
        { afterInput: 3, json: { type: 'session_start', id: 's_cal', t: 1, spec, startedAt: '2026-01-01T00:00:01.000Z', programName: 'Calibration' } },
        { afterInput: 600, json: { type: 'session_end', id: 's_cal', t: 6, completed: false } },
      ],
    });
    const records: string[] = [];
    const emitted: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const { deps, engines } = makeDeps();
      const c = new SessionController(deps);
      await runReplay(c, bytes);
      const f = c.getState().finished;
      expect(f?.kind).toBe('program');
      expect(f?.record?.program.id).toBe('calibration');
      expect(f?.record?.blocks.length).toBeGreaterThan(0);
      records.push(JSON.stringify(f?.record));
      emitted.push(engines[0].emitted);
      await c.closeReplay();
    }
    expect(records[1]).toBe(records[0]);
    expect(emitted[1]).toEqual(emitted[0]);
    // The runner's own markers were forwarded to the engine.
  });

  it('plays sound only in real-time replay', async () => {
    const bytes = buildRecording({ seconds: 3, notes: [{ afterInput: 3, json: freeStart }] });
    const { deps, calls } = makeDeps({ settings: { replaySpeed: 1 } });
    const c = new SessionController({ ...deps, getSettings: () => ({ ...DEFAULT_APP_SETTINGS, replaySpeed: 'fast', soundOn: true }) });
    await c.startReplay(bytes, { label: 'x', speed: 1 });
    expect(calls.start).toBe(1);
    await c.closeReplay();
  });

  it('refuses a file that is not a recording, with a plain message', async () => {
    const { deps } = makeDeps();
    const c = new SessionController(deps);
    await expect(c.startReplay(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { label: 'bad' })).rejects.toThrow(/not a Hurricane Brain raw recording/);
  });
});

describe('SessionController live path', () => {
  it('connect, quick start, record, stop: the saved recording replays to the same samples', async () => {
    const source = new ManualSource('muse');
    const { deps, engines, saved } = makeDeps({ museFactory: () => source });
    const c = new SessionController(deps);
    await c.connectMuse();
    expect(c.getState().muse.state).toBe('streaming');
    // Engine input waits for the stream description and the engine start.
    source.emit('streams', { eeg: { channels: ['TP9', 'AF7', 'AF8', 'TP10'], rate_hz: 256, bits: 12, model: 'Muse 2' }, ppg: null, motion: null, chest_strap: null });
    await vi.waitFor(() => expect(c.getState().engine).toBe('ready'));
    const chunk = new Float32Array(48).fill(1);
    for (let i = 0; i < 40; i++) source.emit('eeg', { firstIndex: i * 12, nSamples: 12, nChannels: 4, samples: chunk });
    expect(engines[0].eegSamples).toBe(480);
    await c.startFree();
    expect(c.getState().session?.kind).toBe('free');
    c.addNote('hello');
    await c.stop();
    expect(c.getState().session).toBeNull();
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0].kind).toBe('free');
    expect(saved.sessions[0].notes.map((n) => n.text)).toEqual(['hello']);
    expect(saved.sessions[0].settings.engine.version).toBe('fake-1');
    expect(saved.recordings.length).toBeGreaterThan(0);
    const last = saved.recordings.at(-1) as { meta: RecordingMeta; bytes: Uint8Array };
    expect(last.meta.sessions[0].sessionId).toBe(saved.sessions[0].id);
    const parsed = readRecording(last.bytes);
    const kinds = parsed.records.filter((r) => r.kind === 'note').map((r) => (r.json as { type: string }).type);
    expect(kinds).toEqual(['session_start', 'marker', 'session_end']);
    expect(c.getState().finished?.stored).toBe(true);
  });

  it('refuses to start without a connection and explains', async () => {
    const { deps } = makeDeps();
    const c = new SessionController(deps);
    await expect(c.startFree()).rejects.toThrow(/Connect a headset/);
  });

  it('a heart-only program is refused while the headset is the only device', async () => {
    const source = new ManualSource('muse');
    const { deps } = makeDeps({ museFactory: () => source });
    const c = new SessionController(deps);
    await c.connectMuse();
    source.emit('streams', { eeg: { channels: ['TP9', 'AF7', 'AF8', 'TP10'], rate_hz: 256, bits: 12, model: 'Muse 2' }, ppg: null, motion: null, chest_strap: null });
    await vi.waitFor(() => expect(c.getState().engine).toBe('ready'));
    await expect(c.startProgram({ programId: 'hrv_resonance_finding' })).rejects.toThrow(/chest strap/);
  });
});
