import type { AudioSettingsPatch } from '../../audio';
import { createProfile, deriveSeed, ingestSession, learnSignature, type SafetyAnswers, type Questionnaire, type SessionRecord, type UserProfile } from '../../training';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../storage';

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
  return out;
}

export class SettingsStore extends Store<AppSettings> {
  private readonly save: (s: AppSettings) => Promise<void>;
  constructor(initial: AppSettings, save: (s: AppSettings) => Promise<void>) {
    super({ ...DEFAULT_APP_SETTINGS, ...initial });
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

export class ProfileStore extends Store<UserProfile | null> {
  private readonly save: (p: UserProfile) => Promise<void>;
  constructor(initial: UserProfile | null, save: (p: UserProfile) => Promise<void>) {
    super(initial);
    this.save = save;
  }
  async put(p: UserProfile): Promise<void> {
    this.set(p);
    await this.save(p);
  }
  async create(safety: SafetyAnswers, questionnaire: Questionnaire | null, now: Date, seed: number): Promise<UserProfile> {
    const p = createProfile('local', now.toISOString(), seed, safety, questionnaire);
    await this.put(p);
    return p;
  }
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
