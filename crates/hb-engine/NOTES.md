# hb-engine notes

Decisions taken where the spec was open, and changes requested outside this crate.
Every provisional number is a `Params` field (spec 14 names first, then implementation
parameters), overridable by name and echoed back in `SlowFrame.params`.

## Requested changes elsewhere

`app/src/engine/frames.ts` (the engine already has the data; adding these needs a frames.ts change first):

- A low-confidence flag for the delta band. Below 2 Hz the multitaper ±W smoothing and the high-pass shape the background, so delta values are less reliable.
- A fast-track confidence field (lock state is binary at the moment).
- The engine version and a param-set id (hash) in SlowFrame for provenance. `Engine::version()` exists.
- Track merge and split events. `Engine::diagnostics()` already returns `TrackEvent`s.
- Background-fit error per site (the OLS prediction log-SD), so the UI can show how far the flat spectrum can be trusted.

Not implemented here:

- Heart frames (owned by hb-heart).
- Spec 12 block statistics, per-field baselines beyond the ones the ratios use, signatures and anchors. These were outside the listed items.

## Decisions

### Spectrum and peaks

- **Persistence:** a peak counts as persistent when it passes in the current window and in at least one earlier window that does not overlap (u − 32k updates) and joins by the join rule. Overlapping windows are not independent, so they do not count.
- **α split:** `alpha_peak` is split evenly across sites (Bonferroni across sites). Within a site the Sidak correction uses M = searched Hz × T × `peak_tries_per_rayleigh`, which is one try per Rayleigh bin. Simulation confirmed this:
  - height test alone on 1/f noise: 0.60% (8 s) and 1.12% (4 s, within Monte Carlo noise of 1%);
  - full window test: 0.35%.
- **Background model:** the fit models the multitaper's ±W box smoothing and the high-pass power response, but not the notch, because a notch term makes flat blow up at the mains line. `bg_offset` and `bg_exponent` in frames describe the best single power law. The fit is robust over 3 iterations with bins more than `bg_drop_sigma` above the fit dropped. Its level is set so that the median of flat equals the chi²₂K/2K median. If the fit ratio exceeds `bg_fit_max_ratio`, the site is null with `bad_fit`. **Changed in review:** the spectrum is flattened by a curve (`bg_curve_terms`), not by that power law, and a lack-of-fit test can also give `bad_fit`. See "Milestone review" below.
- **Threshold widening for fit uncertainty:** the per-bin threshold is multiplied by exp(½λσ²), where σ is the background prediction log-SD (OLS SE inflated for correlated bins) and λ = K·h − (K−1). A plain z·σ widening was far too conservative (0.1%).
- **Centroid and width:** both come from the excess power S − bg over the peak region, not from flattened power. The flattened weighting biased the centroid by about +1% at 5 Hz; with excess power the bias is −0.2% to +0.1%. Frequency SE comes from a jackknife over tapers, floored at `freq_se_floor`.
- **Minimum width:** `peak_width_min_factor` × 2W = 0.8 × 1 Hz for the 8 s window. Narrower peaks are spikes or line noise.
- **One peak per region:** a candidate moves to the top of its region, and a region that is already taken is skipped. This stops skirts and ripples from creating duplicate tracks.

### Mains and gating

- **Mains detection:** periodograms are averaged across channels, and a line must stand ≥ 10 dB above its neighbours for ≥ 4 s. Only then is a notch (Q 30) added. A per-channel version raised false alarms.
- **Gating references:** they lock after `gate_reference_s` (60 s) and afterwards can only tighten, at baseline end. An artifact-heavy stretch therefore cannot widen them.
- **Step classification:** same-sign steps on the frontal pair are a blink and opposite-sign steps are eye movement. A step on one channel alone is a pop. A step on several channels that are not a frontal pair is motion; spec 9's motion source also covers the IMU.
- **Muscle:** 30-45 Hz power over the last 128 samples (Hann window), compared with a reference median and checked every fast block. A spectral-flatness criterion is not used.

### Fast path

- **Tracker:** F1 (complex demodulation plus a 2nd-order Butterworth low-pass), behind the `Tracker` trait. The corner is half the confirmed width, raised if needed so total delay stays within `fast_delay_limit_s`.
- **Lock:** lock is lost when the 1 s amplitude-weighted mean frequency differs from the slow centre by more than `fast_lock_se` (3) combined SEs for longer than `lost_lock_s`. Relock needs `fast_relock_s` of agreement. Readings are null (`weak`) when amplitude is below `fast_amp_floor` × the background RMS in the tracker's band (from the filter ENBW).
- **Gated samples:** the fast flag covers only the followed sites (spec 9), so a blink on AF7/AF8 does not null a TP-site fast track.

