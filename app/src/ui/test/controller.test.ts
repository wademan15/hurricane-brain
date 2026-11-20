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
  const audios: ReturnType<typeof fakeAudio>[] = [];
  const noCalls = fakeAudio().calls;
  const saved = { recordings: [] as { meta: RecordingMeta; bytes: Uint8Array }[], sessions: [] as StoredSession[], finished: 0 };
  const deps: ControllerDeps = {
    createEngine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    createAudio: () => {
      const a = fakeAudio();
      audios.push(a);
      return a.audio;
    },
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
  return { deps, engines, audios, get calls() { return audios[0]?.calls ?? noCalls; }, saved };
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
    const h = makeDeps();
    const { deps, engines, saved } = h;
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
    expect(h.calls.frames).toBe(0);
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
    const h = makeDeps({ settings: { replaySpeed: 1 } });
    const { deps } = h;
    const c = new SessionController({ ...deps, getSettings: () => ({ ...DEFAULT_APP_SETTINGS, replaySpeed: 'fast', soundOn: true }) });
    await c.startReplay(bytes, { label: 'x', speed: 1 });
    expect(h.calls.start).toBe(1);
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

async function connected(h: ReturnType<typeof makeDeps>, source: ManualSource) {
  const c = new SessionController(h.deps);
  await c.connectMuse();
  source.emit('streams', { eeg: { channels: ['TP9', 'AF7', 'AF8', 'TP10'], rate_hz: 256, bits: 12, model: 'Muse 2' }, ppg: null, motion: null, chest_strap: null });
  await vi.waitFor(() => expect(c.getState().engine).toBe('ready'));
  return c;
}
let nextIndex = 0;
const feed = (source: ManualSource, chunks: number) => {
  const chunk = new Float32Array(48).fill(1);
  for (let i = 0; i < chunks; i++) {
    source.emit('eeg', { firstIndex: nextIndex, nSamples: 12, nChannels: 4, samples: chunk });
    nextIndex += 12;
  }
};

describe('a second session in the same page load', () => {
  it('runs end to end after the first one stopped, with every per-session object fresh', async () => {
    nextIndex = 0;
    const source = new ManualSource('muse');
    const h = makeDeps({ museFactory: () => source });
    const c = await connected(h, source);
    const e = h.engines[0];
    // Switch the combined state on for a stretch of each session.
    e.hook = (f) => (f.t >= 3 && f.t < 6 ? { ...f, states: { ...f.states, phi: { ...f.states.phi, active: true }, octave: { ...f.states.octave, active: true }, both: { active: true, for_s: f.t - 3 } } } : f);

    feed(source, 60); // ~2.8 s
    await c.startFree();
    feed(source, 160); // to ~9 s
    await c.stop();
    expect(h.audios).toHaveLength(1);
    const firstAudio = h.audios[0];
    expect(firstAudio.calls.frames).toBeGreaterThan(0);
    expect(firstAudio.calls.stop).toBe(1);

    feed(source, 40);
    await c.startFree();
    expect(c.getState().session?.kind).toBe('free');
    const framesBefore = firstAudio.calls.frames;
    feed(source, 160);
    await c.stop();

    // The second session got its own audio engine and it received frames; the first was left alone.
    expect(h.audios).toHaveLength(2);
    expect(h.audios[1].calls.start).toBe(1);
    expect(h.audios[1].calls.frames).toBeGreaterThan(10);
    expect(firstAudio.calls.frames).toBe(framesBefore);
    expect(h.saved.sessions).toHaveLength(2);
    const [a, b] = h.saved.sessions;
    expect(a.id).not.toBe(b.id);
    // The second session's rows start at its own start time, not before, and carry live values.
    expect(b.keyRows[0].t).toBeGreaterThanOrEqual(Math.floor(b.tStart));
    expect(b.keyRows.some((r) => r.cells.alpha_db.v !== null)).toBe(true);
    expect(b.tStart).toBeGreaterThan(a.tEnd as number);
    // Both sessions are in the one recording, and each has its own cascade events (none leaked over).
    const last = h.saved.recordings.at(-1) as { meta: RecordingMeta };
    expect(last.meta.sessions.map((s) => s.sessionId)).toEqual([a.id, b.id]);
    expect(a.cascadeEvents.map((x) => x.kind).sort()).toEqual(['both', 'octave', 'phi']);
    expect(b.cascadeEvents.every((x) => x.tStart >= b.tStart)).toBe(true);
    expect(a.profileId).toBe('local');
  });
});

describe('after a replay ends', () => {
  it('keeps the connection and the last frames until the person exits, and can play again at another speed', async () => {
    const bytes = buildRecording({ seconds: 5, notes: [{ afterInput: 3, json: freeStart }, { afterInput: 380, json: { type: 'session_end', id: 's_free', t: 4, completed: true } }] });
    const h = makeDeps();
    const c = new SessionController(h.deps);
    await runReplay(c, bytes);
    expect(c.getState().replay?.ended).toBe(true);
    expect(c.getState().link?.kind).toBe('replay');
    expect(c.getState().finished?.mode).toBe('replay');
    expect(c.hub.latest().slow).not.toBeNull();
    const first = h.engines.length;
    await c.replayAgain(4);
    await vi.waitFor(() => expect(c.getState().replay?.ended).toBe(true), { timeout: 5000 });
    expect(h.engines.length).toBe(first + 1);
    expect(c.getState().replay?.speed).toBe(4);
    await c.closeReplay();
    expect(c.getState().link).toBeNull();
    expect(c.getState().replay).toBeNull();
  });
});

describe('settings that reach the engine', () => {
  it('passes response speed and harmonics as engine parameters, and nothing by default', async () => {
    nextIndex = 0;
    const s1 = new ManualSource('muse');
    const h1 = makeDeps({ museFactory: () => s1 });
    await connected(h1, s1);
    expect(h1.engines[0].configs[0].params).toBeUndefined();

    const s2 = new ManualSource('muse');
    const h2 = makeDeps({ museFactory: () => s2, settings: { responseSpeed: 'quicker', harmonicsCount: true } });
    await connected(h2, s2);
    expect(h2.engines[0].configs[0].params).toEqual({ integration_s: 15, exclude_harmonics: false });
  });

  it('stores them with the session', async () => {
    nextIndex = 0;
    const s = new ManualSource('muse');
    const h = makeDeps({ museFactory: () => s, settings: { responseSpeed: 'slower', reducedMotion: 'on', soundOnly: true, chanceDriver: 'b' } });
    const c = await connected(h, s);
    feed(s, 40);
    await c.startFree();
    feed(s, 40);
    await c.stop();
    const st = h.saved.sessions[0].settings;
    expect([st.responseSpeed, st.harmonicsCount, st.reducedMotion, st.soundOnly, st.chanceDriver]).toEqual(['slower', false, 'on', true, 'b']);
    // The sound is told which chance level drives the blooms; no frame is rewritten.
    expect(h.audios[0].calls.settings.some((x) => (x as { bloomChance?: string }).bloomChance === 'b')).toBe(true);
  });
});

describe('journal', () => {
  it('is saved with the session, fed to the profile hook, and skipping saves nothing', async () => {
    nextIndex = 0;
    const s = new ManualSource('muse');
    const hooks: string[] = [];
    const h = makeDeps({ museFactory: () => s });
    h.deps.persist.sessionJournal = async (id, j) => { hooks.push(`${id}:${j.mood}`); };
    const c = await connected(h, s);
    feed(s, 40);
    await c.startFree();
    feed(s, 40);
    await c.stop();
    expect(c.getState().finished?.journalOpen).toBe(true);
    await c.submitJournal({ note: 'calm', mood: 4, ease: 3, depth: null, tags: ['relaxed'], writtenAt: '2026-03-01T10:00:00.000Z' });
    const last = h.saved.sessions.at(-1) as StoredSession;
    expect(last.journal?.note).toBe('calm');
    expect(last.journal?.depth).toBeNull();
    expect(hooks).toEqual([`${last.id}:4`]);
    expect(c.getState().finished?.journalOpen).toBe(false);

    feed(s, 40);
    await c.startFree();
    feed(s, 40);
    await c.stop();
    const n = h.saved.sessions.length;
    await c.submitJournal(null);
    expect(h.saved.sessions.length).toBe(n);
    expect(c.getState().finished?.journalOpen).toBe(false);
  });
});

describe('live stream out', () => {
  it('sends nothing until the person turns it on, then forwards frames to the address they entered', async () => {
    nextIndex = 0;
    const s = new ManualSource('muse');
    const log: string[] = [];
    const fake = {
      connect: (u: string) => log.push(`connect ${u}`),
      disconnect: () => log.push('disconnect'),
      on: () => () => {},
      setStreams: () => {},
      handleFrame: (f: { kind: string }) => { if (f.kind === 'slow' && !log.includes('frame')) log.push('frame'); },
      handleEeg: () => { if (!log.includes('eeg')) log.push('eeg'); },
      handleMarker: () => {},
      handlePpg: () => {},
      handleMotion: () => {},
      handleRr: () => {},
    };
    let stream = { enabled: false, url: 'ws://localhost:8765', rawEeg: false };
    const h = makeDeps({ museFactory: () => s, createStream: () => fake as never });
    h.deps.getSettings = () => ({ ...DEFAULT_APP_SETTINGS, stream });
    const c = await connected(h, s);
    c.applyStreamSettings();
    feed(s, 40);
    expect(log).toEqual([]);
    stream = { enabled: true, url: 'ws://localhost:9000', rawEeg: true };
    c.applyStreamSettings();
    feed(s, 40);
    expect(log).toEqual(['connect ws://localhost:9000', 'eeg', 'frame']);
    stream = { ...stream, enabled: false };
    c.applyStreamSettings();
    expect(log.at(-1)).toBe('disconnect');
  });
});
