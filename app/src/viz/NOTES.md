# Visualizer notes and handovers

Things the visualizer needs from other roles. The visualizer does not edit these areas.

## For the signal architect

1. **Parameter table (spec section 14).** CLAUDE.md rule 9 says provisional numbers live there. The
   visualizer's constants are all in `app/src/viz/params.ts`. Please add these rows, or say they are
   presentation constants that can stay in `params.ts`:
   - `VIZ_SMOOTHING.RAMP_S` 0.5 s: the declared smoothing between a measurement and the picture (rule 2.8).
   - `VIZ_SMOOTHING.SLOW_STALE_S` 1.0 s and `HEART_STALE_S` 2.5 s: when the picture treats frames as no data.
   - `VIZ_SMOOTHING.PULSE_S` 0.6 s and `PULSE_MIN_INTERVAL_S` 0.34 s: the heartbeat pulse.
   - `VIZ_MAPPING.*`: rotation rate per Hz and its cap, dB for full brightness, pitch range, eye and
     combined-state hold time constants, symmetry offset, swell amplitude, pulse gain.
   - `VIZ_PHOTOSAFE.*` (3 Hz flicker limit, texture feature sizes) and `VIZ_REDUCED_MOTION.*`.
2. **Open decision D1.** `HurricaneView` now takes `chance: 'a' | 'b'` (default `'a'`) and reads
   `excess_a` or `excess_b` itself for winding, rings and the combined-state strength.
3. **Hemisphere symmetry needs one field.** `hemispheres[]` has one entry per track and the binding
   table says "hemisphere match" without saying which. The visualizer uses the entry for the dominant
   track (`hemispheres[track=dominant].match`). If a summary across tracks is wanted, the engine should
   provide it as a field. The visualizer will not average it privately.
4. **Rotation reads `tracks[].freq` (latest window), not `freq_integrated`.** The table says "frequency of
   the strongest confirmed track". Say so if you meant the integrated frequency.
5. Arms are drawn only for cascade members whose state is `confirmed`. `fading` tracks are not drawn.

## For the app engineer

- **Remove the chance-B swap** in `ui/session/hub.ts` (`swapToChanceB`) for the visualizer: pass
  `chance={settings.chanceDriver}` to `HurricaneView` and hand it the unmodified frames. The readout
  needs the original `excess_a` and `excess_b` to show both. (Audio still reads `excess_a`; ask the
  sonification engineer before dropping the swap for audio too.)
- **Reduced motion**: `HurricaneView` takes `motion: 'auto' | 'full' | 'reduced'` (default `auto`,
  which follows `prefers-reduced-motion`). If the settings screen has its own reduced-motion switch,
  pass `motion={settings.reducedMotion ? 'reduced' : 'auto'}`.
- **Restyling**: every colour, font and size is a CSS custom property (README, "Theme tokens"). Set
  them on `:root` or a wrapper; no code change in viz needed.

- `VIZ_SMOOTHING` should be shown in settings (read-only is fine) and written into the session record (rule 2.8).
- `HurricaneView` and `SpectrumView` take a `FrameSource` (`subscribe(listener) => unsubscribe`). The
  engine worker wrapper should implement it. Both views fill their parent, so give the parent a height.
- The picture is never needed to understand the state (many users have their eyes closed). The
  component's `aria-label` carries the calm message. Training text and sound must carry the state on their own.

## For the skeptic

- The fake test at the visual layer: with confirmed tracks and no cascade the picture is bands only, with
  no spiral and no ring (unit-tested). Whether a spiral ever forms from shuffled or synthetic noise is
  decided by the engine's cascade output, so the end-to-end fake test has to run engine plus bindings
  on recorded noise. `computeVisualState` is pure and can be driven from a recorded frame stream for
  that purpose.

## Not verified

- Frame time on real GPUs. Only SwiftShader (CPU) was available here; see README "Performance".
- WebGL1 fallback path: the shader is GLSL ES 1.00 and runs under WebGL2 here, but a real WebGL1-only
  device was not tested.
- Context loss and restore: exercised in Playwright with WEBGL_lose_context (passes), not on a real device.
- The combined state's `for_s` is assumed to reset to 0 when `both.active` turns false (frames.ts says
  "seconds in the current combined condition"). The visual only reads it while active.
