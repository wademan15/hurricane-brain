import type { AudioSettingsPatch } from '../../audio';
import { createProfile, deriveSeed, ingestSession, learnSignature, type SafetyAnswers, type Questionnaire, type SessionRecord, type UserProfile } from '../../training';
import { DEFAULT_APP_SETTINGS, type AgeGroup, type AppSettings, type Journal, type ProfileInfo } from '../../storage';

type Listener = () => void;

/** Small observable value, for useSyncExternalStore. */
export class Store<T> {
  private value: T;
  private readonly listeners = new Set<Listener>();
  constructor(initial: T) {
    this.value = initial;
  }
  get = (): T => this.value;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  protected set(v: T): void {
    this.value = v;
    for (const l of [...this.listeners]) l();
  }
  /** For subclasses and tests. */
  replace(v: T): void {
    this.set(v);
  }
}

function mergeAudio(old: AudioSettingsPatch, patch: AudioSettingsPatch): AudioSettingsPatch {
  const out: AudioSettingsPatch = { ...old, ...patch };
  if (old.gains || patch.gains) out.gains = { ...old.gains, ...patch.gains };
  if (old.breathGuide || patch.breathGuide) out.breathGuide = { ...old.breathGuide, ...patch.breathGuide };
  if (old.blooms || patch.blooms) {
    out.blooms = { phi: { ...old.blooms?.phi, ...patch.blooms?.phi }, octave: { ...old.blooms?.octave, ...patch.blooms?.octave }, both: { ...old.blooms?.both, ...patch.blooms?.both } };
  }
  return out;
}

export class SettingsStore extends Store<AppSettings> {
  private readonly save: (s: AppSettings) => Promise<void>;
  constructor(initial: AppSettings, save: (s: AppSettings) => Promise<void>) {
    super({ ...DEFAULT_APP_SETTINGS, ...initial, stream: { ...DEFAULT_APP_SETTINGS.stream, ...initial.stream } });
    this.save = save;
  }
  update(patch: Partial<AppSettings>): void {
    const next = { ...this.get(), ...patch };
    this.set(next);
    void this.save(next).catch((e) => console.error('could not save settings', e));
  }
  updateAudio(patch: AudioSettingsPatch): void {
    this.update({ audio: mergeAudio(this.get().audio, patch) });
  }
  resetAudio(): void {
    this.update({ audio: {} });
  }
}

export interface ProfileEntry {
  profile: UserProfile;
  info: ProfileInfo;
}

export interface ProfileDeps {
  save: (p: UserProfile) => Promise<void>;
  remove: (userId: string) => Promise<void>;
}

const DEFAULT_INFO: ProfileInfo = { name: 'Me', ageGroup: null };

/**
 * The people who use this device. `get()` is the active person's profile (what the rest of the
 * app reads); `all` lists everyone. Each profile has its own calibration, history, signatures
 * and anchors, and every stored session carries the id of the profile it belongs to.
 */
export class ProfileStore extends Store<UserProfile | null> {
  private readonly deps: ProfileDeps;
  private readonly settings: SettingsStore;
  readonly all: Store<ProfileEntry[]>;

  constructor(profiles: UserProfile[], settings: SettingsStore, deps: ProfileDeps) {
    const wanted = settings.get().activeProfileId;
    super(profiles.find((p) => p.userId === wanted) ?? profiles[0] ?? null);
    this.deps = deps;
    this.settings = settings;
    this.all = new Store<ProfileEntry[]>(profiles.map((p) => ({ profile: p, info: settings.get().profileInfo[p.userId] ?? DEFAULT_INFO })));
    const active = this.get();
    if (active && settings.get().activeProfileId !== active.userId) settings.update({ activeProfileId: active.userId });
  }

  info(userId: string | null | undefined): ProfileInfo {
    return (userId ? this.settings.get().profileInfo[userId] : null) ?? DEFAULT_INFO;
  }

  private refreshList(list?: UserProfile[]): void {
    const profiles = list ?? this.all.get().map((e) => e.profile);
    const info = this.settings.get().profileInfo;
    this.all.replace(profiles.map((p) => ({ profile: p, info: info[p.userId] ?? DEFAULT_INFO })));
  }

