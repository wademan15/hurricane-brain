/**
 * Muse protocol constants. Every value here has its source recorded in app/src/device/NOTES.md.
 * Nothing in this file is recalled from memory.
 */

/** Primary service advertised by every Muse (muse-js MUSE_SERVICE, muse-rs MUSE_SERVICE_UUID). */
export const MUSE_SERVICE = 0xfe8d;

/** Vendor characteristic UUID for a 16-bit suffix: 273eXXXX-4c4d-454d-96be-f03bac821358. */
export function museUuid(suffix: number): string {
  return `273e${suffix.toString(16).padStart(4, '0')}-4c4d-454d-96be-f03bac821358`;
}

/**
 * Characteristic codes: the 16-bit UUID suffix. These are also the `char` ids written into
 * recordings, so they must never be renumbered.
 */
export const MuseChar = {
  CONTROL: 0x0001,
  EEG_TP9: 0x0003,
  EEG_AF7: 0x0004,
  EEG_AF8: 0x0005,
  EEG_TP10: 0x0006,
  EEG_AUX: 0x0007,
  GYRO: 0x0009,
  ACCEL: 0x000a,
  TELEMETRY: 0x000b,
  PPG_AMBIENT: 0x000f,
  PPG_INFRARED: 0x0010,
  PPG_RED: 0x0011,
  /** Athena: every sensor multiplexed here. Its presence identifies Athena (muse-rs). */
  ATHENA_DATA: 0x0013,
  /** Athena: second data characteristic subscribed by OpenMuse and muse-lsl. No capture shows data on it. */
  ATHENA_DATA_2: 0x0014,
} as const;

export const CLASSIC_EEG_CHARS: number[] = [MuseChar.EEG_TP9, MuseChar.EEG_AF7, MuseChar.EEG_AF8, MuseChar.EEG_TP10, MuseChar.EEG_AUX];
export const CLASSIC_EEG_NAMES = ['TP9', 'AF7', 'AF8', 'TP10', 'AUX'];
export const CLASSIC_PPG_CHARS: number[] = [MuseChar.PPG_AMBIENT, MuseChar.PPG_INFRARED, MuseChar.PPG_RED];
export const CLASSIC_PPG_NAMES = ['ambient', 'infrared', 'red'];

export const EEG_RATE_HZ = 256;
export const PPG_RATE_HZ = 64;
export const MOTION_RATE_HZ = 52;

// ---- Classic ---------------------------------------------------------------
export const CLASSIC_EEG_SAMPLES_PER_PACKET = 12;
export const CLASSIC_EEG_BITS = 12;
/** µV = 0.48828125 * (raw - 2048). muse-js, muse-rs, muse-lsl. */
export const CLASSIC_EEG_SCALE_UV = 0.48828125;
export const CLASSIC_EEG_MIDPOINT = 2048;
export const CLASSIC_PPG_SAMPLES_PER_PACKET = 6;
export const CLASSIC_IMU_SAMPLES_PER_PACKET = 3;
export const ACCEL_SCALE_G = 0.0000610352;
export const CLASSIC_GYRO_SCALE_DPS = 0.0074768;
/** Classic telemetry battery: u16 BE / 512 = percent. */
export const CLASSIC_BATTERY_DIVISOR = 512;

// ---- Athena ----------------------------------------------------------------
export const ATHENA_PACKET_HEADER = 14;
export const ATHENA_FIRST_TAG_OFFSET = 9;
export const ATHENA_SUBPACKET_HEADER = 5;
export const ATHENA_EEG_BITS = 14;
export const ATHENA_EEG_MIDPOINT = 8192;
/**
 * 1450 µV over the 14-bit range (OpenMuse EEG_SCALE, muse-lsl/BrainFlow MUSE_ATHENA_EEG_SCALE).
 * muse-rs rounds it to 0.0885 (0.007% smaller). Midpoint subtraction as muse-rs and muse-lsl.
 */
export const ATHENA_EEG_SCALE_UV = 1450 / 16383;
export const ATHENA_OPTICS_BITS = 20;
/** Athena gyro scale is negated relative to Classic (OpenMuse, muse-rs, muse-lsl agree). */
export const ATHENA_GYRO_SCALE_DPS = -0.0074768;
/** Athena battery: u16 LE / 256 = percent. Checked against captures at known levels (see NOTES). */
export const ATHENA_BATTERY_DIVISOR = 256;

export const AthenaTag = {
  EEG4: 0x11,
  EEG8: 0x12,
  OPTICS4: 0x34,
  OPTICS8: 0x35,
  OPTICS16: 0x36,
  IMU: 0x47,
  DRL_REF: 0x53,
  BATTERY_NEW: 0x88,
  BATTERY_OLD: 0x98,
} as const;

