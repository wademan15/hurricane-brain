# Visualizer (`app/src/viz`)

The hurricane and the live spectrum. Everything drawn here comes from engine frames
(`app/src/engine/frames.ts`) and nothing else. Nothing moves unless a measurement moved.

## Files

| File | What it is |
| --- | --- |
| `bindings.ts` | The binding table as code. `computeVisualState(prev, frames, now)` (pure) and `toUniforms(state)` |
| `frameStore.ts` | `FrameSource` interface, and the snapshot of latest frames with arrival times |
| `geometry.ts` | Display mappings and storm geometry, shared by the shader and the hit test |
| `params.ts` | Every tunable number: declared smoothing, mappings, geometry, quality presets |
| `hurricane.ts` | WebGL2 renderer (falls back to WebGL1), one fragment shader, draws only when a uniform changed |
| `noise.ts` | Static cloud texture from a fixed seed |
| `readout.ts` | Tap-to-inspect hit test and number formatting |
| `HurricaneView.tsx` | React component: subscription, resize, context loss, visibility pause, readouts |
| `SpectrumView.tsx` | Canvas 2D spectrum for one site |
| `test/` | Unit tests, test-only fixtures, Playwright harness and screenshots. Not shipped |

## Public API

```tsx
import { HurricaneView, SpectrumView, type FrameSource } from './viz';

const source: FrameSource = { subscribe(listener) { /* call listener(frame) for each engine frame */ return unsubscribe; } };

<HurricaneView source={source} quality="medium" onReadout={(r) => {}} />
<SpectrumView source={source} site="temporal" />
```

`HurricaneViewProps`: `source` (required), `quality?: 'low' | 'medium' | 'high'` (default `medium`),
`className?`, `style?`, `onReadout?: (r: Readout | null) => void`.
`SpectrumViewProps`: `source`, `site` (channel name or composite), `className?`, `style?`.

The views fill their parent; give the parent a height. There is no demo or simulated mode.

## Binding table as implemented (spec 9.1)

Each visual property reads exactly one frame field. "Gate" is when the element is allowed to exist.

| What you see | Field read | Display mapping (design) | Null / gate |
| --- | --- | --- | --- |
| Rotation speed | `slow.tracks[id=dominant].freq` | phase advances at 0.008 rev/s per Hz (10 Hz -> one turn in 12.5 s) | `dominant` null, track not confirmed, or freq null: rotation **stops at once**. No coasting, no spin-down |
| Number of spiral arms | `slow.cascades.phi.tracks.length` | one arm per member, evenly spaced | needs at least 2 confirmed members and a measured `excess_a`; otherwise no spiral |
| How tightly the arms wind | `slow.cascades.phi.excess_a` | pitch angle 72 deg (excess 0, loose) to 13 deg (excess 1, tight) | as above |
| Ring structure | `slow.cascades.octave.excess_a` | strength of three thin warm rings at radii 0.24, 0.48, 0.96 | null: no ring |
| Brightness of each arm | `slow.tracks[id=member i].height_db` | linear, full at 12 dB | null: that arm is dark |
| Clarity of the eye | `slow.cascades.phi.held_s` | 1 - exp(-held_s / 20 s) | only while the spiral forms |
| Left / right symmetry | `slow.hemispheres[track=dominant].match` | left and right halves offset by (1 - match) x 0.7 rad | null: halves drawn aligned, readout says "not measured" |
| Pulse through the eye wall | each new `heart.beats[]` entry | 0.6 s soft rise and fall of the eye wall | no beat, no pulse. Beats closer than 0.34 s merge (max 3 per second) |
| Slow swell | `heart.breath_phase` | picture scale 1 + 0.03 cos(phase) | null: swell fades out over the ramp, phase freezes |
| Unorganized bands of cloud | `slow.tracks[id].height_db` of confirmed tracks that are not arms | patchy rings at evenly spaced radius slots, in track order; brightness linear, full at 12 dB | confirmed tracks but no cascade: this is all you see ("honest minimum") |
| Scattered cloud / calm water + reason | no confirmed tracks, or frames stale | dark still water, text names the reason | reason from channel quality, then spectra, then "no confirmed peak"; stale or never received: "No data" |

`excess_a` is chance A, per the spec's recommendation for open decision D1. If the owner picks chance B,
change the two field reads in `bindings.ts` (`phi.excess_a`, `octave.excess_a`) and nothing else.

