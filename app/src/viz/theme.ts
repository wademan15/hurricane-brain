/**
 * Theme: the storm's colours come from VIZ_THEME (params.ts), overridden by CSS custom properties
 * (VIZ_THEME_CSS) set on the view or any ancestor, e.g. `:root { --hb-storm-octave-ring: #e2b86b; }`.
 * Accepted forms: #rgb, #rrggbb, rgb(r, g, b) with 0..255 channels. Anything else is ignored.
 */
import { VIZ_THEME, VIZ_THEME_CSS, type VizTheme } from './params.ts';

export function parseCssColor(raw: string): [number, number, number] | null {
  const s = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const h = m[1];
    return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16) / 255) as [number, number, number];
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const h = m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return null;
}

/** The storm theme in force for an element: defaults plus any CSS custom property overrides. */
export function themeFromCss(el: Element): VizTheme {
  const cs = getComputedStyle(el);
  const out = { ...VIZ_THEME };
  for (const k of Object.keys(VIZ_THEME_CSS) as (keyof VizTheme)[]) {
    const c = parseCssColor(cs.getPropertyValue(VIZ_THEME_CSS[k]));
    if (c) out[k] = c;
  }
  return out;
}

/** Read one CSS custom property, with a fallback. For the canvas 2D spectrum. */
export function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}
