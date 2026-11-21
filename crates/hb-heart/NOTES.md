# hb-heart: decisions, open requests, things to verify

Owner: heart and breath engineer. Scope is spec section 13. Output contract: `HeartFrame` in
`app/src/engine/frames.ts`, schema 1. `src/types.rs` serializes to it field for field (checked by the
`json_shape_matches_contract` test).

## Decisions

**Spectral estimator: sine multitaper (3 tapers) on the 4 Hz resampled series. Not Welch, not Lomb-Scargle.**
- Resonance strength is "power within +-0.015 Hz of the peak". That needs about 0.015 Hz resolution,
  which means one segment of about 120 s. Welch with shorter segments cannot resolve it, and Welch with one
  segment is a single periodogram.
- A single periodogram has 2 degrees of freedom per frequency. With a Hann periodogram the breathing
  detector reported a breathing rate on 12.6% of frames of rhythm-free data (30 seeds). Chance peaks are
  common at 2 degrees of freedom.
- Sine tapers (Riedel and Sidorenko) give about 6 degrees of freedom at the same resolution, roughly
  +-(K+1)/(2T) = +-0.017 Hz at K = 3 and T = 120 s. They have a closed form, so no eigen-solver is needed.
  With them, false breathing reports fell to 1.6% of frames, and a 15/min breathing rhythm with a
  wandering rate was still detected on 100% of frames.
- Lomb-Scargle would avoid resampling. But it has the same 2-degree-of-freedom variance, and the breathing
  phase and coupling need an evenly sampled series anyway.
- Resampling uses a natural cubic spline through the clean beats (`resample_cubic`). Linear interpolation
  biased a 0.1 Hz rhythm's power about 5% low. The RSA test now measures LF at 1719 against 1800 expected.

**Beat cleaning.** Each interval is compared with the median of up to 11 preceding intervals from the last
30 s, flagged or not, so a lasting change of rate is accepted after a few beats. An interval more than 20%
from that median is flagged, and so is one outside 300 to 2000 ms. Flagged intervals are kept and shown, are
never values in the resampled series, and are excluded from SDNN. RMSSD uses only pairs of consecutive,
contiguous, clean intervals. Missed beats (about 2x), extra beats (two short intervals) and ectopic
short-long pairs are all caught by this one rule. They are not classified, because the treatment is the
same. The cleaning is causal, so a beat's flag is final when it is emitted.

**Strap clock.** Beat k is placed at `c + S_k`, where S_k is the running sum of intervals. The offset c
follows the smallest `arrival - S_last` seen: it snaps down at once and creeps up at 0.5 ms/s
(`rr_clock_creep`) to allow for drift between the two clocks. A notification that arrives more than
`rr_latency_max_s` plus half an interval later than its intervals can explain means intervals were lost. The
clock then re-anchors, and the next beat is marked non-contiguous: no successive difference and no
unflagged interpolation across it. The constant part of the BLE latency cannot be known, so beat times carry
the minimum notification latency. Measured with 0 to 0.4 s jitter and 3 dropped notifications: maximum
beat-time error 0.45 s or less, both runs of lost notifications detected, no false flags.

**PPG.** Every 16 samples, on a fixed grid of the sample index, so the result does not depend on how the
input was chunked, the last 8 s of each channel is band-passed zero-phase (0.5 to 5 Hz, biquads run
forward and backward, reflection padding). Peaks are searched only in data at least 0.75 s old
(`ppg_margin_s`), so the filter has data on both sides of them. PPG beats therefore arrive about 0.75 to
1 s late, and their `t` is the true pulse time, which is earlier than the frame's `t`.

Channel quality is (peak normalized autocorrelation at pulse lags) x (fraction of regular consecutive
intervals). Autocorrelation alone did not separate noise from pulse when the heart rate changes: on noise
it reached 0.58, and on a clean pulse with +-8 bpm RSA it fell to 0.59. The product puts noise at 0.33 or
below and clean pulse at 0.59 or above (12 seeds). The threshold is 0.45.

Peaks must exceed 40% of the median of recent peak amplitudes and be at least 0.33 s apart, with the
larger peak kept. The time is refined with a parabola. The first pulse after start or a dropout is not
emitted as a `Beat`, because `Beat.ibi_ms` is not nullable. It only starts the interval.

**High variability state.** stat = ln(measure / baseline median). The measure is RMSSD by default
(`high_hrv_measure` can be sdnn, lf_power, hf_power or resonance_strength). The baseline distribution comes
from per-second values inside `mark_baseline(t0, t1)`, and at least 60 s is required. Entry is at the 0.9
quantile, and at least +0.1, which is +10%. Exit is at the 0.6 quantile, kept below entry. There is a 5 s
dwell before entry. Exit happens on falling below exit, or on the statistic becoming null, because the
state is not claimed when it cannot be measured.

Not done: spec 8.4 asks for dwell and hysteresis to be applied to surrogates as well, to publish a false
alarm rate. No surrogate is run for this state yet. That needs a recorded-baseline null (see requests).

