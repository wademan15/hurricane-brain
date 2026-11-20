import { describe, expect, it } from 'vitest';
import { createProfile } from '../../training';
import { DEFAULT_AUDIO_SETTINGS } from '../../audio/settings';
import { MemoryBackend } from '../backend';
import { csvCell, sessionSummaryCsv } from '../csv';
import { Storage } from '../storage';
import { DEFAULT_APP_SETTINGS, KEY_COLUMNS, type RecordingMeta, type StoredSession } from '../types';

const meta = (id: string, over: Partial<RecordingMeta> = {}): RecordingMeta => ({
  id, createdAt: '2026-03-01T10:00:00.000Z', endedAt: null, durationS: 60, bytes: 0, headset: 'Muse-X', hasHeart: false, sessions: [], label: 'rec', imported: false, ...over,
});

const session = (id: string, recordingId: string | null = null): StoredSession => ({
  id, kind: 'free', startedAt: '2026-03-01T10:00:00.000Z', endedAt: '2026-03-01T10:10:00.000Z', programId: null, programName: 'Free session', state: null, recordingId,
  tStart: 1, tEnd: 601, record: null,
  keyRows: [
    { t: 1, block: null, cells: Object.fromEntries(KEY_COLUMNS.map((c) => [c.id, { v: 1.5, why: 'ok' as const }])) },
    { t: 2, block: 'a, "quoted"', cells: Object.fromEntries(KEY_COLUMNS.map((c) => [c.id, { v: null, why: 'bad_contact' as const }])) },
  ],
  settings: { audio: DEFAULT_AUDIO_SETTINGS, viz: { quality: 'medium', rampS: 0.5, slowStaleS: 1, heartStaleS: 2.5 }, mains: 'auto', chanceDriver: 'a', responseSpeed: 'steady', harmonicsCount: false, reducedMotion: 'system', soundOnly: false, ageGroup: null, engine: { version: 'e1', params: { a: 1 } }, engineOverrides: {}, appVersion: '1.0.0' },
  completed: true, notes: [], profileId: 'local', cascadeEvents: [], journal: null,
});

describe('Storage', () => {
  it('settings round trip, with defaults filled in for anything missing', async () => {
    const st = new Storage(new MemoryBackend());
    expect(await st.loadSettings()).toEqual(DEFAULT_APP_SETTINGS);
    await st.saveSettings({ ...DEFAULT_APP_SETTINGS, onboarded: true, chanceDriver: 'b', audio: { pitchTauS: 0.3, gains: { heart: 0.5 } } });
    const s = await st.loadSettings();
    expect(s.onboarded).toBe(true);
    expect(s.chanceDriver).toBe('b');
    expect(s.audio.gains?.heart).toBe(0.5);
    expect(s.soundOn).toBe(true);
  });

  it('profile round trip and JSON export and import', async () => {
    const st = new Storage(new MemoryBackend());
    const p = createProfile('local', '2026-01-01T00:00:00.000Z', 5, { epilepsy: true });
    await st.saveProfile(p);
    expect(await st.getProfile('local')).toEqual(p);
    const json = st.exportProfileJson(p);
    const other = new Storage(new MemoryBackend());
    const imported = await other.importProfileJson(json);
    expect(imported).toEqual(p);
    expect((await other.listProfiles()).length).toBe(1);
  });

  it('refuses a file that is not a profile, and stores nothing', async () => {
    const st = new Storage(new MemoryBackend());
    await expect(st.importProfileJson('{"hello":1}')).rejects.toThrow(/not a Hurricane Brain profile/);
    await expect(st.importProfileJson('not json')).rejects.toThrow();
    expect(await st.listProfiles()).toEqual([]);
  });

  it('recordings keep their exact bytes', async () => {
    const st = new Storage(new MemoryBackend());
    const bytes = Uint8Array.from([72, 66, 82, 65, 87, 0, 1, 2, 3, 250, 251]);
    await st.saveRecording(meta('r1'), bytes);
    expect(await st.getRecordingBytes('r1')).toEqual(bytes);
    expect((await st.getRecordingMeta('r1'))?.bytes).toBe(bytes.length);
    expect(await st.getRecordingBytes('nope')).toBeNull();
    await st.deleteRecording('r1');
    expect(await st.getRecordingBytes('r1')).toBeNull();
    expect(await st.listRecordings()).toEqual([]);
  });

  it('sessions list newest first; deleting the last session of a recording deletes the recording', async () => {
    const st = new Storage(new MemoryBackend());
    await st.saveRecording(meta('r1'), new Uint8Array([1]));
    await st.saveSession({ ...session('a', 'r1'), startedAt: '2026-03-01T10:00:00.000Z' });
    await st.saveSession({ ...session('b', 'r1'), startedAt: '2026-03-02T10:00:00.000Z' });
    expect((await st.listSessions()).map((s) => s.id)).toEqual(['b', 'a']);
    await st.deleteSession('b');
    expect(await st.getRecordingBytes('r1')).not.toBeNull(); // 'a' still uses it
    await st.deleteSession('a');
    expect(await st.getRecordingBytes('r1')).toBeNull();
    expect(await st.listSessions()).toEqual([]);
  });

  it('deleteEverything removes recordings, sessions, profiles and settings', async () => {
    const st = new Storage(new MemoryBackend());
    await st.saveRecording(meta('r1'), new Uint8Array([1, 2]));
    await st.saveSession(session('a', 'r1'));
    await st.saveProfile(createProfile('local', 'x', 1));
    await st.saveSettings({ ...DEFAULT_APP_SETTINGS, onboarded: true });
    expect((await st.usage()).recordings).toBe(1);
    await st.deleteEverything();
    const u = await st.usage();
    expect([u.recordings, u.sessions, u.profiles]).toEqual([0, 0, 0]);
    expect(await st.loadSettings()).toEqual(DEFAULT_APP_SETTINGS);
    expect(await st.listRecordings()).toEqual([]);
  });
});

