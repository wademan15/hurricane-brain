/** Stillness and alpha programs (design P1, P2, P3). */

import type { Program } from '../program';
import { b, COMMON_SOUND, COMMON_VISUAL, F, program, SAFETY, sound, standardSession, standardVariables, visual } from './common';

const ALPHA_METRIC = {
  id: 'alpha_metric',
  label: 'What the sound follows',
  description: 'The tracking option follows your own confirmed alpha rhythm moment to moment (fast, needs a clear alpha peak). The band option follows alpha above background at the ear sensors (steadier, a few seconds slower, works when the peak is faint).',
  kind: 'choice' as const,
  default: 'fast.track[alpha].height_db',
  options: [
    { value: 'fast.track[alpha].height_db', label: 'Your alpha rhythm, moment to moment' },
    { value: 'spectra[temporal].bands.alpha.above_bg_db', label: 'Alpha band at the ear sensors' },
  ],
};

export const STILLNESS: Program = program({
  id: 'stillness_soft_landing',
  version: 1,
  name: 'Soft Landing',
  family: 'stillness',
  state: 'stillness',
  summary: 'Learn to soften the forehead, jaw and temples and let the head be still. Everyone starts here.',
  description: 'The sound opens as muscle activity at the forehead and temples falls below your own baseline and the head is still. This is the one thing this headset measures best, it is felt quickly, and it cleans the signal for every other program. It also works for people whose alpha rhythm is naturally faint.',
  evidence: { grade: 'A', summary: 'Muscle activity is directly and reliably measured at these sensors and relaxing it is trainable. It is a measure of muscle tension, not of brainwaves.', sources: ['Research brief R2.2, R4.5', 'Stetter and Kupper 2002'] },
  experimental: false,
  requires: { eeg: true, heart: 'none', signature: false, anchor: false },
  targets: [{ id: 'emg', label: 'Muscle tension', source: 'field', field: F.emg, direction: 'down', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'AF7', 'AF8', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: standardSession({
    eyes: 'any',
    baselineText: 'Sit as you normally would and rest. This sets today\'s reference for muscle tension.',
    train: b.train({ eyes: 'any', strategy: 'user_choice', title: 'Soften', text: 'Let the forehead widen, the eyes rest heavy, the jaw hang and the tongue lie soft. As the face softens, the sound opens.', cues: [{ atS: 30, text: 'Soft jaw. Smooth brow.', sparse: true }, { atS: 90, text: 'Let the head rest still, like a heavy ball balanced on the neck.' }] }),
  }),
  bindings: {
    sound: [...COMMON_SOUND],
    visual: [...COMMON_VISUAL],
    display: [F.emg, F.clean],
  },
  observe: [F.alphaT, F.thetaT, F.betaT],
  variables: standardVariables({ train: 120, blocks: 4, tau: 1.5, muscle: false, trainMin: 60, trainMax: 300 }),
  ladder: true,
  strategies: { recommended: ['face_soften', 'body_scan', 'breath_long_exhale', 'progressive_relaxation', 'shake_then_sit'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const ALPHA_EYES_CLOSED: Program = program({
  id: 'alpha_eyes_closed',
  version: 1,
  name: 'Calm Alpha',
  family: 'alpha',
  state: 'alpha_ec',
  summary: 'Eyes closed. Reach your relaxed alpha quickly and let it stay.',
  description: 'Feedback follows alpha above the fitted background at the ear sensors, relative to your own eyes-closed baseline. With eyes closed most people are already near their natural alpha level, so the skill is reaching it quickly and holding it without effort, not breaking records. Trying hard tends to block alpha: allow, do not strive.',
  evidence: { grade: 'B', summary: 'People can learn to raise and hold alpha, much of it by learning to stop blocking it. Effects on calm are real but overlap with ordinary relaxation.', sources: ['Hardt and Kamiya 1978', 'Lynch and Paskewitz 1971', 'Gruzelier 2014'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'stillness_soft_landing', level: 1 },
  targets: [{ id: 'alpha', label: 'Alpha', source: 'field', field: '${alpha_metric}', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'profile_best', title: 'Calm alpha', text: 'Eyes closed. Use your approach, gently. Let the sound show you when you are there, and let it stay without holding on.', cues: [{ atS: 45, text: 'Allow, rather than try.', sparse: true }, { atS: 120, text: 'Let the eyes rest still behind the lids.' }] }),
  }),
  bindings: {
    sound: [...COMMON_SOUND, sound('tracking_tone', F.fastAlphaFreq, 'Pitch is your alpha frequency times 32; present only while the alpha peak is confirmed.'), sound('alpha_warmth', F.alphaT, 'Warmth relative to your baseline and how long it has held.')],
    visual: [...COMMON_VISUAL],
    display: [F.alphaT, F.alphaFreq, F.emg],
  },
  observe: [F.alphaT, F.thetaT, F.betaT, F.emg, F.alphaFreq, F.exponent, F.rmssd],
  variables: [ALPHA_METRIC, ...standardVariables({ tau: 1, posture: 'upright' })],
  ladder: true,
  strategies: { recommended: ['none', 'open_awareness', 'breath_resonance', 'body_scan', 'visual_calm', 'mantra_silent', 'brow_point', 'breath_count', 'heavy_warm', 'listen_sound'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general, SAFETY.driving],
});

export const ALPHA_EYES_OPEN: Program = program({
  id: 'alpha_eyes_open',
  version: 1,
  name: 'Open-Eyed Calm',
  family: 'alpha',
  state: 'alpha_eo',
  summary: 'Eyes open, soft gaze. Carry calm alpha into daily life.',
  description: 'The same alpha measure as Calm Alpha, compared with your eyes-open baseline, never with eyes closed: closing the eyes raises alpha for almost everyone and is not training. Rest the eyes on a dim, plain point or the hurricane at low contrast, and let the gaze go soft and wide. Blinks are fine; they are removed before anything is scored.',
  evidence: { grade: 'B', summary: 'Fixation and focusing suppress alpha; a defocused gaze lets it return. Eyes-open alpha is harder to raise and closer to everyday use.', sources: ['Mulholland and Peper 1971', 'Barry et al. 2007'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 3 },
  targets: [{ id: 'alpha', label: 'Alpha, eyes open', source: 'field', field: '${alpha_metric}', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'open',
    train: b.train({ eyes: 'open', strategy: 'soft_gaze', title: 'Open-eyed calm', text: 'Eyes open, resting on the point. Let the focus soften and the gaze widen to the edges. Let the sound find you.', cues: [{ atS: 40, text: 'Soft and wide.', sparse: true }, { atS: 110, text: 'Let the eyes be still between blinks.' }] }),
  }),
  bindings: {
    sound: [...COMMON_SOUND, sound('tracking_tone', F.fastAlphaFreq), sound('alpha_warmth', F.alphaT)],
    visual: [...COMMON_VISUAL],
    display: [F.alphaT, F.emg],
  },
  observe: [F.alphaT, F.thetaT, F.betaT, F.emg, F.alphaFreq],
  variables: [{ ...ALPHA_METRIC, default: 'spectra[temporal].bands.alpha.above_bg_db' }, ...standardVariables({ tau: 1, posture: 'upright' })],
  ladder: true,
  strategies: { recommended: ['soft_gaze', 'none', 'breath_long_exhale', 'face_soften', 'listen_sound'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});
