/**
 * SessionController: joins the device layer, the engine, the sound, the visuals, the training
 * runner and storage. A live headset and a replayed recording take exactly the same path:
 *
 *   DeviceSource events -> (LinkRecorder) -> EngineClient pushes
 *   EngineClient frames -> FrameHub -> HurricaneView / SpectrumView / readouts
 *                                   -> AudioEngine.handleFrame
 *                                   -> training runner -> events (guidance, pacer, anchors, ratings)
 *                                   -> key-second sampler
 *   runner markers -> EngineClient.pushMarker and the recording (as NOTE records, so a replay
 *   puts them back in the same place in the sample stream)
 *
 * The controller computes no measurement. It does not smooth, hold or fill in frames.
 */
import type { AudioEngine } from '../../audio';
import { sanitizeAnchor, type AnchorSynthParams } from '../../audio/anchors.ts';
import { DEFAULT_AUDIO_SETTINGS, mergeSettings } from '../../audio/settings.ts';
import {
  MuseDevice, PolarH10, ReplaySource, SessionClock, bluetoothAvailable, describeError, mergeStreams, readRecording,
  type ConnectionState, type DeviceSource, type ParsedRecording, type StatusEvent,
} from '../../device';
import type { EngineClient } from '../../engine/client';
import type { EngineConfig, Frame, Marker, StreamDescription } from '../../engine/frames';
import type { AgeGroup, AppSettings, Journal, ProfileInfo, RecordingMeta, RecordingSessionRef, ResponseSpeed, SessionSettings, StoredSession } from '../../storage';
import { StreamOut, type StreamStatus } from '../../stream';
import { VIZ_SMOOTHING } from '../../viz';
import {
  createSessionRunner, getProgram, instantiateProgram, SIGNATURE_FIELD,
  type RatingKey, type RunnerEvent, type RunnerOutput, type SessionRecord, type SessionRunner, type UserProfile,
} from '../../training';
import { CascadeLogger } from './cascadeLog';
import { CHILD_ENGINE_PARAMS } from './child';
import { FrameHub } from './hub';
import { KeyRowSampler } from './keyrows';
import { LinkRecorder } from './linkRecorder';
import { freeSessionSpec, newSessionId, prepareProgramSession, type ProgramRequest, type SessionSpec } from './plan';

export const APP_VERSION = '1.1.0';

/**
 * Alignment response speed as an engine parameter (spec 6.4 and 15): the integration time of the
 * frequency estimate. Steady is the engine default and is not passed. The engine recomputes the
 * chance level for the chosen speed.
 */
export const RESPONSE_SPEED_INTEGRATION_S: Record<ResponseSpeed, number | null> = { quicker: 15, steady: null, slower: 60 };

/** Engine parameters the settings choose (not the tolerance overrides), by name. */
export function enginePrefs(settings: Pick<AppSettings, 'responseSpeed' | 'harmonicsCount'>, ageGroup: AgeGroup | null = null): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  // A child's profile starts from the engine's child preset, then the speed choice on top (spec 5.4).
  if (ageGroup === 'child') Object.assign(out, CHILD_ENGINE_PARAMS);
  const s = RESPONSE_SPEED_INTEGRATION_S[settings.responseSpeed];
  if (s !== null) out.integration_s = s;
  if (settings.harmonicsCount) out.exclude_harmonics = false;
  return out;
}
const ALPHA_FIELD = 'spectra[temporal].bands.alpha.above_bg_db';

export interface ControllerDeps {
  createEngine: () => EngineClient;
  createAudio: () => AudioEngine;
  getSettings: () => AppSettings;
  getProfile: () => UserProfile | null;
  getProfileInfo?: () => ProfileInfo | null;
  /** The live stream out (off unless the user turned it on and entered an address). */
  createStream?: () => StreamOut;
  /** Save a recording snapshot and a session; fold a finished program session into the profile. */
  persist: {
    saveRecording: (meta: RecordingMeta, bytes: Uint8Array) => Promise<void>;
    saveSession: (s: StoredSession) => Promise<void>;
    sessionFinished: (record: SessionRecord) => Promise<void>;
    /** The journal entry for a saved session was written; fold it into the profile. */
    sessionJournal?: (sessionId: string, journal: Journal) => Promise<void>;
  };
  now?: () => Date;
  random?: () => number;
  bluetoothAvailable?: () => boolean;
  /** Test hooks for live devices. */
  museFactory?: (clock: SessionClock) => DeviceSource;
  strapFactory?: (clock: SessionClock) => DeviceSource;
  /** How long frames must be quiet before a replay is considered finished, ms. */
  replaySettleMs?: number;
  /** Minimum time between notifications to listeners, ms. */
  notifyMs?: number;
}

export interface DeviceView {
  state: ConnectionState | 'none';
  detail: string | null;
  attempt: number | null;
  retryInMs: number | null;
  name: string | null;
  battery: number | null;
}

export interface SessionView {
  id: string;
  kind: 'program' | 'free';
  mode: 'live' | 'replay';
  programId: string | null;
  programName: string;
  tStart: number;
  /** Seconds since the session started, on the session clock. */
  elapsedS: number;
  output: RunnerOutput | null;
  blockTitle: string | null;
  guidance: string | null;
  tether: string | null;
  checkFit: boolean;
  pacerBpm: number | null;
  /** True when a block asks for a breath guide and the guide sound is off. */
  guideOffNotice: boolean;
  ratingRequest: { blockIndex: number; keys: RatingKey[] } | null;
  finished: boolean;
  completed: boolean;
}

export interface FinishedView {
  sessionId: string;
  kind: 'program' | 'free';
  mode: 'live' | 'replay';
  programName: string;
  record: SessionRecord | null;
  stored: boolean;
  completed: boolean;
  /** True until a journal entry has been saved or skipped (saved sessions only). */
  journalOpen: boolean;
  journal: Journal | null;
  elapsedS: number;
}