  /** Replace a profile (after a session, a calibration, a new anchor...). */
  async put(p: UserProfile): Promise<void> {
    const list = this.all.get().map((e) => e.profile);
    const next = list.some((x) => x.userId === p.userId) ? list.map((x) => (x.userId === p.userId ? p : x)) : [...list, p];
    if (this.get()?.userId === p.userId || this.get() === null) this.set(p);
    this.refreshList(next);
    await this.deps.save(p);
  }

  /** Create a person and make them the active one. */
  async create(
    args: { name: string; ageGroup: AgeGroup | null; safety: SafetyAnswers; questionnaire: Questionnaire | null },
    now: Date,
    seed: number,
  ): Promise<UserProfile> {
    const userId = `p_${now.getTime().toString(36)}_${(seed >>> 0).toString(36)}`;
    const p = createProfile(userId, now.toISOString(), seed, args.safety, args.questionnaire);
    this.settings.update({
      activeProfileId: userId,
      profileInfo: { ...this.settings.get().profileInfo, [userId]: { name: args.name.trim() || 'Me', ageGroup: args.ageGroup } },
    });
    await this.deps.save(p);
    this.set(p);
    this.refreshList([...this.all.get().map((e) => e.profile), p]);
    return p;
  }

  switchTo(userId: string): void {
    const p = this.all.get().find((e) => e.profile.userId === userId)?.profile;
    if (!p) return;
    this.settings.update({ activeProfileId: userId });
    this.set(p);
  }

  rename(userId: string, info: Partial<ProfileInfo>): void {
    const cur = this.info(userId);
    this.settings.update({ profileInfo: { ...this.settings.get().profileInfo, [userId]: { ...cur, ...info } } });
    this.refreshList();
  }

  /** Delete a person and their sessions. The active profile moves to someone else, or to nobody. */
  async remove(userId: string): Promise<void> {
    await this.deps.remove(userId);
    const rest = this.all.get().map((e) => e.profile).filter((p) => p.userId !== userId);
    const { [userId]: _gone, ...info } = this.settings.get().profileInfo;
    const nextActive = this.get()?.userId === userId ? (rest[0] ?? null) : this.get();
    this.settings.update({ profileInfo: info, activeProfileId: nextActive?.userId ?? null });
    this.set(nextActive);
    this.refreshList(rest);
  }
}

/**
 * The journal feeds the profile: the person's own ease, depth and mood go into the session's
 * summary ratings where the program's block ratings left them empty. Subjective answers, kept
 * apart from measurements (see `subjectiveVsMeasured`). Pure.
 */
export function profileWithJournal(profile: UserProfile, sessionId: string, j: Pick<Journal, 'ease' | 'depth' | 'mood'>): UserProfile {
  if (!profile.sessions.some((s) => s.sessionId === sessionId)) return profile;
  return {
    ...profile,
    sessions: profile.sessions.map((s) =>
      s.sessionId !== sessionId
        ? s
        : { ...s, ratings: { depth: s.ratings.depth ?? j.depth, ease: s.ratings.ease ?? j.ease, pleasantness: s.ratings.pleasantness ?? j.mood } },
    ),
  };
}

/**
 * Fold a finished program session into the profile, and refresh the signature for the state
 * when the session had marked state and contrast blocks. Pure.
 */
export function profileAfterSession(profile: UserProfile, record: SessionRecord, atIso: string): UserProfile {
  let p = ingestSession(profile, record);
  const state = record.program.state;
  const blocks = p.signatureBlocks[state];
  if (blocks && blocks.length && record.blocks.some((b) => b.label)) {
    p = relearnSignature(p, state, atIso);
  }
  return p;
}

export function relearnSignature(profile: UserProfile, state: string, atIso: string): UserProfile {
  const blocks = profile.signatureBlocks[state] ?? [];
  const previous = profile.signatures.find((s) => s.state === state) ?? null;
  const sig = learnSignature(blocks, { id: previous?.id ?? `sig_${state}`, state, at: atIso, seed: deriveSeed(profile.seed, `signature:${state}:${blocks.length}`), previous });
  if (!sig) return profile;
  return { ...profile, signatures: [...profile.signatures.filter((s) => s.state !== state), sig] };
}
