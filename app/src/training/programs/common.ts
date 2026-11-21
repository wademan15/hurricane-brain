/**
 * Shared building blocks for the program library. Every helper returns plain JSON data;
 * the programs themselves are data (spec section 12).
 */

import { PROGRAM_FORMAT, PROGRAM_FORMAT_VERSION, type BlockItem, type BlockSpec, type Binding, type Guidance, type Program, type SoundElement, type StrategyRef, type VariableSpec, type VisualElement } from '../program';

export type ProgramBody = Omit<Program, 'format' | 'formatVersion'>;

export function program(body: ProgramBody): Program {
  return { format: PROGRAM_FORMAT, formatVersion: PROGRAM_FORMAT_VERSION, ...body };
}

// ---------------------------------------------------------------- field paths used across programs
export const F = {
  alphaT: 'spectra[temporal].bands.alpha.above_bg_db',
  thetaT: 'spectra[temporal].bands.theta.above_bg_db',
  betaT: 'spectra[temporal].bands.beta.above_bg_db',
  deltaT: 'spectra[temporal].bands.delta.above_bg_db',
  alphaF: 'spectra[frontal].bands.alpha.above_bg_db',
  thetaMinusAlpha: 'diff(spectra[temporal].bands.theta.above_bg_db, spectra[temporal].bands.alpha.above_bg_db)',
  asymmetry: 'diff(spectra[AF8].bands.alpha.above_bg_db, spectra[AF7].bands.alpha.above_bg_db)',
  fastAlphaHeight: 'fast.track[alpha].height_db',
  fastAlphaFreq: 'fast.track[alpha].freq',
  fastThetaFreq: 'fast.track[theta].freq',
  alphaFreq: 'track[alpha].freq_integrated',
  thetaFreq: 'track[theta].freq_integrated',
  alphaHeight: 'track[alpha].height_db',
  alphaWidth: 'track[alpha].width_hz',
  dominantFreq: 'track[dominant].freq',
  exponent: 'spectra[temporal].bg_exponent',
  emg: 'quality[*].emg_db',
  clean: 'quality[*].clean_fraction',
  artifact: 'fast.artifact',
  iaf: 'iaf_hz',
  hr: 'heart.hr_bpm',
  rmssd: 'heart.rmssd_ms',
  sdnn: 'heart.sdnn_ms',
  lf: 'heart.lf_power',
  hf: 'heart.hf_power',
  resHz: 'heart.resonance_hz',
  resStrength: 'heart.resonance_strength',
  breathBpm: 'heart.breath_bpm',
  breathPhase: 'heart.breath_phase',
  adherence: 'heart.pacer_adherence',
  highHrv: 'heart.high_hrv.active',
  highHrvStat: 'heart.high_hrv.stat',
  coupling: 'heart.coupling[alpha.above_bg_db@temporal].correlation.value',
  couplingChance: 'heart.coupling[alpha.above_bg_db@temporal].correlation.chance',
  couplingP: 'heart.coupling[alpha.above_bg_db@temporal].correlation.p',
} as const;

/** Everything rule 3 requires beside golden ratio alignment: octave alignment, controls via chance, both chance levels. */
export const ALIGNMENT_DISPLAY: string[] = [
  'cascades.phi.excess_a',
  'cascades.octave.excess_a',
  'cascades.phi.excess_b',
  'cascades.octave.excess_b',
  'cascades.phi.chance.a.p',
  'cascades.octave.chance.a.p',
  'cascades.phi.chance.b.p',
  'cascades.octave.chance.b.p',
  'cascades.phi.steps',
  'cascades.octave.steps',
  'states.phi.active',
  'states.octave.active',
];

