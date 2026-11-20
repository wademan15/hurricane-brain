/**
 * Calibration (design 5.3) and the Discovery strategy sampler (design 5.4).
 *
 * Discovery is a small within-person experiment: neutral rest, then a technique, repeated for
 * five or six techniques in a counterbalanced order (profile.planDiscoverySession fills the slots),
 * with the soundscape NOT responding to the brain, so each technique's own effect is measured
 * separately from feedback learning. Eyes stay closed throughout so every technique is compared
 * within the same eye condition.
 */

import type { BlockItem, BlockSpec, Program } from '../program';
import { b, F, program, SAFETY, sound, v, visual } from './common';

const CAL_TASKS: { id: string; text: string }[] = [
  { id: 'blink', text: 'Blink normally a few times.' },
  { id: 'look_left_right', text: 'Keeping your head still, look left, then right, a few times.' },
  { id: 'look_up', text: 'Look up, then back to the front.' },
  { id: 'jaw_clench', text: 'Gently clench your jaw for two seconds, then release.' },
  { id: 'eyebrows', text: 'Raise your eyebrows, then relax them.' },
  { id: 'swallow', text: 'Swallow once.' },
  { id: 'head_nod', text: 'Make a small, slow nod.' },
];

const calTask = (t: { id: string; text: string }): BlockSpec => ({
  id: `cal_${t.id}`, kind: 'calibration', durationS: { var: 'artifact_task_s' }, feedback: false, eyes: 'open', task: t.id,
  guidance: { title: 'Teaching the app your signals', start: t.text },
});

