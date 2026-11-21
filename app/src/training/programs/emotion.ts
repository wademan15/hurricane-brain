/**
 * Emotional states, personal signatures and sound anchors (spec 12.1; design section 7).
 *
 * Order of use: Emotional State Practice (feedback off, builds marked state and contrast blocks)
 * -> the signature is learned and validated across days (signatures.ts) -> Signature Practice
 * (feedback on the personal signature) -> Anchor Pairing (only while the signature is detected)
 * -> Anchor Test (anchor against a never-paired control sound).
 */

import type { Program, VariableSpec } from '../program';
import { b, COMMON_SOUND, COMMON_VISUAL, F, program, SAFETY, sound, v, visual } from './common';

const EMOTION_VAR: VariableSpec = {
  id: 'emotion',
  label: 'Feeling',
  description: 'The state you are practising. Calm and warmth show most clearly in the body; energetic joy looks like other activation, so for it your own ratings matter most.',
  kind: 'choice',
  default: 'calm',
  options: [
    { value: 'calm', label: 'Calm' },
    { value: 'warmth', label: 'Warmth and kindness' },
    { value: 'gratitude', label: 'Gratitude' },
    { value: 'awe', label: 'Awe' },
    { value: 'confidence', label: 'Confidence' },
    { value: 'joyful_energy', label: 'Joyful energy' },
    { value: 'safety', label: 'Safety' },
  ],
};

const CONTRAST_VAR: VariableSpec = {
  id: 'contrast',
  label: 'Comparison blocks',
  description: 'What the state is compared with. Neutral rest is the default. Everyday thinking (planning your day) is a livelier comparison that can make the signature more specific.',
  kind: 'choice',
  default: 'neutral',
  options: [{ value: 'neutral', label: 'Neutral rest' }, { value: 'everyday', label: 'Everyday thinking' }],
};

const EMOTION_EVIDENCE = {
  grade: 'B' as const,
  summary: 'People can bring on feelings by recalling memories (Grade A for self-report). Reading which feeling it is from four headband sensors is weak science (Grade C), and heart measures separate calm from activated states better than named feelings. So your signature is personal, built from your own marked blocks, and tested on sessions it has not seen before it is called reliable.',
  sources: ['Lench, Flores and Bench 2011', 'Coan and Allen 2004', 'Shaffer and Ginsberg 2017', 'Spec section 12.1'],
};

const SIG_DISPLAY = [F.alphaT, F.emg, F.hr, F.rmssd];
const SIG_OBSERVE = [F.alphaT, F.thetaT, F.betaT, F.alphaF, F.asymmetry, F.emg, F.hr, F.rmssd, F.resStrength];

const stateBlock = (id: string, anchor?: 'pair'): Program['blocks'][number] => ({
  id, kind: 'train', durationS: { var: 'state_s' }, feedback: true, eyes: 'closed', strategy: 'profile_best', label: 'state', ratings: ['emotion_intensity'],
  ...(anchor ? { anchor } : {}),
  guidance: { title: 'Your state', start: 'Bring on your feeling the way that works for you. The sound warms as your measurements move toward your personal signature.', cues: [{ atS: 60, text: 'Let the feeling fill the body.', sparse: true }] },
});

