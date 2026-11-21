/**
 * The program library.
 *
 * Not offered on a Muse, by design (research R2.2, R5.4): gamma training and SMR training
 * (the headset cannot measure them honestly: gamma is dominated by muscle, SMR needs the top of
 * the head), frontal-midline theta (needs Fz), and waking delta training (mostly eye artifact).
 * Upper-alpha "Clear Mind" (design P4) is waiting for an upper-alpha band field (NOTES.md).
 * No rhythmic entrainment anywhere (rule 6).
 */

import type { Program } from '../program';
import { GOLDEN_CASCADE, GOLDEN_RATIO_ALIGNMENT, FRONTAL_BALANCE, HEMISPHERE_BALANCE, OCTAVE_ALIGNMENT } from './alignment';
import { ALPHA_EYES_CLOSED, ALPHA_EYES_OPEN, STILLNESS } from './alpha';
import { ALPHA_THETA, SLEEP_ONSET, THETA } from './deep';
import { ANCHOR_PAIRING, ANCHOR_PROBE, EMOTION_PRACTICE, SIGNATURE_PRACTICE } from './emotion';
import { BRAIN_HEART, HIGH_HRV, RESONANCE_BREATHING, RESONANCE_FINDING } from './heart';
import { CALIBRATION, DISCOVERY } from './profiling';

export const PROGRAMS: Program[] = [
  CALIBRATION,
  DISCOVERY,
  STILLNESS,
  ALPHA_EYES_CLOSED,
  ALPHA_EYES_OPEN,
  THETA,
  ALPHA_THETA,
  SLEEP_ONSET,
  GOLDEN_RATIO_ALIGNMENT,
  GOLDEN_CASCADE,
  OCTAVE_ALIGNMENT,
  HEMISPHERE_BALANCE,
  FRONTAL_BALANCE,
  RESONANCE_FINDING,
  RESONANCE_BREATHING,
  HIGH_HRV,
  BRAIN_HEART,
  EMOTION_PRACTICE,
  SIGNATURE_PRACTICE,
  ANCHOR_PAIRING,
  ANCHOR_PROBE,
];

const BY_ID = new Map(PROGRAMS.map((p) => [p.id, p]));

export function getProgram(id: string): Program | undefined {
  return BY_ID.get(id);
}

/** Targets we will not offer, with the reason shown if a user asks. */
export const NOT_OFFERED: { target: string; reason: string }[] = [
  { target: 'gamma', reason: 'At the ear and forehead sensors, gamma-range activity is dominated by jaw, forehead and temple muscle. Training it would mostly train muscle tension.' },
  { target: 'smr', reason: 'The sensorimotor rhythm sits over the top of the head, where this headset has no sensor.' },
  { target: 'frontal_midline_theta', reason: 'Focus-related theta sits at the top-centre of the forehead (Fz); the forehead sensors here mostly pick up eye movement in that range.' },
  { target: 'waking_delta', reason: 'While awake, slow delta activity on this headset is mostly eye movement, sweat or band movement. Delta is shown only in sleep-onset practice, for information, marked low confidence.' },
  { target: 'upper_alpha', reason: 'Calm-focus upper-alpha practice needs an upper-alpha band measurement that the engine does not provide yet.' },
  { target: 'entrainment', reason: 'Binaural, monaural and isochronic stimulation are not part of this app; they arrive later with EarthSync.' },
];

export { ALPHA_EYES_CLOSED, ALPHA_EYES_OPEN, ALPHA_THETA, ANCHOR_PAIRING, ANCHOR_PROBE, BRAIN_HEART, CALIBRATION, DISCOVERY, EMOTION_PRACTICE, FRONTAL_BALANCE, GOLDEN_CASCADE, GOLDEN_RATIO_ALIGNMENT, HEMISPHERE_BALANCE, HIGH_HRV, OCTAVE_ALIGNMENT, RESONANCE_BREATHING, RESONANCE_FINDING, SIGNATURE_PRACTICE, SLEEP_ONSET, STILLNESS, THETA };
