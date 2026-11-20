# Signal engine specification

Status: draft 1, 20 November 2026. Awaiting the owner's approval (roadmap gate 1).
Owner of this document: the signal architect. Changes go through a pull request reviewed at the Fable tier.

This document says what the signal engine must measure, what it must output, which methods are candidates for each stage, and how we will choose between them by testing. It is written so that an implementer can build the engine without redesigning it.

Words used in a fixed sense:

- **Must** is a requirement. A build that breaks it does not ship.
- **Provisional** marks a starting value that the bake-off in section 10 is expected to change. Every provisional number lives in the table in section 14 and nowhere else in code.
- **Null** means "not measured". It is a distinct value in every output. It is never replaced by zero, by the last good value, or by a guess.

## 1. Purpose and scope

The engine turns raw headset samples into one stream of measurements. The sound, the hurricane, the training logic and the session record all read that stream and nothing else. The engine is written in Rust, compiled to WebAssembly for Chrome, and checked against a Python reference lab.

In scope: signal conditioning, artifact gating, spectra, confirmed peaks, peak tracking, golden ratio and octave alignment with chance levels, cascades, hemisphere and front-back comparisons, band summaries, and the per-block statistics that training programs and user profiling need.

Out of scope here: the Bluetooth link and packet decoding (device engineer), sound synthesis (sonification engineer), the shader (visualizer engineer), protocol content (training roles). Heart and breath measurements are in section 13. Brainwaves are built first and heart follows in the same build.

Excluded from this app for now, by the owner's decision: binaural, monaural and isochronic entrainment. Those arrive later when this app is blended with EarthSync. This app is biofeedback only: it reports what the brain and heart are doing and does not try to drive them with rhythmic stimulation.

## 2. Rules that cannot be broken

These come from the owner's requirement that everything seen and heard is authentic.

1. **Measured or null.** Every output field is either computed from samples that passed gating, or null. No field is ever synthesized, extrapolated past its stated hold time, or animated.
2. **Every number carries its evidence.** Each measured value comes with an uncertainty, the time span of the data behind it, and a validity reason when it is null.
3. **No peak without confirmation.** The largest bump in a band is not a peak. A peak exists only after it passes the confirmation test in section 6.3.
4. **Chance is always alongside.** Golden ratio alignment is never reported without octave alignment and the chance level computed by the identical procedure.
5. **The null goes through the same pipeline.** Any surrogate or chance calculation uses the same code path, the same search and the same thresholds as the real measurement, so that every "best of several" choice is paid for.
6. **Deterministic.** The same recorded session produces the same output, bit for bit, every time, live or replayed. Random numbers are used only for surrogates and come from a seed stored in the session.
7. **Raw is kept.** Every session stores the raw samples and the engine version and parameter set, so any moment can be re-analysed later with a better method.
8. **Smoothing is declared.** Any smoothing or fade between a measurement and what the user perceives has one named time constant, visible in settings and recorded in the session.

## 3. Inputs

The engine receives decoded, timestamped samples from the device layer. It does not know which headset model produced them beyond the stream description.

| Stream | Rate | Channels | Notes |
| --- | --- | --- | --- |
| EEG | 256 Hz nominal | 4 (TP9, AF7, AF8, TP10) on Classic headsets. 4 or 8 on Athena. | Microvolts, as floats. Reference near the centre of the forehead. |
| Motion | about 52 Hz | 3 accelerometer, 3 gyroscope | Used only for artifact gating. |
| Optical pulse (PPG) | 64 Hz | up to 3 | Section 13. |
| Chest strap | per beat | beat-to-beat intervals | Section 13. Polar H10 first. |

Requirements on the device layer, restated here because the engine depends on them:

- **One clock.** Sample times are reconstructed from the sample count and the packet sequence numbers, anchored to the first packet. Arrival times are used only to detect drift. This is required for Athena, whose EEG packets carry no usable timestamps, and we use it for all models so they behave the same.
- **Gaps are reported, not hidden.** A lost packet arrives at the engine as an explicit gap with its length in samples.
- **Stream description.** Each stream declares its channel names, units, nominal rate and bit depth. The engine works from channel names, so 4 and 8 channel headsets use the same code.

Gap handling in the engine (provisional): a gap of at most 12 samples (one Classic packet, about 47 ms) is filled by linear interpolation and marked "repaired". A longer gap is marked invalid. A window with more than 2% repaired samples or any invalid sample is not analysed.

A clock error between headset and host scales every frequency by the same factor. Ratios are unaffected. An error of 0.1% moves a 10 Hz reading by 0.01 Hz, which is well inside our precision.

## 4. Pipeline overview

```
raw samples
   │
   ▼
[5] conditioning ──► signal quality per channel
   │
   ▼
[5] artifact gating ──► validity mask (which samples may be used)
   │
   ├──────────────► [6] SLOW PATH, 4 updates a second
   │                    spectrum ─► background fit ─► confirmed peaks ─► peak tracks
   │                                                                        │
   │                                                                        ▼
   │                                              [8] ratios, cascades, chance levels
   │                                                                        │
   └──────────────► [7] FAST PATH, 32 updates a second                      │
                        follows each confirmed peak: frequency, strength    │
                                        │                                   │
                                        ▼                                   ▼
                              [9] measurement frames ──► sound, hurricane, training, recorder
```