// ---------------------------------------------------------------- variables
export const v = {
  settle: (def = 120): VariableSpec => ({ id: 'settle_s', label: 'Settling time', description: 'Time to arrive and let the signal settle before anything is measured.', kind: 'number', default: def, min: 30, max: 300, step: 15, unit: 's' }),
  baseline: (def = 90): VariableSpec => ({ id: 'baseline_s', label: 'Baseline length', description: 'Quiet rest that sets your personal reference for this session. Longer is steadier.', kind: 'number', default: def, min: 60, max: 240, step: 15, unit: 's' }),
  trainBlock: (def = 180, min = 60, max = 420): VariableSpec => ({ id: 'train_block_s', label: 'Training block length', description: 'Length of each feedback block.', kind: 'number', default: def, min, max, step: 30, unit: 's' }),
  blocks: (def = 4, max = 8): VariableSpec => ({ id: 'blocks', label: 'Number of training blocks', description: 'How many feedback blocks in the session.', kind: 'number', default: def, min: 1, max, step: 1 }),
  rest: (def = 20): VariableSpec => ({ id: 'rest_s', label: 'Rest between blocks', description: 'A short pause between blocks.', kind: 'number', default: def, min: 10, max: 90, step: 5, unit: 's' }),
  transfer: (def = 120): VariableSpec => ({ id: 'transfer_s', label: 'Transfer block length', description: 'A block with the feedback off, to see whether the skill holds without it.', kind: 'number', default: def, min: 60, max: 300, step: 30, unit: 's' }),
  closing: (def = 60): VariableSpec => ({ id: 'closing_s', label: 'Closing rest', description: 'A quiet minute at the end.', kind: 'number', default: def, min: 30, max: 180, step: 15, unit: 's' }),
  tau: (def: number, min = 0.5, max = 5): VariableSpec => ({ id: 'reward_tau_s', label: 'Sound response time', description: 'How quickly the sound follows your measurements. This one time constant is the only smoothing between measurement and sound, and it is stored with the session.', kind: 'number', default: def, min, max, step: 0.5, unit: 's' }),
  muscleGate: (def = 6): VariableSpec => ({ id: 'muscle_gate_db', label: 'Muscle tension allowance', description: 'How far forehead and jaw muscle activity may rise above your baseline before the reward pauses. Lower is stricter.', kind: 'number', default: def, min: 3, max: 12, step: 1, unit: 'dB' }),
  minClean: (def = 0.6): VariableSpec => ({ id: 'min_clean', label: 'Signal quality required', description: 'Share of clean signal needed in the analysis window for reward. Never lowered automatically.', kind: 'number', default: def, min: 0.6, max: 0.9, step: 0.05 }),
  soundscape: (): VariableSpec => ({ id: 'soundscape', label: 'Sound setting', description: 'The base sound under the feedback. Recorded so your profile can learn which setting suits you.', kind: 'choice', default: 'warm_pad', options: [{ value: 'warm_pad', label: 'Warm pad' }, { value: 'water', label: 'Flowing water' }, { value: 'forest', label: 'Forest' }, { value: 'quiet', label: 'Near silence' }] }),
  posture: (def = 'upright'): VariableSpec => ({ id: 'posture', label: 'Posture', description: 'Upright keeps you alert; reclined helps deep states and makes sleep more likely.', kind: 'choice', default: def, options: [{ value: 'upright', label: 'Upright' }, { value: 'reclined', label: 'Reclined' }, { value: 'lying', label: 'Lying down' }] }),
  guidanceVoice: (): VariableSpec => ({ id: 'voice', label: 'Spoken guidance', description: 'Hear the guidance spoken, or read it only.', kind: 'boolean', default: true }),
};

// ---------------------------------------------------------------- blocks
const g = (title: string, start: string, cues?: Guidance['cues'], end?: string): Guidance => ({ title, start, ...(cues ? { cues } : {}), ...(end ? { end } : {}) });

export const b = {
  settle: (eyes: BlockSpec['eyes'] = 'closed', text = 'Get comfortable. Let the headband settle and your breathing find its own pace. Nothing is being scored yet.'): BlockSpec => ({
    id: 'settle', kind: 'settle', durationS: { var: 'settle_s' }, feedback: false, eyes, guidance: g('Settle in', text),
  }),
  baseline: (eyes: BlockSpec['eyes'], text?: string, id = 'baseline'): BlockSpec => ({
    id, kind: 'baseline', durationS: { var: 'baseline_s' }, feedback: false, eyes,
    guidance: g('Resting reference', text ?? (eyes === 'open' ? 'Rest with your eyes open, gaze resting softly on one plain point. Just be here; this sets your personal reference for today.' : 'Rest with your eyes closed. Just be here; this sets your personal reference for today.')),
  }),
  train: (opts: { id?: string; eyes: BlockSpec['eyes']; strategy?: StrategyRef; text: string; cues?: Guidance['cues']; label?: 'state' | 'contrast'; pacer?: BlockSpec['pacer']; anchor?: BlockSpec['anchor']; title?: string; ratings?: BlockSpec['ratings'] }): BlockSpec => ({
    id: opts.id ?? 'train', kind: 'train', durationS: { var: 'train_block_s' }, feedback: true, eyes: opts.eyes,
    ...(opts.strategy ? { strategy: opts.strategy } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.pacer !== undefined ? { pacer: opts.pacer } : {}),
    ...(opts.anchor ? { anchor: opts.anchor } : {}),
    ...(opts.ratings ? { ratings: opts.ratings } : {}),
    guidance: g(opts.title ?? 'Training', opts.text, opts.cues),
  }),
  rest: (opts: { id?: string; eyes?: BlockSpec['eyes']; dur?: BlockSpec['durationS']; text?: string; label?: 'state' | 'contrast'; anchor?: BlockSpec['anchor']; pacer?: BlockSpec['pacer'] } = {}): BlockSpec => ({
    id: opts.id ?? 'rest', kind: 'rest', durationS: opts.dur ?? { var: 'rest_s' }, feedback: false, eyes: opts.eyes ?? 'any',
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.anchor ? { anchor: opts.anchor } : {}),
    ...(opts.pacer !== undefined ? { pacer: opts.pacer } : {}),
    guidance: g('Rest', opts.text ?? 'Rest for a moment. Let go of the practice.'),
  }),
  transfer: (eyes: BlockSpec['eyes'], text = 'The sound now stays neutral. Carry on exactly as before, as if the feedback were still there. This shows whether the skill is yours without the sound.', strategy: StrategyRef = 'profile_best', label?: 'state'): BlockSpec => ({
    id: 'transfer', kind: 'transfer', durationS: { var: 'transfer_s' }, feedback: false, eyes, strategy, ...(label ? { label } : {}), ratings: ['ease', 'depth'],
    guidance: g('On your own', text),
  }),
  closing: (text = 'Rest quietly. When you are ready, take a deeper breath, open your eyes, and notice how you feel.'): BlockSpec => ({
    id: 'closing', kind: 'rest', durationS: { var: 'closing_s' }, feedback: false, eyes: 'any', ratings: ['depth', 'pleasantness', 'ease'],
    guidance: g('Closing', text),
  }),
};