export const EMOTION_PRACTICE: Program = program({
  id: 'emotional_state_practice',
  version: 1,
  name: 'Emotional State Practice',
  family: 'emotion',
  state: '${emotion}',
  summary: 'Practise bringing on a feeling, and let the app learn what it looks like in your own measurements.',
  description: 'Blocks of the feeling alternate with comparison blocks. The sound stays neutral: these sessions teach the app your personal signature, the few brain and heart measures that reliably differ between your feeling and your comparison blocks. After each block you rate how strongly you felt it. Once the signature has held up on sessions it had not seen, on at least three different days, it is called reliable and Signature Practice opens.',
  evidence: EMOTION_EVIDENCE,
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: false, anchor: false },
  targets: [],
  combine: 'all',
  rewardTauS: 2,
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('closed'),
    { id: 'contrast_start', kind: 'baseline', durationS: { var: 'contrast_s' }, feedback: false, eyes: 'closed', label: 'contrast', guidance: { title: 'Comparison', start: 'Rest neutrally, or if you chose everyday thinking, quietly plan the rest of your day.' } },
    { repeat: { var: 'cycles' }, blocks: [
      { id: 'state', kind: 'strategy', durationS: { var: 'state_s' }, feedback: false, eyes: 'closed', strategy: 'emotion_recall', label: 'state', ratings: ['emotion_intensity'],
        guidance: { title: 'Your feeling', start: 'Bring on the feeling: recall a specific moment, its light and sounds, and notice where the feeling lives in your body. Let it grow a little.', cues: [{ atS: 45, text: 'Stay with the feeling, not the story.' }] } },
      { id: 'contrast', kind: 'rest', durationS: { var: 'contrast_s' }, feedback: false, eyes: 'closed', label: 'contrast', ratings: ['emotion_intensity'],
        guidance: { title: 'Comparison', start: 'Let the feeling go. Rest neutrally, or quietly plan the rest of your day if you chose everyday thinking.' } },
    ] },
    b.closing(),
  ],
  bindings: { sound: [sound('base_soundscape', 'reward', 'Constant: the sound does not respond during signature learning.')], visual: [visual('quality_panel', F.clean)], display: SIG_DISPLAY },
  observe: SIG_OBSERVE,
  variables: [EMOTION_VAR, CONTRAST_VAR, v.settle(60), { id: 'state_s', label: 'Feeling block length', description: 'Length of each feeling block.', kind: 'number', default: 90, min: 60, max: 240, step: 15, unit: 's' }, { id: 'contrast_s', label: 'Comparison block length', description: 'Length of each comparison block.', kind: 'number', default: 90, min: 60, max: 240, step: 15, unit: 's' }, { id: 'cycles', label: 'Feeling and comparison pairs', description: 'More pairs teach the signature faster.', kind: 'number', default: 4, min: 2, max: 8, step: 1 }, v.closing(), v.minClean(), v.soundscape(), v.posture()],
  ladder: false,
  strategies: { recommended: ['emotion_recall', 'gratitude_recall', 'loving_kindness', 'awe_recall', 'safety_recall', 'appreciation_heart', 'confidence_posture'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: ['Choose pleasant memories. If something difficult comes up, open your eyes, feel your feet on the floor and take a long breath out.', SAFETY.general],
});

const sigTarget = { id: 'signature', label: 'Your signature', source: 'signature' as const, direction: 'up' as const, weight: 1, threshold: { initial: { rule: 'baseline_mean_plus_sd' as const, k: 0.5 }, adapt: { enabled: true, band: 'level' as const }, spanSd: 1 } };

