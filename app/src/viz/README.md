# Visualizer (`app/src/viz`)

The hurricane and the live spectrum. Everything drawn here comes from engine frames
(`app/src/engine/frames.ts`) and nothing else. Nothing moves unless a measurement moved.

## Files

| File | What it is |
| --- | --- |
| `bindings.ts` | The binding table as code. `computeVisualState(prev, frames, now, options)` (pure) and `toUniforms(state)` |
| `frameStore.ts` | `FrameSource` interface, and the snapshot of latest frames with arrival times |
| `geometry.ts` | Display mappings, rotation cap, flicker gain and storm geometry, shared by the shader and the hit test |
| `params.ts` | Every tunable number: declared smoothing, mappings, photosensitivity limits, reduced motion, geometry, quality, theme |
| `theme.ts` | Reads the storm colours from CSS custom properties |
| `hurricane.ts` | WebGL2 renderer (falls back to WebGL1), one fragment shader, draws only when a uniform changed |
| `noise.ts` | Static cloud texture from a fixed seed |
| `readout.ts` | Tap-to-inspect hit test, chance comparison in plain words, number formatting |
| `HurricaneView.tsx` | React component: subscription, resize, context loss, visibility pause, reduced motion, readouts |
| `SpectrumView.tsx` | Canvas 2D spectrum for one site |
| `viz.css` | Every colour, font and size as a CSS custom property (see "Theme tokens") |
| `test/` | Unit tests, test-only fixtures, Playwright harness and screenshots. Not shipped |

## Public API

```tsx
import { HurricaneView, SpectrumView, type FrameSource } from './viz';

const source: FrameSource = { subscribe(listener) { /* call listener(frame) for each engine frame */ return unsubscribe; } };

<HurricaneView source={source} quality="medium" chance="a" motion="auto" onReadout={(r) => {}} />
<SpectrumView source={source} site="temporal" />
```

