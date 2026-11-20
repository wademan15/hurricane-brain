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
  'This is a relaxation and self-awareness tool. It is not a medical device and does not diagnose, treat or prevent anything.',
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
  'If you have epilepsy or a seizure history, or a history of psychosis or bipolar condition, talk with your doctor before using biofeedback. The app has no flashing, but this advice stands.',
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
