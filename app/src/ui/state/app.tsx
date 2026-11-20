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
import { ChanceView } from '../session/hub';
import { ProfileStore, SettingsStore, profileAfterSession } from './stores';

export interface Services {
  controller: SessionController;
  storage: Storage;
  settings: SettingsStore;
  profile: ProfileStore;
  /** The hub as the hurricane and spectrum see it (chance A or B). */
  view: ChanceView;
}

export async function createServices(storage: Storage = createStorage()): Promise<Services> {
  const loaded = await storage.loadSettings();
  const profiles = await storage.listProfiles();
  const settings = new SettingsStore(loaded, (s) => storage.saveSettings(s));
  const profile = new ProfileStore(profiles.find((p) => p.userId === 'local') ?? profiles[0] ?? null, (p) => storage.saveProfile(p));
  const controller: SessionController = new SessionController({
    createEngine: createEngineClient,
    createAudio: () => new AudioEngine({ settings: settings.get().audio }),
    getSettings: settings.get,
    getProfile: profile.get,
    persist: {
      saveRecording: (meta, bytes) => storage.saveRecording(meta, bytes),
      saveSession: (s) => storage.saveSession(s),
      sessionFinished: async (record) => {
        const p = profile.get();
        if (p) await profile.put(profileAfterSession(p, record, new Date().toISOString()));
      },
    },
  });
  settings.subscribe(() => controller.getAudio().setSettings(settings.get().audio));
  const view = new ChanceView(controller.hub, () => settings.get().chanceDriver);
  return { controller, storage, settings, profile, view };
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