/** The standard training session: settle, baseline, repeated [train, rest], transfer, closing. */
export function standardSession(opts: { eyes: BlockSpec['eyes']; train: BlockSpec; baselineText?: string; transfer?: boolean; restText?: string }): BlockItem[] {
  const items: BlockItem[] = [b.settle(opts.eyes === 'open' ? 'open' : 'closed'), b.baseline(opts.eyes, opts.baselineText), { repeat: { var: 'blocks' }, blocks: [opts.train, b.rest({ eyes: opts.eyes, text: opts.restText })] }];
  if (opts.transfer !== false) items.push(b.transfer(opts.eyes));
  items.push(b.closing());
  return items;
}

export const standardVariables = (o: { train?: number; blocks?: number; tau: number; tauMax?: number; muscle?: boolean; posture?: string; trainMin?: number; trainMax?: number }): VariableSpec[] => [
  v.settle(),
  v.baseline(),
  v.trainBlock(o.train ?? 180, o.trainMin, o.trainMax),
  v.blocks(o.blocks ?? 4),
  v.rest(),
  v.transfer(),
  v.closing(),
  v.tau(o.tau, 0.5, o.tauMax ?? 5),
  ...(o.muscle === false ? [] : [v.muscleGate()]),
  v.minClean(),
  v.soundscape(),
  v.posture(o.posture),
];

// ---------------------------------------------------------------- bindings
export const sound = (element: SoundElement, reads: string, note?: string): Binding<SoundElement> => ({ element, reads, ...(note ? { note } : {}) });
export const visual = (element: VisualElement, reads: string, note?: string): Binding<VisualElement> => ({ element, reads, ...(note ? { note } : {}) });

export const COMMON_SOUND: Binding<SoundElement>[] = [
  sound('base_soundscape', 'reward', 'Always present at a comfortable low level; does not move with the brain.'),
  sound('reward_layer', 'reward', 'A warm layer that swells in as the reward level rises and recedes as it falls. Never a discrete sound.'),
  sound('thinning', F.artifact, 'The sound thins while the signal is gated.'),
];
export const COMMON_VISUAL: Binding<VisualElement>[] = [
  visual('hurricane_rotation', F.dominantFreq),
  visual('arm_brightness', F.alphaHeight),
  visual('scattered_cloud', F.artifact, 'No structure while the signal is gated or null, with the reason shown.'),
  visual('quality_panel', F.clean),
];

export const SAFETY = {
  general: 'This is a relaxation and self-awareness practice, not a medical device. Stop if you feel unwell.',
  epilepsy: 'If you have epilepsy or a seizure history, check with your doctor before using biofeedback.',
  deepStates: 'Deep relaxed states can bring up strong images, memories or feelings. You can stop at any time: open your eyes, feel your feet on the floor, and take a long slow breath out. The sound fades out gently.',
  psych: 'If you have a history of psychosis or a bipolar condition, talk with a clinician before doing deep-state practice.',
  breath: 'Breathe gently. If you feel light-headed, return to natural breathing. Never hold the breath or breathe fast in this app.',
  driving: 'Never use while driving or operating machinery.',
  sleepiness: 'This practice can make you drowsy. Do not drive straight afterwards if you feel sleepy.',
};