`HurricaneViewProps`:
- `source` (required).
- `quality?: 'low' | 'medium' | 'high'` (default `medium`): render resolution only.
- `chance?: 'a' | 'b'` (default `a`): which chance level's excess drives the winding, the rings and the combined state. The view reads `excess_a` or `excess_b` itself, so frames need no rewriting. The readout always shows both.
- `motion?: 'auto' | 'full' | 'reduced'` (default `auto`, which follows the system's `prefers-reduced-motion` and updates live).
- `announce?: boolean` (default `true`): polite live-region announcement of state changes. The picture's text alternative stays either way.
- `announceDelayS?: number` (default 2): a new state must hold this long before it is announced.
- `partsVisible?: 'focus' | 'always' | 'never'` (default `focus`): the keyboard list of storm parts is shown while it has focus, always, or never (screen readers can still reach it).
- `showFieldNames?: boolean` (default `false`): engine field paths in the readout. The readout has its own "Show technical names" toggle.
- `readoutClassName?: string`: an extra class on the readout region, for the app shell to position it.
- `className?`, `style?`, `onReadout?: (r: Readout | null) => void`.

`SpectrumViewProps`: `source`, `site` (channel name or composite), `className?`, `style?`,
`summary?: 'hidden' | 'visible'` (default `hidden`, which keeps the peak table for screen readers only).

The views fill their parent; give the parent a height. There is no demo or simulated mode.

## Binding table as implemented (spec 9.1)

Each visual property reads one frame field. The combined state's strength is the one deliberate
exception: it reads the smaller of the two excess values, as the owner specified. `excess_X` below
means `excess_a` or `excess_b`, as chosen by the `chance` prop. "Gate" is when the element may exist.

| What you see | Field read | Display mapping (design) | Null / gate |
| --- | --- | --- | --- |
| Rotation speed | `slow.tracks[id=dominant].freq` | 0.008 rev/s per Hz (10 Hz -> one turn in 12.5 s), capped at 0.36 rev/s (= 45 Hz, never binds on a measured EEG rhythm). Reduced motion: 0.0015 rev/s per Hz, capped at 0.03 rev/s | `dominant` null, track not confirmed, or freq null: rotation **stops at once**. No coasting, no spin-down |
| Number of spiral arms | `slow.cascades.phi.tracks.length` | one arm per member, evenly spaced | needs at least 2 confirmed members and a measured `excess_X`; otherwise no spiral |
| How tightly the arms wind | `slow.cascades.phi.excess_X` | pitch angle 72 deg (excess 0, loose) to 13 deg (excess 1, tight) | as above |
| Ring structure | `slow.cascades.octave.excess_X` | strength of three thin warm rings at radii 0.24, 0.48, 0.96 | null: no ring |
| **Combined state**: arms and rings interlock | `slow.states.both.active` | on: bright beads where arm centre lines cross the rings, rings shift from amber toward warm white | off or null: no interlock (arms and rings, if present, just overlay) |
| Strength of the combined look | `min(slow.cascades.phi.excess_X, slow.cascades.octave.excess_X)` | brightness of the beads and the shared eye wall | only while `both.active`; null if either excess is null |
| Shared luminous eye wall | `slow.states.both.for_s` | 1 - exp(-for_s / 20 s): a broad warm eye wall and a soft glow in the eye | only while `both.active` |
| Brightness of each arm | `slow.tracks[id=member i].height_db` | linear, full at 12 dB | null: that arm is dark |
| Clarity of the eye | `slow.cascades.phi.held_s` | 1 - exp(-held_s / 20 s) | only while the spiral forms |
| Left / right match | `slow.hemispheres[track=dominant].match` | left and right halves offset by (1 - match) x 0.7 rad. Labelled "Left and right match (frequency and balance; locking is inflated by the shared reference)" | null: halves drawn aligned, readout says "not measured" |
| Pulse through the eye wall | each new `heart.beats[]` entry | 0.6 s soft rise and fall (reduced motion: 1.0 s, 35% strength) | no beat, no pulse. Beats closer than 0.34 s merge (max 3 per second) |
| Slow swell | `heart.breath_phase` | picture scale 1 + 0.03 cos(phase) (reduced motion: half) | null: swell fades out over the ramp, phase freezes |
| Unorganized bands of cloud | `slow.tracks[id].height_db` of confirmed tracks that are not arms | patchy rings at evenly spaced radius slots, in track order; brightness linear, full at 12 dB | confirmed tracks but no cascade: this is all you see ("honest minimum") |
| Scattered cloud / calm water + reason | no confirmed tracks, or frames stale | dark still water, text names the reason | reason from channel quality, then spectra, then "no confirmed peak"; stale or never received: "No data" |

The four looks, side by side (screenshots in `test/out/`):

| State | Look |
| --- | --- |
| Golden ratio only | silver log-spiral arms around a dark eye (`c-phi-3-steps.png`) |
| Octave only | thin amber rings over patchy cloud, no arms (`d-octave.png`) |
| Both cascades, combined state off | arms and amber rings overlaid, dark eye (`e-both-cascades-no-combined-state.png`) |
| Combined state on | arms and rings interlock: warm-white beads where they cross, rings turn warm white, one broad luminous shared eye wall with a soft glow in the eye (`e-combined-state-1.png`) |

With `chance: 'b'`, chance B needs 120 s of history (spec 8.5). Until then `excess_b` is null, so no
spiral and no ring form, and the readout says chance B is still warming up. That is the honest
consequence of the choice, not a fault.

### Measured versus design choice

Measured: whether a spiral forms at all, how many arms, how tightly wound, how bright each arm is,
whether the ring appears and how strongly, whether golden ratio and octave occur together and for
how long, how clear the eye is, the left/right mismatch, the rotation rate, each heartbeat, and the
breathing phase.

Design choices (every readout says so): the **spiral form itself** (a logarithmic spiral
theta = a0 + b ln r), the hurricane metaphor, the bead-and-shared-wall look of the combined state,
colours, the mapping constants in `params.ts`, ring radii (doubling, as a visual pun on the octave),
band radius slots, and the static cloud texture.

## Accessibility

The picture is never needed to understand the state.

- **Text alternative.** The picture is a `role="img"` whose name is one sentence built from structure
  only, for example "Hurricane: golden ratio chain of 4 peaks, holding; octave chain of 3 peaks,
  holding; both at once; 2 rhythms outside the golden ratio chain." Counts and states only, no
  fast-changing numbers, so the sentence changes only when the measured state changes.
- **Live region.** The same sentence goes to a polite, atomic live region once a new state has held
  for `announceDelayS` (2 s). `announce={false}` turns it off.
- **Keyboard.** A list of buttons, "Parts of the storm", covers every part present:
  - the eye, the eye wall or the shared eye wall;
  - the bead crossings, each arm, the rings and each cloud band;
  - the whole storm, and the swell.

  Each button is named with its bound measurement (for example "Spiral arm 2, track 2: 7.00 ± 0.40 dB above background") and opens the same readout as tapping. The list appears while it has focus.
- **Readout.** The readout is a `section` labelled by its heading, outside the `role="img"`. Focus moves to the heading on open, and returns to where it was on close. Escape closes it. Table headers are real `th` elements (the empty corner has a hidden "Measure" label). Field paths are hidden behind "Show technical names".
- **Placement.** `--hb-readout-top`, `-right`, `-bottom`, `-left`, `-max-height` and `-z` let the app shell move the readout below its own top bar (fixes the "Eyes closed" overlap). `readoutClassName` is also available.
- **Without colour.** The three states differ in shape as well as colour:
  - golden ratio: spiral arms;
  - octave: rings;
  - combined: bright beads where arms cross rings, and a luminous filled eye wall instead of a dark eye.

  Checked with greyscale screenshots (`test/out/k-greyscale-*.png`).
- **Contrast.** `--hb-ink-dim` was raised to `#93a0b5`: 7.7:1 on `--hb-bg`, 7.2:1 on the readout panel. Other ratios: spectrum labels in `--hb-ink-dim` 7.7:1, gold 10.9:1, octave 10.3:1. The control border `--hb-control-border` is `#5a6a88`.
- **Spectrum.** The canvas is a `role="img"` with a one-line label, described by a table of the confirmed peaks. The table gives frequency ± error, height above background, band, site, and where golden ratio and octave partners would sit. It is hidden visually by default (`summary="visible"` shows it).
- axe-core reports no violations on the hurricane (readout closed and open) or the spectrum. Run the Playwright check with `AXE_CORE=/path/to/axe.min.js` to include it.

## Readout wording (fake-test finding)

The readout leads with the chance comparison in plain words, then the alignment value:

> Octave: as often as this by chance: 42 in 100, by random peaks (chance A). Alignment 0.969 ± 0.010, typical by chance 0.31.

- The p value (`chance.a.p` / `chance.b.p`) is shown as "N in 100", or "fewer than 1 in 100". It is
  never described as the probability that the alignment is real.
- Excess values are labelled "beyond chance (0 unless fewer than 5 in 100 chance draws do as well,
  1 = exact; not a probability)" wherever they appear. This matches the engine's revised definition
  (spec 8.5): excess is 0 unless the percentile is 5% or less, so an unremarkable alignment draws no
  ring and winds no arm. `excess_b` is null with its reason ("warming up") until chance B can
  support a 5% percentile. The readout shows that reason.
