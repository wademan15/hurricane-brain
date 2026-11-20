# Themes and appearance

Status: agreed direction, 20 November 2026. Owner: app engineer, with the visualizer engineer for the hurricane colours.

Mockups of all four looks (session, home, profile, settings and kid mode, at phone and laptop sizes):
https://claude.ai/artifact/BEGmxCt4cWQxEwT73BHmKH

## What Jesus asked for

Make the look modular. People choose a theme, choose light or dark, and get the usual appearance settings. The four mockup directions become four selectable themes. Following the standing rule, every look choice is a user setting with a sensible default.

## Defaults

| Setting | Default |
|---|---|
| Theme for a grown-up profile | Still Water |
| Theme for a child profile | Night Garden |
| Light or dark | Follow the device |
| Session screen | Always dark, whatever the mode (see below) |
| Readouts | Standard |
| Text size | Device size |

## The four themes

Each theme is a set of design tokens plus a few layout choices. Every theme ships a dark and a light version.

| Theme | Feel | Type | Shape | Session layout |
|---|---|---|---|---|
| Still Water | A dark lake at night. The storm fills the screen and everything else stays faint. | Inter | 14 to 20 px radius, thin borders | Storm centred and large. Pacer at left, heart at right, spectrum and alignment along the bottom. |
| Dawn Journal | Warm paper by day, candlelight during the session. | Fraunces headings, Inter body | Small radius, ruled lines | Storm in a round window at left. Right column has a big pacer, a sentence readout, then the numbers and spectrum. |
| Calm Instrument | A quiet lab bench. Every measure visible. | IBM Plex Sans, IBM Plex Mono for numbers | 6 to 8 px radius, panels | Grid of panels: alignment bars with chance ticks and the cascade chips at left, storm in the middle, heart and pacer at right, full spectrum with background line along the bottom. |
| Night Garden | Soft, rounded and friendly, for families. | Nunito | 22 to 36 px radius, no borders | Storm in a rounded tile, cascade shown as stepping stones, big rounded pacer. Home starts with a picker for each family member. |

Palettes, dark version (light versions to be derived and checked for contrast):

| Token | Still Water | Dawn Journal (session) | Calm Instrument | Night Garden |
|---|---|---|---|---|
| `--bg` | #070B12 | #1C1814 | #0B0F0E | #23213A |
| `--surface` | #0D141E | #241F1A | #121816 | #2E2B4A |
| `--border` | #172131 | #3A322A | #1F2925 | none |
| `--text` | #C9D4E3 | #EFE6D8 | #D7E0DC | #EDE9FF |
| `--dim` | #8D9AAE | #A89C8C | #8FA09A | #B4AED6 |
| `--accent` | #5FB3B3 | #D9A066 | #6FD0B0 | #F2B89A |
| `--gold` (golden ratio) | #D9B26A | #E5C07B | #E2B865 | #F2D27A |
| `--octave` | #A9AAEB | #9DB4D9 | #9FB3FF | #9FD8C8 |

Dawn Journal's light palette is the one in the mockups: `--bg` #F4EFE6, `--surface` #FBF8F2, `--text` #2B2620, `--dim` #6B6257, `--accent` #3F6B5A, `--gold` #8A5F18, `--octave` #4A5A9A.

## Settings the person sees

Under Settings, Appearance:

- **Theme**: Still Water, Dawn Journal, Calm Instrument, Night Garden. Each shown as a small preview card.
- **Light or dark**: Follow device, Light, Dark.
- **Session screen**: Always dark (default), Match my mode, Candlelight (warm dark). The session is often used with eyes closed and in dim rooms, so it stays dark unless the person opts out.
- **Dim during session**: Off, after 30 seconds (default), after 2 minutes. Dims to near black. Sound carries the feedback.
- **Readouts**: Minimal (storm, pacer and one alignment line), Standard (default), Full instrument (every panel, as in Calm Instrument). This is independent of the theme, so someone can have Night Garden colours with full readouts.
- **Show numbers**: On or off. Off shows words such as "high, well above chance" instead of values.
- **Text size**: Device, Larger, Largest.
- **High contrast**: Off or on. Raises `--dim` and borders to at least 7:1.
- **Reduce colour reliance**: adds shape or text to anything told apart by colour.

Settings are stored per profile on the device (CLAUDE.md rule 8), so a child's profile keeps its own theme.

## Kid mode

Kid mode belongs to the profile (the age choice), not to the theme. Every theme has a kid version of the session screen, as in the mockups: Still Water star storm, Dawn Journal sunrise story, Calm Instrument mission control, Night Garden spiral flower. The default child profile uses Night Garden.

In every kid version:

- Big words and short sentences. The plain label stays visible in small text, for example "Golden ratio alignment: high".
- Fewer numbers by default.
- Touch targets at least 48 px.
- A grown-up lock option for settings.

Child tuning of the signal (lower alpha band, more movement tolerance) is a separate engine setting tied to the age choice. It is not a theme concern.

## Rules every theme must keep

1. Golden ratio alignment always appears beside octave alignment and the chance level (rule 3), in every theme and in kid mode.
2. `--gold` and `--octave` are fixed roles in every theme. They must differ in lightness, not hue alone, and both must reach 4.5:1 on `--bg` and `--surface`.
3. Body text reaches 4.5:1 and large text 3:1 in all eight palettes. Add a unit test that computes contrast for every token pair that carries text.
4. Changing theme, mode or text size changes no measurement and adds no motion. No transition animation on switch (rule 1).
5. The hurricane and spectrum read colours from the tokens. The visualizer must not hard-code colours. Brightness and winding still come only from measured values.
6. No flashing in any theme. The photosensitivity warning stays.
7. Fonts are bundled with the PWA so themes work offline.

## Implementation notes

- The app already defines tokens in `app/src/index.css` with a `[data-theme='light']` override. Extend this to `data-theme="still-water|dawn-journal|calm-instrument|night-garden"` plus `data-mode="dark|light"` and `data-session="dark|match|candle"` on the root.
- Keep the existing token names (`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--border`, `--text`, `--dim`, `--faint`, `--accent`, `--accent-ink`, `--gold`, `--octave`, `--ok`, `--warn`, `--bad`, `--radius`, `--tap`) and add `--font-body`, `--font-display`, `--font-num`, `--radius-lg`.
- Layout differences between themes (for example Calm Instrument's panel grid) come from the Readouts setting and a small number of layout variants on the session screen, not from four separate screen implementations.
- Settings live in the existing settings store and are exported with the rest of the profile.

## Out of scope for now

- Custom colour pickers.
- Themes from other people or downloads.
