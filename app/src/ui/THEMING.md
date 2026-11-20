# Theming the app

A new look is a change to `src/ui/theme.css` (and, for layout, to the layout components below).
Nothing in `session/`, `state/`, `storage/`, `measured.ts` or `copy.ts` names a colour, a size or a
font, so behaviour does not change when the look does.

## How the pieces are split

- **Tokens**: `src/ui/theme.css`. Every colour, radius, spacing step, size, font, shadow and
  transition is a CSS custom property on `:root`. A light theme is the `:root[data-theme='light']`
  block. Reduced motion is `:root[data-motion='reduced']`, set by `App.tsx` from the person's setting.
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
| Accent and meaning | `--accent --accent-ink --gold` (golden ratio) `--octave --ok --warn --bad --scrim` |
| Live session screen | `--live-bg --live-text --live-dim --live-subtle --live-dock-bg --live-border --live-control-border --live-control-text --live-control-on-bg --live-control-on-text --live-control-on-border --live-chip-bg --live-rate-bg --live-rate-text --live-shade --live-shade-clear --eyes-closed-text` |
| Diagrams | `--diagram-unknown --diagram-ok --diagram-bad` |
| Shape | `--radius --radius-sm --radius-md --radius-lg --radius-xl --radius-pill --border-w` |
| Spacing | `--space-1 .. --space-6` (4, 8, 12, 16, 20, 32 px) `--gutter` |
| Size | `--tap --tap-small --tap-big` (touch targets) `--nav-h --sidebar-w --content-w` |
| Type | `--font --font-size --line` |
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
