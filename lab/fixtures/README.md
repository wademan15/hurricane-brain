# Cross-check fixtures for the Rust engine

Synthetic recordings with known answers, written by `lab/make_fixtures.py` (deterministic: fixed seeds).
There are no real Muse recordings here yet.

## Format

- `<name>.f32`: little-endian float32, samples interleaved by channel in the order TP9, AF7, AF8, TP10
  (sample 0 of every channel, then sample 1, and so on), in microvolts, 256 Hz. A lost 12-sample
  packet is NaN on every channel for those 12 samples (only in `phi3_10db_loss1pct`). The engine's device
  layer is expected to turn NaN runs into explicit gaps (spec section 3).
- `<name>.json`: `{"channels": ["TP9","AF7","AF8","TP10"], "rate_hz": 256, "seed": N, "kind": "...",
  "duration_s": T, "truth": {...}}`. `truth.peaks` lists every planted rhythm: nominal centre `f0`,
  spectral width `bw` (standard deviation of its Gaussian spectral shape, Hz), nominal `snr_db`, the mean
  of its realised centre frequency over the file `mean_freq_hz`, and the realised centre frequency once a
  second `traj_1hz`. Cascades also carry `ratio`, `n_members`, `cascade_freqs`; artifacts carry onset and
  end times; `form_dissolve_120s` carries its `schedule`.
- `expected/<name>.lab.json` (if present): the Python lab's own output on that file with the configuration
  named inside it, one entry per 1 s analysis window (the engine updates every 250 ms; compare at matching
  window end times). Spec 11 asks Rust and Python to agree on peak frequencies within 0.05 Hz, the same
  confirmed tracks and the same aligned-state intervals within one slow frame.
  The committed set was written with `--expected lab/out/bakeoff_results_pass2.json --config S1Q-P1-excess-band-a033`
  (the bake-off's recommended configuration, see docs/spec/bakeoff-report.md: S1Q spectrum, P1 with the tuned
  factor 1.280, excess centroid, chance A placed by band, CFAR thresholds at the 3.3% exceedance of the amended
  spec 8.4). The lab hops 1 s, so compare at the engine frames whose end time is a whole second.
  Per window: `peaks` = `[frequency Hz, window SE Hz (-1 if none), height dB over background, width Hz]`,
  `tracks` = `[track id, integrated frequency Hz, integrated SE Hz]`, `null` = reason or null.
  `states[target][rule]` = window end times at which that state was entered.

SNR convention: the rhythm's nominal peak spectral density over the background density at its centre
(the same as `lab/precision_and_chance_sketch.py`). Bursting, drift and the estimator's own smoothing
make the height an 8 s window sees lower than nominal, by up to about 2 dB for 0.25 Hz wide rhythms.

## Files

| Name | Length | What it is | What a correct engine does |
| --- | --- | --- | --- |
| `gate2_sine_10hz` | 60 s | Pure 10.000 Hz sine over 1/f background | Reads 10.0 Hz within 0.1 (roadmap gate 2) |
| `phi3_10db` | 120 s | 3-member golden ratio cascade at 10 dB | Three confirmed tracks, golden ratio cascade of 3 |
| `phi5_15db` | 120 s | 5-member golden ratio cascade at 15 dB | Five tracks, cascade of up to 5 |
| `phi2_6db` | 90 s | 2-member golden ratio pair at 6 dB | Usually both confirmed |
| `phi3_3db` | 90 s | 3-member cascade at 3 dB | Silence is acceptable, a wrong answer is not |
| `octave3_10db` | 120 s | 3-member octave cascade at 10 dB, independent rhythms | Octave alignment, never golden ratio, not marked harmonic |
| `nearmiss_1.5_10db`, `nearmiss_1.55_10db`, `nearmiss_1.7_10db`, `nearmiss_1.8_10db` | 90 s | 3-member cascades with near-miss steps | Golden ratio state mostly absent (1.55 and 1.7 are hard) |
| `background_only` | 90 s | 1/f background only | No confirmed peaks |
| `white_noise` | 60 s | White noise | No confirmed peaks |
| `random_bands` | 90 s | Unrelated peaks, one per band (theta, alpha, sometimes beta) | Peaks confirmed; any alignment is chance and must be shown beside chance |
| `harmonic_8hz` | 90 s | Non-sinusoidal 8 Hz rhythm with phase-locked harmonics at 16 and 24 Hz | 16 and 24 Hz marked harmonic, no octave credit |
| `artifact_blinks` | 90 s | Two genuine rhythms (alpha, beta) plus 20 blinks on AF7/AF8 | Blinks gated, no blink peaks |
| `artifact_jaw_clench` | 90 s | Same plus 6 jaw clenches | Muscle gated |
| `artifact_railed_mains60` | 90 s | One channel railed from 40 s, plus 60 Hz mains on all | Mains detected as 60 Hz, railed channel excluded |
| `form_dissolve_120s` | 120 s | 3-member golden cascade whose outer members are present 25 to 70 s | State enters after 25 s and leaves after 70 s, with the delays reported |
| `drift_band_edge` | 90 s | One rhythm drifting 7.4 to 8.6 Hz across the theta/alpha edge | One track, not two |
| `phi3_10db_loss1pct` | 120 s | `phi3_10db` with 1 % of packets lost (NaN) | Same answer within uncertainty; some windows null |
| `phi3_10db_phase_randomized` | 120 s | Phase-randomized copy of `phi3_10db` | Same peaks and ratios (the spectrum is kept); shows what this surrogate can and cannot test |
