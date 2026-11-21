# Theming the app

Four themes, each with a dark and a light palette: **Still Water** (default for grown-ups),
**Dawn Journal**, **Calm Instrument** and **Night Garden** (default for a child's profile). A look is
a change to `src/ui/theme.css`, `src/ui/themes.ts` and (for layout) the variant components below.
Nothing in `session/`, `state/`, `storage/`, `measured.ts` or `copy.ts` names a colour, a size or a
font, so behaviour does not change when the look does. Switching theme, mode or text size has no
transition and nothing flashes.

## What is on the root

`App.tsx` sets these on `<html>` from the profile's appearance (`useAppearance`) and the device:
`data-theme`, `data-mode` (dark or light, resolved from Follow device), `data-session`,
`data-contrast="high"`, `data-colour="shape"`, and the font size. The live screen carries
`data-pal` (dark, light or candle, from the Session screen setting), `data-layout`
(centred, window, grid, tile), `data-readouts` and `data-view` (simple for the kid screen).

## Adding a fifth theme

1. `src/storage/types.ts`: add the id to `THEME_IDS`.
2. `src/ui/themes.ts`: add a row to `THEMES` (id, name, one-line feel, layout). Pick an existing
   layout, or add a layout value and the arrangement in `Session.tsx` (the `layout ===` branches).
3. `src/ui/theme.css`: add `:root[data-theme='x']` shape and font tokens (`--radius*`, `--font-body`,
   `--font-display`, `--font-num`, `--head-weight`), then two palette blocks with the selector pair
   `:is(:root, .theme-scope)[data-theme='x'][data-mode='dark'], :root[data-theme='x'] .live[data-pal='dark']`
   (and `light`). Give every token the other palettes give, including `--gold`, `--octave`, `--both`
   and `--state-ink`.
4. `src/ui/fonts.css` and `fonts.ts`: bundle any new font file under `public/fonts/` (woff2, latin
   subset) and list it in both; the service worker precaches `FONT_URLS`.
5. Add the theme to the list in `src/ui/test/contrast.test.ts` (`THEMES`). The test reads the CSS and
   fails if any text-carrying pair misses its ratio (body 4.5:1, gold and octave 4.5:1 on the
   background and surface and 1.4:1 apart, 7:1 for dim text and borders in high contrast).
6. Run `e2e/ui-themes.cjs` and look at the screenshots in `src/ui/test/out/themes/`.

The `.theme-scope` class lets a preview card carry its own `data-theme` and `data-mode` (the theme
picker in Settings > Appearance uses it), so one palette block serves both.

## Readouts, words and the kid screen

- Readouts (minimal, standard, full) and Show numbers are settings, not themes. Minimal is
  `LiveVariants.OneLine`; standard arranges the alignment display by layout (`AlignmentTrio`,
  `AlignmentBars` with `CascadeChips`, `StepStones`); full adds the peaks and heart lines and the
  panel tabs. Golden ratio alignment is beside octave alignment and chance in every one.
- Show numbers off turns measured values into words. The thresholds are in one place,
  `src/ui/words.ts`, and every word keeps its chance comparison.
- The kid screen (`data-view="simple"`) is for the profile (Automatic means on for a child) and is
  drawn in whichever theme is chosen. Touch targets are at least 48 px. Settings can be locked behind
  a grown-up gate (a sum; held in memory only).

## How the pieces are split

- **Tokens**: `src/ui/theme.css`. Every colour, radius, spacing step, size, font, shadow and
  transition is a CSS custom property on `:root`. Palettes are the blocks described above. Reduced motion is `:root[data-motion='reduced']`, set by `App.tsx` from the person's setting.
- **Rules that use the tokens**: `src/index.css`. It contains no literal colours except through
  `var(--...)`. Class names are the interface between layout components and styling.
- **Logic and hooks** (no markup): `state/` (`app.tsx` services and hooks, `stores.ts`, `start.ts`
  starting flow, `fit.ts` fit hold, `router.ts`) and `session/` (the controller, frame hub, key-row
  sampler, cascade logger, recorder, session planning).
- **Layout components** (markup over data, no business logic): `components/` and `screens/`.
- **Wording**: `copy.ts`. Display rules for numbers and nulls: `measured.ts`.

## Tokens

| Group | Tokens |
| --- | --- |
| Surfaces and text | `--bg --surface --surface-2 --surface-3 --border --text --dim --faint` |
| Accent and meaning | `--accent --accent-ink --gold` (golden ratio) `--octave --both --state-ink --ok --warn --bad --scrim` |
| Live session screen | `--live-bg --live-text --live-dim --live-subtle --live-dock-bg --live-border --live-control-border --live-control-text --live-control-on-bg --live-control-on-text --live-control-on-border --live-chip-bg --live-rate-bg --live-rate-text --live-shade --live-shade-clear --eyes-closed-text` |
| Diagrams | `--diagram-unknown --diagram-ok --diagram-bad` |
| Shape | `--radius --radius-sm --radius-md --radius-lg --radius-xl --radius-pill --border-w` |
| Spacing | `--space-1 .. --space-6` (4, 8, 12, 16, 20, 32 px) `--gutter` |
| Size | `--tap --tap-small --tap-big` (touch targets) `--nav-h --sidebar-w --content-w` |
| Type | `--font --font-body --font-display --font-num --font-size --line` |
| Depth | `--shadow-1 --shadow-2` |
| Motion | `--transition` (short responses to a tap; nothing runs on its own) |

The hurricane picture has its own optional colour properties, read by `viz/theme.ts`
(`VIZ_THEME_CSS`): `--hb-storm-water --hb-storm-water-ripple --hb-storm-cloud-dark
--hb-storm-cloud-light --hb-storm-octave-ring --hb-storm-eye-wall --hb-storm-pulse
--hb-storm-combined` (hex or rgb()). Set them in `theme.css` to restyle the picture; they never
change what is bound to what.

Rules a new look must keep: dark by default, touch targets of at least `--tap`, no flashing, no
decorative animation, and the golden ratio, octave and chance cells always shown side by side.

## Component map

| Where | What it is |
| --- | --- |
| `App.tsx` | navigation shell, routes, running-session banner |
| `screens/Home.tsx` | devices, quick start, recommendation, replay, last session |
| `screens/Ready.tsx` | get-ready step before every session (fit coaching, start, skip) |
| `screens/Session.tsx` | live screen: hurricane, readout dock, panels, rating sheet, finished replay, post-session summary and journal |
| `screens/FitCheck.tsx` | fit and signal check (also reachable from Home) |
| `screens/Programs.tsx` | program list and detail |
| `screens/Discover.tsx` | calibration, Discovery plan, estimates, recommendations |
| `screens/Signatures.tsx` | signatures and anchors |
| `screens/History.tsx` | sessions, recordings, detail (cascade event log, journal, charts, export) |
| `screens/Settings.tsx` | sound, smoothing, visuals, measurement, stream out, people, data, about |
| `screens/Profiles.tsx` | the people on this device |
| `screens/Onboarding.tsx` | first run |
| `components/kit.tsx` | Button, Card, Badge, Note, Field, Segmented, Val and Num (measured or not measured), Modal, Toast, Icon, PageHeader |
| `components/LiveReadout.tsx` | alignment trio (golden, octave, chance), signal, peaks, heart lines |
| `components/Cascades.tsx` | golden ratio cascade, octave cascade, both at once, event log, golden ratio info |
| `components/FitCoach.tsx` | head diagram, per-sensor contact and fixes, small-head guidance |
| `components/Journal.tsx` | journal form and view |
| `components/ProfileForm.tsx` | name, age group, safety questions |
| `components/LiveDetails.tsx`, `BlockTable.tsx`, `KeyChart.tsx`, `IntervalBar.tsx`, `StartButton.tsx` | tables, charts, start button |

## Hooks a layout can rely on

`useServices`, `useController` (session, devices, replay, stream status), `useSettings`, `useProfile`,
`useProfiles`, `useProfileInfo`, `useAsync`, `useLive` (latest frames with staleness), `useFitHold`,
`useStarter`, `useRoute`. Layout components call these and render; they never compute a measurement.

## Round 3 additions

- Dark values are declared on `:root, .live`, and the light values on `:root[data-theme='light']`, so the live
  screen stays dark whatever the theme. `App.tsx` sets `data-theme` from Settings (dark, light, follow device)
  and the root font size from the text-size setting (a percentage of the browser's own size).
- New tokens: `--control-border` (3:1 edges for buttons, inputs and tabs), `--both` (both at once), `--state-ink`
  (text on a filled state badge). `--faint` is 5.6:1 on `--surface-2` so the not-measured text passes AA.
- `--tap`, `--tap-small` and `--tap-big` are `max(Npx, Nrem)`: never under 44 px (48 and 64 for the others).
- State badges (`.state-badge.phi | .oct | .both`, `.on` when holding) take their colour from `--c`, set per kind.
