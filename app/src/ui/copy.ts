/**
 * Plain-language text shown in the app. No medical claims (CLAUDE.md rule 7): the app measures
 * and reports; interpretations are offered as readings, not facts.
 */
import { STRATEGIES, type SafetyFlag } from '../training';

export const WHAT_IT_MEASURES = [
  'Brain rhythms from the four sensors of a Muse headband: how strong each rhythm is above the normal background, and which rhythms are present as confirmed peaks, with their frequency and its uncertainty.',
  'How the frequencies of those peaks relate to one another: golden ratio alignment and octave alignment, always shown beside the chance level, which is what you would expect from peaks placed at random using the same procedure.',
  'With a chest strap: heart rate, beat-to-beat variability (RMSSD), the rhythm of your heart and an estimate of your breathing.',
];

export const WHAT_IT_DOES_NOT_CLAIM = [
  'Hurricane Brain is for wellness and self-exploration. It is not a medical device, and nothing it shows is medical advice.',
  'Four dry sensors cannot read specific emotions or thoughts. Anything the app calls your signature is built from your own marked blocks and tested before it is called reliable.',
  'When a value cannot be measured the app says "not measured" and why. It never shows a made-up or old number in its place.',
];

export const GOLDEN_RATIO_TEXT = {
  measurement:
    'Golden ratio alignment is a measurement. It asks how closely the frequency ratios between your confirmed rhythm peaks sit near 1.618. The app always shows it beside octave alignment (ratios near 2) and the chance level, so you can see whether a reading is more than the app would find in random peaks.',
  winter:
    'One reading, associated with Dan Winter, takes a high golden ratio alignment to indicate coherent, well-organised rhythmic activity.',
  mainstream:
    'The mainstream reading is that golden-ratio spacing is the most "irrational" spacing, and rhythms with such spacing are the least likely to lock onto one another, which keeps them from synchronizing.',
  research:
    'What the published research tested: ratios of 2 to 1 (octave) and 3 to 1 between rhythms such as theta and alpha. The golden ratio has not been tested in that research. Looking for golden ratio alignment is this app\'s own hypothesis, a frontier idea that you can explore with the chance level beside it.',
  stance: 'The app measures the alignment and takes no side between these readings.',
};

export const HEADPHONES = [
  'Wired headphones are recommended. Bluetooth headphones add 100 to 300 milliseconds of delay, which is noticeable when the tone follows your brain rhythm.',
  'Small speakers (phone and laptop speakers) cannot play the low tones. Slow rhythms become tones around 32 to 128 Hz, and the heartbeat sound is about 58 Hz. You will hear less, but nothing is wrong.',
  'Keep the volume comfortable. The app limits how loud it can get, and you can lower it further in Settings.',
];

export const PRIVACY = [
  'Everything stays on this device: recordings, sessions, your profile, signatures and anchors are stored in this browser and are never sent anywhere.',
  'Nothing leaves the device unless you export it. You can export or delete everything in Settings.',
  'The app works offline after its first load.',
];

export const SAFETY_QUESTIONS: { flag: SafetyFlag; text: string }[] = [
  { flag: 'epilepsy', text: 'I have epilepsy or a history of seizures.' },
  { flag: 'psychosis_bipolar', text: 'I have a history of psychosis or a bipolar condition.' },
  { flag: 'trauma_dissociation', text: 'Deep relaxation or imagery has sometimes brought up distressing memories or a sense of detachment.' },
  { flag: 'breathing_condition', text: 'I have a breathing condition.' },
  { flag: 'heart_condition', text: 'I have a heart condition.' },
  { flag: 'pregnancy', text: 'I am pregnant.' },
];

/** Distinct cautions from the technique library, shown in onboarding. */
export function techniqueCautions(): string[] {
  const seen = new Set<string>();
  for (const s of STRATEGIES) for (const c of s.cautions) seen.add(c);
  return [...seen];
}

export const GENERAL_SAFETY = [
  'Stop at any time: open your eyes, feel your feet on the floor and take a long, slow breath out. The sound fades out gently.',
  'Never use the app while driving or operating machinery.',
  'If you have epilepsy or a seizure history, or a history of psychosis or bipolar condition, talk with your doctor first. The picture does not flash, but this advice stands.',
  'Breathe gently. If you feel light-headed, go back to natural breathing. The app never asks you to hold your breath or breathe fast.',
];

export const FIT_STEPS = [
  { title: 'Wet-free, clean skin', text: 'Wipe your forehead and the skin behind your ears. Move hair out from under the sensors.' },
  { title: 'Forehead sensors sit high', text: 'The two front sensors rest on the forehead about a finger-width above the eyebrows, centred on each eye.' },
  { title: 'Ear sensors sit behind the ears', text: 'The two rear sensors rest on the bone just behind and above each ear. Tuck hair behind the ear first.' },
  { title: 'Snug, not tight', text: 'The band should feel secure when you nod your head, without pressing hard. Glasses arms can lift the ear sensors; slide them under the band.' },
  { title: 'Wait for the dots', text: 'Each sensor should show good contact. Hold still and relax your jaw for a few seconds while the signal settles.' },
];