Two speeds are needed because precision and speed pull against each other. Telling a golden ratio step from a nearby ratio needs long windows. Driving a tone that feels connected to the brain needs a delay of a fraction of a second. The slow path decides what is real. The fast path is only allowed to follow what the slow path has confirmed.

## 5. Conditioning and artifact gating

### 5.1 Conditioning

Per EEG channel, in this order:

1. Gap repair and marking (section 3).
2. High-pass at 0.5 Hz to remove drift (provisional; delta training needs content down to 1 Hz).
3. Mains notch at 50 or 60 Hz. The engine detects which is present from the spectrum in the first seconds and the user can override. The mains line and its neighbourhood (±2 Hz) are excluded from peak search and from the background fit.

Filters must be causal, with a documented delay that is compensated in the timestamps. The slow path may use the unfiltered signal with detrending if the bake-off shows it is cleaner.

### 5.2 Signal quality

Per channel, updated once a second, each with a measured value and a pass or fail:

- Contact: mains line amplitude and broadband variance. A loose dry electrode shows large mains pickup and slow drift.
- Range: fraction of samples at or near the converter's limits. Flat or railed signal fails.
- Plausibility: amplitude over the last second within the range of scalp EEG (provisional: standard deviation between 1 and 100 µV after conditioning).

A channel that fails is excluded from everything until it has passed for 3 seconds in a row (provisional).

### 5.3 Artifact gating

Gating produces a validity mask per channel and a reason code. Candidate detectors, all to be tuned on recorded artifacts in the bake-off:

| Artifact | Where it shows | Detector (provisional) |
| --- | --- | --- |
| Blink, eye movement | AF7 and AF8, large slow deflection, delta and theta range | Amplitude step above a threshold scaled to the channel's own running median, frontal pair moving together |
| Jaw, forehead, neck muscle | All channels, broadband above 20 Hz | Ratio of 30 to 45 Hz power to the fitted background, and spectral flatness |
| Head movement | Any | Accelerometer and gyroscope energy above the resting level |
| Electrode pop or shift | One channel | Single-channel step with no partner |

Rules:

- A flagged stretch is padded on both sides (provisional: 250 ms) and removed from analysis.
- The slow path computes its spectrum only from clean stretches inside its window, and needs a minimum clean fraction (provisional: 60%) and a minimum longest clean stretch (provisional: 2 s). Otherwise its output is null with the reason.
- Thresholds scale to the person's own resting signal, measured in the baseline minute, and never loosen during a session to "find" signal.
- Delta (1 to 4 Hz) results are flagged as low confidence whenever the frontal channels show eye activity in the window. On a Muse, waking delta is mostly eyes.

## 6. Slow path: spectrum and confirmed peaks

Runs every 250 ms on the most recent window of each usable channel.

### 6.1 Spectrum

- Window length: 8 s (provisional), with 4 s offered as a faster, less precise setting.
- Estimator candidates (section 10): multitaper, Welch averaging, and irregular resampling.
- Analysed range: 1 to 45 Hz for peak finding. The displayed spectrum may extend higher, but nothing above 45 Hz is scored, because on dry forehead electrodes that range is dominated by muscle.
- Outputs per channel, plus three composites: temporal pair (TP9, TP10), frontal pair (AF7, AF8), and all clean channels. A composite is the mean of its clean members' spectra and is null if no member is clean.

Know the statistics of the estimator. If a spectrum value is an average of K independent estimates (K tapers or K non-overlapping segments), then estimate ÷ truth follows a chi-squared distribution with 2K degrees of freedom, divided by 2K. This is what makes a confirmation test possible. For an 8 s window with a half-bandwidth of 0.5 Hz, a multitaper estimate has K = 7. For 4 s it has K = 3.

### 6.2 Background

EEG power falls with frequency roughly as 1/f^χ, with no rhythm needed. The engine fits this background in log power against log frequency over 2 to 45 Hz, using a robust fit that ignores the bins sitting above the line (iterate: fit, drop bins above the fit by more than a threshold, refit). It reports the exponent χ, the offset, and the fit error. If the fit error is above a limit, the spectrum is unusable and everything downstream is null.

The "flattened spectrum" is the spectrum divided by the fitted background. A flat line at 1 means no rhythm.

### 6.3 Peak confirmation

A candidate peak is a local maximum of the flattened spectrum. It becomes a **confirmed peak** only if all of the following hold:

