/**
 * Shapes stored on the device. Everything here stays in this browser's IndexedDB; nothing is
 * sent anywhere unless the user exports it (CLAUDE.md rule 8).
 */
import type { AudioSettings, AudioSettingsPatch } from '../audio';
import type { Reason } from '../engine/frames';
import type { SessionRecord } from '../training';

export type ResponseSpeed = 'quicker' | 'steady' | 'slower';
export type AgeGroup = 'child' | 'teen' | 'adult';

/** What the app knows about a person besides their training profile. */
export interface ProfileInfo {
  name: string;
  ageGroup: AgeGroup | null;
}

/** One member of a cascade as the engine reported it. */
export interface CascadeMember {
  id: number;
  band: string;
  /** Integrated frequency, Hz, or null with the reason it was not measured. */
  freqHz: KeyCell;
}

/** The state of one cascade (golden ratio or octave) at the end of an event. */
export interface CascadeSnapshot {
  target: 'phi' | 'octave';
  members: CascadeMember[];
  steps: number;
  maxSteps: number;
  /** Measured frequency ratio between neighbouring members (hi / lo), one per step. */
  ratios: KeyCell[];
  closeness: KeyCell;
  chanceA: KeyCell;
  chanceB: KeyCell;
  pA: KeyCell;
  excessA: KeyCell;
  excessB: KeyCell;
}

/** A stretch in which the golden ratio state, the octave state, or both at once, held. */
export interface CascadeEvent {
  kind: 'phi' | 'octave' | 'both';
  /** Session clock seconds. */
  tStart: number;
  tEnd: number;
  durationS: number;
  /** One snapshot for phi or octave, two for both. */
  parts: CascadeSnapshot[];
}

/** The short entry after a session. Everything optional; stored with the session. */
export interface Journal {
  note: string;
  /** 1 (low) to 5 (high), or null when not answered. */
  mood: number | null;
  ease: number | null;
  depth: number | null;
  tags: string[];
  writtenAt: string;
}

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
  { id: 'phi_active', label: 'golden ratio state active (1 = yes)', unit: '0/1' },
  { id: 'phi_for_s', label: 'seconds in the current golden ratio condition', unit: 's' },
  { id: 'oct_active', label: 'octave state active (1 = yes)', unit: '0/1' },
  { id: 'oct_for_s', label: 'seconds in the current octave condition', unit: 's' },
  { id: 'both_active', label: 'both states at once (1 = yes)', unit: '0/1' },
  { id: 'both_for_s', label: 'seconds in the current combined condition', unit: 's' },
  { id: 'at_ratio', label: 'alpha:theta frequency ratio (strongest alpha and theta peaks)', unit: 'ratio' },
  { id: 'at_miss_2', label: 'alpha:theta distance from 2:1 (ln ratio)', unit: 'ln' },
  { id: 'at_miss_3', label: 'alpha:theta distance from 3:1 (ln ratio)', unit: 'ln' },
  { id: 'at_miss_phi', label: 'alpha:theta distance from the golden ratio (ln ratio)', unit: 'ln' },
  { id: 'usable_channels', label: 'usable EEG channels', unit: 'count' },
  { id: 'clean_fraction', label: 'clean fraction (mean of channels)', unit: '0..1' },
  { id: 'emg_db', label: 'muscle level (mean of channels)', unit: 'dB' },
  { id: 'hr_bpm', label: 'heart rate', unit: 'bpm' },
  { id: 'rmssd_ms', label: 'RMSSD', unit: 'ms' },
  { id: 'sdnn_ms', label: 'SDNN', unit: 'ms' },
  { id: 'lf_power', label: 'heart rhythm power 0.04-0.15 Hz', unit: 'ms2' },
  { id: 'hf_power', label: 'heart rhythm power 0.15-0.4 Hz', unit: 'ms2' },
  { id: 'resonance_hz', label: 'heart rhythm peak frequency', unit: 'Hz' },
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
  /** Alignment response speed preset and the integration time it set (null = engine default). */
  responseSpeed: ResponseSpeed;
  /** Whether harmonics counted toward octave alignment. */
  harmonicsCount: boolean;
  reducedMotion: 'system' | 'on' | 'off';
  /** The screen was dark, sound only. */
  soundOnly: boolean;
  ageGroup: AgeGroup | null;
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
  /** The profile this session belongs to (several people can share one device). */
  profileId: string;
  /** Golden ratio, octave and combined-state events derived from the slow frames. */
  cascadeEvents: CascadeEvent[];
  journal: Journal | null;
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
  /** Alignment response speed: steady (30 s, default), quicker or slower. */
  responseSpeed: ResponseSpeed;
  /** Whether harmonics count toward octave alignment (default no). */
  harmonicsCount: boolean;
  /** 'system' follows the device's reduced-motion preference. */
  reducedMotion: 'system' | 'on' | 'off';
  /** Run sessions with the screen dark, sound only. */
  soundOnly: boolean;
  /** The photosensitivity notice was read. */
  photoNoticeSeen: boolean;
  /** Seconds of usable signal on every channel before "good to go". */
  fitHoldS: number;
  /** Show the fit and contact coaching before every session. */
  fitCoaching: boolean;
  /** Live stream out to a local address chosen by the user. Off by default. */
  stream: { enabled: boolean; url: string; rawEeg: boolean };
  /** The person using the app now. */
  activeProfileId: string | null;
  /** Names and age groups, by profile id. */
  profileInfo: Record<string, ProfileInfo>;
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
  responseSpeed: 'steady',
  harmonicsCount: false,
  reducedMotion: 'system',
  soundOnly: false,
  photoNoticeSeen: false,
  fitHoldS: 10,
  fitCoaching: true,
  stream: { enabled: false, url: 'ws://localhost:8765', rawEeg: false },
  activeProfileId: null,
  profileInfo: {},
  eyesClosedLevel: 0.04,
  engineOverrides: {},
  replaySpeed: 1,
  keepScreenOn: true,
};