export const BLUETOOTH_UNAVAILABLE =
  'This browser cannot connect to Bluetooth devices. Connecting works in Chrome or Edge on Windows, Mac, Linux and Android. It does not work in Safari or Firefox, or in any browser on an iPhone or iPad. You can still replay recorded sessions and look at your history here.';

export const WIRED_NOTE = 'A Muse must not be paired in your system settings or connected to another app. Close the Muse phone app, then choose the headset in the list.';

export const WELLNESS =
  'Hurricane Brain is for wellness and self-exploration. It is not a medical device, and it does not replace care from a professional. If something worries you about your health, talk with a professional.';

export const STORE_DESCRIPTION =
  'A brainwave and heart biofeedback app for Muse headbands and the Polar H10 chest strap. See your own rhythms as a slowly moving picture and a gentle sound. Wellness and self-exploration, not a medical device. Everything stays on your device.';

export const PHOTOSENSITIVITY = [
  'The picture on screen does not flash. It moves slowly, and nothing on it changes faster than a few times a second.',
  'If you are sensitive to light, motion or patterns, you can turn on reduced motion, or run sessions with the screen dark and sound only. Both are in Settings and can be changed at any time.',
  'If anything on the screen is uncomfortable, close your eyes or look away. Sessions work with eyes closed.',
];

export const AGE_GROUPS: { value: 'child' | 'teen' | 'adult'; label: string; text: string }[] = [
  { value: 'child', label: 'Child', text: 'Shorter, simpler sessions, with a grown-up helping.' },
  { value: 'teen', label: 'Teen', text: 'Younger person, using the app on their own or with help.' },
  { value: 'adult', label: 'Adult', text: 'Fully grown.' },
];

export const CHILD_HELPER_NOTE =
  'Children can use this with a grown-up helping. The grown-up fits the band, starts the session and stays nearby. Short sessions are fine. Stop whenever the child wants to.';

/** Plain fixes for each way a sensor can fail (keys are the engine's reasons) and each artifact kind. */
export const FIX_BY_REASON: Record<string, string> = {
  bad_contact: 'The sensor is not touching the skin. Move hair out from under it and press the band gently into place.',
  insufficient_clean: 'Not enough clean signal. Sit still, relax the jaw and forehead, and give it a few seconds.',
  artifact: 'Movement or muscle tension is getting in. Sit still, relax the jaw and forehead.',
  no_data: 'Nothing is arriving from this sensor yet. Wait a moment, or check the headset is on and awake.',
  warming_up: 'Still settling. Hold still for a few seconds.',
  gap: 'Some data was lost on the way. Move closer to the device and away from other Bluetooth things.',
};

export const FIX_BY_ARTIFACT: Record<string, string> = {
  blink: 'Blinks show up on the forehead sensors. Blink gently and keep your eyes relaxed or closed.',
  eye_movement: 'Eye movement shows up on the forehead sensors. Rest your gaze, or close your eyes.',
  muscle: 'Muscle tension. Unclench the jaw, soften the forehead, drop the shoulders.',
  motion: 'The head is moving. Sit still and let the head rest.',
  pop: 'A sensor shifted or lost contact for a moment. Press the band gently into place.',
  gap: 'Some data was lost. Move closer to the device.',
};

/** Where to look for each channel, in plain words. */
export const CHANNEL_HELP: Record<string, { where: string; tip: string }> = {
  TP9: { where: 'behind the left ear', tip: 'Tuck hair behind the ear and make sure the sensor rests on skin, just behind and above the ear. Glasses arms can lift it.' },
  TP10: { where: 'behind the right ear', tip: 'Tuck hair behind the ear and make sure the sensor rests on skin, just behind and above the ear. Glasses arms can lift it.' },
  AF7: { where: 'left of the forehead', tip: 'Move hair and fringe away. If the skin is dry, a slightly damp fingertip wiped across it helps. Raise the band a little if it sits on the eyebrow.' },
  AF8: { where: 'right of the forehead', tip: 'Move hair and fringe away. If the skin is dry, a slightly damp fingertip wiped across it helps. Raise the band a little if it sits on the eyebrow.' },
};

export const GENERAL_FIT_TIPS = [
  'Wipe the forehead and the skin behind the ears. Moisten dry skin very slightly with a damp fingertip.',
  'Move hair out from under every sensor, especially behind the ears.',
  'Snug, not tight. If the band slides when you nod, tighten the fit a little. If it leaves a mark, loosen it.',
  'Relax the jaw and forehead, and sit still while the signal settles.',
];

export const SMALL_HEAD_TIPS = [
  'A smaller head: wear the band a little lower at the back so the ear sensors sit on the bone behind the ears, and fold the band arms in so it feels snug without pressure.',
  'A thin headband or a hair tie around the back of the band can take up slack. Do not squeeze: it should feel like a comfortable hat.',
  'If the two ear sensors cannot all reach the skin, that is fine: the app tells you which sensors are good, and shows only what it can measure.',
  'Let the child get settled first. Quiet, sitting or lying down, a few slow breaths. Movement is the biggest source of noise.',
];
