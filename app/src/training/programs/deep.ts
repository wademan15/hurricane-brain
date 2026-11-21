/** Theta, alpha-theta and sleep-onset programs (design P5, P6; research R4.12, R5.2). */

import type { Program, VariableSpec, WatchSpec } from '../program';
import { b, COMMON_SOUND, COMMON_VISUAL, F, program, SAFETY, sound, standardSession, standardVariables, v } from './common';

const TETHER: WatchSpec = {
  id: 'wake_tether',
  when: [
    { field: F.alphaT, op: 'below', baselineSd: -1.5 },
    { field: F.thetaT, op: 'above', baselineSd: 1 },
  ],
  forS: 30,
  event: 'tether',
  text: 'You may be drifting toward sleep. If you want to stay on the edge, take one slightly deeper breath.',
  enabledBy: 'wake_tether',
};

const tetherVar: VariableSpec = { id: 'wake_tether', label: 'Wake tether', description: 'When your alpha drops away and theta rises for a while, as at sleep onset, the sound brightens slightly and a quiet voice invites a deeper breath, to help you stay on the edge.', kind: 'boolean', default: true };

export const THETA: Program = program({
  id: 'theta_drift',
  version: 1,
  name: 'Theta Drift',
  family: 'theta',
  state: 'theta',
  summary: 'Eyes closed, reclined. Let theta rise as you drift toward the edge of sleep while staying aware.',
  description: 'Feedback follows theta above the fitted background at the ear sensors, relative to your own baseline. On this headset theta is read at the ear sensors only: at the forehead it is mostly eye movement. Theta rises naturally with drowsiness, so this is a practice of staying on the edge, and the wake tether helps if you want it.',
  evidence: { grade: 'B-C', summary: 'Theta rises reliably with drowsiness and in some meditation and hypnosis (Grade A to B). Training theta for its own sake has mixed evidence, and the focus-related theta at the top of the head cannot be seen with this headset.', sources: ['Hori et al. 1994', 'Jensen et al. 2015', 'Lomas et al. 2015'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false, recommendedHeadsets: ['museS'] },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 2, excludeIf: ['psychosis_bipolar'] },
  targets: [{ id: 'theta', label: 'Theta', source: 'field', field: F.thetaT, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'profile_best', title: 'Drift', text: 'Eyes closed, body heavy. Let yourself drift, as if just before sleep, while a small part of you stays aware.', cues: [{ atS: 60, text: 'Drifting, still aware.', sparse: true }, { atS: 150, text: 'Let images come and go.' }] }),
  }),
  bindings: {
    sound: [...COMMON_SOUND, sound('theta_texture', F.thetaT, 'A low, bowl-like drone that deepens with theta.')],
    visual: [...COMMON_VISUAL],
    display: [F.thetaT, F.alphaT, F.emg],
  },
  observe: [F.alphaT, F.thetaT, F.thetaMinusAlpha, F.emg, F.thetaFreq],
  variables: [...standardVariables({ tau: 2, posture: 'reclined', train: 240 }), tetherVar],
  ladder: true,
  strategies: { recommended: ['visual_drift', 'descent_count', 'heavy_warm', 'mantra_silent', 'open_awareness'], usesProfile: true },
  watches: [TETHER],
  contraindications: ['A history of psychosis or a bipolar condition: talk with a clinician first.'],
  safetyNotes: [SAFETY.general, SAFETY.deepStates, SAFETY.psych, SAFETY.sleepiness],
});