### Ratios

- **Pair alignment:** a pair is aligned only when it is resolved, |miss| ≤ ε, and not an excluded harmonic (`exclude_harmonics` = true).
- **Cascade closeness:** when no cascade has two or more steps, closeness falls back to the best eligible pair.
- **State statistic:** the maximum pair ln Λ (T3).
  - T3 is made monotone in s_x via min(raw(s_x), raw(0)), so uncertainty can never make alignment easier. A unit test enforces this.
  - q is triangular (unrelated peaks) with no baseline, and a Gaussian mixture of baseline ratios when a baseline exists, mixed with `baseline_mix`. **Changed in review:** q no longer widens with s_x (that broke the monotone property when a baseline exists).
- **`state_chance`:** defaults to "a" (chance A sets the CFAR threshold). "b" and "both" are available. This awaits decision D1.
- **Static threshold (chance A):** a binomial upper-confidence order statistic (`threshold_confidence` 0.9) of the (1 − p*) quantile, with p* = integration_s / 600 s. The raw quantile was too noisy, varying from 0.9 to 3.8 between refreshes.
- **Chance A surrogates:** peaks are placed log-uniformly over the searched range. They inherit their tracks' ids and relative SEs and are scored through the same `score_set` path. **Changed in review:** placement is within the track's own band.
- **Chance B:**
  - each track is shifted by its own circular lag, at least 10 s, within its own history. **Changed in review:** any two tracks' lags also differ by at least integration time + slow window;
  - every scored track needs ≥ `chance_b_span_s` (120 s) of history, otherwise chance B is null (`warming_up`);
  - CFAR runs on a 1 Hz series with dwell and hysteresis, and uses a Poisson upper confidence bound on the entry rate.
- **Surrogate refresh:** every `chance_refresh_s` (5 s). The PRNG stream is derived from (seed, stream, update count), so output does not depend on how input is chunked. p-value = (1 + count) / (1 + N).
- **Harmonic test:** frequency within tolerance of n × f0 (n ≤ 3) plus n:1 PLV ≥ 0.7 that exceeds the shifted-surrogate PLV by 0.3. The history co-movement test is not implemented.

### Site comparisons

- **Locking:** reported in excess of the mean over 8 time-shifted surrogates (shift ≥ 1 s). Locking from a shared reference is not removed by time-shifting, so a high excess on Muse can partly reflect the common reference.
- **`match`:** the geometric mean of the two sites' sub-scores.

### Stream and time

- **Overlapping pushes:** samples whose index precedes the next expected index are dropped. The clock starts at the first sample index.
- **Frame time:** frame `t` = index of the last sample / rate.

### Not measured

- Per-update cost on a phone in wasm. Under Node on a desktop it averages 7.7 ms. A chance-B refresh is the slowest frame: 22-31 ms natively. If phones are slow, the chance-B surrogates can be spread over several updates without changing results, because the draws are seeded per update.

## Milestone review, November 2026 (signal architect)

Findings and changes, with the measurements behind them. Spec sections 6.2, 6.4, 7, 8.4, 8.5, 9 and 14 were amended to match. Regression tests are in `tests/review.rs` and in the unit tests of `ratios.rs` and `tracks.rs`.

