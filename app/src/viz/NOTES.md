# Visualizer notes and handovers

Things the visualizer needs from other roles. The visualizer does not edit these areas.

## For the signal architect

1. **Parameter table (spec section 14).** CLAUDE.md rule 9 says provisional numbers live there. The
   visualizer's constants are all in `app/src/viz/params.ts`. Please add these rows, or say they are
   presentation constants that can stay in `params.ts`:
   - `VIZ_SMOOTHING.RAMP_S` 0.5 s: the declared smoothing between a measurement and the picture (rule 2.8).
   - `VIZ_SMOOTHING.SLOW_STALE_S` 1.0 s and `HEART_STALE_S` 2.5 s: when the picture treats frames as no data.
   - `VIZ_SMOOTHING.PULSE_S` 0.6 s and `PULSE_MIN_INTERVAL_S` 0.34 s: the heartbeat pulse.
   - `VIZ_MAPPING.*`: rotation rate per Hz, dB for full brightness, pitch range, eye hold time constant,
     symmetry offset, swell amplitude, pulse gain.
2. **Open decision D1.** The winding reads `cascades.phi.excess_a` (chance A) and the ring reads
   `cascades.octave.excess_a`, as the spec recommends. If D1 goes the other way, only those two reads change.
3. **Hemisphere symmetry needs one field.** `hemispheres[]` has one entry per track and the binding
   table says "hemisphere match" without saying which. The visualizer uses the entry for the dominant
   track (`hemispheres[track=dominant].match`). If a summary across tracks is wanted, the engine should
   provide it as a field. The visualizer will not average it privately.
4. **Rotation reads `tracks[].freq` (latest window), not `freq_integrated`.** The table says "frequency of
   the strongest confirmed track". Say so if you meant the integrated frequency.
5. Arms are drawn only for cascade members whose state is `confirmed`. `fading` tracks are not drawn.

## For the app engineer

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
- Context loss and restore: handled in code, not exercised in the automated test.
