/**
 * The device-local store. Typed access to recordings, sessions, profiles and settings,
 * plus export, import and delete-everything. No network, no external service.
 */
import { parseProfile, type UserProfile } from '../training';
import { IdbBackend, type KvBackend } from './backend';
import { sessionSummaryCsv } from './csv';
import { DEFAULT_APP_SETTINGS, type AppSettings, type Journal, type RecordingMeta, type StoredSession } from './types';

/** Sessions saved before profiles, events and journals existed get safe defaults. */
function normalizeSession(s: StoredSession): StoredSession {
  return { ...s, profileId: s.profileId ?? 'local', cascadeEvents: s.cascadeEvents ?? [], journal: s.journal ?? null };
}

const SETTINGS_KEY = 'app';

export interface StorageUsage {
  recordings: number;
  recordingBytes: number;
  sessions: number;
  profiles: number;
  /** Browser-reported quota, when available. */
  quotaBytes: number | null;
  usedBytes: number | null;
}

export class Storage {
  private readonly kv: KvBackend;
  constructor(kv: KvBackend) {
    this.kv = kv;
  }

  // ---- settings -----------------------------------------------------------------------------
  async loadSettings(): Promise<AppSettings> {
    const s = await this.kv.get<Partial<AppSettings>>('settings', SETTINGS_KEY);
    return { ...DEFAULT_APP_SETTINGS, ...(s ?? {}), stream: { ...DEFAULT_APP_SETTINGS.stream, ...(s?.stream ?? {}) }, version: 1 };
  }
  async saveSettings(s: AppSettings): Promise<void> {
    await this.kv.put('settings', SETTINGS_KEY, s);
  }

  // ---- profiles -----------------------------------------------------------------------------
  async listProfiles(): Promise<UserProfile[]> {
    return this.kv.getAll<UserProfile>('profiles');
  }
  async getProfile(userId: string): Promise<UserProfile | null> {
    return (await this.kv.get<UserProfile>('profiles', userId)) ?? null;
  }
  async saveProfile(p: UserProfile): Promise<void> {
    await this.kv.put('profiles', p.userId, p);
  }
  /** Delete a profile and every session that belongs to it (recordings go with their last session). */
  async deleteProfile(userId: string): Promise<void> {
    for (const s of await this.listSessions(userId)) await this.deleteSession(s.id);
    await this.kv.delete('profiles', userId);
  }
  exportProfileJson(p: UserProfile): string {
    return JSON.stringify(p, null, 2);
  }
  /** Parse and store a profile file. Throws with a plain message if it is not a profile. */
  async importProfileJson(text: string): Promise<UserProfile> {
    let p: UserProfile;
    try {
      p = parseProfile(text);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'not a Hurricane Brain profile');
    }
    if (typeof p.userId !== 'string' || !p.userId) throw new Error('the profile file has no user id');
    await this.saveProfile(p);
    return p;
  }

  // ---- recordings ---------------------------------------------------------------------------
  async saveRecording(meta: RecordingMeta, bytes: Uint8Array): Promise<void> {
    await this.kv.put('recordings', meta.id, bytes);
    await this.kv.put('recordingMeta', meta.id, { ...meta, bytes: bytes.length });
  }
  async listRecordings(): Promise<RecordingMeta[]> {
    const all = await this.kv.getAll<RecordingMeta>('recordingMeta');
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async getRecordingMeta(id: string): Promise<RecordingMeta | null> {
    return (await this.kv.get<RecordingMeta>('recordingMeta', id)) ?? null;
  }
  async getRecordingBytes(id: string): Promise<Uint8Array | null> {
    const b = await this.kv.get<Uint8Array>('recordings', id);
    return b ? new Uint8Array(b) : null;
  }
  async deleteRecording(id: string): Promise<void> {
    await this.kv.delete('recordings', id);
    await this.kv.delete('recordingMeta', id);
  }

  // ---- sessions -----------------------------------------------------------------------------
  async saveSession(s: StoredSession): Promise<void> {
    await this.kv.put('sessions', s.id, s);
  }
  /** Sessions, newest first. Pass a profile id to list one person's sessions only. */
  async listSessions(profileId?: string): Promise<StoredSession[]> {
    const all = (await this.kv.getAll<StoredSession>('sessions')).map(normalizeSession);
    const mine = profileId === undefined ? all : all.filter((x) => x.profileId === profileId);
    return mine.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
  async getSession(id: string): Promise<StoredSession | null> {
    const s = await this.kv.get<StoredSession>('sessions', id);
    return s ? normalizeSession(s) : null;
  }
  /** Save the journal entry of a session (null removes it). */
  async saveJournal(id: string, journal: Journal | null): Promise<StoredSession | null> {
    const s = await this.getSession(id);
    if (!s) return null;
    const next = { ...s, journal };
    await this.saveSession(next);
    return next;
  }
  /** Delete a session; its recording goes too when no other session refers to it. */
  async deleteSession(id: string): Promise<void> {
    const s = await this.getSession(id);
    await this.kv.delete('sessions', id);
    if (s?.recordingId) {
      const others = (await this.listSessions()).filter((x) => x.recordingId === s.recordingId);
      if (!others.length) await this.deleteRecording(s.recordingId);
    }
  }
  sessionCsv(s: StoredSession): string {
    return sessionSummaryCsv(s);
  }

  // ---- data management ----------------------------------------------------------------------
  async usage(): Promise<StorageUsage> {
    const metas = await this.kv.getAll<RecordingMeta>('recordingMeta');
    let quotaBytes: number | null = null;
    let usedBytes: number | null = null;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        quotaBytes = est.quota ?? null;
        usedBytes = est.usage ?? null;
      }
    } catch {
      /* not available */
    }
    return {
      recordings: metas.length,
      recordingBytes: metas.reduce((a, m) => a + m.bytes, 0),
      sessions: (await this.kv.keys('sessions')).length,
      profiles: (await this.kv.keys('profiles')).length,
      quotaBytes,
      usedBytes,
    };
  }
  /** Remove every recording, session, profile and setting from this device. */
  async deleteEverything(): Promise<void> {
    await this.kv.clearAll();
  }
}

export function createStorage(): Storage {
  return new Storage(new IdbBackend());
}
