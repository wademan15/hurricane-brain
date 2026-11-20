export { AudioEngine, type AudioDebug, type AudioEngineOptions, type SoundingVoice } from './audio-engine.ts';
export { FrameBinder, type AudioBaseline, type BindingTrace, type BinderOutput, type ScheduledBeat } from './bindings.ts';
export {
  type AnchorSynthParams,
  ANCHOR_RATIOS,
  anchorCandidates,
  anchorDistance,
  anchorDurationS,
  anchorFromSeed,
  neutralControlFor,
  sanitizeAnchor,
} from './anchors.ts';
export {
  type AudioSettings,
  type AudioSettingsPatch,
  type BreathGuideSettings,
  type LayerGains,
  AUDIO_SETTINGS_VERSION,
  DEFAULT_AUDIO_SETTINGS,
  mergeSettings,
} from './settings.ts';
export { SynthCore, type SynthControl, type SynthStatus, type VoiceControl, type VoiceStatus, type BedControl } from './synth-core.ts';
