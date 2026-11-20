import { describe, expect, it } from 'vitest';
import { createProfile, type SessionSummary } from '../../training';
import { MemoryBackend, Storage, DEFAULT_APP_SETTINGS } from '../../storage';
import { slowFrame } from '../../training/test-fixtures';
import { FIT_GAP_S, NO_HOLD, stepFitHold } from '../state/fit';
import { ProfileStore, SettingsStore, profileWithJournal } from '../state/stores';

async function setup() {
  const storage = new Storage(new MemoryBackend());
  const settings = new SettingsStore(await storage.loadSettings(), (s) => storage.saveSettings(s));
  const store = new ProfileStore([], settings, { save: (p) => storage.saveProfile(p), remove: (id) => storage.deleteProfile(id) });
  return { storage, settings, store };
}
const now = new Date('2026-03-01T10:00:00.000Z');

describe('more than one person on the device', () => {
  it('creates, switches and deletes people, each with their own profile and sessions', async () => {
    const { storage, settings, store } = await setup();
    const a = await store.create({ name: 'Ada', ageGroup: 'adult', safety: {}, questionnaire: null }, now, 1);
    const b = await store.create({ name: 'Ben', ageGroup: 'child', safety: { epilepsy: true }, questionnaire: null }, new Date(now.getTime() + 5), 2);
    expect(a.userId).not.toBe(b.userId);
    expect(store.get()?.userId).toBe(b.userId);
    expect(settings.get().activeProfileId).toBe(b.userId);
    expect(store.info(b.userId)).toEqual({ name: 'Ben', ageGroup: 'child' });
    expect(store.all.get().map((e) => e.info.name)).toEqual(['Ada', 'Ben']);
    // Each profile has its own state: a calibration-like change on one does not touch the other.
    await store.put({ ...b, discoverySessions: 3 });
    expect(store.all.get().find((e) => e.profile.userId === a.userId)?.profile.discoverySessions).toBe(0);
    expect((await storage.getProfile(b.userId))?.discoverySessions).toBe(3);

    store.switchTo(a.userId);
    expect(store.get()?.userId).toBe(a.userId);
    expect(settings.get().activeProfileId).toBe(a.userId);

    // Sessions are kept per person, and deleting a person deletes theirs only.
    const base = { kind: 'free' as const, startedAt: '2026-03-01T10:00:00.000Z', endedAt: null, programId: null, programName: 'Free', state: null, recordingId: null, tStart: 0, tEnd: 1, record: null, keyRows: [], completed: true, notes: [], cascadeEvents: [], journal: null };
    const settingsSnap = (await import('../../storage/test/storage.test-helpers')).sessionSettings();
    await storage.saveSession({ ...base, id: 'sa', profileId: a.userId, settings: settingsSnap });
    await storage.saveSession({ ...base, id: 'sb', profileId: b.userId, settings: settingsSnap });
    expect((await storage.listSessions(a.userId)).map((s) => s.id)).toEqual(['sa']);
    await store.remove(b.userId);
    expect((await storage.listSessions()).map((s) => s.id)).toEqual(['sa']);
    expect(await storage.getProfile(b.userId)).toBeNull();
    expect(store.all.get().map((e) => e.info.name)).toEqual(['Ada']);
    await store.remove(a.userId);
    expect(store.get()).toBeNull();
    expect(settings.get().activeProfileId).toBeNull();
  });

  it('restores the active person from settings', async () => {
    const storage = new Storage(new MemoryBackend());
    const p1 = createProfile('p1', now.toISOString(), 1);
    const p2 = createProfile('p2', now.toISOString(), 2);
    const settings = new SettingsStore({ ...DEFAULT_APP_SETTINGS, activeProfileId: 'p2', profileInfo: { p1: { name: 'One', ageGroup: null }, p2: { name: 'Two', ageGroup: 'teen' } } }, async () => {});
    const store = new ProfileStore([p1, p2], settings, { save: (p) => storage.saveProfile(p), remove: async () => {} });
    expect(store.get()?.userId).toBe('p2');
    expect(store.info('p2').ageGroup).toBe('teen');
  });
});

describe('the journal feeds the profile', () => {
  const summary = (id: string, r: SessionSummary['ratings']): SessionSummary => ({
    sessionId: id, day: '2026-03-01', startedAt: now.toISOString(), programId: 'p', level: 1, state: 'alpha_ec', posture: null, soundscape: null,
    checkIn: {} as never, cleanFraction: 0.9, fractionInTarget: 0.5, medianLatencyS: null, transferRatio: null, signatureReached: null, ratings: r,
  });
  it('fills ratings the program did not ask for, and never overwrites a block rating', () => {
    const p = { ...createProfile('x', now.toISOString(), 1), sessions: [summary('s1', { depth: 4, ease: null, pleasantness: null }), summary('s2', { depth: null, ease: null, pleasantness: null })] };
    const out = profileWithJournal(p, 's1', { ease: 5, depth: 2, mood: 3 });
    expect(out.sessions[0].ratings).toEqual({ depth: 4, ease: 5, pleasantness: 3 });
    expect(out.sessions[1].ratings).toEqual({ depth: null, ease: null, pleasantness: null });
    expect(profileWithJournal(p, 'nope', { ease: 1, depth: 1, mood: 1 })).toBe(p);
    expect(p.sessions[0].ratings.ease).toBeNull(); // the input is not changed
  });
});

describe('fit hold', () => {
  const good = (t: number) => slowFrame(t, {});
  const bad = (t: number) => slowFrame(t, { usable: false });
  it('counts seconds of frame time with every channel usable, and a bad frame starts again', () => {
    let h = NO_HOLD;
    for (let t = 1; t <= 6; t += 0.25) h = stepFitHold(h, good(t));
    expect(h.goodForS).toBeCloseTo(5);
    h = stepFitHold(h, bad(6.25));
    expect(h.goodSinceT).toBeNull();
    expect(h.goodForS).toBe(0);
    h = stepFitHold(h, good(6.5));
    h = stepFitHold(h, good(8.5));
    expect(h.goodForS).toBeCloseTo(2);
  });
  it('a gap in the frames breaks the run', () => {
    let h = stepFitHold(NO_HOLD, good(1));
    h = stepFitHold(h, good(2));
    h = stepFitHold(h, good(2 + FIT_GAP_S + 1));
    expect(h.goodForS).toBe(0);
    expect(h.goodSinceT).toBe(2 + FIT_GAP_S + 1);
  });
});