export const ALPHA_THETA: Program = program({
  id: 'alpha_theta_twilight',
  version: 1,
  name: 'Twilight',
  family: 'alpha_theta',
  state: 'alpha_theta',
  summary: 'The classic deep-state practice: drift from alpha into theta and rest at the edge of sleep.',
  description: 'Two textures follow two measurements: a flowing alpha texture and a deeper theta drone, crossfading with the balance of theta to alpha above background at the ear sensors. The reward rises as theta rises and as theta overtakes alpha (a crossover), which is marked by the theta texture blooming slightly, never by a discrete sound. A wake tether can help you stay on the edge rather than fall asleep.',
  evidence: { grade: 'B-C', summary: 'Alpha-theta training has positive studies in music and performance and a long clinical history under supervision; many studies are small and used combined methods. Offered here for relaxation and self-exploration only.', sources: ['Egner and Gruzelier 2003', 'Peniston and Kulkosky 1989', 'Gruzelier 2014'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false, recommendedHeadsets: ['museS'] },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 2, excludeIf: ['psychosis_bipolar'] },
  targets: [
    { id: 'theta', label: 'Theta', source: 'field', field: F.thetaT, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } },
    { id: 'crossover', label: 'Theta over alpha', source: 'field', field: F.thetaMinusAlpha, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } },
  ],
  combine: 'mean',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'profile_best', title: 'Twilight', text: 'Eyes closed, reclined and heavy. Let yourself float down, listening as the flowing sound gives way to the deeper one.', cues: [{ atS: 60, text: 'Floating down.', sparse: true }, { atS: 180, text: 'Stay just on the edge.' }] }),
  }),
  bindings: {
    sound: [...COMMON_SOUND, sound('alpha_texture', F.alphaT, 'Soft flowing texture following alpha above background.'), sound('theta_texture', F.thetaT, 'Deeper drone following theta above background; blooms slightly at a crossover.')],
    visual: [...COMMON_VISUAL],
    display: [F.thetaMinusAlpha, F.alphaT, F.thetaT],
  },
  observe: [F.alphaT, F.thetaT, F.thetaMinusAlpha, F.emg, F.alphaFreq, F.thetaFreq],
  variables: [...standardVariables({ tau: 2.5, posture: 'reclined', train: 300, blocks: 3, trainMax: 600 }), tetherVar],
  ladder: true,
  strategies: { recommended: ['visual_drift', 'heavy_warm', 'descent_count', 'mantra_silent'], usesProfile: true },
  watches: [TETHER],
  contraindications: ['A history of psychosis or a bipolar condition: talk with a clinician first.', 'If difficult memories tend to surface in deep relaxation, consider doing this with support.'],
  safetyNotes: [SAFETY.general, SAFETY.deepStates, SAFETY.psych, SAFETY.sleepiness],
});

export const SLEEP_ONSET: Program = program({
  id: 'sleep_onset_descent',
  version: 1,
  name: 'Descent',
  family: 'sleep_onset',
  state: 'descent',
  summary: 'A bedtime wind-down. The sound fades as your rhythms show you letting go toward sleep.',
  description: 'As alpha fades and theta rises at the ear sensors, the soundscape gradually fades out, so the deeper you go the quieter it gets, until there is silence. This is a guided wind-down with a measured descent, not a sleep aid. Delta (the slow waves of deep sleep) is shown for information only and marked low confidence: while awake on this headset it is mostly eye movement, so it is never a training target.',
  evidence: { grade: 'B-C', summary: 'The stages of sleep onset are well established (Grade A). Sleep-related feedback has not beaten sham in controlled trials, so this is offered as a wind-down, with no sleep claims.', sources: ['Hori et al. 1994', 'Schabus et al. 2017'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false, recommendedHeadsets: ['museS'] },
  targets: [{ id: 'descent', label: 'Theta over alpha', source: 'field', field: F.thetaMinusAlpha, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.5 }, adapt: { enabled: false, band: [0.6, 0.8] }, spanSd: 2 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('closed', 'Lie down comfortably. Let the headband settle against the pillow. Nothing to do.'),
    b.baseline('closed', 'Rest with your eyes closed. This is your awake reference for tonight.'),
    b.train({ eyes: 'closed', strategy: 'user_choice', title: 'Descent', text: 'Let go into the evening. As you settle deeper, the sound will fade away by itself.', cues: [{ atS: 120, text: 'Heavier with each breath out.', sparse: true }] }),
  ],
  bindings: {
    sound: [sound('base_soundscape', 'reward', 'Fades out as the reward rises: the inverse of other programs.'), sound('fade_on_target', 'reward', 'Gradual fade with the declared time constant; silence at the end.'), sound('thinning', F.artifact)],
    visual: [],
    display: [F.thetaMinusAlpha, F.deltaT],
  },
  observe: [F.alphaT, F.thetaT, F.deltaT, F.emg],
  variables: [v.settle(60), v.baseline(60), v.trainBlock(1200, 300, 3600), v.tau(10, 3, 30), v.minClean(), v.soundscape(), v.posture('lying')],
  ladder: false,
  strategies: { recommended: ['descent_count', 'body_scan', 'heavy_warm', 'breath_long_exhale', 'visual_drift'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general, 'Wind-down only: this is not a sleep aid, and it does not record overnight unless you choose that separately.'],
});