### Measured versus design choice

Measured: whether a spiral forms at all, how many arms, how tightly wound, how bright each arm is,
whether the ring appears and how strongly, how clear the eye is, the left/right mismatch, the rotation
rate, each heartbeat, and the breathing phase.

Design choices (and the UI says so in every readout): the **spiral form itself** (a logarithmic spiral
theta = a0 + b ln r), the hurricane metaphor, colours, the mapping constants in `params.ts`, ring radii
(doubling, as a visual pun on the octave), band radius slots, and the static cloud texture.

## Time rules

- **Declared smoothing** (`VIZ_SMOOTHING`, spec rule 2.8): one ramp time `RAMP_S = 0.5 s`. When a field
  changes, the drawn value moves in a straight line from where it was to the new measured value and stops
  exactly on it. It never overshoots and never runs ahead of the latest frame: interpolation, not
  extrapolation. The settings screen and session recorder should read `VIZ_SMOOTHING`.
- **Stale**: slow frames older than 1.0 s (heart: 2.5 s) count as null. The storm dissolves over the
  ramp to calm water and the text says "No data".
- **No idle motion**: the shader has no time input. The texture is static and fixed to the storm's
  rotating frame. The renderer skips drawing when the uniforms are unchanged, so a still measurement is
  a pixel-identical picture and costs no GPU time.
- **Determinism**: same frames and same clock give the same uniforms (unit-tested). The noise texture
  comes from a fixed seed.

## Photosensitivity

- Rotation constant chosen so that, at the worst case of 8 arms on a 45 Hz track, an arm passes any
  point at most 2.9 times a second.
- Large-area changes are limited by the 0.5 s ramp. If a signal toggled between valid and null at the
  4 Hz frame rate, the storm's brightness would swing by about 14% of its own level, roughly 5% of
  screen maximum, below the 10% flash threshold.
- Heartbeat pulses are soft (no hard edge in time), confined to the eye wall, and never more than 3 a
  second.
- Trilinear filtering on the texture so rotating detail does not shimmer.

## Performance

Measured by `test/playwright-check.mjs` in this container, which has no GPU: Chromium falls back to
SwiftShader, a CPU renderer on 4 cores. Absolute times there are meaningless for real hardware, so the
script also times the cheapest possible full-screen pass (one texture read per pixel) on the same
renderer.

| Measurement (SwiftShader, CPU) | Result |
| --- | --- |
| Hurricane, 1920x1080, storm with 4 arms + 2 bands + ring + eye, GPU waited for | 104 to 237 ms mean across runs |
| Hurricane, 1280x720 | 48 to 88 ms mean |
| Trivial one-texture-read pass, 1920x1080 | 30 to 61 ms mean |
| **Hurricane relative to the trivial pass** | **3.4x to 3.9x** |

Absolute times swing with machine load (other jobs shared the CPU); the ratio is the stable number.

On real GPUs a trivial 1080p pass costs a fraction of a millisecond, so about 4x that is a few milliseconds
on integrated graphics against a 16.7 ms budget. **That is an estimate, not a measurement on real
hardware.** It still needs checking on an Intel UHD-class laptop and a mid-range Android phone.

Cost controls: one full-screen triangle, no render targets, at most 4 texture reads per pixel, arm and
band loops break at the measured count, everything outside the storm disc is skipped, and nothing is
drawn when nothing changed. Quality presets cap the backing store: `low` 0.6x CSS pixels, `medium`
device pixel ratio capped at 1 and at most 1920x1080 pixels (default), `high` ratio capped at 2 and at
most 2560x1440 pixels.

## Tests

- `npx vitest run src/viz`: binding table unit tests. Each parameter equals its bound field. Null in
  gives calm out. Nothing changes when frames do not change. Stale frames dissolve. Rotation stops at
  once on null. Interpolation is monotonic and never passes the latest value. Determinism. The golden
  ratio cascade gives arms and the octave cascade a ring. Hit test.
- `node src/viz/test/playwright-check.mjs`: renders the real shader in headless Chromium and checks
  (a) all-null frames give calm water, pixel-identical 1 s apart; (b) a static frame rotates when the
  dominant frequency is measured and is pixel-identical when it is null; (c) a 3-step golden ratio
  cascade and (d) an octave cascade look different. It also checks the readouts, WebGL context loss and
  restore, and measures frame cost. Screenshots go to `test/out/`.