- The side-by-side table: steps, "as often as this by chance" for A and B, closeness, typical score
  by chance A and B, beyond chance A and B, held time, aligned state, combined state.

## Time rules

- **Declared smoothing** (`VIZ_SMOOTHING`, spec rule 2.8): one ramp time `RAMP_S = 0.5 s`. When a field
  changes, the drawn value moves in a straight line from where it was to the new measured value and stops
  exactly on it. It never overshoots and never runs ahead of the latest frame: interpolation, not
  extrapolation.
- **Stale**: slow frames older than 1.0 s (heart: 2.5 s) count as null. The storm dissolves over the
  ramp to calm water and the text says "No data".
- **No idle motion**: the shader has no time input. The texture is static and fixed to the storm's
  rotating frame. The renderer skips drawing when the uniforms are unchanged, so a still measurement is
  a pixel-identical picture (checked for calm water, a still spiral and the combined state).
- **Determinism**: same frames and same clock give the same uniforms (unit-tested). Fixed-seed texture.

## Photosensitivity guarantees

Goal: no luminance feature anywhere on screen rises and falls more than 3 times a second
(`VIZ_PHOTOSAFE.MAX_FLICKER_HZ`), in every state including the combined state.

| Source of change | Guarantee | How | Test |
| --- | --- | --- | --- |
| Bright arms rotating past a point | at most 8 arms x 0.36 rev/s = 2.88 per second, for any frequency | hard cap on rotation (`ROT_MAX_REV_PER_S`) | `photosafe.test.ts`: rate x 8 arms < 3 for 0..500 Hz; arm passes at a fixed point counted at 45 Hz and 120 Hz with 8 arms: 2 to 3 per second |
| Combined-state beads | ride on the arms, so the same cap | geometry | as above |
| Fine cloud texture, streaks and band patches rotating | contrast falls as (3 / pass rate)^2 once features would pass faster than 3 per second, so contrast x rate never exceeds the cap | `flickerGain()`, same formula in the shader. Depends only on the measured rotation rate | `flickerGain(hz) x hz <= 3` for all hz; at 45 Hz the finest texture is softened about 100x (`g-8-arms-45hz.png` shows smooth arms) |
| Heartbeat pulses | at most 3 per second at any heart rate; a new beat never cuts a fading pulse off (the pulse is the larger of the two latest envelopes) | `PULSE_MIN_INTERVAL_S = 0.34`, max of envelopes | 300 bpm for 6 s: at most 3 peaks per second; no downward step above 0.15 |
| Signal toggling between valid and null, or the combined state toggling, at 4 Hz | brightness swings under 30% of full | 0.5 s linear ramp | toggling at 4 Hz for 6 s: arm brightness and combined glow swing under 0.3 |
| Rotation stopping or starting | a single change, not repeated | (toggling is the case above) | |

