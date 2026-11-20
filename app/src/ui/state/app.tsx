/**
 * Wiring of the app's services, and the hooks the screens use. `createServices` is the one
 * place that imports the real engine client.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AudioEngine } from '../../audio';
import { createEngineClient } from '../../engine';
import { createStorage, type AppSettings, type Storage } from '../../storage';
import type { UserProfile } from '../../training';
import { SessionController } from '../session/controller';
import type { FrameHub } from '../session/hub';
import type { PendingStart } from './start';
import { ProfileStore, Store, SettingsStore, profileAfterSession, profileWithJournal, type ProfileEntry } from './stores';

export interface Services {
  controller: SessionController;
  storage: Storage;
  settings: SettingsStore;
  profile: ProfileStore;
  /** Frames as the hurricane and spectrum read them. */
  view: FrameHub;
  /** A session waiting on the get-ready (fit coaching) screen. */
  pending: Store<PendingStart | null>;
}

export async function createServices(storage: Storage = createStorage()): Promise<Services> {
  const loaded = await storage.loadSettings();
  const profiles = await storage.listProfiles();
  const settings = new SettingsStore(loaded, (s) => storage.saveSettings(s));
  const profile = new ProfileStore(profiles, settings, { save: (p) => storage.saveProfile(p), remove: (id) => storage.deleteProfile(id) });
  const controller: SessionController = new SessionController({
    createEngine: createEngineClient,
    createAudio: () => new AudioEngine({ settings: { ...settings.get().audio, bloomChance: settings.get().chanceDriver } }),
    getSettings: settings.get,
    getProfile: profile.get,
    getProfileInfo: () => profile.info(profile.get()?.userId),
    persist: {
      saveRecording: (meta, bytes) => storage.saveRecording(meta, bytes),
      saveSession: (s) => storage.saveSession(s),
      sessionFinished: async (record) => {
        const p = profile.get();
        if (p) await profile.put(profileAfterSession(p, record, new Date().toISOString()));
      },
      sessionJournal: async (sessionId, journal) => {
        const p = profile.get();
        if (p) await profile.put(profileWithJournal(p, sessionId, journal));
      },
    },
  });
  let last = settings.get();
  settings.subscribe(() => {
    const now = settings.get();
    if (now.audio !== last.audio || now.chanceDriver !== last.chanceDriver) controller.applyAudioSettings();
    if (now.stream !== last.stream) controller.applyStreamSettings();
    last = now;
  });
  controller.applyStreamSettings();
  const view = controller.hub;
  return { controller, storage, settings, profile, view, pending: new Store<PendingStart | null>(null) };
}

export const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesProvider is missing');
  return s;
}

export function useController() {
  const { controller } = useServices();
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

export function useSettings(): AppSettings {
  const { settings } = useServices();
  return useSyncExternalStore(settings.subscribe, settings.get);
}

export function useProfile(): UserProfile | null {
  const { profile } = useServices();
  return useSyncExternalStore(profile.subscribe, profile.get);
}

/** Everyone who uses this device, with their names and age groups. */
export function useProfiles(): ProfileEntry[] {
  const { profile } = useServices();
  return useSyncExternalStore(profile.all.subscribe, profile.all.get);
}

/** The active person's name and age group (a default when there is no profile yet). */
export function useProfileInfo() {
  const { profile } = useServices();
  const p = useProfile();
  const s = useSettings();
  void s.profileInfo;
  return profile.info(p?.userId);
}

/** Load something async once (and again when `deps` change). */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) => alive && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