describe('CSV export', () => {
  it('escapes cells', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('writes settings, then per-second rows with empty cells and a reason for what was not measured', () => {
    const csv = sessionSummaryCsv(session('a'));
    const lines = csv.trim().split('\r\n');
    expect(lines.some((l) => l.startsWith('# engine version,e1'))).toBe(true);
    expect(lines.some((l) => l.startsWith('# audio and smoothing settings,'))).toBe(true);
    const head = lines.findIndex((l) => l.startsWith('t_s,block'));
    expect(head).toBeGreaterThan(0);
    const cols = lines[head].split(',');
    expect(cols).toContain('alpha_db [dB]');
    expect(cols).toContain('alpha_db_why');
    const row2 = lines[head + 2];
    // second row: every value empty, every reason bad_contact, none of them 0
    expect(row2.startsWith('2,"a, ""quoted"""')).toBe(true);
    expect(row2).toContain('bad_contact');
    const cells = row2.replace('2,"a, ""quoted""",', '').split(',');
    for (let i = 0; i < cells.length; i += 2) {
      expect(cells[i]).toBe('');
      expect(cells[i + 1]).toBe('bad_contact');
    }
    const row1 = lines[head + 1].replace('1,,', '').split(',');
    expect(row1[0]).toBe('1.5');
    expect(row1[1]).toBe('ok');
  });
});

describe('journal, events and older sessions', () => {
  it('saves a journal with the session and gives older sessions safe defaults', async () => {
    const st = new Storage(new MemoryBackend());
    const old = session('old') as Partial<StoredSession>;
    delete old.profileId;
    delete old.cascadeEvents;
    delete old.journal;
    await st.saveSession(old as StoredSession);
    const back = await st.getSession('old');
    expect(back?.profileId).toBe('local');
    expect(back?.cascadeEvents).toEqual([]);
    expect(back?.journal).toBeNull();
    const j = { note: 'calm, a bit sleepy', mood: 4, ease: 5, depth: null, tags: ['relaxed'], writtenAt: '2026-03-01T11:00:00.000Z' };
    await st.saveJournal('old', j);
    expect((await st.getSession('old'))?.journal).toEqual(j);
    expect(await st.saveJournal('missing', j)).toBeNull();
  });

  it('exports cascade events, the journal and the new per-second columns in the CSV', () => {
    const ev = {
      kind: 'both' as const, tStart: 10, tEnd: 40, durationS: 30,
      parts: [
        { target: 'phi' as const, members: [{ id: 2, band: 'theta', freqHz: { v: 7.44, why: 'ok' as const } }, { id: 1, band: 'alpha', freqHz: { v: 12.04, why: 'ok' as const } }], steps: 1, maxSteps: 2, ratios: [{ v: 1.618, why: 'ok' as const }], closeness: { v: 0.9, why: 'ok' as const }, chanceA: { v: 0.4, why: 'ok' as const }, chanceB: { v: null, why: 'warming_up' as const }, pA: { v: 0.02, why: 'ok' as const }, excessA: { v: 0.8, why: 'ok' as const }, excessB: { v: null, why: 'warming_up' as const } },
        { target: 'octave' as const, members: [], steps: 0, maxSteps: 1, ratios: [], closeness: { v: null, why: 'unresolved' as const }, chanceA: { v: null, why: 'no_data' as const }, chanceB: { v: null, why: 'no_data' as const }, pA: { v: null, why: 'no_data' as const }, excessA: { v: null, why: 'no_data' as const }, excessB: { v: null, why: 'no_data' as const } },
      ],
    };
    const s = { ...session('a'), cascadeEvents: [ev], journal: { note: 'said "hello", then slept', mood: 3, ease: null, depth: 2, tags: ['a', 'b'], writtenAt: '2026-03-01T11:00:00.000Z' }, settings: { ...session('a').settings, responseSpeed: 'quicker' as const, harmonicsCount: true } };
    const csv = new Storage(new MemoryBackend()).sessionCsv(s);
    expect(csv).toContain('# alignment response speed,quicker');
    expect(csv).toContain('# harmonics count toward octave alignment,true');
    expect(csv).toContain('# journal');
    expect(csv).toContain('"said ""hello"", then slept",3,,2,a; b');
    expect(csv).toContain('# cascade events');
    const row = csv.split('\r\n').find((l) => l.startsWith('both,10,40,30'));
    expect(row).toBeDefined();
    expect(row).toContain('theta > alpha');
    expect(row).toContain('7.440 > 12.040');
    expect(row).toContain('1.618');
    // Octave closeness was not measured: the cell is empty and says why.
    expect(row).toContain('unresolved');
    for (const col of ['at_ratio', 'at_miss_2', 'at_miss_3', 'at_miss_phi', 'phi_active', 'both_active', 'both_for_s', 'sdnn_ms', 'lf_power', 'resonance_hz']) {
      expect(csv).toContain(`${col} [`);
      expect(csv).toContain(`${col}_why`);
    }
  });
});
