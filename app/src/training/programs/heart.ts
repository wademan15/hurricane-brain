/**
 * Heart programs (design P10; research R4.3, R7.3; spec 13): finding the personal resonance
 * breathing rate, resonance breathing, high variability practice, and combined brain and heart.
 * The breath pacer is a guide and is labelled as the one element that is not a measurement.
 */

import type { Program } from '../program';
import { b, COMMON_SOUND, F, program, SAFETY, sound, standardSession, standardVariables, v, visual } from './common';

const HEART_SOUND = [
  sound('base_soundscape', 'reward'),
  sound('reward_layer', 'reward', 'Swells as the heart rhythm gathers into one slow, smooth wave.'),
  sound('heartbeat', F.hr, 'Soft pulse on each detected beat.'),
];
const HEART_VISUAL = [
  visual('eyewall_pulse', F.hr, 'Pulse through the eye wall on each detected beat.'),
  visual('slow_swell', F.breathPhase, 'Follows the measured breathing rhythm, not the pacer.'),
];
const HEART_GATING = { channels: [] as string[], channelRule: 'any' as const, minCleanFraction: 0.6, fastArtifact: false, maxEmgRiseDb: null, heart: true };
const HEART_DISPLAY = [F.resStrength, F.resHz, F.rmssd, F.hr, F.adherence, F.breathBpm, F.highHrv];