Also: trilinear texture filtering so rotating detail does not shimmer; pulses are confined to the eye
wall (a small area); everything is a soft gradient with no hard edges in time.

**Reduced motion** (`motion="reduced"`, or `auto` with the system preference): rotation becomes a slow
drift, still proportional to the measured frequency (0.0015 rev/s per Hz, capped at 0.03 rev/s, one
turn in at least 33 s). Pulses last 1.0 s at 35% strength, and the breath swell is halved. Nothing is
invented; it is the same measurements drawn more gently.

## Theme tokens

All colours, fonts and sizes are CSS custom properties, declared in `viz.css` with zero specificity
(`:where(:root)`), so the app restyles by setting them on `:root` or any ancestor. No logic changes.

| Token | Default | Used for |
| --- | --- | --- |
| `--hb-bg` | `#03060c` | view background, spectrum background |
| `--hb-ink` | `#c9d4e3` | text |
| `--hb-ink-dim` | `#93a0b5` | secondary text, axes, calm-water message (7.7:1 on `--hb-bg`) |
| `--hb-panel-bg` | `rgba(10,16,28,0.92)` | readout panel |
| `--hb-line` | `rgba(140,165,200,0.18)` | panel border, table rules |
| `--hb-focus-strong` | `#c9d4e3` | keyboard focus outline |
| `--hb-control-border` | `#5a6a88` | button borders in the readout |
| `--hb-parts-bg` | `rgba(10,16,28,0.94)` | keyboard parts list |
| `--hb-readout-top` / `-right` / `-bottom` / `-left` | gutter / gutter / auto / auto | where the readout sits; move it below the app's top bar |
| `--hb-readout-max-height`, `--hb-readout-z` | fill / 5 | readout height and stacking |
| `--hb-probe` | `rgba(220,230,245,0.7)` | tap marker |
| `--hb-gold` | `#e2b86b` | golden ratio (readout header, spectrum markers) |
| `--hb-octave` | `#6fc7c0` | octave (readout header, spectrum markers) |
| `--hb-font` | system UI stack | all text (also the spectrum canvas) |
| `--hb-font-mono` | monospace stack | field paths in the readout |
| `--hb-font-size` / `-small` / `-tiny` / `-title` / `-message` | 14 / 12 / 11 / 16 / 15 px | text sizes |
| `--hb-gutter` | `16px` | outer spacing |
| `--hb-radius` | `10px` | panel corners |
| `--hb-readout-width` | `440px` | readout panel width (capped to the view) |
| `--hb-touch-target` | `44px` | close button size |
| `--hb-min-height` | `240px` | minimum view height |
| `--hb-spec-psd`, `-fit`, `-flat`, `-peak`, `-grid`, `-band` | see `viz.css` | spectrum lines, peaks, grid, band shading |
| `--hb-storm-water`, `-water-ripple`, `-cloud-dark`, `-cloud-light`, `-octave-ring`, `-eye-wall`, `-pulse`, `-combined` | unset, so `VIZ_THEME` in `params.ts` | storm colours in the shader; hex or `rgb()`; read on mount and resize |