export interface AthenaTagInfo {
  kind: 'eeg' | 'optics' | 'imu' | 'drlref' | 'battery';
  channels: number;
  samples: number;
  /** Payload bytes; null = runs to the end of its packet (0x88). */
  len: number | null;
}

export const ATHENA_TAGS: Record<number, AthenaTagInfo> = {
  0x11: { kind: 'eeg', channels: 4, samples: 4, len: 28 },
  0x12: { kind: 'eeg', channels: 8, samples: 2, len: 28 },
  0x34: { kind: 'optics', channels: 4, samples: 3, len: 30 },
  0x35: { kind: 'optics', channels: 8, samples: 2, len: 40 },
  0x36: { kind: 'optics', channels: 16, samples: 1, len: 40 },
  0x47: { kind: 'imu', channels: 6, samples: 3, len: 36 },
  0x53: { kind: 'drlref', channels: 2, samples: 6, len: 24 },
  0x88: { kind: 'battery', channels: 1, samples: 1, len: null },
  0x98: { kind: 'battery', channels: 1, samples: 1, len: 20 },
};

/**
 * Athena EEG names. The first four are the Classic sites (OpenMuse, muse-rs, muse-lsl agree).
 * Channels 5-8: the vendor describes them as "4 amplified Aux channels"; OpenMuse names them
 * AUX_1..AUX_4, muse-rs names them FPz, AUX_R, AUX_L, AUX without a cited source. We use the
 * neutral names. Unverified which physical input each one is.
 */
export const ATHENA_EEG_NAMES_4 = ['TP9', 'AF7', 'AF8', 'TP10'];
export const ATHENA_EEG_NAMES_8 = ['TP9', 'AF7', 'AF8', 'TP10', 'AUX1', 'AUX2', 'AUX3', 'AUX4'];

/**
 * Optical channel names from OpenMuse (decode.py OPTICS_CHANNELS, validated there by
 * cross-correlation). LO/LI/RI/RO = left outer/inner, right inner/outer; NIR 730 nm, IR 850 nm,
 * RED, AMB(ient). The 4-channel mode carries canonical channels 4..7 (OpenMuse and muse-lsl agree).
 * muse-rs names them differently (ambient, infrared, red, opt3...). Unverified on our side.
 */
export const ATHENA_OPTICS_16 = [
  'LO_NIR', 'RO_NIR', 'LO_IR', 'RO_IR', 'LI_NIR', 'RI_NIR', 'LI_IR', 'RI_IR',
  'LO_RED', 'RO_RED', 'LO_AMB', 'RO_AMB', 'LI_RED', 'RI_RED', 'LI_AMB', 'RI_AMB',
];
export const ATHENA_OPTICS_8 = ATHENA_OPTICS_16.slice(0, 8);
export const ATHENA_OPTICS_4 = ATHENA_OPTICS_16.slice(4, 8);

export function athenaEegNames(channels: number): string[] {
  return channels === 4 ? ATHENA_EEG_NAMES_4 : ATHENA_EEG_NAMES_8;
}
export function athenaOpticsNames(channels: number): string[] {
  if (channels === 4) return ATHENA_OPTICS_4;
  if (channels === 8) return ATHENA_OPTICS_8;
  return ATHENA_OPTICS_16;
}

/**
 * Presets. Classic: p21 = 4 EEG, p20 = EEG + AUX, p50 = EEG + PPG (muse-js, muse-rs).
 * Athena presets as measured by muse-rs (fw 3.1.11/3.1.19) and OpenMuse (captures).
 */
export const CLASSIC_PRESET_EEG = 'p21';
export const CLASSIC_PRESET_AUX = 'p20';
export const CLASSIC_PRESET_PPG = 'p50';
export const ATHENA_DEFAULT_PRESET = 'p1041';
export const ATHENA_PRESETS: Record<string, { eeg: number; optics: number }> = {
  p1041: { eeg: 8, optics: 16 },
  p1042: { eeg: 8, optics: 16 },
  p1043: { eeg: 8, optics: 8 },
  p1044: { eeg: 8, optics: 8 },
  p1045: { eeg: 8, optics: 4 },
  p1046: { eeg: 8, optics: 4 },
  p1031: { eeg: 4, optics: 16 },
  p1032: { eeg: 4, optics: 16 },
  p1033: { eeg: 4, optics: 8 },
  p1034: { eeg: 4, optics: 8 },
  p1035: { eeg: 4, optics: 4 },
  p1036: { eeg: 4, optics: 4 },
  p21: { eeg: 4, optics: 0 },
};

/** The longest command one control write takes (muse-rs MAX_COMMAND_LEN, measured). */
export const MAX_COMMAND_LEN = 18;