export const SIGNATURE_PRACTICE: Program = program({
  id: 'signature_practice',
  version: 1,
  name: 'Signature Practice',
  family: 'signature',
  state: '${emotion}',
  summary: 'Return to your feeling with feedback from your own reliable signature.',
  description: 'The sound follows how close your measurements are to your personal signature for this feeling, relative to how they sit at rest today. Entering the state uses a threshold set from your own comparison blocks, with a dwell time and hysteresis, so it does not flicker. It opens once your signature is reliable.',
  evidence: EMOTION_EVIDENCE,
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: true, anchor: false },
  targets: [sigTarget],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('closed'),
    { id: 'baseline', kind: 'baseline', durationS: { var: 'baseline_s' }, feedback: false, eyes: 'closed', label: 'contrast', guidance: { title: 'Resting reference', start: 'Rest neutrally. This sets where your signature score sits today.' } },
    { repeat: { var: 'blocks' }, blocks: [stateBlock('state'), { ...b.rest({ eyes: 'closed', label: 'contrast', text: 'Let the feeling go and rest neutrally.' }), durationS: { var: 'rest_s' } }] },
    { id: 'transfer', kind: 'transfer', durationS: { var: 'transfer_s' }, feedback: false, eyes: 'closed', strategy: 'profile_best', label: 'state', ratings: ['emotion_intensity', 'ease'], guidance: { title: 'On your own', start: 'The sound stays neutral now. Bring on your feeling just as before.' } },
    b.closing(),
  ],
  bindings: { sound: [...COMMON_SOUND], visual: [...COMMON_VISUAL, visual('signature_meter', 'signature')], display: SIG_DISPLAY },
  observe: SIG_OBSERVE,
  variables: [EMOTION_VAR, v.settle(60), v.baseline(90), { id: 'state_s', label: 'Feeling block length', description: 'Length of each feedback block.', kind: 'number', default: 150, min: 60, max: 300, step: 30, unit: 's' }, v.blocks(4, 8), v.rest(45), v.transfer(120), v.closing(), v.tau(3, 1, 10), v.minClean(), v.soundscape(), v.posture()],
  ladder: true,
  strategies: { recommended: ['emotion_recall', 'gratitude_recall', 'loving_kindness', 'awe_recall', 'safety_recall', 'appreciation_heart'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});

export const ANCHOR_PAIRING: Program = program({
  id: 'anchor_pairing',
  version: 1,
  name: 'Anchor Pairing',
  family: 'anchor',
  state: '${emotion}',
  summary: 'Your signature sound plays only while your measurements show you are in your state.',
  description: 'Practise your feeling as in Signature Practice. When your signature has been detected for a few seconds, your personal anchor sound fades in gently over the soundscape. It never plays at any other time, so it comes to mean this state. In the rest blocks a neutral control sound plays as often as the anchor, so that later tests can tell real pairing from mere familiarity. Every pairing records whether the state was actually present while the sound played. About 30 to 60 pairings over 8 to 12 sessions, on different days and in different settings, build the strongest link.',
  evidence: { grade: 'C', summary: 'Pairing a cue with relaxation lets the cue alone bring back part of the state (Grade B, cue-controlled relaxation); conditioning of a complex positive brain state is plausible but not well studied (Grade C). The anchor test tells you whether it works for you.', sources: ['Russell and Sipich 1973', 'Jasper and Shagass 1941', 'Juslin and Vastfjall 2008'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: true, anchor: true },
  targets: [sigTarget],
  combine: 'all',
  rewardTauS: { var: 'reward_tau_s' },
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('closed'),
    { id: 'baseline', kind: 'baseline', durationS: { var: 'baseline_s' }, feedback: false, eyes: 'closed', label: 'contrast', guidance: { title: 'Resting reference', start: 'Rest neutrally.' } },
    { repeat: { var: 'blocks' }, blocks: [stateBlock('state', 'pair'), { ...b.rest({ eyes: 'closed', label: 'contrast', anchor: 'control_exposure', text: 'Let the feeling go and rest neutrally. You may hear a neutral sound; just let it be.' }), durationS: { var: 'rest_s' } }] },
    b.closing(),
  ],
  bindings: { sound: [...COMMON_SOUND, sound('anchor', 'signature', 'Plays only while the signature is detected (pairing gate), soft onset, over the soundscape.'), sound('control_sound', 'reward', 'Played once in each rest block, never paired.')], visual: [...COMMON_VISUAL, visual('signature_meter', 'signature')], display: SIG_DISPLAY },
  observe: SIG_OBSERVE,
  variables: [EMOTION_VAR, v.settle(60), v.baseline(90), { id: 'state_s', label: 'Feeling block length', description: 'Length of each pairing block.', kind: 'number', default: 180, min: 120, max: 360, step: 30, unit: 's' }, v.blocks(4, 8), v.rest(60), v.closing(), v.tau(3, 1, 10), v.minClean(), v.soundscape(), v.posture()],
  ladder: false,
  strategies: { recommended: ['emotion_recall', 'gratitude_recall', 'loving_kindness', 'safety_recall', 'appreciation_heart'], usesProfile: true },
  watches: [],
  contraindications: [],
  safetyNotes: ['Your anchor sound is used only for this. It is never used for notifications or alarms, which would weaken it.', SAFETY.general],
});

