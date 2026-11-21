/**
 * The induction technique library, as data.
 *
 * Source: /home/user/research/brainwave-induction-research.md (R-sections) and
 * training-programs-and-profiling.md section 3. Every entry carries its evidence grade.
 * "Suits" lines are hypotheses that set the profiling prior only; conclusions come from the
 * person's measured response (profile.ts).
 *
 * Excluded on purpose:
 *  - Rhythmic entrainment (binaural, monaural, isochronic): rule 6. The research design listed
 *    `entrain_binaural` and `entrain_iso`; they arrive later with EarthSync.
 *  - Breath holds and fast breathing: safety (R4.3), and the EEG slowing is low CO2, not a state.
 *  - Upward eye roll: produces a large eye-potential shift on AF7/AF8 that a naive system
 *    would reward (R4.2).
 */

import type { Evidence, StateId } from './program';

export type StrategyFamily = 'breath' | 'attention' | 'visualization' | 'body' | 'emotional_recall' | 'mantra_sound' | 'movement';
/** Traits from the optional questionnaire (profile.ts), used only as a starting guess. */
export type TraitId = 'imagery' | 'aphantasia' | 'absorption' | 'interoception' | 'meditation' | 'anxiety' | 'verbal';

export interface StrategyVariable {
  id: string;
  label: string;
  kind: 'number' | 'choice' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string | number; label: string }[];
}

export interface ExpectedEffect {
  /** A field path (fields.ts). */
  field: string;
  direction: 'up' | 'down';
  note: string;
}

export interface Strategy {
  id: string;
  name: string;
  family: StrategyFamily;
  /** Finer tag used in the profile summary. */
  modality: string;
  summary: string;
  /** Step-by-step instructions, spoken or shown in order. */
  steps: string[];
  /** Short reminders for sparse guidance during a block. */
  cues: string[];
  eyes: 'closed' | 'open' | 'either';
  variables: StrategyVariable[];
  expectedEffects: ExpectedEffect[];
  serves: StateId[];
  evidence: Evidence;
  artifactRisk: 'low' | 'medium' | 'high';
  artifactNote?: string;
  /** Scoring window adjustments, e.g. score only the silent phase after humming. */
  scoring?: { ignoreFirstS?: number };
  cautions: string[];
  /** Hypotheses for the questionnaire prior: +1 raises the starting guess, -1 lowers it. */
  suits: { trait: TraitId; sign: 1 | -1 }[];
  /** Tested in Discovery for everyone. */
  core: boolean;
}

const ALPHA = 'spectra[temporal].bands.alpha.above_bg_db';
const THETA = 'spectra[temporal].bands.theta.above_bg_db';
const EMG = 'quality[*].emg_db';
const RMSSD = 'heart.rmssd_ms';
const RES = 'heart.resonance_strength';
const HR = 'heart.hr_bpm';

const alphaUp = (note = 'Alpha above background at the temporal sites, compared within the same eye condition.'): ExpectedEffect => ({ field: ALPHA, direction: 'up', note });
const emgDown = (note = 'Forehead, jaw and temple muscle activity falls.'): ExpectedEffect => ({ field: EMG, direction: 'down', note });
const thetaUp = (note = 'Theta above background rises as drowsiness or absorption deepens.'): ExpectedEffect => ({ field: THETA, direction: 'up', note });
const hrvUp = (note = 'Beat-to-beat variability rises with calm, slow breathing.'): ExpectedEffect => ({ field: RMSSD, direction: 'up', note });

const BREATH_CAUTION = 'If you feel light-headed or short of breath, return to natural breathing. Never hold the breath or breathe fast in this app.';
const VISUAL_ARTIFACT = 'Moving the eyes behind closed lids to look at imagery shows up on the front sensors. Keep the eyes still and soft; scoring uses the temporal sites.';