- **Background (spectral.rs).** On backgrounds that are not one power law the straight-line fit gave false peaks in 1.5 to 29% of windows (stated 1%) and confirmed tracks in up to 14% of frames of pure noise. `bg_fit_max_ratio` never fired, because the robust fit drops exactly the bins that show the misfit. Now: a second robust stage fits a polynomial in log-log (`bg_curve_terms` = 3, a quadratic), tangent-continued outside the fitted range, and a block-averaged lack-of-fit statistic (`bg_lack_of_fit_max`, `bg_lof_block_hz`) can fail the fit. False peaks per window are 0.3 to 0.45% on power laws, knees and noise floors, and 1.6 to 1.9% with a filter edge inside the fitted range (5 to 11% before). A cubic removes that too but stops confirming broad theta rhythms (17% of frames for a 10 dB rhythm 1 Hz wide at 5.3 Hz), so it was not adopted. `BgFit` gained fields (`terms`, `coef`, `cov`, `x_*`, `lack_of_fit`); `BgFit::at` now returns the curve, `power_law_at` the reported power law. Frame shapes are unchanged, but **`bg_exponent` and `bg_offset` no longer reproduce `psd / flat`**: frames.ts's comment should say they describe the best single power law. The lack-of-fit limit of 1.25 almost never fires on the shapes tried; it is a backstop for gross misfit, not a guarantee.
- **Integrated frequency (tracks.rs).** The overlap of the slow windows was already allowed for (n_eff); the brief's worry that it was not is unfounded. But the mean was weighted by 1/se² of noisy jackknife errors, and the window jackknife error is itself off by a factor 1.7 in either direction depending on the rhythm's width. Actual error over reported error was 1.3 to 2.2 for rhythms 1 Hz wide. Now a plain mean with a pooled variance (`integration_prior_dof`, `integration_young_se_factor`).
- **Evidence ratio (ratios.rs).** With a baseline, q was widened by s_x², so a vaguer measurement could raise ln Λ (by up to 5.4 nats for a tight baseline). q no longer depends on s_x; baseline variance is floored at τ².
- **Chance A (ratios.rs).** Surrogates over 1 to 45 Hz made the chance level about three times too low for a theta and alpha pair: P(p ≤ 0.05) = 0.16, state threshold exceeded by 10% of unrelated pairs. Now placed within each track's band (`ScoreCtx::null_bands`, set by the engine from the band edges in force): 0.054 and 0.033.
- **Chance B (ratios.rs).** Lags were independent per track, so the relative lag between two tracks was often near zero. Now separated by `chance_b_min_relative_lag`; `chance_b_feasible` tells the engine when histories are long enough, and until then chance B is `warming_up`.
- **Fast path (fast.rs).** `fast_amp_floor` 1.0 to 1.73 (background alone reported a frequency in 31% of frames; now about 5%). Settling after gated input 2 to 4 filter delays (13% of the zero-filled transient was left when output resumed; now under 2%).
- **Digests.** All numeric output changed, so the two digests below are out of date. Regenerate them natively and in wasm before relying on them.

Left open, in order of weight (details in the review report):

1. No real recordings. Every number here is from synthetic noise with independent channels.
2. Peak centre and width for rhythms 1 Hz wide or wider: the centroid follows the tallest lump. Width reads about half the truth, centre is biased by up to several percent, and the window jackknife error does not cover it.
3. Hemisphere `locking_excess` counts shared-reference activity as locking (0.27 for independent sources with a reference that carries the rhythm) and is biased to +0.09 at zero. Needs a zero-lag-free measure beside it (schema change).
4. Chance A's "one false entry per 10 minutes" is really "about 1 in 30 unrelated steady pairs reads as aligned throughout". UI wording.
5. Harmonic test: the co-movement half of spec 6.6 is still not implemented.
6. Rhythmic eye or eyelid activity below the step detector's threshold is a rhythm as far as this engine can tell. The delta low-confidence flag of spec 5.3 is still missing from the frame.
7. `slow_update_timing` exceeds its 50 ms budget on a loaded machine (116 ms seen with other builds running).

## Decisions on the bake-off and the fake test, November 2026 (signal architect)

Spec sections 3, 5, 6.5, 6.6, 8, 9, 10, 11, 14 and 15 carry the reasoning; regression tests are the second half of `tests/review.rs`.