export const CALIBRATION: Program = program({
  id: 'calibration',
  version: 1,
  name: 'Calibration',
  family: 'calibration',
  state: 'calibration',
  summary: 'About eight minutes, once and then monthly: teaches the app your signals and finds your alpha frequency.',
  description: 'First a few guided movements (blinks, looking around, a jaw clench) so the app learns what your artifacts look like. Then rest with eyes open and eyes closed, twice, to find your individual alpha frequency, how strongly your alpha responds to closing the eyes, your theta peak if there is one, and your resting muscle level. Some people naturally show little alpha; that is common and not a problem, and the app will suggest the programs that suit you.',
  evidence: { grade: 'A', summary: 'Closing the eyes raises alpha in almost everyone, and individual alpha frequency varies between people from about 8 to 12.5 Hz; both are well established.', sources: ['Barry et al. 2007', 'Klimesch 1999', 'Corcoran et al. 2018'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  targets: [],
  combine: 'all',
  rewardTauS: 1,
  gating: { channels: ['TP9', 'AF7', 'AF8', 'TP10'], channelRule: 'any', minCleanFraction: 0.6, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('open', 'Sit upright and comfortable. Adjust the headband until every sensor shows good contact.'),
    ...CAL_TASKS.map(calTask),
    { id: 'eyes_open_1', kind: 'baseline', durationS: { var: 'rest_long_s' }, feedback: false, eyes: 'open', task: 'eyes_open_rest', guidance: { title: 'Eyes open', start: 'Rest with your eyes open, gaze resting softly on one plain point.' } },
    { id: 'eyes_closed_1', kind: 'baseline', durationS: { var: 'rest_long_s' }, feedback: false, eyes: 'closed', task: 'eyes_closed_rest', guidance: { title: 'Eyes closed', start: 'Close your eyes and simply rest.' } },
    { id: 'eyes_open_2', kind: 'baseline', durationS: { var: 'rest_short_s' }, feedback: false, eyes: 'open', task: 'eyes_open_rest', guidance: { title: 'Eyes open', start: 'Open your eyes again, gaze soft on the same point.' } },
    { id: 'eyes_closed_2', kind: 'baseline', durationS: { var: 'rest_short_s' }, feedback: false, eyes: 'closed', task: 'eyes_closed_rest', guidance: { title: 'Eyes closed', start: 'Close your eyes once more and rest.' } },
  ],
  bindings: { sound: [sound('base_soundscape', 'reward', 'Constant during calibration.')], visual: [visual('quality_panel', F.clean)], display: [F.clean] },
  observe: [F.alphaT, F.thetaT, F.betaT, F.alphaFreq, F.thetaFreq, F.alphaWidth, F.exponent, F.emg, F.alphaF, F.hr, F.rmssd],
  variables: [v.settle(60), { id: 'artifact_task_s', label: 'Time per movement', description: 'Seconds for each guided movement.', kind: 'number', default: 12, min: 8, max: 20, step: 1, unit: 's' }, { id: 'rest_long_s', label: 'First rest blocks', description: 'Eyes open and eyes closed rest, first round.', kind: 'number', default: 120, min: 60, max: 240, step: 30, unit: 's' }, { id: 'rest_short_s', label: 'Second rest blocks', description: 'The repeat, to check stability.', kind: 'number', default: 60, min: 45, max: 180, step: 15, unit: 's' }],
  ladder: false,
  strategies: { recommended: [], usesProfile: false },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general, SAFETY.epilepsy],
});

const MAX_SLOTS = 6;

function slotGroup(i: number): BlockItem {
  return {
    repeat: 1,
    whenSlot: i,
    blocks: [
      { id: `rest_${i}`, kind: 'rest', durationS: { var: 'rest_s' }, feedback: false, eyes: 'closed', guidance: { title: 'Rest', start: 'Simply rest with your eyes closed.' } },
      { id: `technique_${i}`, kind: 'strategy', durationS: { var: 'technique_s' }, feedback: false, eyes: 'closed', strategy: { slot: i }, ratings: ['ease'], guidance: { title: 'Try this', start: 'Follow the guidance for this technique, gently and without straining. The sound stays the same whatever happens.' } },
    ],
  };
}

export const DISCOVERY: Program = program({
  id: 'discovery_sampler',
  version: 1,
  name: 'Discovery',
  family: 'profiling',
  state: 'alpha_ec',
  summary: 'Try five or six techniques, each after a short rest, so the app can measure which ones move your brain.',
  description: 'Each technique is compared with the rest just before it, with eyes closed throughout, and corrected for the way people settle as a session goes on. The sound does not respond during Discovery, so what is measured is the technique itself. The order is varied between sessions, and each technique is tried at least twice across sessions before anything is concluded. A single block proves nothing, and when two techniques are within noise of each other the app says so. Questionnaire answers only decide what to try first.',
  evidence: { grade: 'B', summary: 'Real, measurable individual differences in response to techniques are well supported; fixed learning-style types are not. So the profile is built from your measured response.', sources: ['Pashler et al. 2008', 'Kober et al. 2013', 'Alkoby et al. 2018'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  targets: [],
  combine: 'all',
  rewardTauS: 1,
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('closed'),
    ...Array.from({ length: MAX_SLOTS }, (_, i) => slotGroup(i)),
    { id: 'closing', kind: 'rest', durationS: { var: 'rest_s' }, feedback: false, eyes: 'closed', ratings: ['depth', 'pleasantness'], guidance: { title: 'Closing', start: 'Rest once more. When you are ready, open your eyes.' } },
  ],
  bindings: { sound: [sound('base_soundscape', 'reward', 'Constant: does not respond to the brain during Discovery.')], visual: [visual('quality_panel', F.clean)], display: [] },
  observe: [F.alphaT, F.thetaT, F.betaT, F.thetaMinusAlpha, F.emg, F.alphaFreq, F.rmssd, F.resStrength, F.hr, 'cascades.phi.excess_a', 'cascades.octave.excess_a'],
  variables: [v.settle(120), { id: 'rest_s', label: 'Rest before each technique', description: 'The reference for the technique that follows.', kind: 'number', default: 60, min: 45, max: 120, step: 15, unit: 's' }, { id: 'technique_s', label: 'Time per technique', description: 'Longer blocks give clearer answers.', kind: 'number', default: 90, min: 60, max: 180, step: 15, unit: 's' }, v.minClean(), v.posture()],
  ladder: false,
  strategies: { recommended: [], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});