export interface ControllerState {
  bluetooth: boolean;
  link: null | { kind: 'live' | 'replay'; heartOnly: boolean };
  muse: DeviceView;
  strap: DeviceView;
  engine: 'none' | 'starting' | 'ready' | 'error';
  engineError: string | null;
  engineInfo: { version: string; params: Record<string, number | string | boolean> } | null;
  streams: StreamDescription | null;
  gaps: number;
  /** Session clock seconds of the latest EEG (or latest frame in a heart-only link). */
  clockS: number | null;
  session: SessionView | null;
  finished: FinishedView | null;
  replay: null | { label: string; speed: 1 | 4 | 'fast'; ended: boolean; error: string | null };
  stream: StreamStatus;
  notice: string | null;
  soundOn: boolean;
}

const emptyDevice = (): DeviceView => ({ state: 'none', detail: null, attempt: null, retryInMs: null, name: null, battery: null });

/** Only if the engine never answers the end-of-feed barrier: how long without frames before a replay counts as ended. */
const REPLAY_END_FALLBACK_MS = 5000;

interface Link {
  kind: 'live' | 'replay';
  heartOnly: boolean;
  clock: SessionClock | null;
  recorder: LinkRecorder | null;
  recordingId: string;
  createdAt: string;
  streams: StreamDescription;
  seed: number;
  mainsHz: 50 | 60 | null;
  overrides: Record<string, number | boolean>;
  engine: EngineClient;
  unsubEngine: () => void;
  engineReady: boolean;
  queue: ((e: EngineClient) => void)[];
  initChain: Promise<void>;
  initGen: number;
  sources: DeviceSource[];
  offs: (() => void)[];
  eegT: number;
  eegRate: number;
  sessions: RecordingSessionRef[];
  lastSavedBytes: number;
}

interface ActiveSession {
  spec: SessionSpec;
  id: string;
  mode: 'live' | 'replay';
  startedAtIso: string;
  tStart: number;
  runner: SessionRunner | null;
  programName: string;
  sampler: KeyRowSampler;
  cascades: CascadeLogger;
  sentMarkers: Set<string>;
  notes: { t: number; text: string }[];
  sessionSettings: SessionSettings | null;
  view: SessionView;
  lastRunnerT: number;
  tetherUntil: number;
  finishing: boolean;
}

