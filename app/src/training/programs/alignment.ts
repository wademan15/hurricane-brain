/**
 * Golden ratio alignment, cascade growing, octave alignment, hemisphere balance and the
 * experimental frontal balance program. Alignment is a slow quantity (spec 6.4: tens of
 * seconds), so these programs reward slow, sustained change with long smoothing, and always show
 * golden ratio alignment beside octave alignment and the chance levels (rule 3).
 */

import type { Program, VariableSpec } from '../program';
import { ALIGNMENT_DISPLAY, b, COMMON_SOUND, COMMON_VISUAL, F, program, SAFETY, sound, standardSession, standardVariables, visual } from './common';

const chanceVar = (target: 'phi' | 'octave'): VariableSpec => ({
  id: 'chance_level',
  label: 'Compared with',
  description: 'Unrelated peaks asks whether your rhythms are aligned more than randomly placed peaks would be. Your own wandering asks whether they are moving into alignment together, beyond where each one usually sits; it needs two minutes of history first.',
  kind: 'choice',
  default: `cascades.${target}.excess_a`,
  options: [
    { value: `cascades.${target}.excess_a`, label: 'Unrelated peaks (chance A)' },
    { value: `cascades.${target}.excess_b`, label: 'Your own wandering (chance B)' },
  ],
});

const ALIGN_SOUND = [
  ...COMMON_SOUND,
  sound('tracking_tone', F.fastAlphaFreq, 'Each confirmed track sounds at its frequency times 32, so measured intervals are heard as intervals.'),
  sound('phi_bloom', 'states.phi.active', 'A soft chord built from the measured tracks\' own tones.'),
  sound('octave_bloom', 'states.octave.active', 'A different bloom for octave alignment.'),
];
const ALIGN_VISUAL = [
  ...COMMON_VISUAL,
  visual('spiral_arms', 'cascades.phi.steps'),
  visual('winding', 'cascades.phi.excess_a'),
  visual('rings', 'cascades.octave.excess_a'),
  visual('eye_clarity', 'cascades.phi.held_s'),
];

const ALIGN_EVIDENCE = {
  grade: 'C' as const,
  summary: 'Brain rhythm frequencies have been proposed to sit at golden ratio spacings, which would let them run side by side without locking; whole-number ratios such as the octave let them lock together. This is emerging research (Grade B for the lab findings, C for training it). The app measures it honestly against chance and takes no position on interpretations, which are offered as readings.',
  sources: ['Roopun et al. 2008', 'Pletzer, Kerschbaum and Klimesch 2010', 'Klimesch 2013, 2018', 'Rodriguez-Larios and Alaerts 2019', 'Rodriguez-Larios et al. 2020'],
};

const alignVars = (target: 'phi' | 'octave'): VariableSpec[] => [chanceVar(target), ...standardVariables({ tau: 8, tauMax: 30, train: 300, blocks: 3, trainMin: 180, trainMax: 600, posture: 'reclined' })];