export const STRATEGIES: Strategy[] = [
  // ---------------------------------------------------------------- attention / non-effort
  {
    id: 'none', name: 'Simply rest', family: 'attention', modality: 'non_effort',
    summary: 'No technique. Rest and let the sound guide you.',
    steps: ['Settle into a comfortable position.', 'Let the eyes close or soften.', 'There is nothing to do. Let the sound show you where you are.', 'If you notice yourself trying, let the trying go.'],
    cues: ['Nothing to do.', 'Let the sound guide you.'],
    eyes: 'either', variables: [],
    expectedEffects: [alphaUp('With eyes closed, alpha is often already near its natural level; this is the reference every technique is compared with.')],
    serves: ['alpha_ec', 'alpha_eo', 'alpha_theta', 'stillness'],
    evidence: { grade: 'B', summary: 'In several feedback studies people who used no specific strategy learned as well as or better than those who tried hard. Effort itself tends to block alpha.', sources: ['Kober et al. 2013', 'Lynch and Paskewitz 1971'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'anxiety', sign: -1 }], core: true,
  },
  {
    id: 'open_awareness', name: 'Open awareness', family: 'attention', modality: 'non_effort',
    summary: 'Rest in awareness itself and let thoughts, sounds and sensations come and go.',
    steps: ['Let attention widen to include everything at once: sound, body, thought.', 'When a thought appears, notice it and let it pass without following it.', 'Do not choose anything to focus on.', 'If you get lost in thought, simply notice and widen again.'],
    cues: ['Wide and easy.', 'Let it come and go.'],
    eyes: 'either', variables: [],
    expectedEffects: [alphaUp(), thetaUp('Some experienced meditators show more theta as well.')],
    serves: ['alpha_ec', 'alpha_eo', 'alpha_theta'],
    evidence: { grade: 'B', summary: 'Reviews of meditation EEG find alpha and theta increases across styles, stronger in experienced practitioners.', sources: ['Cahn and Polich 2006', 'Lomas et al. 2015'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'meditation', sign: 1 }, { trait: 'absorption', sign: 1 }], core: true,
  },
  {
    id: 'brow_point', name: 'Attention between the eyebrows', family: 'attention', modality: 'attentional',
    summary: 'Rest attention softly at the point between the eyebrows, with the eyes relaxed and not crossed.',
    steps: ['Close the eyes and let them rest level, as if looking at the horizon.', 'Bring a light attention to the space between the eyebrows.', 'Do not turn or cross the eyes toward it; feel the place rather than look at it.', 'If the eyes start to strain, let them drop and soften, and keep only the feeling of the spot.'],
    cues: ['Feel the spot, eyes soft.', 'Eyes level and easy.'],
    eyes: 'closed',
    variables: [{ id: 'gaze', label: 'Eye position', kind: 'choice', default: 'level', options: [{ value: 'level', label: 'Level, relaxed' }, { value: 'lowered', label: 'Slightly lowered' }] }],
    expectedEffects: [alphaUp('Reported to deepen absorption; no good controlled EEG study isolates it, so we measure it for you.')],
    serves: ['alpha_ec'],
    evidence: { grade: 'C-D', summary: 'A long contemplative tradition; no controlled EEG study isolates brow-point focus. Converging the eyes produces a large eye signal on the front sensors that must not be counted as a brainwave change.', sources: ['Mulholland and Peper 1971 (gaze and alpha)', 'Traditional practice (ajna, trataka)'] },
    artifactRisk: 'high', artifactNote: 'Crossing or rolling the eyes upward creates a steady shift on AF7/AF8. Scored at the temporal sites only, and eye artifacts are gated.',
    cautions: ['If you feel eye strain or a headache, stop and let the eyes rest.'], suits: [{ trait: 'meditation', sign: 1 }], core: true,
  },
  {
    id: 'soft_gaze', name: 'Soft panoramic gaze', family: 'attention', modality: 'attentional',
    summary: 'Eyes open, gaze wide and defocused, taking in the whole visual field.',
    steps: ['Rest your eyes on a plain, dim point in front of you.', 'Let the focus soften until the point blurs slightly.', 'Widen your awareness to the edges of your vision on both sides at once.', 'Blink whenever you need to; keep the eyes still between blinks.'],
    cues: ['Soft and wide.', 'Let the edges in.'],
    eyes: 'open', variables: [],
    expectedEffects: [alphaUp('Defocusing reduces the alpha blocking that fixation and focusing cause. Compared with eyes-open rest, not eyes closed.')],
    serves: ['alpha_eo'],
    evidence: { grade: 'B', summary: 'Visual fixation and focusing suppress alpha; a defocused wide gaze suppresses it less.', sources: ['Mulholland and Peper 1971', 'Lynch and Paskewitz 1971'] },
    artifactRisk: 'medium', artifactNote: 'Blinks and eye movements are gated; a still gaze helps.',
    cautions: [], suits: [], core: false,
  },
  {
    id: 'listen_sound', name: 'Resting on a sound', family: 'mantra_sound', modality: 'auditory',
    summary: 'Let attention rest on the steady sound of the soundscape.',
    steps: ['Find the steadiest part of the sound you hear.', 'Let attention rest there, the way you rest your weight on a chair.', 'When the mind wanders, return to the sound without judgement.'],
    cues: ['Rest on the sound.'],
    eyes: 'closed', variables: [],
    expectedEffects: [alphaUp()],
    serves: ['alpha_ec'],
    evidence: { grade: 'B', summary: 'Focused attention on a continuous sound or sensation builds stability; its EEG effect overlaps breath attention.', sources: ['Lomas et al. 2015'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'imagery', sign: -1 }], core: false,
  },
  {
    id: 'inner_sound', name: 'Listening inward', family: 'mantra_sound', modality: 'auditory',
    summary: 'Listen for the quietest sound you can hear, inside or outside, and rest in the listening.',
    steps: ['Listen to the farthest sound you can hear.', 'Then the nearest.', 'Then the quietest, even the faint ringing or hush inside the ears.', 'Rest in the listening itself.'],
    cues: ['Just listening.'],
    eyes: 'closed', variables: [],
    expectedEffects: [alphaUp()],
    serves: ['alpha_ec', 'alpha_theta'],
    evidence: { grade: 'D', summary: 'Traditional inner-sound practice (nada); no controlled EEG data. Offered as an option to test, not as a claim.', sources: ['Traditional practice'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'absorption', sign: 1 }], core: false,
  },
  // ---------------------------------------------------------------- breath
  {
    id: 'breath_resonance', name: 'Slow paced breathing', family: 'breath', modality: 'breath',
    summary: 'Breathe with the gentle pacer at your own resonance rate, around five to six breaths a minute.',
    steps: ['Breathe through the nose if comfortable.', 'Follow the pacer: in as it rises, out as it falls.', 'Keep each breath easy and not too deep; the slowness matters more than the size.', 'If the pace feels like a strain, breathe naturally and rejoin when ready.'],
    cues: ['Easy and slow.', 'Not too deep.'],
    eyes: 'either',
    variables: [
      { id: 'rate_bpm', label: 'Breaths per minute', kind: 'number', default: 5.5, min: 4.5, max: 7, step: 0.5, unit: '/min' },
      { id: 'inhale_ratio', label: 'Inhale share of each breath', kind: 'number', default: 0.4, min: 0.3, max: 0.5, step: 0.05 },
    ],
    expectedEffects: [{ field: RES, direction: 'up', note: 'Heart rhythm concentrates into one slow wave near your breathing rate.' }, hrvUp(), alphaUp('Slow breathing raised alpha in several studies (review).')],
    serves: ['alpha_ec', 'calm_heart', 'high_hrv'],
    evidence: { grade: 'B', summary: 'Strong for the heart (Grade A: resonance breathing reliably enlarges heart-rate oscillation); moderate for brainwaves (a systematic review reports more alpha and less theta during slow breathing).', sources: ['Lehrer and Gevirtz 2014', 'Zaccaro et al. 2018'] },
    artifactRisk: 'low', cautions: [BREATH_CAUTION], suits: [{ trait: 'interoception', sign: 1 }, { trait: 'aphantasia', sign: 1 }], core: true,
  },
  {
    id: 'breath_long_exhale', name: 'Long exhale', family: 'breath', modality: 'breath',
    summary: 'Breathe in naturally, then let a slow, long breath out.',
    steps: ['Let the in-breath come by itself.', 'Let the out-breath be slow and long, like a sigh that takes its time.', 'Let the shoulders drop on each out-breath.', 'Optionally take a small second sip of air at the top of the in-breath, then the long out-breath.'],
    cues: ['Long, slow out-breath.'],
    eyes: 'either',
    variables: [{ id: 'double_inhale', label: 'Double in-breath (cyclic sigh)', kind: 'boolean', default: false }],
    expectedEffects: [emgDown(), hrvUp(), alphaUp()],
    serves: ['alpha_ec', 'stillness', 'calm_heart'],
    evidence: { grade: 'B-C', summary: 'Daily cyclic sighing improved mood and lowered breathing rate more than mindfulness in one controlled study (Grade B for mood and arousal). EEG effects were not measured (Grade C).', sources: ['Balban et al. 2023'] },
    artifactRisk: 'low', cautions: [BREATH_CAUTION], suits: [{ trait: 'anxiety', sign: 1 }, { trait: 'interoception', sign: 1 }], core: false,
  },
  {
    id: 'breath_count', name: 'Counting breaths', family: 'breath', modality: 'breath_attention',
    summary: 'Count each out-breath from one to ten, then start again.',
    steps: ['Breathe naturally.', 'Silently count "one" on the first out-breath, "two" on the next, up to ten.', 'At ten, or whenever you lose count, start again at one. Losing count is part of it.'],
    cues: ['Back to one.'],
    eyes: 'closed',
    variables: [{ id: 'count_to', label: 'Count up to', kind: 'number', default: 10, min: 4, max: 10, step: 1 }],
    expectedEffects: [alphaUp()],
    serves: ['alpha_ec'],
    evidence: { grade: 'B', summary: 'A core concentration practice; reviews report alpha increases, and frontal theta in experienced meditators (not visible on this headset).', sources: ['Lomas et al. 2015'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'verbal', sign: 1 }], core: false,
  },
  {
    id: 'breath_natural', name: 'Watching the breath', family: 'breath', modality: 'interoceptive',
    summary: 'Observe the natural breath without changing it.',
    steps: ['Notice where you feel the breath most clearly: belly, chest or nose.', 'Let the breath breathe itself; only watch.', 'When attention wanders, notice where it went and return to the breath.'],
    cues: ['Just watching.'],
    eyes: 'closed', variables: [],
    expectedEffects: [alphaUp()],
    serves: ['alpha_ec'],
    evidence: { grade: 'B', summary: 'Breath attention is the most studied meditation focus; alpha increases are the most consistent EEG finding.', sources: ['Lomas et al. 2015', 'Cahn and Polich 2006'] },
    artifactRisk: 'low', cautions: ['Some people find attention on the breath makes them anxious. If so, choose another technique.'], suits: [{ trait: 'interoception', sign: 1 }, { trait: 'anxiety', sign: -1 }], core: false,
  },
  {
    id: 'breath_nostril', name: 'Breath at the nostrils', family: 'breath', modality: 'interoceptive',
    summary: 'Rest attention on the feeling of air at the nostrils.',
    steps: ['Breathe through the nose.', 'Feel the cool air coming in and the warm air going out at the edge of the nostrils.', 'Keep attention light, on that small area.'],
    cues: ['Cool in, warm out.'],
    eyes: 'closed', variables: [],
    expectedEffects: [alphaUp()],
    serves: ['alpha_ec'],
    evidence: { grade: 'B', summary: 'A concentration practice with EEG effects overlapping other breath attention.', sources: ['Lomas et al. 2015'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'interoception', sign: 1 }, { trait: 'meditation', sign: 1 }], core: false,
  },
  // ---------------------------------------------------------------- body
  {
    id: 'body_scan', name: 'Body scan', family: 'body', modality: 'somatic',
    summary: 'Move attention slowly from the crown of the head to the feet, softening each area.',
    steps: ['Start at the top of the head and notice any sensation there.', 'Move slowly down: forehead, eyes, jaw, neck, shoulders, arms, hands.', 'Then chest, belly, back, hips, legs and feet.', 'Wherever you find tension, let it soften on an out-breath.'],
    cues: ['Slowly downward.', 'Soften as you pass.'],
    eyes: 'closed',
    variables: [{ id: 'pace', label: 'Pace', kind: 'choice', default: 'slow', options: [{ value: 'slow', label: 'Slow (whole body in about 5 minutes)' }, { value: 'quick', label: 'Quick (about 90 seconds)' }] }],
    expectedEffects: [emgDown(), alphaUp()],
    serves: ['stillness', 'alpha_ec'],
    evidence: { grade: 'B', summary: 'Relaxation lowers muscle tone and arousal reliably (Grade A); EEG shifts toward more alpha (Grade B).', sources: ['Stetter and Kupper 2002', 'Lomas et al. 2015'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'interoception', sign: 1 }], core: true,
  },
  {
    id: 'progressive_relaxation', name: 'Tense and release', family: 'body', modality: 'somatic',
    summary: 'Gently tense a muscle group for a few seconds, then release it and feel the difference.',
    steps: ['Make fists gently for five seconds, then let go completely.', 'Lift the shoulders toward the ears, hold, and drop them.', 'Continue through the body, leaving the face and jaw for last and tensing them only lightly.', 'Rest in the feeling of release.'],
    cues: ['Feel the release.'],
    eyes: 'closed', variables: [],
    expectedEffects: [emgDown('Muscle activity falls after the release phases. The tensing phases are gated as artifact and not scored.')],
    serves: ['stillness'],
    evidence: { grade: 'B', summary: 'A long-established relaxation method with reliable effects on muscle tension and self-reported calm.', sources: ['Stetter and Kupper 2002 (relaxation methods)'] },
    artifactRisk: 'high', artifactNote: 'Tensing creates large muscle artifact; only the resting phase after is scored.',
    scoring: { ignoreFirstS: 60 },
    cautions: ['Tense gently. Skip any area that is injured or painful.'], suits: [], core: false,
  },
  {
    id: 'heavy_warm', name: 'Heavy and warm', family: 'body', modality: 'somatic',
    summary: 'Autogenic phrases: the arms and legs are heavy and warm.',
    steps: ['Silently repeat, slowly: "My right arm is heavy." Feel for heaviness.', 'Then the left arm, then both legs.', 'Then: "My arms and legs are warm." Feel for warmth.', 'Let any sensation come by itself; do not force it.'],
    cues: ['Heavy and warm.'],
    eyes: 'closed', variables: [],
    expectedEffects: [emgDown(), alphaUp(), thetaUp('With continued relaxation theta can rise.')],
    serves: ['alpha_ec', 'alpha_theta', 'stillness'],
    evidence: { grade: 'B', summary: 'Autogenic training has a long record for relaxation (Grade A); EEG moves toward more alpha and then theta (Grade B).', sources: ['Stetter and Kupper 2002', 'Green and Green 1977'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'interoception', sign: 1 }, { trait: 'absorption', sign: 1 }], core: false,
  },
  {
    id: 'face_soften', name: 'Soften the face', family: 'body', modality: 'somatic',
    summary: 'Let the brow, eyes, jaw and tongue go soft.',
    steps: ['Let the forehead widen and smooth.', 'Let the eyes rest heavy in their sockets.', 'Let the teeth part slightly and the jaw hang.', 'Let the tongue rest on the floor of the mouth.'],
    cues: ['Soft jaw.', 'Smooth brow.'],
    eyes: 'either', variables: [],
    expectedEffects: [emgDown('Muscle activity at the forehead and temples falls; this headset measures it directly and well.')],
    serves: ['stillness'],
    evidence: { grade: 'A', summary: 'Muscle relaxation of the face and jaw is directly measurable on these sensors and trainable; it also cleans the signal for every other program.', sources: ['Research brief R2.2 and R4.5'] },
    artifactRisk: 'low', cautions: [], suits: [], core: false,
  },
  {
    id: 'posture_settle', name: 'Settling the posture', family: 'body', modality: 'somatic',
    summary: 'Find a balanced, upright and easy posture, then let the body be still.',
    steps: ['Sit with the spine tall but not stiff, as if hanging from a thread at the crown.', 'Let the chin drop very slightly so the neck is long.', 'Let the hands rest heavy on the thighs.', 'Once comfortable, let the body become still.'],
    cues: ['Tall and easy.'],
    eyes: 'either',
    variables: [{ id: 'posture', label: 'Posture', kind: 'choice', default: 'upright', options: [{ value: 'upright', label: 'Upright' }, { value: 'reclined', label: 'Reclined' }, { value: 'lying', label: 'Lying down' }] }],
    expectedEffects: [emgDown()],
    serves: ['stillness', 'alpha_eo'],
    evidence: { grade: 'C', summary: 'Posture affects arousal reliably (upright keeps alertness up, reclining lowers it); specific EEG prescriptions are weak.', sources: ['Research brief R4.9'] },
    artifactRisk: 'low', artifactNote: 'Lying down presses the ear sensors into the pillow; a neck pillow or a recline works better.',
    cautions: [], suits: [], core: false,
  },
  // ---------------------------------------------------------------- visualization
  {
    id: 'visual_calm', name: 'A calm scene', family: 'visualization', modality: 'visual',
    summary: 'Picture a calm, simple scene, such as a still lake in warm evening light.',
    steps: ['Picture a calm place with very little detail: still water, soft light.', 'Let the image be faint if it wants to be; you do not need to make it vivid.', 'Rest in the feeling of the place rather than studying it.', 'Keep the eyes still behind closed lids.'],
    cues: ['Still water, soft light.', 'Eyes still.'],
    eyes: 'closed',
    variables: [{ id: 'scene', label: 'Scene', kind: 'choice', default: 'lake', options: [{ value: 'lake', label: 'Still lake' }, { value: 'meadow', label: 'Quiet meadow' }, { value: 'shore', label: 'Calm shore' }, { value: 'own', label: 'A place of your own' }] }],
    expectedEffects: [alphaUp('Calm, low-detail imagery tends to support alpha; vivid, effortful imagery can reduce it in some people.')],
    serves: ['alpha_ec'],
    evidence: { grade: 'B-C', summary: 'Internally directed attention raises alpha (Grade B); specific imagery scripts are less studied (Grade C).', sources: ['Cooper et al. 2003', 'Benedek et al. 2014'] },
    artifactRisk: 'medium', artifactNote: VISUAL_ARTIFACT,
    cautions: [], suits: [{ trait: 'imagery', sign: 1 }, { trait: 'absorption', sign: 1 }, { trait: 'aphantasia', sign: -1 }], core: true,
  },
  {
    id: 'visual_drift', name: 'Floating and drifting', family: 'visualization', modality: 'visual',
    summary: 'Imagine floating, drifting slowly, as on warm water or a cloud.',
    steps: ['Feel yourself supported, floating.', 'Let yourself drift slowly, with nowhere to go.', 'Let images come and go on their own, like a daydream.', 'If you notice yourself falling asleep and want to stay awake, take one slightly deeper breath.'],
    cues: ['Drifting.', 'Let images come and go.'],
    eyes: 'closed', variables: [],
    expectedEffects: [thetaUp(), alphaUp('Alpha first, then it gives way to theta as you drift.')],
    serves: ['alpha_theta', 'descent'],
    evidence: { grade: 'C', summary: 'Dreamy, drifting imagery accompanies the theta rise of drowsiness; scripts are not well studied.', sources: ['Hori et al. 1994', 'Jensen et al. 2015'] },
    artifactRisk: 'medium', artifactNote: VISUAL_ARTIFACT,
    cautions: ['Strong images or feelings can arise in deep states. Open your eyes and feel your feet on the floor if you want to come back.'],
    suits: [{ trait: 'imagery', sign: 1 }, { trait: 'absorption', sign: 1 }, { trait: 'aphantasia', sign: -1 }], core: false,
  },
  {
    id: 'visual_color', name: 'Breathing a colour', family: 'visualization', modality: 'visual',
    summary: 'Imagine breathing in a soft colour or light that fills the body.',
    steps: ['Choose a colour that feels calm to you.', 'On each in-breath imagine it flowing in softly.', 'On each out-breath let it spread through the body.', 'Keep the image soft and easy.'],
    cues: ['Soft colour, filling.'],
    eyes: 'closed',
    variables: [{ id: 'colour', label: 'Colour', kind: 'choice', default: 'gold', options: [{ value: 'gold', label: 'Warm gold' }, { value: 'blue', label: 'Soft blue' }, { value: 'green', label: 'Green' }, { value: 'white', label: 'White light' }] }],
    expectedEffects: [alphaUp()],
    serves: ['alpha_ec'],
    evidence: { grade: 'C-D', summary: 'A common guided practice; no controlled EEG data on colour imagery specifically.', sources: ['Practitioner reports'] },
    artifactRisk: 'medium', artifactNote: VISUAL_ARTIFACT,
    cautions: [], suits: [{ trait: 'imagery', sign: 1 }, { trait: 'aphantasia', sign: -1 }], core: false,
  },
  {
    id: 'descent_count', name: 'Counting down', family: 'visualization', modality: 'hypnotic',
    summary: 'Count slowly down from one hundred, letting each number sink you a little deeper.',
    steps: ['Silently count down from one hundred, one number per out-breath.', 'With each number, imagine sinking a little deeper, as on a slow staircase.', 'If you lose your place, start again from wherever feels right.', 'If the numbers fade away, let them.'],
    cues: ['Each number, a little deeper.'],
    eyes: 'closed', variables: [{ id: 'start_at', label: 'Start at', kind: 'number', default: 100, min: 20, max: 300, step: 10 }],
    expectedEffects: [thetaUp(), alphaUp()],
    serves: ['alpha_theta', 'descent'],
    evidence: { grade: 'B-C', summary: 'Hypnotic induction with descent imagery raises theta in highly hypnotisable people (Grade B); the counting script itself is less studied.', sources: ['Jensen et al. 2015'] },
    artifactRisk: 'low', cautions: [], suits: [{ trait: 'absorption', sign: 1 }, { trait: 'verbal', sign: 1 }], core: false,
  },
  // ---------------------------------------------------------------- mantra and sound
  {
    id: 'mantra_silent', name: 'Silent word', family: 'mantra_sound', modality: 'verbal',
    summary: 'Silently repeat a soft word or phrase, effortlessly.',
    steps: ['Choose a soft word with no strong meaning for you, or a short phrase.', 'Repeat it silently, easily, at whatever pace it wants.', 'When you notice you have drifted into thoughts, return to the word without effort.', 'Let the word become fainter if it wants to.'],
    cues: ['Effortless repetition.'],
    eyes: 'closed',
    variables: [{ id: 'word', label: 'Word', kind: 'choice', default: 'one', options: [{ value: 'one', label: '"one"' }, { value: 'calm', label: '"calm"' }, { value: 'om', label: '"om"' }, { value: 'own', label: 'My own word' }] }],
    expectedEffects: [alphaUp(), thetaUp('Some studies report theta as well.')],
    serves: ['alpha_ec', 'alpha_theta'],
    evidence: { grade: 'B-C', summary: 'Mantra meditation studies report more alpha and theta than rest; many come from affiliated groups or small samples.', sources: ['Lagopoulos et al. 2009', 'Travis (TM studies)'] },
    artifactRisk: 'low', artifactNote: 'Silent only: speaking or whispering creates muscle artifact.',
    cautions: [], suits: [{ trait: 'verbal', sign: 1 }, { trait: 'anxiety', sign: 1 }], core: true,
  },
  {
    id: 'hum_then_silence', name: 'Hum, then silence', family: 'mantra_sound', modality: 'auditory_breath',
    summary: 'Hum softly on each out-breath for a minute, then rest in the silence after.',
    steps: ['Breathe in through the nose.', 'Hum softly on a long out-breath, feeling the vibration in the head.', 'Repeat for about a minute.', 'Then stop humming and rest in the quiet. Only this quiet part is scored.'],
    cues: ['Rest in the quiet after.'],
    eyes: 'closed',
    variables: [{ id: 'hum_s', label: 'Humming time', kind: 'number', default: 60, min: 30, max: 120, step: 15, unit: 's' }],
    expectedEffects: [alphaUp('Measured only in the silent phase.')],
    serves: ['alpha_ec'],
    evidence: { grade: 'C', summary: 'Small studies report calm and more alpha or theta after humming practices; humming also lengthens the out-breath.', sources: ['Research brief R4.3 (bhramari studies)'] },
    artifactRisk: 'high', artifactNote: 'Humming vibrates the skull and creates muscle signal; the humming phase is never scored.',
    scoring: { ignoreFirstS: 60 },
    cautions: [], suits: [{ trait: 'verbal', sign: 1 }], core: false,
  },
  // ---------------------------------------------------------------- emotional recall
  {
    id: 'emotion_recall', name: 'Recall a moment', family: 'emotional_recall', modality: 'emotional',
    summary: 'Recall a specific moment when you felt the chosen feeling, and let it return in your body.',
    steps: ['Choose one specific moment when you felt this feeling clearly.', 'Recall where you were: the light, the sounds, the temperature.', 'Notice where the feeling lives in your body now, and let it grow a little.', 'Stay with the feeling rather than the story.'],
    cues: ['Where is it in your body?', 'Let it grow a little.'],
    eyes: 'closed',
    variables: [{ id: 'emotion', label: 'Feeling', kind: 'choice', default: 'calm', options: [{ value: 'calm', label: 'Calm' }, { value: 'warmth', label: 'Warmth' }, { value: 'gratitude', label: 'Gratitude' }, { value: 'awe', label: 'Awe' }, { value: 'confidence', label: 'Confidence' }, { value: 'joyful_energy', label: 'Joyful energy' }, { value: 'safety', label: 'Safety' }] }],
    expectedEffects: [hrvUp('Calm and warm feelings tend to raise variability; energetic joy can lower it while still being pleasant.'), { field: HR, direction: 'down', note: 'For calm states. Energetic states raise heart rate.' }],
    serves: ['calm', 'warmth', 'gratitude', 'awe', 'confidence', 'joyful_energy'],
    evidence: { grade: 'A', summary: 'Recalling a personal memory reliably shifts how people feel (Grade A, self-report). Reading which feeling it is from four sensors is weak, so your signature is personal and tested.', sources: ['Lench, Flores and Bench 2011'] },
    artifactRisk: 'low', cautions: ['Choose a pleasant memory. If a difficult memory comes up, open your eyes and return to the room.'],
    suits: [{ trait: 'imagery', sign: 1 }], core: false,
  },
  {
    id: 'gratitude_recall', name: 'Gratitude', family: 'emotional_recall', modality: 'emotional',
    summary: 'Bring to mind something or someone you are grateful for and let the feeling settle in.',
    steps: ['Think of one thing you are grateful for today.', 'Recall it in detail, as if it were happening now.', 'Notice the feeling of thanks and where you feel it.', 'Rest in that feeling.'],
    cues: ['Rest in the thanks.'],
    eyes: 'closed', variables: [],
    expectedEffects: [hrvUp()],
    serves: ['gratitude', 'warmth', 'calm'],
    evidence: { grade: 'B', summary: 'Gratitude recall reliably lifts mood in the short term.', sources: ['Research brief R7.1'] },
    artifactRisk: 'low', cautions: [], suits: [], core: false,
  },
  {
    id: 'safety_recall', name: 'A safe place', family: 'emotional_recall', modality: 'emotional',
    summary: 'Recall or imagine a place where you feel completely safe and at ease.',
    steps: ['Picture a place where you feel safe: real or imagined.', 'Notice what tells you that you are safe there.', 'Let the body take on that feeling: shoulders down, breath easy.'],
    cues: ['Safe and at ease.'],
    eyes: 'closed', variables: [],
    expectedEffects: [hrvUp(), emgDown()],
    serves: ['calm'],
    evidence: { grade: 'B', summary: 'Self-generated imagery and recall shift self-reported emotion reliably; calm is the state most visible in body measures.', sources: ['Lench, Flores and Bench 2011'] },
    artifactRisk: 'low', cautions: ['If no place feels safe right now, choose a neutral, pleasant scene instead.'], suits: [{ trait: 'imagery', sign: 1 }], core: false,
  },
  {
    id: 'loving_kindness', name: 'Kindness', family: 'emotional_recall', modality: 'emotional',
    summary: 'Silently offer good wishes to yourself, someone you love, and others.',
    steps: ['Picture someone you care about easily.', 'Silently wish them well: "May you be happy. May you be at ease."', 'Offer the same wishes to yourself.', 'Then widen to others, as far as feels natural.'],
    cues: ['May you be at ease.'],
    eyes: 'closed', variables: [],
    expectedEffects: [hrvUp('A reported link to rising heart variability did not replicate cleanly; we measure it for you.')],
    serves: ['warmth', 'calm'],
    evidence: { grade: 'B', summary: 'Loving-kindness practice increases positive emotion over weeks (Grade B); the heart-variability link is uncertain (Grade C).', sources: ['Fredrickson et al. 2008', 'Kok et al. 2013'] },
    artifactRisk: 'low', cautions: [], suits: [], core: false,
  },
  {
    id: 'awe_recall', name: 'Awe', family: 'emotional_recall', modality: 'emotional',
    summary: 'Recall or imagine something vast: a night sky, a mountain range, the ocean.',
    steps: ['Bring to mind something vast that once took your breath away.', 'Let its size fill your attention.', 'Notice the feeling of being small and part of something large.'],
    cues: ['Vast and open.'],
    eyes: 'closed', variables: [],
    expectedEffects: [alphaUp()],
    serves: ['awe'],
    evidence: { grade: 'B', summary: 'Awe recall and imagery shift self-reported emotion reliably; body and brain markers of awe specifically are not established.', sources: ['Research brief R7.1'] },
    artifactRisk: 'medium', artifactNote: VISUAL_ARTIFACT, cautions: [], suits: [{ trait: 'imagery', sign: 1 }, { trait: 'absorption', sign: 1 }], core: false,
  },
  {
    id: 'appreciation_heart', name: 'Heart-centred appreciation', family: 'emotional_recall', modality: 'emotional_breath',
    summary: 'Breathe slowly as if through the centre of the chest while feeling appreciation.',
    steps: ['Place attention, or a hand, at the centre of the chest.', 'Breathe slowly, a little slower than usual, as if the breath moves through that area.', 'Recall a feeling of appreciation for someone or something.', 'Let the feeling and the slow breath continue together.'],
    cues: ['Slow breath, warm feeling.'],
    eyes: 'closed', variables: [],
    expectedEffects: [{ field: RES, direction: 'up', note: 'Mostly from the slow breathing itself.' }, hrvUp()],
    serves: ['calm_heart', 'warmth', 'high_hrv'],
    evidence: { grade: 'B-C', summary: 'The strong slow heart-rhythm wave is mostly the slow breathing (Grade A); the claim that the feeling adds a distinct effect comes mainly from affiliated research (Grade C).', sources: ['Lehrer and Gevirtz 2014', 'McCraty et al. 2009'] },
    artifactRisk: 'low', cautions: [BREATH_CAUTION], suits: [{ trait: 'interoception', sign: 1 }], core: false,
  },
  {
    id: 'confidence_posture', name: 'Confident posture', family: 'emotional_recall', modality: 'emotional_somatic',
    summary: 'Take an open, upright posture, breathe low and steady, and recall a moment you felt capable.',
    steps: ['Sit or stand tall with the chest open and the shoulders easy.', 'Breathe low into the belly, steady and unhurried.', 'Recall a moment you did something well.', 'Let that feeling sit in the posture.'],
    cues: ['Tall, steady, capable.'],
    eyes: 'either', variables: [],
    expectedEffects: [hrvUp('Steady low breathing; confidence itself has no established brain marker.')],
    serves: ['confidence'],
    evidence: { grade: 'C', summary: 'Recall reliably shifts self-report; posture effects on feelings are debated. Your own signature decides.', sources: ['Lench, Flores and Bench 2011'] },
    artifactRisk: 'low', cautions: [], suits: [], core: false,
  },
  // ---------------------------------------------------------------- movement
  {
    id: 'shake_then_sit', name: 'Shake out, then sit', family: 'movement', modality: 'movement',
    summary: 'Gently shake out the body for a minute standing, then sit and rest in the aftermath.',
    steps: ['Stand and let the knees bounce gently, letting the arms and hands shake loosely.', 'Continue for about a minute, breathing freely.', 'Sit down and let the body settle completely.', 'Rest in the tingling stillness. Only the sitting part is scored.'],
    cues: ['Rest in the stillness after.'],
    eyes: 'closed', variables: [{ id: 'move_s', label: 'Movement time', kind: 'number', default: 60, min: 30, max: 180, step: 15, unit: 's' }],
    expectedEffects: [emgDown('Muscle tone after movement can drop below the starting level.'), alphaUp('Alpha often rises after moderate movement.')],
    serves: ['stillness', 'alpha_ec'],
    evidence: { grade: 'C', summary: 'Alpha rises after moderate exercise (Grade B); short shaking before sitting is a practitioner method without controlled EEG data.', sources: ['Research brief R4.13'] },
    artifactRisk: 'high', artifactNote: 'The movement phase is pure motion artifact and is never scored.',
    scoring: { ignoreFirstS: 75 },
    cautions: ['Move gently; skip if standing or bouncing is uncomfortable.'], suits: [{ trait: 'interoception', sign: 1 }], core: false,
  },
  {
    id: 'stretch_then_sit', name: 'Slow stretch, then sit', family: 'movement', modality: 'movement',
    summary: 'A minute of slow neck, shoulder and back stretches, then sit still.',
    steps: ['Roll the shoulders slowly, then tilt the head gently side to side.', 'Reach the arms up and let them float down.', 'Sit down and let everything settle.', 'Only the still part after is scored.'],
    cues: ['Settle into stillness.'],
    eyes: 'closed', variables: [{ id: 'move_s', label: 'Stretch time', kind: 'number', default: 60, min: 30, max: 180, step: 15, unit: 's' }],
    expectedEffects: [emgDown()],
    serves: ['stillness'],
    evidence: { grade: 'C', summary: 'Stretching relieves muscle tension that would otherwise show as artifact; no controlled EEG data on the sequence itself.', sources: ['Research brief R4.5'] },
    artifactRisk: 'high', artifactNote: 'The stretch phase is motion artifact and is never scored.',
    scoring: { ignoreFirstS: 75 },
    cautions: ['Stay within a comfortable range.'], suits: [], core: false,
  },
];

const BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

export function getStrategy(id: string): Strategy | undefined {
  return BY_ID.get(id);
}

/** Strategies that plausibly serve a state, core first. */
export function strategiesFor(state: StateId): Strategy[] {
  return STRATEGIES.filter((s) => s.serves.includes(state)).sort((a, b) => Number(b.core) - Number(a.core));
}

/** The core strategies that every person samples in Discovery. */
export const CORE_STRATEGIES: string[] = STRATEGIES.filter((s) => s.core).map((s) => s.id);