1. **Height.** Its flattened height exceeds the threshold at which pure background would produce such a maximum anywhere in the search range with probability below α_peak (provisional: 1% per window). The threshold comes from the chi-squared law in 6.1 with a correction for the number of independent frequency bins searched, and is then verified by simulation on background-only noise.
2. **Width.** Its width at half height is between the estimator's own resolution and 6 Hz (provisional). Narrower is a line artifact, such as mains leakage or a device tone. Wider is a shelf, not a rhythm.
3. **Persistence.** It is present in at least 2 of the last 3 non-overlapping windows (provisional), at a frequency consistent within its uncertainty.
4. **Not an artifact band.** It does not coincide with a stretch that gating marked, and is not within the excluded mains zone.

A peak that stops passing is dropped after a hold of 2 s (provisional). During the hold it is marked "fading" and its fast-path output is still measured, never frozen.

### 6.4 Frequency precision

For each confirmed peak the engine reports a centre frequency and a standard error.

- Centre frequency: centroid of the flattened peak above half height (provisional; a Gaussian fit is the alternative).
- Standard error: jackknife over the tapers or segments. This costs almost nothing and is honest about each individual window.

**An important correction to the plan.** The plan assumed 4 to 8 s windows give about 0.1 Hz precision. A quick simulation (`lab/precision_and_chance_sketch.py`) says that is too optimistic for realistic brain rhythms, which are 0.5 to 2 Hz wide and wander. With a simple centroid estimator and a strong rhythm, 10 dB above background:

| Window | Rhythm 0.25 Hz wide | 0.5 Hz wide | 1 Hz wide |
| --- | --- | --- | --- |
| 4 s | 0.41 Hz | 0.33 Hz | 0.57 Hz |
| 8 s | 0.12 Hz | 0.19 Hz | 0.40 Hz |
| 30 s | 0.06 Hz | 0.10 Hz | 0.19 Hz |

Widths are the standard deviation of the rhythm's spectral shape. Weaker rhythms are worse, and below about 6 dB the estimate sometimes jumps to a noise bump altogether, which is why confirmation in 6.3 comes first. A better estimator will improve these somewhat, but the limit is physical: a rhythm that is 1 Hz wide does not have a centre defined to 0.1 Hz in 8 seconds.

Consequences, which shape the rest of this document:

- A single 8 s window can tell a golden ratio step from an octave. Those differ by 21%.
- A single window usually cannot tell 1.618 from 1.55 or 1.70. That needs about 30 s of steady signal.
- So each peak carries an **integrated frequency**: a precision-weighted running mean of its window estimates over an integration time (provisional: 30 s), with its own standard error. Ratio scoring uses the integrated frequency. Alignment is therefore a slowly changing quantity, on the scale of tens of seconds. This suits the owner's requirement for sound that warms slowly, and it must not be hidden by making the display twitchier than the measurement.

### 6.5 Peak tracks

Peaks are linked across windows into tracks so that "the alpha peak" has a stable identity. A new window's peak joins the track whose predicted frequency is nearest, if within 3 standard errors or 1 Hz, whichever is larger (provisional). Each track has an id, a birth time, its history of frequency, height and width, and its integrated frequency. Two tracks that converge are merged and the event is recorded. A track that splits, such as a double alpha peak, becomes two tracks.

Tracks are named by frequency only. Band names (delta 1 to 4, theta 4 to 8, alpha 8 to 13, beta 13 to 30, gamma 30 to 45 Hz) are labels for display and training targets. They are never used to force one peak per band.

### 6.6 The harmonic trap

A rhythm that is not a pure sine has harmonics. A 10 Hz alpha rhythm with a slightly pointed shape produces a real spectral bump at exactly 20 Hz. That is one rhythm, not two rhythms an octave apart, and counting it would make octave alignment partly fake.