export class SessionController {
  readonly hub: FrameHub;
  private readonly deps: ControllerDeps;
  private audio: AudioEngine | null = null;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ControllerState;
  private link: Link | null = null;
  private active: ActiveSession | null = null;
  private lastFrameT = -Infinity;
  private lastDataWall = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private autosave: ReturnType<typeof setInterval> | null = null;
  private audioActive = false;
  private stream: StreamOut | null = null;
  private streamOff: (() => void) | null = null;
  private lastReplayInput: { parsed: ParsedRecording; label: string; sessionId: string | null } | null = null;
  private finishedCtx: { runner: SessionRunner | null; stored: StoredSession; t: number } | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameWall = 0;
  /** A replay link whose recording has ended: its late frames are dropped so nothing is shown after the end banner. */
  private replayClosed: Link | null = null;
  private replayNotes: { tUs: number; json: Record<string, unknown> }[] = [];
  private replayWanted: string | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.hub = new FrameHub();
    this.state = {
      bluetooth: (deps.bluetoothAvailable ?? bluetoothAvailable)(),
      link: null, muse: emptyDevice(), strap: emptyDevice(), engine: 'none', engineError: null, engineInfo: null,
      streams: null, gaps: 0, clockS: null, session: null, finished: null, replay: null, notice: null, soundOn: true,
      stream: { state: 'idle' },
    };
  }

  // ---- observable state ---------------------------------------------------------------------
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getState = (): ControllerState => this.state;

  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    this.scheduleNotify();
  }
  private scheduleNotify(): void {
    if (this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const l of [...this.listeners]) l();
    }, this.deps.notifyMs ?? 120);
  }
  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
  private rand(): number {
    return (this.deps.random ?? Math.random)();
  }
  dismissNotice(): void {
    this.set({ notice: null });
  }
  dismissFinished(): void {
    this.finishedCtx = null;
    this.set({ finished: null });
  }

  // ---- links --------------------------------------------------------------------------------
  private newLink(kind: 'live' | 'replay', heartOnly: boolean, hdr?: { seed: number; mains: 50 | 60 | null; overrides: Record<string, number | boolean> }): Link {
    const settings = this.deps.getSettings();
    const clock = kind === 'live' ? new SessionClock({ eegRateHz: heartOnly ? null : 256, hostOriginMs: performance.now() }) : null;
    const seed = hdr?.seed ?? Math.floor(this.rand() * 2 ** 31);
    const mains = hdr ? hdr.mains : settings.mains === 'auto' ? null : settings.mains;
    const overrides = hdr?.overrides ?? { ...settings.engineOverrides, ...enginePrefs(settings, this.deps.getProfileInfo?.()?.ageGroup ?? null) };
    const created = this.now().toISOString();
    const engine = this.deps.createEngine();
    const link: Link = {
      kind, heartOnly, clock,
      recorder: kind === 'live'
        ? new LinkRecorder({
            clock: { eegRateHz: heartOnly ? null : 256 },
            devices: [],
            meta: { seed, mains_hz: mains, engineOverrides: overrides, appVersion: APP_VERSION, heartOnly },
            createdAt: created,
          })
        : null,
      recordingId: `r_${created.replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.floor(this.rand() * 36 ** 3).toString(36)}`,
      createdAt: created,
      streams: { eeg: null, ppg: null, motion: null, chest_strap: null },
      seed, mainsHz: mains, overrides, engine,
      unsubEngine: () => {},
      engineReady: false, queue: [], initChain: Promise.resolve(), initGen: 0,
      sources: [], offs: [], eegT: 0, eegRate: 256, sessions: [], lastSavedBytes: 0,
    };
    link.unsubEngine = engine.subscribe((f) => this.onFrame(link, f));
    this.link = link;
    this.hub.reset();
    this.replayClosed = null;
    this.lastFrameT = -Infinity;
    this.set({ link: { kind, heartOnly }, engine: 'none', engineError: null, engineInfo: null, streams: null, gaps: 0, clockS: null });
    return link;
  }

  private ensureLiveLink(heartOnly: boolean): Link {
    if (this.link && this.link.kind === 'replay') throw new Error('A replay is open. Close it first.');
    if (this.link && this.link.heartOnly !== heartOnly && !this.active) {
      this.set({ notice: 'The connection was restarted. Connect the headset first, then the chest strap.' });
      void this.disposeLink();
    } else if (this.link && this.link.heartOnly !== heartOnly) {
      throw new Error('A session is running with a different kind of connection.');
    }
    return this.link ?? this.newLink('live', heartOnly);
  }

  async connectMuse(): Promise<void> {
    if (this.link?.sources.some((s) => s.kind === 'muse' && s.state !== 'stopped' && s.state !== 'failed')) return;
    const link = this.ensureLiveLink(false);
    const clock = link.clock as SessionClock;
    const dev = this.deps.museFactory ? this.deps.museFactory(clock) : new MuseDevice({ clock });
    this.wire(link, dev);
    try {
      await dev.start();
    } catch (e) {
      this.set({ notice: describeError(e) });
      throw e;
    }
  }

  async connectStrap(opts: { heartOnly?: boolean } = {}): Promise<void> {
    if (this.link?.sources.some((s) => s.kind === 'chest_strap' && s.state !== 'stopped' && s.state !== 'failed')) return;
    const link = this.ensureLiveLink(opts.heartOnly ?? (this.link?.heartOnly ?? false));
    const clock = link.clock as SessionClock;
    const dev = this.deps.strapFactory ? this.deps.strapFactory(clock) : new PolarH10({ clock });
    this.wire(link, dev);
    try {
      await dev.start();
    } catch (e) {
      this.set({ notice: describeError(e) });
      throw e;
    }
  }

  /** Disconnect devices and drop the connection (the recording is kept only if a session ran). */
  async disconnect(): Promise<void> {
    if (this.active) throw new Error('Stop the session first.');
    await this.disposeLink();
  }

  private wire(link: Link, src: DeviceSource): void {
    // The recorder attaches first so it sees every event before anything that might transfer a buffer.
    if (link.recorder) link.offs.push(link.recorder.attach(src));
    link.sources.push(src);
    const slotKey = src.kind === 'muse' ? 'muse' : src.kind === 'chest_strap' ? 'strap' : null;
    const offs = [
      src.on('status', (s: StatusEvent) => this.onStatus(link, slotKey, src, s)),
      src.on('streams', (s) => this.onStreams(link, s)),
      src.on('eeg', (e) => {
        link.eegRate = link.eegRate || 256;
        const t = (e.firstIndex + e.nSamples) / link.eegRate;
        if (t > link.eegT) link.eegT = t;
        this.lastDataWall = performance.now();
        if (this.streamRaw()) this.stream?.handleEeg(e.firstIndex, e.samples);
        this.push(link, (en) => en.pushEeg(e.firstIndex, e.samples));
        this.set({ clockS: link.eegT });
      }),
      src.on('ppg', (e) => {
        if (this.streamRaw()) this.stream?.handlePpg(e.t, e.samples);
        this.push(link, (en) => en.pushPpg(e.t, e.samples));
      }),
      src.on('motion', (e) => {
        if (this.streamRaw()) this.stream?.handleMotion(e.t, e.acc, e.gyro);
        this.push(link, (en) => en.pushMotion(e.t, e.acc, e.gyro));
      }),
      src.on('rr', (e) => {
        this.lastDataWall = performance.now();
        if (link.heartOnly && e.t > link.eegT) link.eegT = e.t;
        if (this.streamRaw()) this.stream?.handleRr(e.t, e.rrMs);
        this.push(link, (en) => en.pushRr(e.t, e.rrMs));
      }),
      src.on('battery', (b) => {
        const key = b.slot === 1 ? 'strap' : 'muse';
        this.set({ [key]: { ...this.state[key], battery: b.percent } } as Partial<ControllerState>);
      }),
      src.on('gap', () => this.set({ gaps: this.state.gaps + 1 })),
      src.on('error', (e) => this.set({ notice: e.message })),
    ];
    if (link.kind === 'replay') offs.push(src.on('input', (i) => this.flushNotes(link, i.tUs)));
    link.offs.push(...offs);
  }

  private onStatus(link: Link, key: 'muse' | 'strap' | null, src: DeviceSource, s: StatusEvent): void {
    if (key) {
      const name = (src as unknown as { deviceName?: string | null }).deviceName ?? this.state[key].name;
      this.set({
        [key]: { state: s.state, detail: s.detail ?? null, attempt: s.attempt ?? null, retryInMs: s.retryInMs ?? null, name, battery: this.state[key].battery },
      } as Partial<ControllerState>);
      if (s.state === 'failed' && s.detail) this.set({ notice: s.detail });
    }
    void link;
  }

  private onStreams(link: Link, s: StreamDescription): void {
    const merged = mergeStreams(link.streams, s);
    if (JSON.stringify(merged) === JSON.stringify(link.streams)) return;
    link.streams = merged;
    this.stream?.setStreams(merged);
    if (merged.eeg) link.eegRate = merged.eeg.rate_hz;
    this.set({ streams: merged });
    this.initEngine(link);
  }

  private initEngine(link: Link): void {
    const gen = ++link.initGen;
    link.engineReady = false;
    this.set({ engine: 'starting', engineError: null });
    const config: EngineConfig = {
      streams: link.streams,
      seed: link.seed,
      mains_hz: link.mainsHz,
      ...(Object.keys(link.overrides).length ? { params: { ...link.overrides } } : {}),
    };
    link.initChain = link.initChain
      .then(async () => {
        if (gen !== link.initGen || this.link !== link) return;
        await link.engine.init(config);
        const info = await link.engine.info();
        if (gen !== link.initGen || this.link !== link) return;
        const iaf = this.deps.getProfile()?.calibrations.at(-1)?.iafHz ?? null;
        link.engine.setIaf(iaf);
        link.engineReady = true;
        for (const fn of link.queue.splice(0)) fn(link.engine);
        this.set({ engine: 'ready', engineInfo: info });
      })
      .catch((e: unknown) => {
        // A connection that was closed while its engine was still starting is not an error to show.
        if (this.link !== link || gen !== link.initGen) return;
        link.queue.length = 0;
        this.set({ engine: 'error', engineError: e instanceof Error ? e.message : String(e), notice: `The signal engine could not start: ${e instanceof Error ? e.message : String(e)}` });
      });
  }

  /** Engine input is queued until init has finished; nothing is dropped or invented meanwhile. */
  private push(link: Link, fn: (e: EngineClient) => void): void {
    if (this.link !== link) return;
    if (link.engineReady) fn(link.engine);
    else if (this.state.engine !== 'error' && link.queue.length < 20000) link.queue.push(fn);
  }

  private async disposeLink(): Promise<void> {
    const link = this.link;
    if (!link) return;
    this.link = null;
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
    link.initGen++;
    for (const s of link.sources) {
      try {
        await s.stop();
      } catch {
        /* already gone */
      }
    }
    link.offs.forEach((o) => o());
    link.unsubEngine();
    try {
      link.engine.dispose();
    } catch {
      /* ignore */
    }
    link.recorder?.finish();
    this.hub.reset();
    this.releaseAudio();
    this.set({ link: null, muse: emptyDevice(), strap: emptyDevice(), engine: 'none', engineInfo: null, streams: null, clockS: null, replay: null });
  }

  /** Best estimate of "now" on the session clock. Never moves backwards. */
  private sessionNow(link: Link): number {
    let t = Math.max(link.eegT, Number.isFinite(this.lastFrameT) ? this.lastFrameT : 0);
    if (link.kind === 'live' && this.lastDataWall > 0) {
      const quiet = (performance.now() - this.lastDataWall) / 1000;
      if (quiet > 1) t += quiet;
    }
    return t;
  }

  // ---- frames -------------------------------------------------------------------------------
  private onFrame(link: Link, f: Frame): void {
    if (this.link !== link || this.replayClosed === link) return;
    if (f.t > this.lastFrameT) this.lastFrameT = f.t;
    this.lastFrameWall = performance.now();
    const a = this.active;
    if (f.kind === 'slow' && a && !a.finishing) a.cascades.push(f);
    this.stream?.handleFrame(f);
    if (a?.runner) {
      a.runner.push(f);
      this.afterRunner(link, a);
    }
    if (a && !a.finishing) {
      if (a.runner && f.kind !== 'fast') {
        const out = a.runner.output();
        a.sampler.reward = out.reward.level;
        a.sampler.block = out.block?.id ?? null;
        a.view = { ...a.view, output: out };
      }
      a.sampler.push(f);
    }
    this.hub.emit(f);
    if (this.audioActive && this.audio) {
      this.audio.handleFrame(f);
    }
    if (a && !a.finishing && f.kind === 'slow') this.refreshView(link, a, f.t);
  }

  // ---- sessions -----------------------------------------------------------------------------
  /** Prepare and start a program session. Call from a tap (audio and Bluetooth need a gesture). */
  async startProgram(req: ProgramRequest): Promise<void> {
    const link = this.requireLive();
    const profile = this.deps.getProfile();
    if (!profile) throw new Error('Set up a profile first.');
    const program = getProgram(req.programId);
    if (!program) throw new Error(`unknown program '${req.programId}'`);
    this.checkRequirements(program.requires, link);
    const now = this.now();
    const sessionId = this.nextSessionId(now, program.id);
    const headset = this.state.muse.name ?? link.streams.eeg?.model ?? null;
    const spec = prepareProgramSession(req, { profile, startedAtIso: now.toISOString(), sessionId, headset, engine: this.state.engineInfo ?? { version: null, params: null } });
    await this.beginSession(link, spec, sessionId, 'live');
  }

  async startFree(): Promise<void> {
    const link = this.requireLive();
    const now = this.now();
    await this.beginSession(link, freeSessionSpec(), this.nextSessionId(now, null), 'live');
  }

  /** A session id that cannot repeat within this page load, whatever the clock and the random source do. */
  private sessionCount = 0;
  private nextSessionId(now: Date, programId: string | null): string {
    return `${newSessionId(now, () => this.rand(), programId)}_${++this.sessionCount}`;
  }

  private requireLive(): Link {
    const link = this.link;
    if (!link || link.kind !== 'live') throw new Error('Connect a headset or chest strap first, or open a recording to replay.');
    if (this.active) throw new Error('A session is already running.');
    if (this.state.engine === 'error') throw new Error('The signal engine is not running.');
    return link;
  }

  private checkRequirements(req: { eeg: boolean; heart: 'none' | 'optional' | 'required' }, link: Link): void {
    if (req.eeg && link.heartOnly) throw new Error('This program needs the headset. You are connected to the chest strap only.');
    if (req.eeg && !this.state.muse.state.match(/streaming|reconnecting/)) throw new Error('Connect the headset first.');
    if (req.heart === 'required' && !this.state.strap.state.match(/streaming|reconnecting/)) throw new Error('This program needs the chest strap. Connect it first.');
  }

  private async beginSession(link: Link, spec: SessionSpec, id: string, mode: 'live' | 'replay', startT?: number): Promise<void> {
    const settings = this.deps.getSettings();
    let runner: SessionRunner | null = null;
    let programName = 'Free session';
    if (spec.kind === 'program' && spec.programId && spec.runner) {
      const program = getProgram(spec.programId);
      if (!program) throw new Error(`unknown program '${spec.programId}'`);
      programName = program.name;
      const plan = instantiateProgram(program, spec.instantiate ?? {});
      runner = createSessionRunner(plan, spec.runner);
    }
    if (mode === 'live') {
      if (settings.soundOn) await this.startAudio(settings);
      link.engine.setPacer(null);
    }
    const t0 = startT ?? this.sessionNow(link);
    const sampler = new KeyRowSampler();
    sampler.start(t0);
    this.finishedCtx = null;
    const view: SessionView = {
      id, kind: spec.kind, mode, programId: spec.programId, programName, tStart: t0, elapsedS: 0, output: null, blockTitle: null,
      guidance: null, tether: null, checkFit: false, pacerBpm: null, guideOffNotice: false, ratingRequest: null, finished: false, completed: false,
    };
    const a: ActiveSession = {
      spec, id, mode, startedAtIso: this.now().toISOString(), tStart: t0, runner, programName, sampler, cascades: new CascadeLogger(), sentMarkers: new Set(), notes: [],
      sessionSettings: null, view, lastRunnerT: t0, tetherUntil: 0, finishing: false,
    };
    this.active = a;
    if (mode === 'live') {
      link.recorder?.note({ type: 'session_start', id, t: t0, spec, startedAt: a.startedAtIso, programName });
      link.sessions.push({ sessionId: id, kind: spec.kind, programId: spec.programId, programName, tStart: t0, tEnd: null });
      a.sessionSettings = this.snapshotSettings(settings);
      this.tick = setInterval(() => this.onTick(link), 500);
      this.autosave = setInterval(() => void this.saveRecordingSnapshot(link, true), 120_000);
    }
    this.audioActive = mode === 'live' ? settings.soundOn : this.audioActive;
    if (runner) {
      runner.start(t0);
      this.afterRunner(link, a);
    }
    this.set({ session: view, finished: null });
  }

  private snapshotSettings(settings: AppSettings): SessionSettings {
    const info = this.state.engineInfo;
    return {
      audio: this.audio?.getSettings() ?? mergeSettings(DEFAULT_AUDIO_SETTINGS, { ...settings.audio, bloomChance: settings.chanceDriver }),
      viz: { quality: settings.vizQuality, rampS: VIZ_SMOOTHING.RAMP_S, slowStaleS: VIZ_SMOOTHING.SLOW_STALE_S, heartStaleS: VIZ_SMOOTHING.HEART_STALE_S },
      mains: settings.mains,
      chanceDriver: settings.chanceDriver,
      responseSpeed: settings.responseSpeed,
      harmonicsCount: settings.harmonicsCount,
      reducedMotion: settings.reducedMotion,
      soundOnly: settings.soundOnly,
      ageGroup: this.deps.getProfileInfo?.()?.ageGroup ?? null,
      engine: { version: info?.version ?? null, params: info?.params ?? null },
      engineOverrides: { ...settings.engineOverrides },
      appVersion: APP_VERSION,
    };
  }

  /**
   * Sound for one session. The audio engine is created fresh for every session (and dropped when
   * the session ends), so no smoothing state, frame clock or voice carries over from the last one.
   */
  private async startAudio(settings: AppSettings): Promise<void> {
    if (!this.audio) this.audio = this.deps.createAudio();
    this.audio.setSettings({ ...settings.audio, bloomChance: settings.chanceDriver });
    this.audio.setSettings({ breathGuide: { enabled: false } });
    await this.audio.start();
  }

  /** Fade the current session's sound out and forget the engine. */
  private releaseAudio(): void {
    const au = this.audio;
    this.audio = null;
    this.audioActive = false;
    if (au) void au.stop().catch(() => {});
  }

  /** Settings changed: apply the sound settings to a sound that is running. */
  applyAudioSettings(): void {
    const s = this.deps.getSettings();
    this.audio?.setSettings({ ...s.audio, bloomChance: s.chanceDriver });
  }

  /** Called from a tap on the live screen to make sure sound is running (for example after a reload). */
  async ensureAudio(): Promise<void> {
    if (!this.deps.getSettings().soundOn) return;
    await this.startAudio(this.deps.getSettings());
    this.audioActive = !!this.active || !!this.state.replay;
  }

  getAudio(): AudioEngine {
    if (!this.audio) this.audio = this.deps.createAudio();
    return this.audio;
  }

  /** Audition sound (anchors) outside a session: uses its own engine, released afterwards. */
  hasAudio(): boolean {
    return this.audio !== null;
  }

  setSoundOn(on: boolean): void {
    this.set({ soundOn: on });
    if (!on) this.releaseAudio();
    else if (this.active) void this.ensureAudio();
  }

  private onTick(link: Link): void {
    const a = this.active;
    if (!a || this.link !== link) return;
    if (a.runner && !a.finishing) {
      const t = Math.max(this.sessionNow(link), a.lastRunnerT);
      // With no frames arriving the session clock still moves, and values are then null.
      if (performance.now() - this.lastFrameWall > 1500) {
        a.runner.advance(t);
        a.lastRunnerT = t;
        this.afterRunner(link, a);
      }
    }
    this.refreshView(link, a);
  }

  /** Drain runner events and forward its markers. */
  private afterRunner(link: Link, a: ActiveSession, canFinish = true): void {
    const r = a.runner;
    if (!r) return;
    const events = r.drainEvents();
    for (const e of events) this.onRunnerEvent(link, a, e);
    if (events.length) {
      a.view = { ...a.view, output: r.output() };
      if (this.active === a) this.set({ session: a.view });
    }
    for (const m of r.markers()) {
      const key = `${m.t}|${m.type}|${m.label ?? ''}|${JSON.stringify(m.data ?? null)}`;
      if (a.sentMarkers.has(key)) continue;
      a.sentMarkers.add(key);
      this.sendMarker(link, m);
    }
    if (canFinish && r.isFinished() && !a.finishing) void this.finishSession(true);
  }

  private sendMarker(link: Link, m: Marker): void {
    this.stream?.handleMarker(m);
    this.push(link, (en) => en.pushMarker(m));
    if (link.kind === 'live') link.recorder?.note({ type: 'marker', marker: m });
  }

  private onRunnerEvent(link: Link, a: ActiveSession, e: RunnerEvent): void {
    const v = a.view;
    switch (e.type) {
      case 'block_start':
        v.blockTitle = e.block.guidance.title;
        v.guidance = e.block.guidance.start;
        v.ratingRequest = null;
        v.checkFit = false;
        break;
      case 'instruction':
        v.guidance = e.text;
        break;
      case 'block_end':
        this.updateAudioBaseline(a);
        break;
      case 'pacer': {
        v.pacerBpm = e.bpm;
        link.engine.setPacer(e.bpm);
        const guideOn = !!this.deps.getSettings().audio.breathGuide?.enabled;
        if (this.audio && this.audioActive) {
          this.audio.setSettings({ breathGuide: { enabled: e.bpm !== null && guideOn, ...(e.bpm !== null ? { bpm: e.bpm } : {}) } });
        }
        v.guideOffNotice = e.bpm !== null && !guideOn;
        break;
      }
      case 'play_anchor':
      case 'play_control': {
        const id = e.type === 'play_anchor' ? e.anchorId : e.controlId;
        const prof = this.deps.getProfile();
        const rec = prof?.anchors.find((x) => (e.type === 'play_anchor' ? x.id === id : x.control.id === id));
        if (rec && this.audio && this.audioActive) {
          const synth = (e.type === 'play_anchor' ? rec.synth : rec.control.synth) as unknown as AnchorSynthParams;
          this.audio.playAnchor(sanitizeAnchor(synth));
        }
        break;
      }
      case 'rating_request':
        v.ratingRequest = { blockIndex: e.blockIndex, keys: e.keys };
        break;
      case 'tether':
        v.tether = e.text;
        a.tetherUntil = e.t + 20;
        break;
      case 'check_fit':
        v.checkFit = true;
        break;
      case 'session_end':
        break;
    }
  }

  private updateAudioBaseline(a: ActiveSession): void {
    if (!this.audio || !a.runner) return;
    const b = a.runner.record().baselines[ALPHA_FIELD] ?? this.deps.getProfile()?.baselines[`${ALPHA_FIELD}|closed`];
    if (b && b.field !== SIGNATURE_FIELD) this.audio.setBaseline({ alphaAboveBgDbMean: b.mean, alphaAboveBgDbSd: b.sd });
  }

  private refreshView(link: Link, a: ActiveSession, frameT?: number): void {
    const t = frameT ?? Math.max(this.sessionNow(link), a.lastRunnerT);
    const tether = a.view.tether && t > a.tetherUntil ? null : a.view.tether;
    a.view = { ...a.view, tether, elapsedS: Math.max(0, t - a.tStart) };
    if (this.active === a) this.set({ session: a.view });
  }

  // ---- user actions during a session --------------------------------------------------------
  rate(ratings: Partial<Record<RatingKey, number>>): void {
    const a = this.active;
    if (!a?.runner || !this.link) return;
    a.runner.rate(this.sessionNow(this.link), ratings);
    a.view = { ...a.view, ratingRequest: null };
    this.afterRunner(this.link, a);
    this.set({ session: a.view });
  }

  skipBlock(): void {
    const a = this.active;
    if (!a?.runner || !this.link) return;
    a.runner.skipBlock(this.sessionNow(this.link));
    this.afterRunner(this.link, a);
  }

  /** A free-text note or a mark ("now") at the current time. Written to the engine and the recording. */
  addNote(text: string): void {
    const a = this.active;
    const link = this.link;
    if (!a || !link) return;
    const t = this.sessionNow(link);
    a.notes.push({ t, text });
    if (a.runner) {
      a.runner.report(t, text);
      this.afterRunner(link, a);
    } else {
      this.sendMarker(link, { t, type: 'note', label: text });
    }
  }

  /** Free sessions: switch the breath guide on or off at a chosen rate. The guide is not a measurement. */
  setFreeBreathGuide(bpm: number | null): void {
    const link = this.link;
    if (!link || !this.active || this.active.spec.kind !== 'free') return;
    link.engine.setPacer(bpm);
    this.audio?.setSettings({ breathGuide: { enabled: bpm !== null, ...(bpm !== null ? { bpm } : {}) } });
    this.sendMarker(link, { t: this.sessionNow(link), type: 'instruction', label: bpm === null ? 'breath guide off' : `breath guide ${bpm} breaths per minute`, data: { guide: true } });
    this.active.view = { ...this.active.view, pacerBpm: bpm };
    this.set({ session: this.active.view });
  }

  async stop(): Promise<void> {
    if (this.active) await this.finishSession(false);
  }

  // ---- finishing and saving -----------------------------------------------------------------
  private async finishSession(completed: boolean): Promise<void> {
    const a = this.active;
    const link = this.link;
    if (!a || !link || a.finishing) return;
    a.finishing = true;
    const t = Math.max(this.sessionNow(link), a.lastRunnerT);
    if (a.runner && !a.runner.isFinished()) a.runner.stop(t);
    if (a.runner) this.afterRunner(link, a, false);
    if (this.tick) clearInterval(this.tick);
    if (this.autosave) clearInterval(this.autosave);
    this.tick = this.autosave = null;
    const record = a.runner ? a.runner.record() : null;
    const done = record ? record.completed : completed;
    const endIso = this.now().toISOString();
    if (a.mode === 'live') {
      link.recorder?.note({ type: 'session_end', id: a.id, t, completed: done });
      const ref = link.sessions.find((s) => s.sessionId === a.id);
      if (ref) ref.tEnd = t;
      this.audio?.stopAnchor();
      link.engine.setPacer(null);
      const stored: StoredSession = {
        id: a.id, kind: a.spec.kind, startedAt: a.startedAtIso, endedAt: endIso, programId: a.spec.programId, programName: a.programName,
        state: record?.program.state ?? null, recordingId: link.recordingId, tStart: a.tStart, tEnd: t, record, keyRows: a.sampler.rows,
        settings: a.sessionSettings ?? this.snapshotSettings(this.deps.getSettings()), completed: done, notes: a.notes,
        profileId: this.deps.getProfile()?.userId ?? 'local', cascadeEvents: a.cascades.finish(), journal: null,
      };
      this.finishedCtx = { runner: a.runner, stored, t };
      try {
        await this.saveRecordingSnapshot(link, false);
        await this.deps.persist.saveSession(stored);
        if (record) await this.deps.persist.sessionFinished(record);
      } catch (e) {
        this.set({ notice: `The session could not be saved on this device: ${e instanceof Error ? e.message : String(e)}` });
      }
      this.releaseAudio();
    }
    this.active = null;
    this.set({
      session: null,
      finished: {
        sessionId: a.id, kind: a.spec.kind, mode: a.mode, programName: a.programName, record, stored: a.mode === 'live', completed: done,
        journalOpen: a.mode === 'live', journal: null, elapsedS: Math.max(0, t - a.tStart),
      },
    });
  }

  /**
   * The short entry after a session. Saved with the session. Ratings go to the training runner
   * through its own `rate` and `report` calls (so the block record and the profile see them);
   * the profile is updated through the `sessionJournal` hook. Pass null to skip.
   */
  async submitJournal(journal: Journal | null): Promise<void> {
    const ctx = this.finishedCtx;
    const fin = this.state.finished;
    if (!ctx || !fin || fin.sessionId !== ctx.stored.id) {
      this.set({ finished: fin ? { ...fin, journalOpen: false } : fin });
      return;
    }
    if (!journal) {
      this.set({ finished: { ...fin, journalOpen: false } });
      return;
    }
    let record = ctx.stored.record;
    if (ctx.runner) {
      const ratings: Partial<Record<RatingKey, number>> = {};
      if (journal.ease !== null) ratings.ease = journal.ease;
      if (journal.depth !== null) ratings.depth = journal.depth;
      if (journal.mood !== null) ratings.pleasantness = journal.mood;
      if (Object.keys(ratings).length) ctx.runner.rate(ctx.t, ratings);
      if (journal.note.trim()) ctx.runner.report(ctx.t, journal.note.trim());
      record = ctx.runner.record();
    }
    const stored: StoredSession = { ...ctx.stored, journal, record };
    this.finishedCtx = { ...ctx, stored };
    try {
      await this.deps.persist.saveSession(stored);
      await this.deps.persist.sessionJournal?.(stored.id, journal);
    } catch (e) {
      this.set({ notice: `The journal entry could not be saved on this device: ${e instanceof Error ? e.message : String(e)}` });
    }
    this.set({ finished: { ...fin, journalOpen: false, journal, record } });
  }

  // ---- live stream out ------------------------------------------------------------------------
  private streamRaw(): boolean {
    return !!this.stream && this.deps.getSettings().stream.rawEeg;
  }

  /** Apply the stream settings: connect to the address the person entered, or disconnect. */
  applyStreamSettings(): void {
    const st = this.deps.getSettings().stream;
    if (!st.enabled) {
      if (this.stream) {
        this.stream.disconnect();
        this.streamOff?.();
        this.streamOff = null;
        this.stream = null;
      }
      if (this.state.stream.state !== 'idle') this.set({ stream: { state: 'idle' } });
      return;
    }
    if (!this.stream) {
      this.stream = (this.deps.createStream ?? (() => new StreamOut()))();
      this.streamOff = this.stream.on('status', (status) => this.set({ stream: status }));
      if (this.link?.streams) this.stream.setStreams(this.link.streams);
    }
    this.stream.connect(st.url);
  }

  private async saveRecordingSnapshot(link: Link, quiet: boolean): Promise<void> {
    if (!link.recorder) return;
    try {
      const bytes = link.recorder.snapshot();
      const meta: RecordingMeta = {
        id: link.recordingId, createdAt: link.createdAt, endedAt: this.now().toISOString(), durationS: link.eegT || null, bytes: bytes.length,
        headset: this.state.muse.name ?? link.streams.eeg?.model ?? null,
        hasHeart: !!link.streams.chest_strap || !!link.streams.ppg,
        sessions: link.sessions.map((s) => ({ ...s })),
        label: this.state.muse.name ?? (link.heartOnly ? 'Chest strap' : 'Session'),
        imported: false,
      };
      await this.deps.persist.saveRecording(meta, bytes);
      link.lastSavedBytes = bytes.length;
    } catch (e) {
      if (!quiet) throw e;
    }
  }

  // ---- replay -------------------------------------------------------------------------------
  /**
   * Replay a recording through the real engine, by the same path as a live headset. `sessionId`
   * selects which stored session's runner to rebuild (default: the first in the file).
   */
  async startReplay(bytes: Uint8Array | ParsedRecording, opts: { label: string; sessionId?: string | null; speed?: 1 | 4 | 'fast' } = { label: 'Recording' }): Promise<void> {
    if (this.active) throw new Error('Stop the session first.');
    if (this.link) await this.disposeLink();
    const parsed = bytes instanceof Uint8Array ? readRecording(bytes) : bytes;
    const speed = opts.speed ?? this.deps.getSettings().replaySpeed;
    this.lastReplayInput = { parsed, label: opts.label, sessionId: opts.sessionId ?? null };
    const meta = (parsed.header.meta ?? {}) as { seed?: number; mains_hz?: 50 | 60 | null; engineOverrides?: Record<string, number | boolean>; heartOnly?: boolean };
    const link = this.newLink('replay', !!meta.heartOnly, { seed: typeof meta.seed === 'number' ? meta.seed : 1, mains: meta.mains_hz ?? null, overrides: meta.engineOverrides ?? {} });
    link.eegRate = parsed.header.clock.eegRateHz ?? 256;
    this.replayNotes = parsed.records
      .filter((r): r is Extract<typeof r, { kind: 'note' }> => r.kind === 'note')
      .map((r) => ({ tUs: r.tUs, json: (r.json ?? {}) as Record<string, unknown> }))
      .filter((n) => typeof n.json.type === 'string');
    this.replayWanted = opts.sessionId ?? null;
    if (this.replayWanted === null) {
      const first = this.replayNotes.find((n) => n.json.type === 'session_start');
      this.replayWanted = first ? String(first.json.id) : null;
    }
    const src = new ReplaySource(parsed, { speed });
    this.wire(link, src);
    this.lastDataWall = 0;
    this.set({ replay: { label: opts.label, speed, ended: false, error: null }, finished: null, notice: null });
    if (speed === 1 && this.deps.getSettings().soundOn) {
      try {
        await this.startAudio(this.deps.getSettings());
        this.audioActive = true;
      } catch {
        this.set({ notice: 'Sound could not start. The replay continues without it.' });
      }
    }
    void (async () => {
      try {
        await src.start();
        this.flushNotes(link, Infinity);
        this.waitForReplayToSettle(link);
      } catch (e) {
        this.set({ replay: { label: opts.label, speed, ended: true, error: e instanceof Error ? e.message : String(e) } });
      }
    })();
  }

  private flushNotes(link: Link, untilTUs: number): void {
    if (this.link !== link) return;
    while (this.replayNotes.length && this.replayNotes[0].tUs < untilTUs) {
      const n = this.replayNotes.shift() as { tUs: number; json: Record<string, unknown> };
      const j = n.json;
      if (j.type === 'marker' && j.marker) {
        this.push(link, (en) => en.pushMarker(j.marker as Marker));
      } else if (j.type === 'session_start' && String(j.id) === this.replayWanted && !this.active) {
        const spec = j.spec as SessionSpec;
        void this.beginSession(link, spec, String(j.id), 'replay', Number(j.t)).catch((e: unknown) => this.set({ notice: e instanceof Error ? e.message : String(e) }));
      } else if (j.type === 'session_end' && this.active && String(j.id) === this.active.id) {
        if (this.active.runner && !this.active.runner.isFinished()) this.active.runner.stop(Number(j.t));
        void this.finishReplaySession();
      }
    }
  }

  /**
   * The replay has ended when the feed is finished AND the engine has handed back everything it was
   * sent. The worker answers messages in order, so an `info` request sent after the last push is a
   * barrier: its reply arrives after every frame those pushes produced. A timing guess (no frames
   * for a while, capped) remains only as a fallback for an engine that never answers.
   */
  private waitForReplayToSettle(link: Link): void {
    const settleMs = this.deps.replaySettleMs ?? 800;
    const fallbackMs = Math.max(settleMs, REPLAY_END_FALLBACK_MS);
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.lastFrameWall = performance.now();
    let drained = false;
    this.push(link, (en) => {
      en.info().then(() => { drained = true; }, () => { drained = true; });
    });
    this.replayTimer = setInterval(() => {
      if (this.link !== link) return;
      if (!drained && performance.now() - this.lastFrameWall < fallbackMs) return;
      if (this.replayTimer) clearInterval(this.replayTimer);
      this.replayTimer = null;
      if (this.active) void this.finishReplaySession();
      this.releaseAudio();
      // From here every readout, the picture and the sound see no data: later frames are dropped.
      this.replayClosed = link;
      this.hub.reset();
      const r = this.state.replay;
      if (r) this.set({ replay: { ...r, ended: true } });
    }, 50);
  }

  private async finishReplaySession(): Promise<void> {
    if (this.active && this.active.mode === 'replay') await this.finishSession(false);
  }

  /** Play the same recording again, at another speed (1x with sound, 4x, or as fast as possible with no sound). */
  async replayAgain(speed: 1 | 4 | 'fast'): Promise<void> {
    const last = this.lastReplayInput;
    if (!last) return;
    await this.disposeLink();
    await this.startReplay(last.parsed, { label: last.label, sessionId: last.sessionId, speed });
  }

  /** Close a replay and return to the idle state. */
  async closeReplay(): Promise<void> {
    if (this.active?.mode === 'replay') {
      this.active.finishing = true;
      this.active = null;
    }
    this.replayNotes = [];
    this.lastReplayInput = null;
    await this.disposeLink();
    this.set({ session: null, finished: null, replay: null });
  }

  /** The engine's version and parameters, for the settings screen. Null until an engine is running. */
  getEngineInfo(): ControllerState['engineInfo'] {
    return this.state.engineInfo;
  }

  async shutdown(): Promise<void> {
    if (this.active) await this.finishSession(false);
    await this.disposeLink();
    this.releaseAudio();
    this.stream?.disconnect();
  }
}