export const RESONANCE_FINDING: Program = program({
  id: 'hrv_resonance_finding',
  version: 1,
  name: 'Find Your Breathing Rate',
  family: 'heart',
  state: 'calm_heart',
  summary: 'Breathe with the pacer at five slow rates to find the one where your heart rhythm swings most smoothly.',
  description: 'Each person has a breathing rate, usually between 4.5 and 7 breaths a minute, at which the heart rhythm rises and falls in one large smooth wave. You breathe with the pacer for a few minutes at each of 6.5, 6, 5.5, 5 and 4.5 breaths a minute, with a short natural rest between. The rate with the strongest slow heart-rhythm wave, where you followed the pacer comfortably, becomes your rate. If two rates are within noise of each other, the app says so. Needs a chest strap for the best accuracy.',
  evidence: { grade: 'A', summary: 'Breathing near each person\'s resonance rate reliably maximizes heart-rate oscillation; the procedure follows the established resonance-rate protocol.', sources: ['Lehrer and Gevirtz 2014'] },
  experimental: false,
  requires: { eeg: false, heart: 'required', signature: false, anchor: false, recommendedHeadsets: ['polar_h10'] },
  targets: [{ id: 'resonance', label: 'Heart rhythm resonance', source: 'field', field: F.resStrength, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_mean_plus_sd', k: 1 }, adapt: { enabled: false, band: [0.6, 0.8] }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: 3,
  gating: HEART_GATING,
  blocks: [
    b.settle('any', 'Sit upright and comfortable. Breathe naturally while the heart rhythm settles in.'),
    b.baseline('any', 'Breathe naturally. This is your resting heart rhythm for today.'),
    ...[6.5, 6.0, 5.5, 5.0, 4.5].flatMap((rate) => [
      { id: `pace_${String(rate).replace('.', '_')}`, kind: 'strategy' as const, durationS: { var: 'trial_s' }, feedback: false, eyes: 'any' as const, strategy: 'breath_resonance', pacer: rate, ratings: ['ease' as const],
        guidance: { title: `${rate} breaths a minute`, start: `Follow the pacer at ${rate} breaths a minute: in as it rises, out as it falls. Easy, not too deep. The pacer is a guide, not a measurement.` } },
      b.rest({ id: `rest_${String(rate).replace('.', '_')}`, dur: { var: 'rest_s' }, text: 'Breathe naturally for a moment.' }),
    ]),
  ],
  bindings: { sound: [sound('breath_pacer', 'pacer', 'A guide, labelled as the one element that is not a measurement.'), sound('heartbeat', F.hr)], visual: [visual('pacer_visual', 'pacer'), ...HEART_VISUAL], display: HEART_DISPLAY },
  observe: [F.lf, F.resStrength, F.resHz, F.adherence, F.rmssd, F.hr, F.breathBpm],
  variables: [v.settle(60), v.baseline(120), { id: 'trial_s', label: 'Time at each rate', description: 'Longer gives a steadier reading; the heart measures need at least a minute of clean beats.', kind: 'number', default: 150, min: 120, max: 240, step: 30, unit: 's' }, v.rest(45)],
  ladder: false,
  strategies: { recommended: ['breath_resonance'], usesProfile: false },
  watches: [],
  contraindications: ['If you have a heart or breathing condition, check with your doctor before paced breathing practice.'],
  safetyNotes: [SAFETY.breath, SAFETY.general],
});

export const RESONANCE_BREATHING: Program = program({
  id: 'hrv_resonance_breathing',
  version: 1,
  name: 'Calm Heart',
  family: 'heart',
  state: 'calm_heart',
  summary: 'Breathe at your own resonance rate and feel the heart rhythm gather into one slow wave.',
  description: 'The pacer runs at your measured resonance rate. Feedback follows resonance: how much of your heart rhythm sits in one narrow slow wave. A final block turns the pacer and feedback off to see whether the rhythm holds as you breathe on your own.',
  evidence: { grade: 'A', summary: 'Resonance breathing reliably raises heart-rate variability and is the clearest measurable calm state in this whole area (Grade A for the physiology).', sources: ['Lehrer and Gevirtz 2014', 'Shaffer and Ginsberg 2017'] },
  experimental: false,
  requires: { eeg: false, heart: 'required', signature: false, anchor: false, recommendedHeadsets: ['polar_h10'] },
  targets: [{ id: 'resonance', label: 'Heart rhythm resonance', source: 'field', field: '${hrv_metric}', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.5 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: HEART_GATING,
  blocks: [
    b.settle('any', 'Sit upright and comfortable. Breathe naturally.'),
    b.baseline('any', 'Breathe naturally. This is your resting heart rhythm for today.'),
    { repeat: { var: 'blocks' }, blocks: [
      b.train({ eyes: 'any', strategy: 'breath_resonance', pacer: 'resonance', title: 'Resonance breathing', text: 'Follow the pacer at your rate. Easy, low breaths, a little longer out than in. The sound warms as your heart rhythm gathers.', cues: [{ atS: 60, text: 'Easy and slow, not too deep.', sparse: true }] }),
      b.rest({ text: 'Breathe naturally for a moment.' }),
    ] },
    b.transfer('any', 'The pacer and the feedback are off. Keep breathing slowly at your own rate, as if the pacer were still there.', 'breath_resonance'),
    b.closing('Breathe naturally. Notice how you feel.'),
  ],
  bindings: { sound: [...HEART_SOUND, sound('breath_pacer', 'pacer', 'A guide, not a measurement.')], visual: [...HEART_VISUAL, visual('pacer_visual', 'pacer')], display: HEART_DISPLAY },
  observe: [F.resStrength, F.rmssd, F.lf, F.hf, F.hr, F.adherence, F.breathBpm],
  variables: [
    { id: 'hrv_metric', label: 'What the sound follows', description: 'Resonance follows the single slow wave (best with paced breathing). RMSSD follows beat-to-beat variability. Slow-band power follows the 0.1 Hz rhythm.', kind: 'choice', default: F.resStrength, options: [{ value: F.resStrength, label: 'Resonance' }, { value: F.rmssd, label: 'RMSSD' }, { value: F.lf, label: 'Slow-band power' }] },
    v.settle(60), v.baseline(120), v.trainBlock(300, 120, 600), v.blocks(3, 6), v.rest(30), v.transfer(180), v.closing(), v.tau(3, 1, 15), v.soundscape(), v.posture(),
  ],
  ladder: true,
  strategies: { recommended: ['breath_resonance', 'appreciation_heart', 'breath_long_exhale'], usesProfile: true },
  watches: [],
  contraindications: ['If you have a heart or breathing condition, check with your doctor before paced breathing practice.'],
  safetyNotes: [SAFETY.breath, SAFETY.general],
});

export const HIGH_HRV: Program = program({
  id: 'high_hrv_state',
  version: 1,
  name: 'High Variability',
  family: 'heart',
  state: 'high_hrv',
  summary: 'Without a pacer, find your own way into a calm, high-variability heart state.',
  description: 'Feedback follows beat-to-beat variability relative to your resting baseline, with your high-variability state marked when it is entered by the same dwell and hysteresis rules as everything else. No pacer: you find your own way, with whichever approach your profile suggests. Calm, warm states tend to raise variability; excitement can lower it even when pleasant.',
  evidence: { grade: 'A-B', summary: 'Variability rises with calm and slow breathing (Grade A); which approach does it best varies between people, which is what this measures for you.', sources: ['Shaffer and Ginsberg 2017', 'Lehrer and Gevirtz 2014'] },
  experimental: false,
  requires: { eeg: false, heart: 'required', signature: false, anchor: false, recommendedHeadsets: ['polar_h10'] },
  targets: [{ id: 'hrv', label: 'Variability', source: 'field', field: F.rmssd, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.4 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: HEART_GATING,
  blocks: [
    b.settle('any', 'Sit comfortably. Breathe naturally.'),
    b.baseline('any', 'Breathe naturally. This is your resting heart rhythm for today.'),
    { repeat: { var: 'blocks' }, blocks: [
      b.train({ eyes: 'any', strategy: 'profile_best', title: 'Calm heart', text: 'Use your approach, gently: slow breath, a warm memory, softening the body. The sound warms as your heart rhythm opens.', cues: [{ atS: 90, text: 'Warm and unhurried.', sparse: true }] }),
      b.rest({ text: 'Rest naturally.' }),
    ] },
    b.transfer('any'),
    b.closing(),
  ],
  bindings: { sound: HEART_SOUND, visual: HEART_VISUAL, display: [...HEART_DISPLAY, F.highHrvStat] },
  observe: [F.rmssd, F.resStrength, F.hr, F.breathBpm, F.highHrv],
  variables: [v.settle(60), v.baseline(120), v.trainBlock(240, 120, 600), v.blocks(3, 6), v.rest(30), v.transfer(180), v.closing(), v.tau(3, 1, 15), v.soundscape(), v.posture()],
  ladder: true,
  strategies: { recommended: ['breath_long_exhale', 'appreciation_heart', 'safety_recall', 'loving_kindness', 'body_scan', 'breath_resonance'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const BRAIN_HEART: Program = program({
  id: 'brain_heart_calm',
  version: 1,
  name: 'Brain and Heart',
  family: 'brain_heart',
  state: 'calm_brain_heart',
  summary: 'Relaxed alpha and a resonant heart rhythm together.',
  description: 'The reward blends two measurements: alpha above background at the ear sensors, and heart rhythm resonance, each relative to your own baseline. The headset part is gated for artifacts as usual; the heart part needs a chest strap. Coupling between the two (whether alpha strength rises and falls with the slow heart rhythm) is shown with its chance level beside it: two slow signals drift together by accident very easily, so coupling is only a reading when it clearly beats its time-shifted chance.',
  evidence: { grade: 'B-C', summary: 'Each part is established on its own (alpha Grade B, resonance breathing Grade A). Whether training them together adds anything, and brain-heart coupling, are research questions (Grade C).', sources: ['Zaccaro et al. 2018', 'Lehrer and Gevirtz 2014', 'Klimesch 2018'] },
  experimental: false,
  requires: { eeg: true, heart: 'required', signature: false, anchor: false, recommendedHeadsets: ['polar_h10'] },
  unlock: { afterProgram: 'hrv_resonance_breathing', level: 2 },
  targets: [
    { id: 'alpha', label: 'Alpha', source: 'field', field: F.alphaT, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } },
    { id: 'resonance', label: 'Heart resonance', source: 'field', field: F.resStrength, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.4 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } },
  ],
  combine: 'mean',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: true },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'breath_resonance', pacer: 'resonance', title: 'Brain and heart', text: 'Eyes closed. Breathe with the pacer at your rate and let the mind rest. Both layers of sound warm as brain and heart settle.', cues: [{ atS: 90, text: 'Slow breath, easy mind.', sparse: true }] }),
  }),
  bindings: {
    sound: [...COMMON_SOUND, ...HEART_SOUND.slice(2), sound('alpha_warmth', F.alphaT), sound('breath_pacer', 'pacer', 'A guide, not a measurement.')],
    visual: [...HEART_VISUAL, visual('arm_brightness', F.alphaHeight), visual('scattered_cloud', F.artifact), visual('pacer_visual', 'pacer')],
    display: [F.alphaT, F.resStrength, F.coupling, F.couplingChance, F.couplingP, F.rmssd],
  },
  observe: [F.alphaT, F.resStrength, F.rmssd, F.hr, F.emg, F.coupling, F.couplingChance],
  variables: standardVariables({ tau: 2, tauMax: 10, train: 240 }),
  ladder: true,
  strategies: { recommended: ['breath_resonance', 'appreciation_heart', 'body_scan'], usesProfile: true },
  watches: [],
  contraindications: ['If you have a heart or breathing condition, check with your doctor before paced breathing practice.'],
  safetyNotes: [SAFETY.breath, SAFETY.general],
});
