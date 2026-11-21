/**
 * Contrast for every text-carrying token pair in all eight palettes (four themes, dark and light),
 * the candlelight palette, and high-contrast mode. It reads ui/theme.css itself, so a palette edit
 * that breaks a ratio fails here. WCAG 2.x relative luminance.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error the project has no Node types; this test runs under Node in vitest
import { readFileSync } from 'node:fs';

const css: string = (readFileSync as (u: URL, e: string) => string)(new URL('../theme.css', import.meta.url), 'utf8');
const THEMES = ['still-water', 'dawn-journal', 'calm-instrument', 'night-garden'] as const;

type Pal = Record<string, string>;

function declarations(body: string): Pal {
  const out: Pal = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) out[m[1]!] = m[2]!.toUpperCase();
  return out;
}

function block(selectorStart: string): Pal {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`no palette block: ${selectorStart}`);
  const open = css.indexOf('{', i);
  return declarations(css.slice(open + 1, css.indexOf('}', open)));
}

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
export const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const palettes: { name: string; pal: Pal }[] = [];
for (const t of THEMES) for (const m of ['dark', 'light'] as const) palettes.push({ name: `${t} ${m}`, pal: block(`:is(:root, .theme-scope)[data-theme='${t}'][data-mode='${m}']`) });
palettes.push({ name: 'candlelight', pal: block(":root .live[data-pal='candle']") });

const hcDark = block(":is(:root, .theme-scope)[data-contrast='high'][data-mode='dark']");
const hcLight = block(":is(:root, .theme-scope)[data-contrast='high'][data-mode='light']");

const GROUNDS = ['bg', 'surface', 'surface-2'] as const;

describe('contrast of every text-carrying token pair', () => {
  it('finds all nine palettes with every token as a hex colour', () => {
    expect(palettes).toHaveLength(9);
    for (const { name, pal } of palettes) for (const k of ['bg', 'surface', 'surface-2', 'surface-3', 'text', 'dim', 'faint', 'accent', 'accent-ink', 'gold', 'octave', 'both', 'state-ink', 'ok', 'warn', 'bad', 'control-border']) expect(pal[k], `${name} ${k}`).toBeTruthy();
  });

  for (const { name, pal } of palettes) {
    describe(name, () => {
      it('body text, dim text and faint text reach 4.5:1 on the background and every surface', () => {
        for (const g of GROUNDS) for (const t of ['text', 'dim', 'faint']) expect(ratio(pal[t]!, pal[g]!), `${t} on ${g}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(pal['dim']!, pal['surface-3']!), 'dim on surface-3').toBeGreaterThanOrEqual(4.5);
        expect(ratio(pal['text']!, pal['surface-3']!), 'text on surface-3').toBeGreaterThanOrEqual(4.5);
      });
      it('gold and octave reach 4.5:1 on the background and surface, and differ in lightness', () => {
        for (const g of ['bg', 'surface']) for (const c of ['gold', 'octave', 'both']) expect(ratio(pal[c]!, pal[g]!), `${c} on ${g}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(pal['gold']!, pal['octave']!), 'gold against octave').toBeGreaterThanOrEqual(1.4);
      });
      it('status colours, the accent and its ink are readable', () => {
        for (const c of ['ok', 'warn', 'bad', 'accent']) for (const g of ['bg', 'surface']) expect(ratio(pal[c]!, pal[g]!), `${c} on ${g}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(pal['accent-ink']!, pal['accent']!), 'accent-ink on accent').toBeGreaterThanOrEqual(4.5);
        for (const c of ['gold', 'octave', 'both']) expect(ratio(pal['state-ink']!, pal[c]!), `state-ink on ${c}`).toBeGreaterThanOrEqual(4.5);
      });
      it('control borders reach 3:1 against the surface they sit on', () => {
        for (const g of ['bg', 'surface', 'surface-2']) expect(ratio(pal['control-border']!, pal[g]!), `control-border on ${g}`).toBeGreaterThanOrEqual(3);
      });
    });
  }

  describe('high contrast: dim text and borders reach 7:1', () => {
    for (const { name, pal } of palettes) {
      const light = name.endsWith(' light');
      const hc = { ...pal, ...(light ? hcLight : hcDark) };
      it(name, () => {
        for (const g of [...GROUNDS, 'surface-3']) for (const t of ['dim', 'faint', 'text']) expect(ratio(hc[t]!, hc[g]!), `${t} on ${g}`).toBeGreaterThanOrEqual(7);
        for (const g of ['bg', 'surface', 'surface-2']) expect(ratio(hc['control-border']!, hc[g]!), `control-border on ${g}`).toBeGreaterThanOrEqual(7);
        if (hc['border']!.startsWith('#')) for (const g of ['bg', 'surface']) expect(ratio(hc['border']!, hc[g]!), `border on ${g}`).toBeGreaterThanOrEqual(7);
      });
    }
  });
});