## Performance

Measured by `test/playwright-check.mjs` in this container, which has no GPU: Chromium falls back to
SwiftShader, a CPU renderer on 4 cores shared with other jobs. Absolute times there mean little, so
the script also times the cheapest possible full-screen pass (one texture read per pixel).

| Measurement (SwiftShader, CPU, worst case: 4 arms + 2 bands + rings + eye + combined state) | Result |
| --- | --- |
| Hurricane, 1920x1080, GPU waited for | 221 to 283 ms mean across runs |
| Trivial one-texture-read pass, 1920x1080 | 54 to 56 ms mean |
| **Hurricane relative to the trivial pass** | **3.5x to 7.0x** across runs; the spread is CPU contention from other jobs (it was 3.4x to 3.9x before the combined state and flicker gain) |

On real GPUs a trivial 1080p pass costs a fraction of a millisecond, so about 5x that is a few
milliseconds on integrated graphics against a 16.7 ms budget. **An estimate, not a measurement on real
hardware.** It still needs checking on an Intel UHD-class laptop and a mid-range Android phone.

Cost controls: one full-screen triangle, at most 5 texture reads per pixel, arm and band loops break
at the measured count, the combined, ring, arm and band blocks are skipped when absent, everything
outside the storm disc is skipped, and nothing is drawn when nothing changed. Quality presets cap the
backing store: `low` 0.6x CSS pixels, `medium` pixel ratio capped at 1 and at most 1920x1080
(default), `high` ratio capped at 2 and at most 2560x1440.

## Tests

- `npx vitest run src/viz` (51 tests):
  - `test/bindings.test.ts`: each parameter equals its bound field; null in gives calm out; nothing changes when frames do not change; stale frames dissolve; rotation stops at once on null; interpolation is monotonic and never passes the latest value; determinism; golden ratio gives arms and octave gives a ring; hit test.
  - `test/photosafe.test.ts`: the rate caps above; reduced motion; combined-state bindings; chance-driver reads `excess_b` natively; readout wording ("42 in 100" before the alignment number, excess never called a probability).
  - `test/a11y.test.ts`: the state sentence for every state, and its stability when only numbers change; keyboard parts and their names; every part opens its readout; left and right match wording; revised excess (p 0.30 gives excess 0, so no ring); `excess_b` null with a reason.
- `node src/viz/test/playwright-check.mjs`: renders the real shader in headless Chromium and checks:
  - (a) all-null frames give calm water, pixel-identical 1 s apart;
  - (b) a static frame rotates when the dominant frequency is measured and is pixel-identical when it is null;
  - (c) a 3-step golden ratio cascade and (d) an octave cascade look different;
  - (e) the combined state is pixel-stable and looks different from spiral-only, rings-only and the plain overlay;
  - (f) reduced motion rotates less;
  - (g) accessibility: the readout is outside the img and focus moves into it and back; Escape closes it; the keyboard parts open readouts; the text alternative matches the live region; the placement hook works; greyscale distinguishability; the spectrum table; axe (optional);
  - readouts, WebGL context loss and restore, and frame cost.

  Screenshots go to `test/out/`.
