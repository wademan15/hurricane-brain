import { DEFAULT_AUDIO_SETTINGS } from '../../audio/settings';
import type { SessionSettings } from '../types';

export function sessionSettings(over: Partial<SessionSettings> = {}): SessionSettings {
  return {
    audio: DEFAULT_AUDIO_SETTINGS, viz: { quality: 'medium', rampS: 0.5, slowStaleS: 1, heartStaleS: 2.5 }, mains: 'auto', chanceDriver: 'a',
    responseSpeed: 'steady', harmonicsCount: false, reducedMotion: 'system', soundOnly: false, ageGroup: null,
    engine: { version: 'e1', params: { a: 1 } }, engineOverrides: {}, appVersion: '1.1.0', ...over,
  };
}
