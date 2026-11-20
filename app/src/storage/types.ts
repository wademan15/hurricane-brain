/**
 * Shapes stored on the device. Everything here stays in this browser's IndexedDB; nothing is
 * sent anywhere unless the user exports it (CLAUDE.md rule 8).
 */
import type { AudioSettings, AudioSettingsPatch } from '../audio';
import type { Reason } from '../engine/frames';
import type { SessionRecord } from '../training';

export interface RecordingSessionRef {
  sessionId: string;
  kind: 'program' | 'free';
  programId: string | null;
  programName: string;
  /** Session clock seconds. */
  tStart: number;
  tEnd: number | null;
}

/** Metadata about a raw recording (HBRAW bytes are stored separately under the same id). */
export interface RecordingMeta {
  id: string;
  createdAt: string;
  endedAt: string | null;
  /** Seconds of EEG (or host) time covered, when known. */
  durationS: number | null;
  bytes: number;
  headset: string | null;
  hasHeart: boolean;
  sessions: RecordingSessionRef[];
  label: string;
  /** True when the file was opened from disk for replay rather than recorded here. */
  imported: boolean;
}

/** One value of one key measure for one second. Null carries its reason (never zero). */
export interface KeyCell {
  v: number | null;
  why: Reason | 'no_runner' | 'not_in_session';
}

export interface KeyRow {
  /** Whole session seconds. */
  t: number;
  block: string | null;
  cells: Record<string, KeyCell>;
}

/** Column definitions shared by the sampler and the CSV export. */
export interface KeyColumn {
  id: string;
  label: string;
  unit: string;
}

export const KEY_COLUMNS: KeyColumn[] = [
  { id: 'alpha_db', label: 'alpha above background, temporal', unit: 'dB' },
  { id: 'theta_db', label: 'theta above background, temporal', unit: 'dB' },
  { id: 'beta_db', label: 'beta above background, temporal', unit: 'dB' },
  { id: 'dominant_hz', label: 'dominant confirmed peak', unit: 'Hz' },
  { id: 'phi_closeness', label: 'golden ratio alignment (closeness)', unit: '0..1' },
  { id: 'phi_chance_a', label: 'golden ratio chance level A', unit: '0..1' },
  { id: 'phi_excess_a', label: 'golden ratio excess over chance A', unit: '0..1' },
  { id: 'phi_excess_b', label: 'golden ratio excess over chance B', unit: '0..1' },
  { id: 'phi_steps', label: 'golden ratio cascade steps', unit: 'steps' },
  { id: 'oct_closeness', label: 'octave alignment (closeness)', unit: '0..1' },
  { id: 'oct_chance_a', label: 'octave chance level A', unit: '0..1' },
  { id: 'oct_excess_a', label: 'octave excess over chance A', unit: '0..1' },
  { id: 'oct_excess_b', label: 'octave excess over chance B', unit: '0..1' },
  { id: 'oct_steps', label: 'octave cascade steps', unit: 'steps' },
  { id: 'usable_channels', label: 'usable EEG channels', unit: 'count' },
  { id: 'clean_fraction', label: 'clean fraction (mean of channels)', unit: '0..1' },
  { id: 'emg_db', label: 'muscle level (mean of channels)', unit: 'dB' },
  { id: 'hr_bpm', label: 'heart rate', unit: 'bpm' },
  { id: 'rmssd_ms', label: 'RMSSD', unit: 'ms' },
  { id: 'resonance_strength', label: 'heart rhythm resonance strength', unit: '0..1' },
  { id: 'breath_bpm', label: 'breathing rate estimate', unit: 'breaths/min' },
  { id: 'pacer_adherence', label: 'pacer adherence', unit: '0..1' },
  { id: 'reward', label: 'reward level (from the runner)', unit: '0..1' },
];

/** Every setting that affects a measurement or its smoothing, stored with each session. */
export interface SessionSettings {
  audio: AudioSettings;
  viz: { quality: string; rampS: number; slowStaleS: number; heartStaleS: number };
  mains: 'auto' | 50 | 60;
  chanceDriver: 'a' | 'b';
  engine: { version: string | null; params: Record<string, number | string | boolean> | null };
  engineOverrides: Record<string, number>;
  appVersion: string;
}

export interface StoredSession {
  id: string;
  kind: 'program' | 'free';
  startedAt: string;
  endedAt: string | null;
  programId: string | null;
  programName: string;
  state: string | null;
  recordingId: string | null;
  /** Session clock seconds at start and end, for locating the session in its recording. */
  tStart: number;
  tEnd: number | null;
  record: SessionRecord | null;
  keyRows: KeyRow[];
  settings: SessionSettings;
  completed: boolean;
  /** Free-text or marked notes the user added during the session. */
  notes: { t: number; text: string }[];
}

export interface AppSettings {
  version: 1;
  onboarded: boolean;
  /** Sound on or off for sessions. */
  soundOn: boolean;
  audio: AudioSettingsPatch;
  vizQuality: 'low' | 'medium' | 'high';
  mains: 'auto' | 50 | 60;
  chanceDriver: 'a' | 'b';
  /** Screen brightness multiplier in eyes-closed mode, 0..0.5 (0 = black). */
  eyesClosedLevel: number;
  /** Numeric engine parameter overrides (tolerances), applied at the next session start. */
  engineOverrides: Record<string, number>;
  replaySpeed: 1 | 4 | 'fast';
  keepScreenOn: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  onboarded: false,
  soundOn: true,
  audio: {},
  vizQuality: 'medium',
  mains: 'auto',
  chanceDriver: 'a',
  eyesClosedLevel: 0.04,
  engineOverrides: {},
  replaySpeed: 1,
  keepScreenOn: true,
};
