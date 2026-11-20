# Training layer: requests and decisions

Written by the neurofeedback protocol designer. Requests are for the owners named; nothing here
has been changed outside `app/src/training/`.

## Requests to the signal architect (frames.ts / engine)

1. **Upper and lower alpha sub-bands** (IAF to IAF+2 Hz, IAF-2 to IAF) as band summaries, so
   design P4 "Clear Mind" (upper-alpha, Grade B) can ship. Not shipped until then.
2. **Motion level** as a measured value (accelerometer and gyroscope energy over the slow window)
   and **head pitch**, so stillness can reward a still head directly and posture (upright,
   reclined, lying) can be verified rather than self-reported (design 4).
3. **Blink rate** per slow frame, to verify eyes open or closed per block (design 4).
4. **Sleep-onset markers** for the Descent program on Muse S: spindle detection and a
   sleep-likelihood or Hori-stage estimate. Today Descent uses theta minus alpha above background.
5. **Signature and anchor fields** (spec 12.1 says the engine reports these): currently computed
   in `signatures.ts` from frame fields, with thresholds from the person's contrast windows.
   If the engine takes this over, the training layer will read it instead; the TypeScript version
   can stay as the reference.
6. **Baselines and block statistics** (spec 12 assigns them to the engine): currently computed in
   `stats.ts` from frames, with autocorrelation handled by an effective sample size with a floor of
   one slow window (8 s), cross-checked by a block bootstrap. Happy to hand over or keep.
7. **Marker types**: `frames.ts` `Marker.type` lacks `rating`, `feedback_on/off`, `threshold`,
   `pacer`, `probe`, `pairing_result`. These are currently written as `report` or `note` with a
   `label` and `data`. Suggest adding explicit types in schema version 2.
8. **Heart-rate oscillation amplitude per breath** (max minus min heart rate per breath cycle),
   which the standard resonance-rate protocol uses; we use `lf_power` with `resonance_strength`
   as the tie-break.
9. **Parameter table**: fold `params.ts` (training-layer provisional numbers) into spec section 14.

## Requests to the sonification engineer (audio)

- Bindings each program declares are in `program.bindings.sound`. The reward layer reads
  `RunnerOutput.reward.level` (already smoothed with the declared time constant); do not add
  a second undeclared smoothing.
- `play_anchor` / `play_control` events: soft onset (at least 300 ms), 4-8 s, the anchor's
  `synth` params are opaque to training and owned by audio. The anchor must never be used for
  anything else (notifications, UI).
- `tether`: brighten slightly and play the spoken text quietly. `check_fit`: a soft voice, no alarm.
- Descent uses `fade_on_target`: the soundscape fades as reward rises (inverse of other programs).

## Requests to the app engineer

- Feed every frame to `runner.push` in time order; forward `runner.markers()` to `EngineApi.pushMarker`.
- After calibration, call `EngineApi.setIaf(profile.calibrations.at(-1).iafHz)`.
- Show program `evidence.summary`, `experimental` badge and `safetyNotes` before first use; apply
  `unlock.excludeIf` against the safety answers (`availablePrograms`).
- Golden ratio displays: every program touching `phi` lists the octave and chance fields in
  `bindings.display`; show them side by side (rule 3).

## Decisions and conflicts with the research design

1. **Entrainment removed.** The design's strategies `entrain_binaural`, `entrain_iso` and the
   "binaural" sound environment in the variables sampler are excluded (rule 6). The validator rejects them.
2. **Threshold adaptation between blocks only.** The design suggests a within-session threshold
   moving with a 60 s time constant over the last 2-3 minutes; the brief and the protocol rules say
   adapt between blocks, not within the moment being rewarded. Inside the success band the step is
   halved; outside it the full gain applies; steps are capped at 1 baseline SD.
3. **Signatures follow the spec, not the design's distance-to-average.** The design scores a state
   by distance to the average feature pattern; the spec requires a small set of reliably separating
   fields validated on held-out sessions against shuffled labels over 3+ days. Implemented per spec.
4. **Anchor eligibility uses both rules:** reliable signature (spec) and reached in 4 of the last 6
   sessions (design).
5. **Statistics model.** The design proposes a hierarchical Bayesian model with a population layer.
   Implemented the design's "lightweight first build": per-user shrinkage toward zero with
   DerSimonian-Laird heterogeneity. A population model needs consented off-device pooling (rule 8),
   so it is deferred. Questionnaire answers set only the exploration prior, never the labels.
6. **"Strong" also needs a replicating ranking** (design 9.2): odd vs even sessions Spearman >= 0.5.
7. **Theta/alpha ratio** is implemented as the difference of above-background dB values (a log ratio
   of periodic power), via `diff(...)`, rather than a ratio of raw band powers, which would move with
   the 1/f background.
8. **Bad signal**: the design says the reward layer "holds steady, then fades". Rule 1 forbids held
   values, so the level decays with the declared time constant from the moment reward stops.
9. **Golden ratio**: the design describes it as an alpha:theta peak ratio near phi; the program uses
   the spec's cascade fields with chance (excess over chance A by default, chance B selectable,
   pending owner decision D1), and slow smoothing (8 s default, up to 30 s).
10. **Delta**: the design's Descent mentions delta; delta is display-only, marked low confidence.
11. **Hemisphere balance** is graded D (exploratory) and behind the labs flag; neither research doc
    supports a training benefit, and shared-reference inflation is stated in the copy.

## Verified

`npx vitest run src/training`: 46 tests pass. `npx tsc -b` passes with no errors. `oxlint src/training` is clean. The training layer also compiles under
`strict: true` (the app's tsconfig does not currently set `strict`; suggest enabling it).