export const ANCHOR_PROBE: Program = program({
  id: 'anchor_probe',
  version: 1,
  name: 'Anchor Test',
  family: 'anchor',
  state: '${emotion}',
  summary: 'An honest test: does your anchor sound move you toward your state more than a neutral sound does?',
  description: 'You rest neutrally with no feedback. From time to time a sound plays: sometimes your anchor, sometimes the equally familiar control sound, in a balanced random order. You do not need to do anything. The app measures how far and how fast your measurements move toward your signature in the minute after each sound. The anchor counts as working only when its effect beats the control sound beyond noise, over several trials on at least two days.',
  evidence: { grade: 'C', summary: 'This is the control comparison learning theory requires: without it, familiarity and expectation look like conditioning.', sources: ['Research brief R7.4', 'Spec section 12.1'] },
  experimental: false,
  requires: { eeg: true, heart: 'optional', signature: true, anchor: true },
  targets: [],
  combine: 'all',
  rewardTauS: 2,
  gating: { channels: ['TP9', 'TP10'], channelRule: 'any', minCleanFraction: { var: 'min_clean' }, fastArtifact: true, maxEmgRiseDb: null, heart: false },
  blocks: [
    b.settle('closed'),
    { id: 'baseline', kind: 'baseline', durationS: { var: 'baseline_s' }, feedback: false, eyes: 'closed', label: 'contrast', guidance: { title: 'Rest', start: 'Rest neutrally with your eyes closed. There is nothing to do in this session.' } },
    { repeat: { var: 'probe_pairs' }, blocks: [
      { id: 'washout_a', kind: 'rest', durationS: { var: 'washout_s' }, feedback: false, eyes: 'closed', label: 'contrast', guidance: { title: 'Rest', start: 'Rest neutrally.' } },
      { id: 'probe_a', kind: 'probe', durationS: { var: 'probe_s' }, feedback: false, eyes: 'closed', cue: 'slot', guidance: { title: 'Listen', start: 'Rest. If you hear a sound, simply let it be.' } },
      { id: 'washout_b', kind: 'rest', durationS: { var: 'washout_s' }, feedback: false, eyes: 'closed', label: 'contrast', guidance: { title: 'Rest', start: 'Rest neutrally.' } },
      { id: 'probe_b', kind: 'probe', durationS: { var: 'probe_s' }, feedback: false, eyes: 'closed', cue: 'slot', guidance: { title: 'Listen', start: 'Rest. If you hear a sound, simply let it be.' } },
    ] },
    b.closing(),
  ],
  bindings: { sound: [sound('base_soundscape', 'reward', 'Constant: no feedback during the test.'), sound('anchor', 'signature', 'Probe cue only.'), sound('control_sound', 'reward', 'Probe cue only.')], visual: [visual('quality_panel', F.clean)], display: [] },
  observe: SIG_OBSERVE,
  variables: [EMOTION_VAR, v.settle(60), v.baseline(90), { id: 'washout_s', label: 'Rest between sounds', description: 'Neutral rest before each sound; it is also the reference for that trial.', kind: 'number', default: 60, min: 45, max: 180, step: 15, unit: 's' }, { id: 'probe_s', label: 'Listening time after each sound', description: 'How long after each sound is measured.', kind: 'number', default: 75, min: 60, max: 120, step: 15, unit: 's' }, { id: 'probe_pairs', label: 'Anchor and control pairs', description: 'Each pair plays the anchor once and the control once, in random order.', kind: 'number', default: 3, min: 1, max: 6, step: 1 }, v.closing(), v.minClean(), v.posture()],
  ladder: false,
  strategies: { recommended: [], usesProfile: false },
  watches: [],
  contraindications: [],
  safetyNotes: [SAFETY.general],
});