For every pair of tracks whose ratio is within tolerance of an integer, the engine tests whether the upper one is a harmonic of the lower: the two frequencies move together over time at exactly that integer ratio, and their phases are locked (bicoherence, or phase locking of the upper track to the lower track's phase multiplied by the integer). A pair that passes is marked "harmonic". It is shown, it is excluded from octave alignment and from cascades by default, and the exclusion is a visible setting.

## 7. Fast path: tracking

Runs for each confirmed track on the channel or composite where that track is strongest. Emits 32 times a second (every 8 samples).

Per track it outputs:

- Instantaneous frequency in Hz.
- Instantaneous strength: amplitude in microvolts, and height above the background in decibels.
- Phase.
- A lock flag and a confidence.

Requirements:

- **Bounded by the slow path.** The tracker searches only within the confirmed peak's own width around its slow-path centre. If its reading leaves that range or disagrees with the slow path by more than 3 standard errors for longer than 1 s (provisional), the output is null and the reason is "lost lock". The slow path wins every disagreement.
- **Null when weak.** Instantaneous frequency is meaningless when amplitude is near zero, because phase jumps. Below an amplitude floor set from the background, frequency is null while strength is still reported.
- **Delay.** Total delay from scalp to output frame at or under 300 ms for alpha and above (provisional), and reported per track. A narrower filter is more precise and slower. The delay actually achieved is a measured output, not a constant in the documentation.
- **No invention.** When the track is dropped, output stops. There is no glide to a default pitch. Fading the tone out is the sound layer's job, with its declared time constant.

The tone's pitch is the fast-path frequency multiplied by exactly 32, five octaves up. That multiplication preserves ratios, so two tracks at golden ratio spacing sound as that interval.

Candidate trackers are listed in section 10.

## 8. Ratio alignment, cascades and chance

### 8.1 Working in log ratios

For two tracks with integrated frequencies f₁ < f₂ and standard errors s₁, s₂:

- x = ln(f₂ / f₁)
- s_x = √((s₁/f₁)² + (s₂/f₂)²)

Targets: golden ratio, ln φ = 0.4812 (φ = 1.6180). Octave, ln 2 = 0.6931. They are 0.212 apart in log units. The point equally far from both is a ratio of 1.799.

Control targets are scored the same way and reported with them: 1.5 and 1.8 (provisional). A method that lights up for the golden ratio and equally for 1.5 has found nothing special about the golden ratio.

Useful identity: φ² = φ + 1. In a golden ratio cascade each frequency is the sum of the two below it, for example 3.8, 6.2, 10.0, 16.2, 26.2 Hz. An octave cascade from the same start runs 3.8, 7.6, 15.2, 30.4 Hz.

### 8.2 Pair alignment

For each pair of tracks and each target t the engine reports:

- **Resolved or not.** If s_x is above a limit (provisional: 0.03) the pair is "unresolved" and its alignment is null. Uncertainty must never make alignment easier to reach.
- **Miss:** x − t, in log units and as a percentage.
- **Closeness:** c = exp(−½ ((x − t)/ε)²), from 0 to 1, where ε is the tolerance (provisional: 0.03, about 3%, visible setting).
- **Evidence:** how much more likely the measured x is if the true ratio is the target than if the ratio is just a draw from this person's own usual spread for that pair. Defined in 8.4.

### 8.3 Cascades

A cascade is a chain of tracks in which each step is aligned to the same target. The engine finds the longest chain, breaking ties by total evidence. A chain may skip over an unrelated track that sits between two of its members, and reports that it did. Harmonic pairs do not count as steps.

Reported: the member tracks, the number of steps, the target, per-step miss and closeness, how long the cascade has held without a break, and its chance level.

Golden ratio and octave cascades are found separately and may exist at once.

### 8.4 The aligned state and the adaptive threshold

The app needs a yes or no ("in golden ratio alignment") as well as a continuous value. The owner asked for a smart, adaptive threshold. Four candidates go into the bake-off:

| | Rule | Strength | Weakness |
| --- | --- | --- | --- |
| T1 | Fixed tolerance: aligned if the miss is under ε | Simple to explain | Ignores how well the peaks are known. Same chance level for everyone |
| T2 | Scaled tolerance: aligned if the miss is under k·s_x, capped at ε, and the pair is resolved | Uses measurement precision | Without the cap and the resolved rule, sloppy peaks align more easily |
| T3 | Evidence ratio: Λ = N(x; t, s_x² + τ²) ÷ q(x), where q is the person's own baseline density of x and τ is a small intrinsic tolerance. Aligned if ln Λ is above a threshold | A vague measurement gives Λ near 1, so no claim. A ratio the person sits at all the time earns little | Needs a baseline. Harder to explain |
| T4 | Constant false alarm rate: whichever statistic is used, its threshold is set from the person's own chance distribution so that false entries happen at a fixed, stated rate (provisional: at most one false entry per 10 minutes) | The threshold adapts to the person and the day. The false alarm rate is a number we can publish | Needs enough data to estimate the chance distribution |

My expectation, to be tested and not assumed, is that T3 with a T4 threshold wins.

Whatever rule wins, state changes use:

- **Dwell.** The statistic must stay above the entry threshold for a minimum time (provisional: 5 s) before the state is entered.
- **Hysteresis.** The exit threshold is lower than the entry threshold, so the state does not flicker.
- **The same rule in the null.** Dwell and hysteresis are applied to the surrogates too, so the published false alarm rate includes them.

### 8.5 Chance levels

Unrelated peaks land near the golden ratio often. From `lab/precision_and_chance_sketch.py`:

| Situation | Tolerance 1% | 2% | 3% | 5% |
| --- | --- | --- | --- | --- |
| One theta peak and one alpha peak, placed at random in their bands, land on the golden ratio | 3.2% | 6.3% | 9.4% | 15.5% |
| The same, landing on the octave | 2.6% | 5.2% | 7.8% | 12.9% |
| Three peaks in theta, alpha and beta, both steps on the golden ratio | 0.07% | 0.26% | 0.57% | 1.54% |
| Any two of five unrelated peaks between 2 and 45 Hz on the golden ratio | 10.4% | 19.6% | 28.0% | 42.2% |

Read the last row carefully. With five peaks and a 3% tolerance, more than a quarter of random spectra contain a "golden ratio pair". A single aligned pair is weak evidence. A three-step cascade is strong evidence. The chance level has to be computed for the search actually performed.

The engine computes two chance levels, live, by rule 5:

- **Chance A, unrelated peaks.** "Would this many peaks, placed at random, score this well?" Surrogate peak sets have the same number of tracks, placed at random in log frequency across the search range with the same measured uncertainties, and go through the same pairing, cascade search and thresholds. Available from the first confirmed peak.
- **Chance B, your own wandering.** "Are these rhythms moving into alignment together, or is this just where each one usually sits?" Each track's frequency history is shifted in time by an independent random lag of at least 10 s, wrapping around, and scored the same way. This keeps each rhythm's own behaviour and removes only their relationship in time. Needs at least 120 s of track history (provisional). Until then it is null and the display says it is still measuring.

For each, the engine reports the expected closeness under chance, and where the observed value falls in the chance distribution (a percentile). At least 200 surrogates (provisional), from the session's seed, refreshed every 5 s.

**Excess alignment** is (observed closeness − chance closeness) ÷ (1 − chance closeness), floored at 0. This is the quantity the hurricane's winding is bound to.

Open decision D1, for the owner, in section 15: which chance level the hurricane uses. They answer different questions. A person whose alpha and theta sit steadily at a golden ratio for a whole session scores high against chance A and near zero against chance B.

The reference lab also runs heavier surrogates on recorded sessions, which are too slow to run live: phase-randomized copies of the raw signal that keep each channel's spectrum, block-shuffled recordings, and channel time shifts. The live chance levels must agree with these within a stated margin, or the live method is wrong.

### 8.6 What the app always shows together

Golden ratio alignment, octave alignment, the controls, and the chance level, side by side, each with its uncertainty. This is rule 4. The UI label is "golden ratio alignment". Interpretations, including Dan Winter's, are offered in the app's text as readings of the measurement. The engine takes no position.

## 9. Outputs: the measurement frame

The engine emits two kinds of frames. Every field is a value, an uncertainty where it applies, and a validity (ok, or null with a reason). Field names here are indicative. The signal architect fixes the exact schema, versioned, before implementation starts.

**Slow frame, 4 per second**

- Time, engine version, parameter set id.
- Per channel: signal quality measures, artifact reason, clean fraction.
- Per channel and composite: spectrum, background exponent and offset, flattened spectrum.
- Band summaries per channel and composite: power above background, and total power, for each named band. Power above background is the one training uses, so that a change in overall signal level is not mistaken for a change in a rhythm.
- Tracks: id, centre frequency and standard error, integrated frequency and standard error, height above background, width, age, state (new, confirmed, fading), harmonic-of.
- Pairs: for every pair and target, resolved, miss, closeness, evidence.
- Cascades: golden ratio and octave, as in 8.3.
- Chance: A and B, expected closeness and percentile, for pairs and cascades.
- States: aligned state per target, with time in state.
- Hemispheres: for each track present on both sides, the frequency difference between TP9 and TP10, the amplitude balance, and phase locking between the sides. Caveat to carry into the UI text: all channels share one reference electrode, which inflates measured locking between them. The engine reports locking in excess of a time-shifted surrogate, not the raw value.
- Front and back: the same comparison between the frontal pair and the temporal pair.

**Fast frame, 32 per second**

- Time.
- Per track: instantaneous frequency, amplitude, height above background, phase, lock, confidence, delay.
- Artifact flag for the current moment, so the sound can thin immediately when the signal is bad.

### 9.1 Bindings

These tables are a contract. A sound or visual element may read only the field listed, plus its declared smoothing.

Sound:

| Sound element | Field |
| --- | --- |
| Tracking tone pitch | Fast frame instantaneous frequency × 32 |
| Tracking tone loudness | Fast frame height above background, with a loudness ceiling |
| Tone present or absent | Track state and lock |
| Warmth and steadiness of the alpha tone | Alpha power above background relative to the person's baseline, and how long it has held |
| Bloom into a soft chord | Golden ratio aligned state and excess alignment. The chord is built from the measured tracks' own tones |
| The different bloom for octaves | Octave aligned state and excess alignment |
| Thinning of the sound | Artifact flag, lost lock, or null |

Hurricane, from the plan's table:

| What you see | Field |
| --- | --- |
| Rotation speed | Frequency of the strongest confirmed track |
| Number of spiral arms | Number of tracks in the golden ratio cascade |
| How tightly the arms wind | Golden ratio excess alignment |
| Ring structure | Octave excess alignment |
| Brightness of each arm | That track's height above background |
| Clarity of the eye | Time the cascade has held |
| Left and right symmetry | Hemisphere match |
| Pulse through the eye wall | Detected heartbeat (section 13) |
| Slow swell | Measured breathing rhythm (section 13) |
| Scattered cloud, no structure | Null, with the reason shown |

## 10. Choosing the methods: the bake-off

No method is adopted because it is standard or because this document's author expects it to win. Each stage has candidates. All are implemented in the Python reference lab first, run on the same test battery, and the winner is implemented in Rust.

### 10.1 Candidates

| Stage | Candidates |
| --- | --- |
| Spectrum | S1 multitaper. S2 Welch averaging with overlap. S3 irregular resampling, which separates rhythms from background by construction |
| Background and confirmation | P1 robust background fit plus the chi-squared height test (6.2, 6.3). P2 simple prominence over the median of neighbouring bins. P3 multitaper harmonic F-test. P4 fitted Gaussians over a fitted background, in the style of specparam |
| Peak frequency | Centroid above half height. Gaussian fit. Parabolic interpolation |
| Fast tracking | F1 narrow band-pass and analytic signal, instantaneous frequency weighted by amplitude. F2 phase-locked or frequency-locked loop. F3 short overlapping spectra with interpolation. F4 Kalman filter with an oscillator model. F5 cycle-by-cycle period measurement |
| Aligned state | T1 to T4 in section 8.4 |
| Chance level | Chance A, chance B, and the lab's heavier surrogates as the yardstick |

Note on P3: the F-test is built for pure sine lines. Brain rhythms are a little broad, so I expect it to miss real rhythms at 8 s. It stays in as a check on that expectation.

### 10.2 Test battery

The skeptic builds and owns the battery. The implementer of a candidate never sees the hidden answers.

**A. Planted cascades.** Synthetic recordings: background noise with a realistic slope (χ from 1 to 2), plus rhythms planted at known frequencies. Rhythms are realistic: 0.25 to 1.5 Hz wide, waxing and waning in bursts, drifting slowly. Planted as golden ratio cascades of 2, 3, 4 and 5 members, at 3, 6, 10 and 15 dB above background, at several starting frequencies.

**B. Planted octaves and near misses.** The same with octave cascades, and with steps of 1.5, 1.55, 1.7 and 1.8. This gives the tuning curve: detection rate as a function of the true ratio. A good method has a narrow curve centred on 1.618 and a separate one on 2.0.

**C. Nothing there.** Background noise only. Random peaks at unrelated frequencies. Real recordings with the samples shuffled, shuffled in blocks, phase-randomized, and with channels shifted against each other in time. White noise, and a recording of a headset sitting on a table.

**D. Harmonic trap.** Non-sinusoidal rhythms that produce true harmonics at 2 and 3 times the base.

**E. Artifacts.** Recorded and synthetic blinks, eye movements, jaw clenches, frowning, swallowing, head turns, walking, a loose electrode, an electrode pop, mains at 50 and 60 Hz, a railed channel.

**F. Hard cases.** A peak drifting across a band edge. Two peaks close together. A peak splitting. Two tracks crossing. A cascade that forms and dissolves on a known schedule, to measure detection delay. Rhythms that come in short bursts.

**G. Link faults.** Dropped packets at 0.1%, 1% and 5%. A clock running 0.5% fast. Classic and Athena streams, 4 and 8 channels.

**H. Repeatability.** The same file twice (must be identical). The same recording analysed starting at different offsets. The same person on different days, for the report only.

**I. Blind files.** A set with hidden ground truth and seeds that no implementer has seen, used once, for the final choice.

### 10.3 Pass marks (provisional)

| Test | Requirement |
| --- | --- |
| A at 10 dB and above | Every planted peak confirmed in at least 95% of files. Integrated frequency within 1% of truth. Correct cascade length in at least 90% |
| A at 6 dB | At least 80% of planted peaks confirmed. No false cascade members |
| A at 3 dB | Reported for information. Silence is acceptable. A wrong answer is not |
| B | Octave cascades labelled golden ratio in under 1% of files, and the reverse. Aligned-state rate for a 1.5 or 1.8 step under 10% of the rate at 1.618 |
| C | Confirmed peaks in background-only noise at or under the stated α_peak. Aligned state entered at or under the stated false alarm rate. Cascades of 3 or more steps: none in the whole set. Hurricane structure: none |
| D | At least 95% of harmonics marked as harmonic. No octave alignment credited |
| E | No confirmed peak, no aligned state and no cascade attributable to an artifact. Recovery within 3 s of the artifact ending |
| F | Detection delay and identity errors reported per candidate. The cascade schedule recovered with a median delay under 20 s |
| G | Up to 1% loss: results within the uncertainty of the clean run. At 5% loss: null, with the reason, and never a wrong value |
| H | Bit-identical on repeat. Offset changes results by no more than the reported uncertainty |
| Calibration | Reported standard errors match the actual spread of errors on test A, within a factor of 1.5 |
| Roadmap gate 2 | A synthetic 10 Hz signal reads 10.0 Hz within 0.1 |

### 10.4 Decision rule

1. A candidate that fails any requirement in C, D or E is out. Staying quiet when nothing is there matters more than sensitivity.
2. Among the rest, prefer the best detection at 6 dB on test A, then the narrowest tuning curve on test B, then the lowest delay, then the lowest cost.
3. If two candidates are within noise of each other, pick the one that is simpler to explain to a user.
4. The signal architect writes the result up with the numbers, the skeptic signs it off against the blind files, and this specification is updated before any Rust is written for that stage.

## 11. Performance, determinism and the reference lab

- **Speed.** A slow-path update must finish in under 50 ms on a mid-range Android phone in Chrome (provisional). The fast path must run faster than real time with a wide margin. The engine runs off the main thread.
- **Memory.** Bounded. No growth over a two-hour session beyond the stored track histories, which are capped.
- **Determinism.** Rule 6. Floating point operations are ordered so that the browser build and the native test build agree. Replay of a recorded session reproduces the live frames exactly, and a test asserts it.
- **Reference lab.** Python, using established libraries, implements every stage independently. On the recorded test set, Rust and Python must agree: peak frequencies within 0.05 Hz, heights within 0.5 dB, the same confirmed tracks, the same aligned-state intervals within one slow frame. Disagreement blocks a release until explained.
- **Versioning.** The output schema, the parameter set and the engine each carry a version, stored in every session.

## 12. Support for personalized training

The owner wants many training programs, with enough variables that each person can find an approach that suits them, and a way to test which approaches work for a given person. The engine does not contain training programs. It gives the training roles what they need to build and compare them.

- **Any measurement can be a target.** A training program names a field from the frames: a band's power above background, a track's frequency or strength, a hemisphere match, an aligned state, a cascade length, time in state. The engine has no hard-wired "alpha mode".
- **Programs are data.** A program is a description, not code: the target field, the direction, how the threshold is set and adapts, the timing of blocks, and which sound and visual bindings are active. The protocol designer fixes the format. The engine guarantees the fields it reads are stable across versions.
- **Baselines.** The engine computes a resting baseline for every field, over a block the program marks as baseline, with mean, spread and the amount of clean data behind it. Targets are expressed relative to the person's own baseline.
- **Markers.** The app writes markers into the session: block start and end, the technique in use (for example breath focus, visualization, attention between the eyes, open monitoring, eyes open or closed), instructions given, and anything the user reports. Markers are stored with the raw data.
- **Block statistics.** For any marked block and any field, the engine reports the change from baseline as an effect size with a confidence interval, the time taken to first reach the target, the fraction of the block spent in the target state, and how stable it was. It also reports the clean-data fraction, because a technique that makes someone frown or move will show as lost signal.
- **Profiling.** A profile is the set of block statistics across techniques for one person, across sessions. The engine supplies comparable numbers and their uncertainty. It also reports when a difference between two techniques is within noise, so the app does not tell someone they are "a visualizer" on the strength of one noisy block. How techniques are chosen, ordered and interpreted belongs to the training methods researcher and the protocol designer.
- **Order and fatigue.** Block statistics carry the time since session start and the block's position, so the training roles can correct for people simply settling down as a session goes on.

### 12.1 Personal state signatures and sound anchors

The owner wants people to connect with emotional states, see them reflected in their own rhythms, and later learn to return to a state on hearing a sound that is unique to them. The engine's part is measuring whether a state is real and repeatable for that person. It makes no claim about what any emotion looks like in general. On four dry electrodes the evidence for reading specific emotions from EEG is weak, so a signature is always personal and always tested.

- **A signature is learned from marked blocks.** The user marks blocks in which they produced a state, and resting or contrast blocks. The engine builds a signature: the small set of fields, brain and heart, that differ most reliably between the state blocks and the contrast blocks for this person, with the range each takes in the state.
- **A signature must earn its name.** It is reported as "reliable" only when it separates state from contrast on blocks that were not used to build it, across at least 3 sessions on different days (provisional), better than a signature built from the same blocks with their labels shuffled. Until then it is "still learning", and the app says so.
- **Detection uses the same rules as alignment.** Entering a signature state uses a threshold set from the person's own chance distribution, with dwell and hysteresis (section 8.4), and a stated false alarm rate.
- **Anchors are gated by measurement.** A sound anchor may be paired with a state only while the signature is detected. The engine reports, per pairing, whether the state was actually present. Later, when the anchor is played as a cue, the engine reports how quickly and how often the signature followed, compared with blocks where no cue or a neutral sound was played. That comparison is how the app finds out, honestly, whether the anchor works for this person.
- **The profile holds it.** A user profile stores the baselines, the block statistics per technique, the signatures with their reliability history, and the anchors with their pairing and test history. Profiles stay on the user's device.

## 13. Heart and breath

Built after the brainwave path and in the same build. Every rule in section 2 applies.

Sources, in order of preference when both are present:

1. **Chest strap.** Beat-to-beat intervals over the standard Bluetooth heart rate profile. The Polar H10 is the first target. This is the source for variability measures.
2. **Headset optical sensor.** Pulse times with a quality measure. The pulse reaches the forehead a fraction of a second after the heartbeat, with a delay that varies a little, so it is adequate for a heartbeat sound and weaker for precise variability. Measures derived from it are labelled with their source.

Processing:

- **Beat cleaning.** Missed and extra beats and ectopic beats are detected from the interval series (an interval far from the local median) and marked. They are excluded from variability measures and never interpolated silently. The corrected fraction is reported, and above a limit (provisional: 5% in the window) the variability outputs are null.
- **Heart rate** per beat and smoothed, with the smoothing declared.
- **Variability.** RMSSD and SDNN over a moving window (provisional: 60 s, with a 30 s fast option marked as less reliable). Power in the low band around 0.1 Hz and the high band, from the evenly resampled interval series. A resonance measure: how much of the heart rhythm's power sits in one narrow peak between 0.04 and 0.26 Hz, with that peak's frequency. Each needs a minimum window of clean beats or it is null.
- **Breathing.** Rate estimated from the heart rhythm, marked as an estimate with a confidence, null when the rhythm has no clear peak. When the breath pacer is running, the engine reports how closely the measured rhythm follows it.
- **High variability state.** Defined relative to the person's own baseline, entered and left by the same threshold, dwell and hysteresis rules as section 8.4. It can be a training target and part of a signature (12.1).

Brain and heart coupling:

- Candidate measures: correlation between the heart rhythm and the slow changes in a band's power or a track's strength; phase locking between the heart's 0.1 Hz rhythm and those slow changes; changes in EEG time-locked to heartbeats.
- Every coupling value is reported with a time-shifted surrogate alongside (rule 4), and needs several minutes of clean data from both sources. Two slow signals drift together by accident very easily, so this is where the skeptic looks hardest.
- **Pulse artifact.** The heartbeat can leak into EEG directly, electrically or through skin movement under an electrode. A coupling that is strongest at the pulse rate itself, on one channel, is flagged as likely artifact and not reported as coupling.

Frame fields: beat times, intervals with flags, heart rate, the variability measures, resonance frequency and strength, breathing estimate, pacer adherence, high variability state, coupling measures with their chance levels, and the source of each.

The breath pacer is a guide and is labelled as the one element that is not a measurement.

## 14. Provisional parameters

Every number here is a starting value. Each lives in one parameter file, is recorded in every session, and is expected to move in the bake-off.

| Parameter | Start value | Section |
| --- | --- | --- |
| Repairable gap | 12 samples | 3 |
| Repaired samples allowed in a window | 2% | 3 |
| High-pass corner | 0.5 Hz | 5.1 |
| Mains exclusion | ±2 Hz | 5.1 |
| Channel recovery time | 3 s | 5.2 |
| Artifact padding | 250 ms | 5.3 |
| Minimum clean fraction | 60% | 5.3 |
| Minimum clean stretch | 2 s | 5.3 |
| Slow window | 8 s (4 s option) | 6.1 |
| Slow update | 250 ms | 6 |
| Peak search range | 1 to 45 Hz | 6.1 |
| Background fit range | 2 to 45 Hz | 6.2 |
| α_peak, false peaks per window | 1% | 6.3 |
| Peak width limits | estimator resolution to 6 Hz | 6.3 |
| Persistence | 2 of the last 3 windows | 6.3 |
| Peak hold after last pass | 2 s | 6.3 |
| Integration time for ratio scoring | 30 s | 6.4 |
| Track joining distance | 3 standard errors or 1 Hz | 6.5 |
| Fast update | 32 per second | 7 |
| Fast path delay limit | 300 ms | 7 |
| Lost lock time | 1 s | 7 |
| Resolved limit on s_x | 0.03 | 8.2 |
| Tolerance ε | 0.03 | 8.2 |
| Intrinsic tolerance τ | 0.01 | 8.4 |
| Control ratios | 1.5 and 1.8 | 8.1 |
| Dwell before entering a state | 5 s | 8.4 |
| False entries allowed | 1 per 10 minutes | 8.4 |
| Surrogates per chance estimate | 200 | 8.5 |
| Minimum lag for chance B | 10 s | 8.5 |
| History needed for chance B | 120 s | 8.5 |
| Slow update time budget | 50 ms | 11 |

## 15. User settings and things to verify

The owner's standing rule: where a design choice is a matter of the user's preference, the user gets the setting, with a sensible default. These three were first written as open decisions and are now settings. Each is saved with the session, and none of them can switch off the rules in section 2.

- **Which chance level the hurricane uses.** Default: chance A, "more aligned than random peaks would be", so a steady, lasting alignment still forms a storm. Option: chance B, "moving into alignment together, beyond where each rhythm usually sits". Both are always shown in the readout whichever drives the storm.
- **Response speed of alignment.** Default: steady, 30 s integration (section 6.4). Options: quicker (shorter integration) and slower. The setting is labelled with what it costs: a quicker reading has a wider uncertainty, more pairs come back "unresolved", and the chance level is recomputed for the chosen speed, so a quicker setting cannot manufacture alignment.
- **Whether harmonics count toward octave alignment.** Default: no (section 6.6). Option: yes, in which case harmonic pairs are still marked as harmonic on screen.

To verify before or during implementation:

- Exact packet formats, scale factors and sequence counters for Classic and Athena, against muse-rs. Nothing in this document depends on a number recalled from memory.
- Whether the Muse 2's real sampling rate matches 256 Hz closely enough to ignore. Measure it with a signal generator.
- Whether 8-channel Athena data changes which composites are worth computing.
- All pass marks in 10.3, once the first real recordings exist.