- **State rule (ratios.rs, engine.rs).** Statistic is `chain_stat`: the largest total ln Λ along a chain of eligible pairs (one pair's ln Λ for two tracks). Entry threshold is the larger of `state_min_evidence` (2) and the chance threshold on the same statistic; exit 1 below. The chance threshold alone could be hundreds of nats below zero and let "less far off than chance" enter (near-miss files, artifacts); the single-pair statistic could not beat its own threshold among many tracks (phi5_15db).
- **Excess (ratios.rs `NullDist::excess`).** Measured from the closeness only `excess_level` (5%) of surrogates reach, not from their mean. Zero unless p ≤ 5%. `excess_b` is null (warming up) while chance B's percentile floor is above that level.
- **Targets.** `Target::Ratio3` (3:1), index 4 in `Target::ALL`, serialized `ratio_3`. `ratios::NT` = 5.
- **Frame additions.** `states.both { active, for_s }` (types `States`, `BothState`); `spectra[].bands_fixed` (always present, fixed band edges; proposed here, optional in frames.ts). `SlowFrame.states` is now `States`, not `PhiOctave<AlignedState>`. Schema number unchanged (1), as in frames.ts.
- **Harmonics (engine.rs `detect_harmonics`, compare.rs `locking_vector`).** Candidate band instead of the tolerance gate; mark from the mean locking vector over the integration time (`harmonic_alpha`, `harmonic_release_p`) or one decisive window; pending until `harmonic_pending_tests`; family pairs excluded. `PairScore.harmonic` is true for every pair kept out of scoring (marked, pending or family); `Track.harmonic_of` only for marked pairs.
- **Tracks resume (engine.rs `link_tracks`, `dormant`).** `track_resume_s`. `TrackEvent::Resumed` added. `TrackInt::integrate` counts independent windows by time covered, so a pause does not inflate n_eff.
- **Gaps (engine.rs `push_eeg`).** Rows with no finite value are missing samples, repaired like an index jump; `repaired_max_fraction` 0.02 to 0.04. `hb-run` needed no change.
- **Gating.** Muscle band is `muscle_lo_hz`..`muscle_hi_hz` (65 to 95, was 30 to 45 fixed). Motion reference is a quantile (`motion_ref_quantile`, 0.25).
- **Chance B history.** `chance_b_history_corr` correlation times (`Params::chance_b_need_s`); `chance_b_history_s` > 0 overrides.
- **Presets.** `Params::preset("steady" | "quicker" | "slower" | "child")`, `Params::PRESETS`.

Not adopted from the bake-off, and why:

- **Smoothed eigenspectra (S1Q) and the threshold factor 1.28.** The factor answers a threshold that was anti-conservative in the lab's composite (1.19% against 1%). In this engine the analytic threshold is conservative: 0.3 to 0.45% of single-site windows and 0.4% of frames at any site on background, no confirmed track in 40 minutes of noise per background shape. Smoothing changes the degrees of freedom of the height test, the width limits and the jackknife, and needs that calibration redone; it was not done in this review. What S1Q buys (fewer duplicate peaks on broad rhythms, steadier centres) is real and is the next thing to do: see open item 2.
- **Fixed thresholds alone for the state.** 2.2 false entries per 10 minutes on recordings with one unrelated peak per band (bake-off section 7, second column). Kept as the floor under the chance threshold.

Still open after this round, most important first:

1. No real recordings; channels in every synthetic file are independent.
2. Broad rhythms (1 Hz and wider): several tracks on one rhythm, centre errors of 0.3 to 0.5 Hz at 18 to 25 Hz with a reported error about 1.6 times too small (octave3_10db top member: rms error 0.47 Hz, reported 0.30). Finding the peak's region and centre on a smoothed spectrum while testing its height on the raw one is the design to try.
3. Sensitivity at 6 dB is far below the 80% mark (phi2_6db: 3% and 17% of frames). The per-site split of α_peak and the quadratic background both cost here.
4. A first minute full of artifacts sets the blink and muscle references too high (a 150 µV blink train from the first second was tracked as rhythms at 1.7, 3.3 and 6.7 Hz, all marked harmonic, so no alignment was credited). A low quantile for those references, as now used for motion, is the likely fix; the thresholds would need rescaling.
5. Rhythmic eye or eyelid activity below the step threshold is a rhythm as far as the engine can tell (a 3.3 Hz, 25 µV train is tracked). The delta low-confidence flag of spec 5.3 is still not in the frame.
6. Muscle band 65 to 95 Hz is unverified on a real headset.
7. Hemisphere `locking_excess` still includes the shared reference (unchanged from the review).
8. Chance B goes back to null whenever a new track joins the scored set.
9. Digests below are stale.

## Verified numbers (release, this machine)

**Out of date after the review** for anything numeric below; kept for the record of what the first build measured.


- **False peaks on 1/f noise:** 7/2000 windows = 0.35% (height test alone 0.60%, α_peak 1%).
- **Full engine on 1/f noise:** 2/2756 windows had a passing peak, 0 confirmed tracks.
- **Planted phi cascade:**

  | Planted | Measured |
  | --- | --- |
  | 6.180 Hz | 6.164 ± 0.035 Hz (−0.26%) |
  | 10.000 Hz | 10.068 ± 0.058 Hz (+0.68%) |
  | 16.180 Hz | 16.138 ± 0.026 Hz (−0.26%) |

  Phi aligned, octave not.
- **Planted octave cascade:** errors +0.87%, +0.24% and −0.42%. Octave steps 2, phi 0.
- **10 Hz sine:** integrated 9.9996 ± 0.0029 Hz. Fast reading 10.017 Hz, locked, delay 0.300 s.
- **Slow update (64 samples, 4 channels, chance B active):** mean 6.5 ms, median 5.6 ms, p99 21.9 ms, max 30.6 ms.
- **Native = wasm32 digests:**
  - digest(7, 45) = 0x4c475e0d4b434194
  - digest(7, 150) = 0xc6d8a431edda3d25
