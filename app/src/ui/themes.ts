/** The selectable themes and the small helpers the shell uses to apply them. Colours live in theme.css only. */
import { useEffect, useState } from 'react';
import { THEME_IDS, type Appearance, type ThemeId } from '../storage';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  feel: string;
  /** Session layout variant (data-layout on the live screen): see the layout block in index.css. */
  layout: 'centred' | 'window' | 'grid' | 'tile';
}

export const THEMES: ThemeInfo[] = [
  { id: 'still-water', name: 'Still Water', feel: 'A dark lake at night. The storm fills the screen and everything else stays faint.', layout: 'centred' },
  { id: 'dawn-journal', name: 'Dawn Journal', feel: 'Warm paper by day, candlelight in the session.', layout: 'window' },
  { id: 'calm-instrument', name: 'Calm Instrument', feel: 'A quiet lab bench. Every measure visible.', layout: 'grid' },
  { id: 'night-garden', name: 'Night Garden', feel: 'Soft, rounded and friendly, for families.', layout: 'tile' },
];
export const layoutOf = (id: ThemeId): ThemeInfo['layout'] => THEMES.find((t) => t.id === id)?.layout ?? 'centred';
export const themeName = (id: ThemeId): string => THEMES.find((t) => t.id === id)?.name ?? id;
export { THEME_IDS };

/** Root font size by text size: a percentage of the browser's own size. */
export const TEXT_SIZE: Record<Appearance['textSize'], string> = { device: '106.25%', larger: '125%', largest: '150%' };

/** 'system' resolved against the device's colour scheme, kept current. */
export function useResolvedMode(mode: Appearance['mode']): 'light' | 'dark' {
  const q = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: light)') : undefined;
  const [light, setLight] = useState(!!q?.matches);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!m) return;
    const on = () => setLight(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return mode === 'light' || (mode === 'system' && light) ? 'light' : 'dark';
}

/** Which palette the live screen wears. */
export function sessionPalette(session: Appearance['session'], mode: 'light' | 'dark'): 'dark' | 'light' | 'candle' {
  return session === 'candle' ? 'candle' : session === 'match' ? mode : 'dark';
}