export const GOLDEN_RATIO_ALIGNMENT: Program = program({
  id: 'golden_ratio_alignment',
  version: 1,
  name: 'Golden Ratio Alignment',
  family: 'alignment',
  state: 'golden',
  summary: 'Rest deeply and let your rhythms settle into golden ratio alignment. Slow, sustained feedback.',
  description: 'Feedback follows golden ratio alignment in excess of chance: how much closer your confirmed rhythms sit to golden ratio spacing than chance would put them. Telling a golden ratio step from nearby ratios needs about 30 seconds of steady signal, so the sound changes over tens of seconds, never moment to moment. Octave alignment and both chance levels are always shown beside it. A single aligned pair is weak evidence; a cascade of three or more is much stronger.',
  evidence: ALIGN_EVIDENCE,
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 2 },
  targets: [{ id: 'golden', label: 'Golden ratio alignment beyond chance', source: 'field', field: '${chance_level}', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanAbs: 0.25, floor: 0.02, ceiling: 0.9 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'profile_best', title: 'Alignment', text: 'Eyes closed, settled and still. Use your deepest approach, lightly. The sound will change slowly; there is no need to chase it.', cues: [{ atS: 90, text: 'Slow and steady. Nothing to chase.', sparse: true }] }),
  }),
  bindings: { sound: ALIGN_SOUND, visual: ALIGN_VISUAL, display: [...ALIGNMENT_DISPLAY, F.alphaFreq, F.thetaFreq] },
  observe: ['cascades.phi.excess_a', 'cascades.octave.excess_a', 'cascades.phi.excess_b', 'cascades.phi.steps', 'states.phi.active', 'states.octave.active', F.alphaT, F.thetaT, F.alphaFreq, F.thetaFreq, F.emg],
  variables: alignVars('phi'),
  ladder: true,
  strategies: { recommended: ['open_awareness', 'none', 'breath_resonance', 'mantra_silent', 'heavy_warm'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const GOLDEN_CASCADE: Program = program({
  id: 'golden_cascade_growing',
  version: 1,
  name: 'Growing the Cascade',
  family: 'alignment',
  state: 'golden_cascade',
  summary: 'Build a longer chain of rhythms each a golden ratio step from the next.',
  description: 'Feedback follows the number of golden ratio steps in your cascade, together with how far above chance it is. Each added step is much stronger evidence than the one before: three peaks on golden ratio steps by chance happen well under 1% of the time. Alignment responds over tens of seconds, so the sound grows slowly. Octave cascades and chance levels are shown beside it, and rhythms that are harmonics of another are never counted.',
  evidence: ALIGN_EVIDENCE,
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'golden_ratio_alignment', level: 2 },
  targets: [
    { id: 'steps', label: 'Golden ratio cascade steps', source: 'field', field: 'cascades.phi.steps', direction: 'up', weight: 2, threshold: { initial: { rule: 'baseline_quantile', q: 0.5 }, adapt: { enabled: true, band: 'level' }, spanAbs: 1, floor: 1, ceiling: 4 } },
    { id: 'excess', label: 'Beyond chance', source: 'field', field: '${chance_level}', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanAbs: 0.25, floor: 0.02, ceiling: 0.9 } },
  ],
  combine: 'mean',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'profile_best', title: 'Cascade', text: 'Eyes closed and very still. Let your practice deepen gently; the spiral grows arms slowly as more rhythms fall into step.', cues: [{ atS: 120, text: 'Stillness lets the rhythms show.', sparse: true }] }),
  }),
  bindings: { sound: ALIGN_SOUND, visual: ALIGN_VISUAL, display: [...ALIGNMENT_DISPLAY, 'cascades.phi.held_s', 'cascades.phi.chance.a.p_steps'] },
  observe: ['cascades.phi.steps', 'cascades.octave.steps', 'cascades.phi.held_s', 'cascades.phi.excess_a', 'cascades.octave.excess_a', 'track_count', F.emg],
  variables: alignVars('phi'),
  ladder: true,
  strategies: { recommended: ['open_awareness', 'none', 'mantra_silent', 'breath_resonance'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const OCTAVE_ALIGNMENT: Program = program({
  id: 'octave_alignment',
  version: 1,
  name: 'Octave Alignment',
  family: 'alignment',
  state: 'octave',
  summary: 'Explore when your rhythms fall into whole-number (2:1) relationships, the coupled counterpart of golden ratio spacing.',
  description: 'Feedback follows octave alignment beyond chance. Research suggests 2:1 alpha-to-theta relationships appear more during active thinking and golden ratio spacing more during rest, so this program is for exploring how your rhythms couple and uncouple, side by side with golden ratio alignment and the chance levels. Rhythms that are simply harmonics of another are excluded.',
  evidence: { ...ALIGN_EVIDENCE, summary: 'Transient 2:1 alpha-to-theta relations have been linked to active cognition in one well-designed research line (Grade B); training them is untested (Grade C). Offered as exploration.' },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 2 },
  targets: [{ id: 'octave', label: 'Octave alignment beyond chance', source: 'field', field: '${chance_level}', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanAbs: 0.25, floor: 0.02, ceiling: 0.9 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'user_choice', title: 'Octave', text: 'Eyes closed. Try a gently engaged mind: counting breaths, or a silent word. Notice how the rings respond, slowly.', cues: [{ atS: 90, text: 'Gently engaged, still body.', sparse: true }] }),
  }),
  bindings: { sound: ALIGN_SOUND, visual: ALIGN_VISUAL, display: [...ALIGNMENT_DISPLAY] },
  observe: ['cascades.octave.excess_a', 'cascades.phi.excess_a', 'cascades.octave.steps', 'states.octave.active', 'states.phi.active', F.alphaFreq, F.thetaFreq, F.emg],
  variables: alignVars('octave'),
  ladder: true,
  strategies: { recommended: ['breath_count', 'mantra_silent', 'listen_sound', 'open_awareness'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const HEMISPHERE_BALANCE: Program = program({
  id: 'hemisphere_balance',
  version: 1,
  name: 'Balance',
  family: 'hemisphere',
  state: 'hemisphere_match',
  summary: 'Let the left and right sides settle into the same rhythm.',
  description: 'Feedback follows the match between your left and right ear sensors for the chosen rhythm: the same frequency, an even balance of strength, and locking beyond what a time-shifted copy shows. All sensors share one reference point on the forehead, which makes the two sides look more alike than they are, so locking is reported only in excess of that shared baseline. The symmetry of the hurricane shows the match. This is an exploratory measure.',
  evidence: { grade: 'D', summary: 'There is no established evidence that training left-right symmetry of a rhythm has a specific benefit. Offered as exploration of your own measurements, honestly corrected for the shared reference.', sources: ['Spec section 9 (hemisphere comparison)', 'Research brief R2.2'] },
  experimental: true,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 2 },
  targets: [{ id: 'match', label: 'Left-right match', source: 'field', field: 'hemispheres[${rhythm}].match', direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1, floor: 0, ceiling: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'all', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'user_choice', title: 'Balance', text: 'Eyes closed. Let attention rest evenly on both sides of the body at once, both hands, both feet, both ears.', cues: [{ atS: 60, text: 'Both sides at once.', sparse: true }] }),
  }),
  bindings: { sound: [...COMMON_SOUND], visual: [...COMMON_VISUAL, visual('symmetry', 'hemispheres[${rhythm}].match')], display: ['hemispheres[${rhythm}].match', 'hemispheres[${rhythm}].balance', 'hemispheres[${rhythm}].freq_diff', 'hemispheres[${rhythm}].locking_excess'] },
  observe: ['hemispheres[${rhythm}].balance', 'hemispheres[${rhythm}].freq_diff', 'hemispheres[${rhythm}].locking_excess', F.alphaT, F.emg],
  variables: [
    { id: 'rhythm', label: 'Rhythm', description: 'Which rhythm to balance.', kind: 'choice', default: 'alpha', options: [{ value: 'alpha', label: 'Alpha' }, { value: 'theta', label: 'Theta' }] },
    ...standardVariables({ tau: 3, tauMax: 10, posture: 'upright' }),
  ],
  ladder: true,
  strategies: { recommended: ['body_scan', 'open_awareness', 'breath_natural', 'none'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const FRONTAL_BALANCE: Program = program({
  id: 'frontal_approach_balance',
  version: 1,
  name: 'Approach Balance (labs)',
  family: 'asymmetry',
  state: 'approach',
  summary: 'Experimental: frontal alpha balance, a rough marker linked to approach and positive mood.',
  description: 'Feedback follows right-minus-left frontal alpha above background. Relatively more alpha on the right goes with relatively more activity on the left, which research links to approach and positive mood. On this headset the forehead sensors are near, not at, the classic sites, the measure is noisy, and eye movements dominate the forehead, so eyes stay closed and still and blinks are removed. Experimental: consider it a personal experiment.',
  evidence: { grade: 'C', summary: 'Frontal asymmetry is a real but small and noisy marker; one controlled study shifted mood by training it. On this headset it is approximate.', sources: ['Allen, Harmon-Jones and Cavender 2001', 'Coan and Allen 2004'] },
  experimental: true,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  unlock: { afterProgram: 'alpha_eyes_closed', level: 2 },
  targets: [{ id: 'asymmetry', label: 'Frontal balance', source: 'field', field: F.asymmetry, direction: 'up', weight: 1, threshold: { initial: { rule: 'baseline_quantile', q: 0.3 }, adapt: { enabled: true, band: 'level' }, spanSd: 1 } }],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['AF7', 'AF8'], channelRule: 'all', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: { var: 'muscle_gate_db' }, heart: false },
  blocks: standardSession({
    eyes: 'closed',
    train: b.train({ eyes: 'closed', strategy: 'profile_best', title: 'Approach', text: 'Eyes closed and still. Bring to mind something you look forward to, or someone you feel warmly toward, and let the feeling of moving toward it grow.', cues: [{ atS: 60, text: 'Moving toward what you value.', sparse: true }] }),
  }),
  bindings: { sound: [...COMMON_SOUND], visual: [...COMMON_VISUAL], display: [F.asymmetry, F.alphaF] },
  observe: [F.alphaF, F.alphaT, F.emg],
  variables: standardVariables({ tau: 2, tauMax: 10 }),
  ladder: true,
  strategies: { recommended: ['gratitude_recall', 'loving_kindness', 'emotion_recall', 'confidence_posture'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});