**Coupling.**
- The heart rate series is the 4 Hz instantaneous heart rate from clean beats. Samples bridged across an
  excluded beat or a dropout are unusable.
- Correlation and phase locking are both computed on the series band-passed to 0.04 to 0.26 Hz (FFT,
  circular), ignoring 12.5 s at each end. Correlating detrended but unfiltered series gave 14.5% false
  positives at alpha 0.05 on independent random walks (400 seeds), because a circular shift of a drifting
  series does not reproduce its accidental correlation. After band-passing the rate was 3.5%.
- The chance level is the mean of 200 circularly shifted surrogates, with lag 30 s or more. The surrogates
  run through the identical statistic function, and the observed value is that function at lag 0. The
  band-pass commutes with a circular shift, so the series are filtered once.
- For correlation, `chance` is the mean |r| of the surrogates and `p` is two-sided on |r|. For phase
  locking, `chance` is the mean PLV.
- p = (1 + count(surrogate >= observed)) / (1 + 200). The +1 makes it conservative and never 0. The
  contract text says "fraction of them at least as large"; the difference is at most 1/201.
- The surrogate seed is derived from the session seed, the series name and the window's end index, so it
  does not depend on call history.
- Coupling needs 180 s of jointly valid samples. Before that it is `warming_up` while the session is
  younger than the window, and `insufficient_clean` after. It is recomputed every 5 s (`coupling_update_s`)
  and frames carry the latest computation. This is a declared update interval, as for chance levels in
  spec 8.5.
- `suspect_artifact` is an input (`set_suspect_artifact`). When set, value, chance and p are null with
  reason `artifact` (spec 13: not reported as coupling).

**Breathing phase.** Phase 0 is the heart-rate maximum of the respiratory rhythm, which is the interval
minimum, and pi is its minimum. Heart rate rises during inhalation, but the delay between breath and heart
rhythm is not modelled. The phase is a least-squares sinusoid at the measured breathing frequency over the
last 1.5 cycles, ending at the last clean beat. It is projected to the frame time at that frequency for at
most 2 s (`breath_phase_max_ahead_s`), and is null after that. The projection is declared here because it is
the one forward step in the crate.

**Frames.** A frame is produced whenever beats of the active source arrive, and at least every
`frame_max_interval_s` (1 s) once any input has arrived. Frame `t` never decreases. `beats` holds the active
source's beats detected since the previous frame; beats of an inactive source are not replayed after a
switch. Source: chest strap while its last beat is 3 s old or less, else PPG while its last beat is 4 s old
or less, else `none`.

**Determinism.** All transcendental functions come from the `libm` crate, so native and wasm32 should agree
bit for bit. That is unverified: there is no wasm runtime test yet. Random numbers come only from SplitMix64
seeded by the session seed. There is no HashMap iteration. Byte-identical JSON on repeat runs is tested.

## Requests to the signal architect (frames.ts)

1. **Breath confidence field.** Spec 13 asks for the breathing estimate "with a confidence". `Measured` has
   only `se`. I report `se` from the spread of the instantaneous frequency divided by the square root of the
   number of cycles. If the UI needs a 0..1 confidence, add a field. I would fill it with the peak's share of
   breath-band power.
2. **PPG quality in the frame.** Spec 13 says pulse times come "with a quality measure". `HeartFrame` has
   nowhere to put it. I suggest `ppg_quality: number | null` (the active channel's quality) and maybe
   `ppg_channel`. The quality is available now through `HeartEngine::ppg_quality()`.
3. **Heart-rate smoothing declaration.** `hr_bpm` is the mean of clean intervals over `hr_window_s` (5 s).
   It might need a `window_s` or a parameter id on the frame, to meet rule 8.
4. **`corrected_fraction`** describes the RMSSD/SDNN window. The spectral window (120 s) has its own, which is
   not in the frame. It is only reflected in `too_many_corrections` nulls.
5. **Pulse artifact detection** (spec 13: "strongest at the pulse rate itself, on one channel"). That needs
   EEG-side heartbeat-locked analysis or a per-channel spectrum at the pulse rate. hb-engine owns the EEG
   samples. For now hb-heart takes `set_suspect_artifact(name, bool)`. I can supply beat times for
   heartbeat-locked averaging if hb-engine wants to compute it.
6. **Unify `Measured` and `Reason`** with hb-engine's copies. Mine are identical in shape: `se` is always
   serialized, as null when absent.
7. **High-variability false alarm rate.** To publish one, as 8.4 does for alignment, we need a null for the
   statistic. My proposal is circularly shifted baseline-period values run through the same
   dwell/hysteresis. This needs a decision on what "chance" means for a single-series state.

## Unverified (recalled, not checked)

- Polar H10 notification cadence (about 1 per second) and its RR resolution (1/1024 s, converted to ms by
  the device layer). The clock model only assumes notifications follow their beats.
- Typical Muse PPG channel layout (3 channels on Muse S/Athena, 64 Hz). Channel count is taken per push.
- The sine-taper resolution figure (K+1)/(2T) is approximate.
