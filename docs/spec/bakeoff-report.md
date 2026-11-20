# Bake-off report: signal engine methods (spec section 10)

Status: first full run, 20 November 2026. The Python reference lab (`lab/`) produced every number here, using synthetic data only. Nothing here comes from a real Muse recording. The blind set (10.2 I) has not been run. The skeptic still has to sign this off against the blind files (10.4 step 4).

Section 13 compares the Rust engine (`hb-run`, built from commit 840deda at 22:15 UTC) with the lab on the cross-check fixtures.

Full tables, regenerated from the results files: `lab/out/bakeoff_tables.md`. Raw results: `lab/out/bakeoff_results_pass*.json`. How to reproduce: section 12.

---

## 1. Summary

**No candidate passes every provisional pass mark. Taken literally, the decision rule in 10.4 rules out every candidate**, because every one fails something in C, D or E. I ranked the candidates by how badly they miss C, D and E (section 2 explains how), then applied step 2 of the rule. The results:

| Stage | Recommended | Runner-up | Why, in one line |
| --- | --- | --- | --- |
| Spectrum | **S1Q**: multitaper, half-bandwidth 0.5 Hz, 7 tapers, eigenspectra smoothed to a resolution of max(1 Hz, 8% of f). This is a lab variant of S1 and is not in the 10.1 list | S1 (plain multitaper) | Same detection as S1 at 10 dB and above (98.2% against 99.4%). About 4 times fewer peaks caused by artifacts (25 windows against 107). No false cascade members at 6 dB (0/24 files against 5/24). Ties with S1 on tuning-curve width |
| Background and confirmation | **P1 with a tuned threshold**: the analytic chi-squared threshold times a factor of 1.280 (S1Q) or 1.248 (S1), fitted on background-only tuning files | P1 with the analytic threshold | P2 and P3 detect almost nothing (P2 0% at 6 dB, P3 0% even at 15 dB). P4 makes false and duplicate peaks in 30% and 47% of windows. The analytic P1 threshold lets through more false peaks than α_peak allows |
| Peak frequency | **Centroid of the excess** (power minus background) above half height | Centroid of the flattened spectrum (the spec's method) | Lowest bias: +0.17% against +0.9% on a pure sine, and gate 2 reads 9.998 against 10.020 Hz. Most tracks within 1% (52.9%). Lower tails in the calibration (robust z sd 1.35) |
| Aligned state | **T3 as amended in 8.4** (Λ taken at the smaller of s_x and s_x = 0), fixed thresholds ln Λ ≥ 2 to enter and ≥ 1 to stay, dwell 5 s | T4c (constant false alarm rate on closeness), chance A by band, 3.3% | Only rule that meets C (0.97 false entries per 10 min) while still entering on 75% of 6 dB and 100% of ≥10 dB golden cascades. Narrowest tuning curve. Median delay 24 s |
| Chance level | **Chance A placed by band**, as amended in 8.5 | Chance A over 1 to 45 Hz | By band, the share of windows wrongly at or above chance's 99th percentile falls from 8.3% to 3.9% on files with one peak per band. It is still anti-conservative: about 1% was expected |
| Fast tracking | **F1**: narrow band-pass, analytic signal, amplitude-weighted frequency | F5 (cycle periods) | Only tracker within the 300 ms delay limit (250 ms). RMS error 0.47 Hz. Cheapest |

What the recommended configuration (S1Q, P1 tuned, excess centroid, T3 amended, chance A by band) **meets**:

- No confirmed peaks in no-rhythm noise: 0 of 3,216 windows.
- No golden cascade of 4 or more members in any nothing-there file.
- No aligned state or cascade caused by an artifact.
- No octave state on harmonic rhythms.
- Control ratios: 0.00 at 1.5 and at 1.8.
- Results held up under 1% packet loss.
- Bit-identical output on repeat.
- Roadmap gate 2: the 10 Hz sine reads 9.998 to 10.000 Hz.
- False golden entries: 0.98 per 10 min, just under the limit of 1, counted over the 163 minutes of set C that are not spectrum-preserving surrogates.
- No hurricane structure on those files.

What it **misses**:

| Requirement | Measured |
| --- | --- |
| Integrated frequency within 1% of truth | 52.9% of tracks |
| Correct cascade length at the end of the file | 52.1% (100% at some point in the file) |
| 6 dB detection (80% required) | 65.5% |
| Harmonics marked harmonic (95% required) | 93.1% at 2x, 78.9% at 3x |
| Peaks caused by artifacts | 22 windows in 13 of 48 files |
| Recovery within 3 s of an artifact | 67% |
| Standard-error calibration (factor 1.5 allowed) | Off by 1.71 |
| Cascade schedule, median delay under 20 s | 24 s |
| Octave/golden labelling under 1% of files | 0/20 and 0/8, too few files to show under 1% |

Full list in section 9.

**Results that go against the spec**, given the same weight as the ones that confirm it (section 3 has the evidence):

1. The spec expected T3 with a T4 threshold to win. T4, the constant false alarm rate on the evidence ratio, failed C at every setting tried (1.43 to 2.04 false entries per 10 min). It also credited states to artifacts (8 entries) and labelled 4 of 20 octave files golden. T3 with a fixed threshold did better, but only after the amendment (Λ at s_x = 0). The first-draft T3 was the loosest rule of all (1.58 per 10 min, and 0.73 of the golden rate at a 1.55 step).
2. The analytic α_peak threshold is anti-conservative: 1.19% of background-only windows had a confirmed peak against the stated 1%. Calibration by simulation has to be part of the method.
3. Placing chance A by band (amended 8.5) is right for the null, but CFAR on it at the strict level made a real golden cascade nearly invisible: 2.5% of time in state, 11 of 12 formations missed. At the amended 3.3% level it meets C, but its median delay is 35 s.
4. Every pass mark for detection at 6 dB, frequency within 1%, error calibration and recovery within 3 s is missed by every candidate. Section 10 explains why some of these marks look physically out of reach for rhythms of the planted widths, or conflict with other parameters.
5. Decision rule 10.4 step 1 favours a detector that sees nothing. P3 detected no planted rhythm and still has the fewest C, D and E failures among the confirmation methods. The rule needs a minimum sensitivity before step 1 (section 2).
6. **Corrected pass rule for surrogates.** Block shuffling with blocks much longer than a rhythm's cycle (here 1 s), phase randomization and channel shifting all keep the spectrum. So a correct engine **should** still show the source's peaks, ratios and cascades. Only sample shuffling, or blocks shorter than a cycle, destroys them.

   The lab passes this rule. Sample shuffling removed all 31 planted peaks. Block shuffling kept 34 of 34, and the other two transforms kept 29 of 29. Golden-state presence matched the source in every block-shuffled and phase-randomized file. A phase-randomized golden cascade stays in the state 99% of the time under T1, which is the expected result.

   The first draft of this battery counted alignment on these surrogates as false entries. That was wrong, and they are now scored against their source (section 6). It follows that these surrogates test timing (chance B), not placement (chance A).

7. **The Rust engine follows the spec's T4 path**: a CFAR threshold on the amended ln Λ, with chance A placed by band. In the lab, that rule failed C at 1.59 false entries per 10 min and entered states on artifacts. On the fixtures, the engine agrees with the lab on window peak frequencies (median difference 0.031 Hz) but confirms fewer peaks at 6 dB. It also loses most windows under 1% packet loss (section 13).

---

## 2. How the decision rule was applied

10.4 step 1 says a candidate that fails any requirement in C, D or E is out. Every candidate fails E: some peak somewhere is attributable to an artifact, and no candidate recovers within 3 s every time. Most also fail D (95% of 3x harmonics marked). So the literal rule leaves nothing. I applied it in three steps and state each one so it can be challenged:

**0. Minimum sensitivity, a step I added.** A candidate must confirm at least 95% of planted peaks at 10 dB and above (the 10.3 A mark). Without this step, P3 would win confirmation, because a detector that never fires passes "stay quiet". P3 confirmed 0 of 168 planted peaks at 10 dB and above. This step removes:

| Candidate | Peaks confirmed at ≥10 dB |
| --- | --- |
| S3 | 56% |
| S1W1 | 89.3% |
| P2 | 15.5% |
| P3 | 0% |

**1. Rank by how severe the C, D and E failures are** (table below).

**2. Step 2 of 10.4**: detection at 6 dB, then tuning-curve width, then delay, then cost.

C, D and E failures per candidate. False entries are golden state entries per 10 min over all 196 minutes of set C.

| Candidate | Peak windows in no-rhythm files | False entries T1 / T4 / T4c | C files with golden cascade ≥4 / ≥3 members | D 2x marked | D 3x marked | D files with an octave pair or cascade at any time | E artifact peak windows (files) | E state entries T1/T4/T4c, cascades | E recovery ≤3 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1-P1 | 0/3216 | 2.09 / 1.12 / 0.30 | 1 / 4 | 95.1% | 87.1% | 4/24 | 107 (28) | 0/8/0, 3 | 68.9% |
| S1-P1 analytic | 25/3216 | 2.19 / 0.97 / 0.36 | 1 / 5 | 95.1% | 86.1% | 5/24 | 150 (33) | 1/8/0, 3 | 68.9% |
| S2-P1 | 0/3216 | 1.78 / 1.12 / 0.20 | 0 / 4 | 96.7% | 90.2% | 4/24 | 93 (30) | 0/20/0, 0 | 84.2% |
| S3-P1 ¹ | 1/3322 | 1.12 / 1.12 / 0.15 | 0 / 1 | 91.4% | 85.9% | 21/24 | 156 (33) | 0/0/0, 0 | 60.7% |
| S1W1-P1 | 0/3216 | 1.27 / 1.58 / 0.20 | 0 / 1 | **99.4%** | **97.1%** | 2/24 | **6 (5)** | 0/8/0, 0 | **87.1%** |
| **S1Q-P1** | 0/3216 | 1.78 / 1.27 / 0.30 | 0 / 1 | 94.6% | 80.5% | 2/24 | 25 (12) | 0/4/0, 0 | 68.3% |
| **S1Q-P1, excess centroid** | 0/3216 | 1.27 / 1.58 / 0.36 | 0 / 1 | 93.1% | 78.9% | 1/24 | 22 (13) | 0/8/0, 0 | 67.0% |
| S1-P2 | 0/3216 | 0.30 / 0.30 / 0.15 | 0 / 0 | 79.9% | 83.3% | 0/24 | 2 (1) | 0/0/0, 0 | 68.2% |
| S1-P3 | 1/3216 | 0 / 0 / 0 | 0 / 0 | n/a | n/a | 0/24 | 3 (3) | 0/0/0, 0 | n/a |
| S1-P4 ¹ | 28/3327 | 2.75 / 1.48 / 0.30 | 2 / 5 | 94.8% | 86.4% | 22/24 | 609 (42) | 11/4/1, 10 | 91.0% |

¹ Pass 1 only, run before the harmonic "pending" and "family" rules, the 65 to 95 Hz muscle band, the contact check and the refined attribution existed. That is why its D octave column is high. Rerun before relying on it.

**Reading.** Among the candidates that pass step 0:

- **S1Q** has the fewest artifact peaks (22 to 25 against 93 to 150), no artifact cascades, at most one ≥3-member cascade on nothing-there files, and the fewest harmonic files with octave credit.
- Its weak spot is D at 3x: 79 to 81% of 3x harmonics marked, against 87 to 90% for S1 and S2. These unmarked 3x harmonics did not turn into octave or golden states (0/24 octave states under T1, T3 and T4c).

S1W1 is the quietest candidate of all, but it fails step 0 (89.3%) and has the poorest precision:

- 32.5% of integrated frequencies within 1%.
- A close double resolved in 2% of windows.
- Rate at a 1.7 step equal to 0.65 of the rate at 1.618 under T1.

**Step 2** decides little among the survivors: 6 dB detection is 66.7% (S1Q) against 72.6% (S1) against 65.5% (S2), and 61/84 against 56/84 is within noise. S1Q is preferred because step 1 favours it clearly, and step 2 does not reverse that. The tuning curves of S1 and S1Q are close (section 5).

**Proposed change to 10.4**: put the A ≥10 dB detection mark in front of step 1, and state step 1 as rates with confidence limits, not as "any".

---

## 3. What was run

Five passes. Each later pass only adds configurations; the battery and seeds are unchanged.

| Run | Configurations | Notes |
| --- | --- | --- |
| Pass 1 (51 min) | All 10.1 candidates, frequency estimators, trackers, deliberately broken builds | Run before the fixes listed below; S3-P1 and S1-P4 come only from this pass |
| Pass 2 (37 min) | Every candidate except S3-P1 and S1-P4, plus the S1Q variants; F, G and H for S1-P1, S1Q-P1 and S1Q-P1 with the excess centroid | Runs with the fixes |
| Pass 3 (5 min) | S1Q variants with chance A placed by band | Spec 8.5 was amended during the run (section 11) |
| Pass 4 (5 min) | The same with the amended threshold under chance A, 3.3% exceedance in place of the lab's 1/120 | |
| Pass 5 (4.5 min) | The same with the amended T3 | |

The fixes made between pass 1 and pass 2:

- Harmonic "pending" rule: a pair is excluded until 3 harmonic tests have run.
- Harmonic "family" rule: 2f and 3f of one base count as harmonic.
- Muscle band moved from 30–45 Hz to 65–95 Hz.
- Motion resting level set at the 25th percentile.
- Contact check: raw mains amplitude ≥ 80 µV means no skin contact.
- Refined artifact attribution.

Pass-2 S1-P1 digests equal pass-1 digests where those changes do not apply, and pass-3 to pass-5 S1Q peak results equal pass 2. All runs are deterministic: the output is identical on repeat (set H, 4 of 4 files, per configuration).

**Tuning.** Thresholds were tuned on 48 background-only files (3,984 windows; seeds 1,000,000 and up) to α_peak = 1% per window. Test files use seeds 2,000,000 and up. No threshold was tuned on a test file.

| Key | Threshold |
| --- | --- |
| S1/P1 (factor on analytic) | 1.248 |
| S1Q/P1 | 1.280 |
| S1W1/P1 | 1.235 |
| S2/P1 | 1.143 |
| S3/P1 (absolute, pass 1) | 2.386 |
| S1/P2 (prominence) | 7.517 |
| S1/P3 (F statistic) | 26.0 |
| S1/P4 (pass 1) | 0.392 |
| S1/P1 analytic, 56 dof | 1.799 |

**Battery.** All synthetic. Background is 1/f^χ with χ from 1 to 2. Rhythms are 0.25 to 1.5 Hz wide, burst and drift. Files are 90 to 120 s at 256 Hz, 4 channels.

| Set | Contents |
| --- | --- |
| A | 96 files: cascades of 2 to 5 members × 3, 6, 10 and 15 dB × 6 |
| B | 108 files: 3-member cascades at 12 step ratios from 1.45 to 2.1 × 8, plus 12 extra octave files |
| C | 142 files, 196 minutes: background, white noise, headset on table, random peaks (log-uniform and one per band), and 4 surrogate kinds made from random-peak recordings |
| D | 24 files: non-sinusoidal rhythms at 5 to 12 Hz with locked 2x and 3x harmonics |
| E | 48 files: 12 artifact kinds × 4, each with a clean twin for attribution |
| F | 44 files: form/dissolve schedule, drift across a band edge, close double, split, crossing, short bursts, a 180 s steady cascade with heavier surrogates |
| G | 48 files: loss of 0.1%, 1%, 5% and 1% in bursts, and a clock 0.5% fast |
| H | 20 files: repeat runs and starting offsets |

The lab hops 1 s; the engine will hop 250 ms. Delays below are therefore resolved to 1 s.

---

## 4. Results by stage

Percentages are pooled over planted peaks, windows or files, as labelled, with counts. "6 dB" and so on are nominal: the effective height an 8 s window sees is up to about 2 dB lower, because of bursting and drift (`lab/fixtures/README.md`).

### 4.1 Spectrum (all with P1 tuned, centroid of flattened spectrum)

| Config | A 6 dB peaks confirmed | A ≥10 dB peaks confirmed | A ≥10 dB cascade length right at end | A 6 dB files with a false cascade member | A ≥6 dB windows with an unmatched peak | A ≥6 dB windows with a duplicate peak | A ≥10 dB integrated freq within 1% | Close double resolved (F) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | 72.6% (61/84) | 99.4% (167/168) | 52.1% | 20.8% (5/24) | 8.1% | 24.0% | 46.5% | 29.1% |
| S2 (Welch) | 65.5% (55/84) | 98.2% (165/168) | 45.8% | 20.8% (5/24) | 6.1% | 13.4% | 46.8% | n/r |
| S3 (IRASA) ¹ | 30.9% (26/84) | 56.0% (94/168) | 12.5% | 0% | 2.7% | 10.9% | 45.5% | n/r |
| S1W1 (W = 1 Hz) | 63.1% (53/84) | 89.3% (150/168) | 45.8% | 0% | 1.0% | 0.3% | 32.5% | 2.1% ¹ |
| **S1Q** | 66.7% (56/84) | 98.2% (165/168) | 58.3% | **0%** | 1.7% | 3.7% | 50.6% | 29.1% |

n/r: not run. ¹ pass 1.

Plain S1 makes a duplicate peak in 24% of windows, because one lumpy rhythm gives several local maxima. Non-maximum suppression cuts the number of duplicates. The smoothing in S1Q cuts it further, to 3.7%, without losing the 0.03 resolution S1W1 gives up.

### 4.2 Background and confirmation (spectrum S1)

| Config | A 6 dB | A ≥10 dB | A 3 dB | Unmatched-peak windows | Duplicate-peak windows | C no-rhythm windows with a peak | E artifact peak windows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 tuned | 72.6% | 99.4% | 1.2% | 8.1% | 24.0% | 0.00% (0/3216) | 107 |
| P1 analytic | 81.0% | 99.4% | 15.5% | 13.3% | 25.6% | **0.78% (25/3216); background-only 1.19%** | 150 |
| P2 prominence | 0.0% | 15.5% | 0% | 0.06% | 0.04% | 0% | 2 |
| P3 F-test | 0.0% | 0.0% | 0% | 0% | 0% | 0.03% | 3 |
| P4 fitted Gaussians ¹ | 75.0% | 100.0% | 0% | **30.0%** | **46.6%** | 0.84% | 609 |

The spec's own note on P3 is confirmed: the F-test is built for pure lines and finds none of these rhythms in 8 s windows, even at 15 dB.

P2's threshold, tuned to 1% on background, is so high that it confirms only the strongest rhythms. P4 (specparam style) fits several Gaussians to one rhythm and to background lumps.

### 4.3 Peak frequency (S1 and S1Q, P1 tuned)

| Config | A ≥10 dB integrated within 1% | 10 dB median rel. error | 10 dB 95th pct rel. error | 6 dB median rel. error | Calibration z sd (≥6 dB) | Robust z sd | Gate 2 track (Hz) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1, centroid of flattened | 46.5% | 0.0110 | 0.0365 | 0.0135 | 1.78 | 1.77 | 10.021 |
| S1, centroid of excess | 50.9% | 0.0112 | 0.0323 | 0.0133 | 1.71 | 1.48 | n/r |
| S1, Gaussian fit | 46.2% | 0.0108 | 0.0333 | 0.0142 | 1.74 | 1.58 | n/r |
| S1, parabolic | 40.5% | 0.0138 | 0.0418 | 0.0183 | 1.64 | 1.52 | n/r |
| S1Q, centroid of flattened | 50.6% | 0.0095 | 0.0378 | 0.0124 | 1.73 | 1.71 | 10.019 to 10.020 |
| **S1Q, centroid of excess** | **52.9%** | 0.0102 | 0.0345 | 0.0142 | 1.71 | **1.35** | **9.998 to 10.000** |

Integrated frequency within 1%, by planted rhythm width (≥10 dB):

| Width | S1 flattened | S1Q flattened | S1Q excess | S1W1 |
| --- | --- | --- | --- | --- |
| 0.25–0.5 Hz | 51% (37/73) | 52% | 60% (44/73) | 13% |
| 0.5–0.8 Hz | 53% | 54% | 49% | 43% |
| 0.8–1.5 Hz | 31% (12/39) | 44% | 43% (16/37) | 50% |

Why the excess centroid wins:

- **Bias.** The flattened-spectrum centroid is biased upward, because dividing by a falling 1/f background raises the high side of a peak. It reads a pure 10.000 Hz sine as 10.02 Hz (+0.2%). In set A the median bias is about +0.9%. Subtracting the background gives +0.17% and reads the sine as 9.998 to 10.000 Hz.
- **Calibration.** Its z distribution has the lightest tails (robust sd 1.35).

The spec's amended 6.4 notes the same bias as "still open". This is the evidence for settling it.

**Roadmap gate 2 is met** by every S1 and S1Q configuration tested: the gate-2 fixture's track reads 9.998 to 10.021 Hz, and every window peak reads 9.996 to 10.026 Hz.

### 4.4 Fast trackers (pass 1; 10 Hz rhythm at 10 dB unless stated)

| Tracker | RMS error (Hz) | 10 Hz 6 dB | 20 Hz 10 dB | 6 Hz 10 dB | Bias at 6 dB (Hz) | Null frames | 50% step delay | Step gain | Cost (µs/sample, Python) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **F1 band-pass + analytic signal** | 0.47 | 0.49 | 0.51 | 0.48 | −0.12 | 50% | **250 ms** | 0.93 | **0.12** |
| F2 phase-locked loop | 0.85 | 0.97 | 0.95 | 1.20 | −0.33 | 36% | 312 ms | 0.93 | 1.38 |
| F3 short spectra | 0.44 | 0.56 | 0.66 | 0.44 | −0.13 | 43% | 531 ms | 0.93 | 2.10 |
| F4 Kalman filter | 0.49 | 0.55 | 0.46 | 0.60 | −0.28 | 63% | 344 ms | 0.93 | 12.2 |
| F5 cycle periods | 0.43 | 0.45 | 0.60 | 0.39 | −0.08 | 48% | 406 ms | 1.02 | 0.23 |

F1 is the only tracker within the 300 ms delay limit. Its accuracy is within 0.05 Hz of the best, and it is the cheapest.

The RMS errors of 0.4 to 0.6 Hz are mostly the rhythm's own wander: these rhythms drift and are 0.25 to 1.5 Hz wide. The null frames (36 to 63%) are the bursts' quiet stretches under the amplitude floor.

Not tested: lost-lock and bounds logic, the amended amplitude floor of 1.73 RMS, and settling after gating.

---

## 5. Tuning curve (set B)

Time in the golden state against the true step ratio. These are 3-member cascades at 10 dB, 8 files per ratio. The columns are rules, on S1Q with the excess centroid. "T3 am." is the amended T3. "T4c band 3.3%" is the closeness CFAR with chance A placed by band, at the amended threshold.

| True step | T1 | T2 | T3 first draft | **T3 am.** | T4 whole range 1/120 | T4c whole range 1/120 | T4c band 1/120 | T4c band 3.3% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.45 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 1.50 | 7.1% | 7.1% | 9.8% | **0.0%** | 0.0% | 0.0% | 0.0% | 0.0% |
| 1.55 | 52.0% | 45.8% | 61.8% | **23.3%** | 9.3% | 3.9% | 2.0% | 5.9% |
| 1.58 | 78.4% | 75.2% | 80.9% | 59.1% | 22.8% | 15.2% | 4.9% | 17.9% |
| **1.618** | 82.6% | 82.6% | 84.3% | **75.5%** | 33.8% | 30.9% | 2.5% | 18.6% |
| 1.65 | 88.7% | 88.7% | 100.0% | 82.3% | 40.7% | 28.4% | 13.5% | 29.4% |
| 1.70 | 13.2% | 11.5% | 30.4% | **4.7%** | 1.0% | 0.0% | 0.0% | 1.0% |
| 1.75 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 1.80 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 0.2% |
| 1.90 to 2.10 | 0.0% | 0.0% | 0.0% | 0.0% | ≤ 2.2% | 0.0% | ≤ 1.2% | ≤ 3.9% |

Rate at each control ratio divided by the rate at 1.618 (pass mark: under 0.1 at 1.5 and at 1.8):

| Rule | 1.5 | 1.55 | 1.7 | 1.8 | Octave files labelled golden | Golden files labelled octave |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 0.09 | 0.63 | 0.16 | 0.00 | 0/20 | 0/8 |
| T3 first draft | 0.12 | 0.73 | 0.36 | 0.00 | 0/20 | 0/8 |
| **T3 amended** | **0.00** | **0.31** | **0.06** | **0.00** | 0/20 | 0/8 |
| T4 whole range, 1/120 | 0.00 | 0.28 | 0.03 | 0.00 | **4/20** | 0/8 |
| T4c whole range, 1/120 | 0.00 | 0.13 | 0.00 | 0.00 | 0/20 | 0/8 |
| T4c band, 3.3% | 0.00 | 0.32 | 0.05 | 0.01 | 0/20 | 0/8 |

The same on S1 (centroid of flattened), T1: 0.05 at 1.5, 0.41 at 1.55, 0.42 at 1.7, 0.03 at 1.8; time at 1.618 86.0%. On S1W1, T1: 0.00, 0.26, **0.65**, 0.00.

Reading:

- Every rule meets the 1.5 and 1.8 control mark.
- No rule tells 1.618 from 1.55 reliably at 30 s integration (0.13 to 0.73). This is what spec 6.4 predicts.
- The amended T3 is the narrowest rule that still keeps most of the time in state at 1.618 (75.5%).
- The first-draft T3 is the widest: a vague measurement widened its acceptance. This is the defect the amendment fixes, and the fix is confirmed here.
- **0 of 20 and 0 of 8 cannot show "under 1% of files"**: the 95% upper limits are 16% and 32%. About 300 files per arm would be needed.

Octave state on the octave files (T1): entered in 100% of the 2.0 files under S1W1, and in 37 to 87% under the CFAR rules on S1Q (in `lab/out/bakeoff_tables.md`). It is entered much less often than golden at 1.618, because S1Q's resolution of max(1 Hz, 8% of f) leaves fewer resolved octave pairs at low frequency.

---

## 6. Measured chance levels (set C and set A)

These are on S1Q with the excess centroid. "Windows ≥99th pct" is the share of windows where the observed golden closeness is at or above chance A's 99th percentile. If chance A were calibrated, that would be about 1% on files with unrelated peaks.

| Files | Chance A placement | Mean expected closeness under chance A | Windows ≥99th pct | Files ending at or above the 95th pct |
| --- | --- | --- | --- | --- |
| Random peaks, one per band (30) | 1 to 45 Hz | 0.052 | **8.3%** | 13% |
| Random peaks, one per band (30) | by band | 0.115 | **3.9%** | 7% |
| Random peaks, log-uniform (30) | 1 to 45 Hz | 0.121 | 2.4% | 7% |
| Random peaks, log-uniform (30) | by band | 0.140 | 2.8% | 7% |
| Planted golden pair, ≥10 dB (12) | 1 to 45 Hz | 0.026 | 41.3% | 83% |
| Planted golden pair, ≥10 dB (12) | by band | 0.083 | 15.3% | 42% |
| Planted golden cascade of 3–5, ≥10 dB (36) | 1 to 45 Hz | 0.166 | 23.9% | 72% |
| Planted golden cascade of 3–5, ≥10 dB (36) | by band | 0.254 | 16.4% | 44% |

- **Placement by band corrects most of the over-calling on band-structured peaks.** The rate falls from 8.3% to 3.9%, but chance A is still 3 to 4 times anti-conservative. Likely causes, not separated here:
  - the best-pair search over tracks that are not independent of each other (tracks born on the same rhythm);
  - the generator's peak placement (log-uniform over 2 to 40 Hz, one per band with band edges) not matching the null's exactly.
- **Against band-placed chance, a single theta–alpha golden pair is weak evidence**: only 42% of planted golden pairs end at or above the 95th percentile. The spec says this in 8.5. This measures it.
- **Chance B was never available at the end of an A or C file.** These files are 90 to 120 s, and chance B needs 120 s of track history after an 8 s window and a 30 s integration. It was available only in the 180 s steady cascades of set F, and there only for some tracks. Chance B is effectively untested.
- **Spectrum-preserving surrogates: the pass rule is "same as the source".** A block shuffle with blocks much longer than a rhythm's cycle (the battery uses 1 s blocks, which is 3 cycles or more of anything at 3 Hz and above), a phase randomization and a channel shift all keep each channel's spectrum. A correct engine should therefore still find the source's peaks and ratios, and its cascades. A whole-app test that found a cascade surviving a 2 s block shuffle saw the expected behaviour. Only sample shuffling, or blocks shorter than one cycle, destroys the rhythms.

  Checked here with the recommended configuration, each surrogate against its own unshuffled source (8 files per kind, `lab/out/surrogate_vs_source.txt`):

  | Transform | Planted peaks found in source / in surrogate | Golden state (T3) time, source / surrogate | Files where state presence differs |
  | --- | --- | --- | --- |
  | Sample shuffle (must destroy) | 31/31 → 0/31 | 4.5% / 0.0% | 1 (correct: the shuffle removed it) |
  | Block shuffle, 1 s blocks (must keep) | 34/34 → 34/34 | 0.0% / 0.0% | 0 |
  | Phase randomization (must keep) | 29/30 → 29/30 | 0.0% / 0.0% | 0 |
  | Channel shift (must keep) | 29/29 → 29/29 | 8.0% / 16.3% | 0 |

  Every transform met its rule. On the 180 s steady golden cascade, time in the golden state under T1 was:
  - 88% on the original;
  - 99% phase-randomized;
  - 64% block-shuffled.

  These are expected. Block shuffling cuts the 30 s integration's continuity, which explains its lower figure. The block-shuffled cascade is still present, as it should be.

  Consequences:
  - Alignment on these files is not counted as false entries in C. The C rates and the hurricane check in section 9 use the other 118 files (163 minutes).
  - The heavier surrogates test chance B (timing) and the engine's agreement with itself. They do not test chance A (placement). Spec 8.5's sentence that "the live chance levels must agree with these within a stated margin" needs restating per chance level.
- **A broken build caught.** `broken-chance-single-pair` scores chance on one random pair instead of the full search. It produced 6.4% of windows at or above the 99th percentile on log-uniform files, against 0.9%.

---

## 7. Aligned-state rules compared

All on S1Q with the excess centroid. C counts over all 196 minutes; F is the form-and-dissolve schedule, 12 formations.

| Rule | C false entries per 10 min | … on band-structured random peaks | A entered, 6 dB | A entered, ≥10 dB | Time in state at 1.618 | D octave state | E artifact state entries | F median entry delay, missed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 fixed ε = 0.03 | 1.27 ✗ | 2.41 | 83% | 100% | 82.6% | 0/24 | 0 | **18 s, 0** ✓ |
| T2 scaled, capped | 1.07 ✗ | 2.17 | 83% | 100% | 82.6% | 0/24 | 0 | 18 s, 0 ✓ |
| T3 first draft | 1.58 ✗ | 3.37 | 88% | 100% | 84.3% | 0/24 | 0 | 18 s, 0 ✓ |
| **T3 amended** | **0.97 ✓** | 2.17 | 75% | 100% | 75.5% | 0/24 | 0 | 24 s, 0 ✗ |
| T4 (CFAR, ln Λ), whole range, 1/120 | 1.58 ✗ | 2.65 | 79% | 69% | 33.8% | 2/24 | **8** | 41 s, 4 ✗ |
| T4c (CFAR, closeness), whole range, 1/120 | 0.36 ✓ | 1.21 | 54% | 60% | 30.9% | 0/24 | 0 | 48 s, 5 ✗ |
| T4, band, 1/120 | 1.43 ✗ | 1.93 | 71% | 50% | 3.7% | 2/24 | 8 | 33.5 s, 10 ✗ |
| T4c, band, 1/120 | 0.20 ✓ | 0.48 | 29% | 29% | **2.5%** | 0/24 | 0 | 65 s, **11** ✗ |
| T4, band, 3.3% (amended 8.4) | 2.04 ✗ | 3.61 | 88% | 96% | 19.6% | 2/24 | 8 | 29 s, 3 ✗ |
| T4c, band, 3.3% (amended 8.4) | 0.71 ✓ | 1.69 | 54% | 88% | 18.6% | 0/24 | 0 | 35 s, 3 ✗ |
| T4 on amended ln Λ, band, 3.3% | 2.04 ✗ | 3.61 | 88% | 96% | 20.3% | 2/24 | 8 | 29 s, 3 ✗ |

Reading:

- The C column counts all 196 minutes, including the spectrum-preserving surrogates, which should keep their source's alignment (section 6). Counted correctly, over the 163 minutes of the other files, the rates are T1 1.10, T3 amended 0.98, T4 1.59 and T4c (band, 3.3%) 0.67. The ranking does not change.
- **No rule meets both C and the F delay.**
- The amended T3 comes closest: it meets C, by a small margin, and its delay of 24 s misses 20 s by 4 s.
- Under 10.4, C comes first, so the amended T3 is recommended.
- The C margin is small. 0.97 per 10 min is 19 entries in 196 minutes, with a 95% Poisson interval of about 0.6 to 1.5. More C data could move it either way.
- Every false entry came from files with real but unrelated peaks: random peaks and their surrogates. No false entries came from background, white noise or a headset on the table, under any rule.
- **T4 on ln Λ is the most dangerous rule tested.** It enters on artifacts (8 entries in E, all rules on the same files: eye movements, head turns, jaw clench, walking), credits octave states on harmonic files (2/24), and labels octave cascades golden (4/20). I did not diagnose why. A suspect is the chance distribution of ln Λ having a large atom at "unresolved", which drags the CFAR quantile down. Do not ship T4 on ln Λ without that diagnosis.
- The delays for T1 (18 s) are set by persistence (two of three windows 8 s apart, so at least 9 s) plus the 30 s integration settling the ratio, not by the 5 s dwell. Meeting a 20 s median with a stricter rule needs a shorter integration time. That costs precision (spec 6.4), and it was not tested.

---

## 8. Sets D to H in brief (recommended spectrum S1Q, excess centroid)

**D, harmonic trap.**

- Marked harmonic: 2x 93.1%, 3x 78.9%.
- Octave state: entered in 0/24 files under T1, T3 and T4c.
- An octave pair or cascade appeared at some moment in 1 of 24 files.
- Before the pending and family rules (pass 1), the 1.5 control (2f:3f) entered in 24 of 24 files.
- `broken-no-harmonic-test` enters the octave state in 24 of 24.

**E, artifacts.**

| Artifact | Artifact peak windows | Recovery ≤3 s |
| --- | --- | --- |
| Blinks | 6 | 85% |
| Eye movements | 2 | 88% |
| Head turns | 7 | 37% |
| Jaw clench | 1 | 42% |
| Swallow | 5 | 25% |
| Frown | 0 | 56% |
| Walking | 1 | 0% (gated as motion; 40% of windows null) |
| Electrode pop, loose electrode, railed, mains | 0 | n/a |

- Mains detected at the right frequency in 8/8 files.
- State entries caused by artifacts: 0 under T1, T3 and T4c.
- `broken-no-gating`: 692 artifact peak windows and 10 state entries.

**F, hard cases.**

| Case | Every planted peak confirmed | Median window error | Notes |
| --- | --- | --- | --- |
| Drift across a band edge | 92% of windows | 0.07 Hz | 1.0 track per file, so no split at the edge |
| Close double | 28% | | 7.75 tracks born per file; the resolution of max(1 Hz, 8% f) cannot separate them |
| Split | 59% | | |
| Crossing | 59% | | |
| Short bursts | 81% | | |

**G, link faults.**

| Fault | Result |
| --- | --- |
| 0.1% and 1% loss | Every track within 2 SE of the clean run (21/21); 8.6% null windows at 1% |
| 1% in bursts | 39% null windows, tracks still within 2 SE |
| 5% loss | 97.6% null windows and **no wrong value** (no peak window absent from the clean run). The 2.4% not null are windows under the 2% repaired-sample limit, as the rule says |
| Clock 0.5% fast | Ratios unaffected |

**H, repeatability.**

- Identical on repeat: 4/4.
- Starting offsets of 64, 137 and 200 samples changed integrated frequencies by no more than the combined reported SE in 94.3% of tracks (largest difference 0.245 Hz).

---

## 9. Pass marks (10.3) for the recommended configuration

Configuration `S1Q-P1-excess-band-a033-t3min`: S1Q, P1 with factor 1.280, centroid of excess, chance A by band, rule T3 amended. G and H come from `S1Q-P1-excess`, because chance placement and rule do not change them.

| Test | Requirement | Measured | Result |
| --- | --- | --- | --- |
| A ≥10 dB | Every planted peak confirmed in ≥ 95% of files | 98.2% of planted peaks (165/168), pooled per peak | met |
| A ≥10 dB | Integrated frequency within 1% of truth | 52.9% (82/155) of matched tracks; 95th percentile error 3.45% | **missed** |
| A ≥10 dB | Correct cascade length in ≥ 90% | 52.1% (25/48) at the final window; 100% (48/48) reach the right length at some point; 49% of late windows right | **missed** |
| A 6 dB | ≥ 80% of planted peaks confirmed | 65.5% (55/84) | **missed** |
| A 6 dB | No false cascade members | 0/24 files | met |
| A 3 dB | Silence acceptable, a wrong answer is not | 0/24 files with a false cascade member; peaks confirmed 0% | met |
| B | Octave labelled golden < 1% of files, and the reverse | 0/20 and 0/8; 95% upper limits 16% and 32% | **not shown** (sample too small) |
| B | Rate at 1.5 and 1.8 under 10% of the rate at 1.618 | 0.00 and 0.00 | met |
| C | Confirmed peaks in no-rhythm noise ≤ α_peak | 0.00% (0/3216) | met |
| C | Aligned state ≤ 1 false entry per 10 min | 0.98 over the 163 min of C that excludes spectrum-preserving surrogates (13 of 118 files had an entry); 0.97 over all 196 min | met, narrowly |
| C | Cascades of 3 or more steps: none | 0 files | met |
| C | Hurricane structure: none | 0 files. The one golden 3-member cascade in C was in a 1 s block-shuffled recording, which should keep its source's peaks and ratios, so it is not a failure | met |
| C | Surrogates: sample shuffle destroys peaks; block shuffle (blocks longer than a cycle), phase randomization and channel shift keep the source's peaks and ratios | 0/31 kept after sample shuffle; 34/34, 29/30 and 29/29 kept after the others (section 6) | met |
| D | ≥ 95% of harmonics marked | 2x 93.1%, 3x 78.9% | **missed** |
| D | No octave alignment credited | Octave state 0/24; an octave pair or cascade at some moment in 1/24 | **missed** (state met) |
| E | No confirmed peak attributable to an artifact | 22 windows in 13 of 48 files | **missed** |
| E | No aligned state or cascade attributable to an artifact | 0 and 0 | met |
| E | Recovery within 3 s | 67.0% (120/179) | **missed** |
| F | Schedule recovered, median delay under 20 s | 24 s entry, 6.5 s exit, 0 of 12 missed, no time in state outside the schedule | **missed** |
| G | ≤ 1% loss within the clean run's uncertainty | 21/21 tracks within 2 SE | met |
| G | 5% loss: null with reason, never a wrong value | 97.6% null, 0 wrong values | met |
| H | Bit-identical on repeat | 4/4 | met |
| H | Offset changes ≤ reported uncertainty | 94.3% (33/35) within the combined SE | met |
| Calibration | Reported SEs within a factor of 1.5 of the actual spread | sd of error/SE 1.71 (robust 1.35); 80.6% within ±1.96 | **missed** |
| Roadmap gate 2 | 10 Hz sine reads 10.0 ± 0.1 | 9.998 to 10.000 Hz | met |

Pass-mark tables for the other configurations (S1-P1 under T1 and T4c, S1Q-P1, and the CFAR variants) are at the end of `lab/out/bakeoff_tables.md`.

---

## 10. Recommended changes to section 14 (and 10.3), with evidence

| Parameter | Now | Recommended | Evidence |
| --- | --- | --- | --- |
| α_peak threshold | Analytic chi-squared with Šidák correction | Keep α_peak = 1%, but set the threshold by simulation on background-only files. New parameter: "peak threshold factor over analytic" = 1.280 for S1Q (1.248 for S1). Recalibrate whenever the spectrum or window changes | Analytic: 1.19% of background-only windows with a peak, after persistence; 0.78% across no-rhythm files; 40% more artifact peak windows (150 against 107). Tuned: 0/3216 |
| Spectrum resolution | Multitaper W = 0.5 Hz (8 s window) | Add "spectral smoothing: max(1 Hz, 8% of f)" on the eigenspectra | Duplicate-peak windows 24% → 3.7%; false cascade members at 6 dB 5/24 → 0/24; artifact peak windows 107 → 25 (4.1, 2) |
| Peak frequency estimator | Centroid of flattened spectrum above half height | Centroid of the excess (power − background) above half height | Bias +0.9% → +0.17%; gate 2 10.020 → 9.998 Hz; within 1% 46.5% → 52.9% (4.3) |
| Muscle detection band (5.3) | 30–45 Hz implied | 65–95 Hz, flag above 4× the channel's resting median | At 30–45 Hz the detector gated genuine beta and gamma rhythms. Moving it cut gating of clean samples without raising jaw or frown peaks (pass 1 against pass 2) |
| Motion resting level (5.3) | — | 25th percentile of the accelerometer magnitude, not the median of the first 60 s | Walking that began early was missed with the median |
| Contact check (5.2) | — | Raw mains amplitude ≥ 80 µV means no skin contact; mark the channel bad | Headset-on-table files produced confirmed peaks without it, and 0 with it (C, 10 files) |
| Harmonic test (6.6) | Mark harmonic when locking passes | Add: a 2:1 or 3:1 pair is excluded from scoring until 3 tests have run ("pending"), and two harmonics of one base (2f:3f) are harmonic too ("family") | The 1.5 control entered on harmonic files in 24/24 before the change and 7/24 after; octave entered in 0/24 |
| Aligned-state rule | T1 to T4 candidates | T3 as amended (Λ = min over s_x and 0), entry ln Λ ≥ 2, exit ≥ 1, dwell 5 s. Add the two thresholds to section 14 | Section 7: the only rule meeting C with useful sensitivity |
| T4 under chance A | "5% of unrelated placements (measured 3.3%)" | Do not use CFAR on ln Λ for the state. Closeness CFAR at 3.3% is the fallback if T3 fails on real data | Section 7: T4 on ln Λ fails C at every level and enters on artifacts |
| Chance A placement | Within the track's own band (amended) | Keep. Add a calibration test: the share of unrelated-peak windows at or above chance's 99th percentile, required ≤ 2% | By band 3.9% against 8.3%; still 3 to 4 times nominal (section 6) |
| ε for cascades | 0.03 for every step | Keep ε for entering. Let an existing cascade member stay while its step is within the hold level (1.33 ε), as states already do. **Not tested** | At ≥10 dB a step's log-ratio error has sd ≈ 0.023. Half the final-window cascade misses had every member present but one step at 0.032 to 0.064. The other half had a member missing because of bursting |
| False entries allowed | 1 per 10 minutes | State it as a rate with a confidence limit, measured on ≥ 10 hours of nothing-there data, and say in the UI what it means per session | 196 minutes gives about ±50% on a rate near 1 |
| History for chance B | 120 s | Make the battery's files ≥ 300 s and test chance B before keeping or changing this | Chance B was never available at the end of a 90 to 120 s file (section 6) |
| Recovery within 3 s (10.3 E) | 3 s after the artifact ends | "Within 3 s after the first window that no longer contains the artifact", or drop persistence to 2 of the last 2 after a gap | With persistence of 2 of 3 windows 8 s apart, a peak lost in an artifact cannot return in 3 s unless one window before the artifact still counts. Head turns, jaw, swallow and frown recover in 25 to 56% |
| Frequency within 1% (10.3 A) | Integrated frequency within 1% | "Within 2 reported SE in 95% of tracks", plus a bias limit (median signed error ≤ 0.3%) | Even the best estimator places only 60% of 0.25–0.5 Hz rhythms and 43% of 0.8–1.5 Hz rhythms within 1% over 30 s; the 95th percentile is 3.4% |
| 6 dB detection (10.3 A) | ≥ 80% | Keep as a goal, but note that no candidate meeting α_peak reaches it. Best: S1 72.6%. Only the anti-conservative analytic threshold reaches 81% | 4.1, 4.2 |
| "None in the whole set" (10.3 C) | Cascades of 3+ steps, hurricane: none | A rate compared with chance A's own rate for the same number of tracks | With enough files, unrelated peaks form a 3-member golden cascade by chance (spec 8.5: 0.57% for three banded peaks at 3%) |
| Surrogates in 10.2 C | Shuffled in blocks, phase-randomized and channel-shifted recordings listed under "nothing there" | Move them out of "nothing there". The pass rule: blocks much longer than a cycle, phase randomization and channel shifts keep the spectrum, so the source's peaks and ratios must still be found. Only sample shuffling or sub-cycle blocks must remove them | Section 6. A whole-app test that found a cascade surviving a 2 s block shuffle was showing correct behaviour |
| Labelling < 1% (10.3 B) | Under 1% of files | Specify the number of files: about 300 per arm to show < 1% with 0 errors | 0/20 and 0/8 only bound it under 16% and 32% |
| Decision rule (10.4) | C, D or E failure removes a candidate | Put the A ≥10 dB detection mark first; then rank C, D and E by rate | Section 2 (P3) |

Kept and not varied: window 8 s, persistence 2 of 3, hold 2 s, integration 30 s, joining distance max(3 SE, 1 Hz), dwell 5 s, hysteresis 1.33, s_x limit 0.03, τ 0.01, 200 surrogates, repair 12 samples, 2% repaired limit, padding 250 ms, minimum clean 60%. The battery gave no evidence against these, and none of them was swept.

---

## 11. Limitations and what is missing

**Data.**

- Everything is synthetic: the backgrounds, the rhythms and the artifacts. No real Muse recordings were available. The real-recording parts of C (shuffled real recordings) used synthetic random-peak recordings instead.
- Artifacts are models of blinks, muscle and the like, not recordings. Real artifacts will be less tidy.
- The accelerometer is simulated.
- Athena 8-channel streams (G) were not tested.
- "The same person on different days" (H) was not possible.

**Spec amendments made during this work.** The spec was amended twice while the bake-off ran (milestone review, 19:25 and 20:01). This lab implements:

| Amendment | Status here |
| --- | --- |
| Chance A by band | Implemented (passes 3 to 5) |
| Threshold at 3.3% under chance A | Implemented (pass 4) |
| T3 with Λ at the smaller of s_x and 0 | Implemented (pass 5) |
| Background as a cubic curve with a lack-of-fit check (6.2) | **Not implemented**. The lab fits a robust power law. The C backgrounds are pure power laws or white, so the knee, noise-floor and filter-edge cases the amendment measured were **not tested** here |
| Integrated SE as the plain mean with pooled v1/v2 (6.4) | **Not implemented**. The lab uses max(jackknife × overlap inflation, scatter / √n_eff). The calibration failure (z sd 1.71) is for the lab's formula |
| Chance B lag-difference and floor rules | **Not implemented**; chance B was rarely available anyway |
| Fast-path amplitude floor (1.73 RMS), settling after gating, lost-lock and bounds | **Not tested** |

**Method coverage.**

- T3 uses chance A's whole-range density for q, not "the person's own baseline", which synthetic files do not have.
- Only one integration time (30 s) and one window (8 s, no 4 s option) were run.
- S3 and P4 were run only in pass 1, before the fixes listed in section 3. Their C, D and E numbers are not comparable, but their A results already rule them out.
- F, G and H for S1W1 and S1 with the excess centroid are pass 1.
- G and H were not rerun for the band and T3 variants, because they do not change those measures.
- The lab hops 1 s, not 250 ms, so delays are resolved to 1 s.

**Rust engine.** Compared on the 21 fixtures only, not on the battery (section 13).

**Not measured.**

- The 50 ms slow-path budget and memory. The lab is Python and timings would be meaningless.
- Hemisphere and front–back fields.
- Heart and breath (section 13).

**Sample sizes.** The sets are modest:

| Set | Files |
| --- | --- |
| A | 24 per SNR |
| B | 8 per ratio |
| C | 142 files, 196 minutes |
| D | 24 |
| E | 4 per artifact kind |

Counts are given beside every percentage; read small differences as noise.

**Blind set (I) not run.** `lab/make_blind.py` is ready. It creates its seeds from the operating system on first run, in `lab/blind/.seeds`, which is not committed (`lab/.gitignore`). The skeptic should run it once, hand only `lab/blind/files/` to the implementer, and score the final choice against `lab/blind/truth/`.

---

## 12. Reproduction and files

```
python3 lab/run_bakeoff.py --configs S1-P1,S1-P1-analytic,S2-P1,S3-P1,S1W1-P1,S1-P2,S1-P3,S1-P4,S1-P1-excess,S1-P1-gauss,S1-P1-parabolic --fgh-configs S1-P1,S1W1-P1,S1-P1-excess --out lab/out/bakeoff_results_pass1.json   # pass 1 (code since changed; see section 3)
python3 lab/run_bakeoff.py --configs S1-P1,S1-P1-analytic,S2-P1,S1W1-P1,S1Q-P1,S1-P2,S1-P3,S1-P1-excess,S1-P1-gauss,S1-P1-parabolic,S1Q-P1-excess --fgh-configs S1-P1,S1Q-P1,S1Q-P1-excess --no-trackers --out lab/out/bakeoff_results_pass2.json
python3 lab/run_bakeoff.py --configs S1Q-P1-band,S1Q-P1-excess-band --sets A,B,C,D,E,F --fgh-configs S1Q-P1-band,S1Q-P1-excess-band --no-broken --no-trackers --out lab/out/bakeoff_results_pass3_band.json
python3 lab/run_bakeoff.py --configs S1Q-P1-excess-band-a033 --sets A,B,C,D,E,F --fgh-configs S1Q-P1-excess-band-a033 --no-broken --no-trackers --out lab/out/bakeoff_results_pass4_a033.json
python3 lab/run_bakeoff.py --configs S1Q-P1-excess-band-a033-t3min --sets A,B,C,D,E,F --fgh-configs S1Q-P1-excess-band-a033-t3min --no-broken --no-trackers --out lab/out/bakeoff_results_pass5_t3min.json
python3 lab/report_tables.py                       # merges the five results files into lab/out/bakeoff_tables.md
python3 lab/make_fixtures.py --expected lab/out/bakeoff_results_pass2.json --config S1Q-P1-excess-band-a033-t3min
```

The fixtures committed in `lab/fixtures/expected/` were written with the command above, so they hold the recommended configuration. Their T4 entries correspond to the engine's rule.

The Rust comparison in section 13:

```
CARGO_TARGET_DIR=/home/user/targets/lab cargo build -p hb-engine --release
for f in lab/fixtures/*.json; do n=$(basename $f .json); /home/user/targets/lab/release/hb-run lab/fixtures/$n > OUT/$n.jsonl; done
python3 lab/compare_rust.py OUT                    # writes lab/out/rust_vs_lab.md and .json
```

| Path | What it is |
| --- | --- |
| `lab/hb_lab/generators.py` | Synthetic recordings, artifacts, surrogates, link faults |
| `lab/hb_lab/candidates.py` | Spectra S1, S2, S3, S1W1, S1Q; P1 to P4; trackers F1 to F5; pair and cascade scoring; chance A |
| `lab/hb_lab/pipeline.py` | The full slow path: gating, quality, peaks, tracks, harmonic test, states, chance A and B |
| `lab/hb_lab/battery.py`, `lab/run_bakeoff.py`, `lab/report_tables.py` | The battery, the runner and the tables |
| `lab/fixtures/` | 21 cross-check recordings for the Rust engine with known answers, plus the lab's own output for each (README inside) |
| `lab/make_blind.py` | The blind-set generator (seeds kept out of the repository) |

**Deliberately broken builds** run in the battery. Each one was caught by the test named beside it:

| Broken build | Caught by | Broken | Correct S1-P1 |
| --- | --- | --- | --- |
| Per-bin chi-squared threshold (no multi-bin correction) | C peaks in no-rhythm files | 10.7% of windows | 0.0% |
| Log-fit bias not corrected | Same | 2.6% | 0.0% |
| Jackknife SE only (no overlap or scatter correction) | Calibration z sd | 8.07 | 1.78 |
| No artifact gating | E artifact peak windows, state entries | 692, 10 | 107, 0 |
| No harmonic test | D octave state entered (T1) | 24/24 | 0/24 |
| T2 without the cap | B time in state at 1.7 | 51.7% | 27.2% |
| Chance scored on one pair, not the full search | C windows ≥ chance's 99th pct | 6.4% | 0.9% |

---

## 13. Rust engine against the lab on the fixtures (spec 11)

**What was run.**

- `hb-run` was built from commit 840deda (`git status` clean for `crates/`) at 22:15 UTC on 20 November 2026, with `CARGO_TARGET_DIR=/home/user/targets/lab cargo build -p hb-engine --release`. The build succeeded on the first try.
- It ran on all 21 fixtures in `lab/fixtures/`, with default parameters.
- The lab ran the recommended configuration (section 9) on the same files.
- Each lab window (hop 1 s) was paired with the engine slow frame (hop 250 ms) nearest in time, within 0.26 s.

Full table: `lab/out/rust_vs_lab.md`. Per-file data: `lab/out/rust_vs_lab.json`. Script: `lab/compare_rust.py`.

**What was compared.** The engine's frame has no separate list of window peaks, so:

- Lab window peaks were compared with the engine's confirmed tracks' window frequency (`freq`).
- Lab integrated tracks were compared with the engine's `freq_integrated`.
- Two frequencies were paired when within 0.5 Hz. Spec 11 asks for agreement within 0.05 Hz.
- "Same confirmed set" means the same number of confirmed tracks, with every one paired.
- For states, the engine's `states.phi.active` was compared with the lab's T3 (recommended) and T4 (CFAR on ln Λ, which is the engine's rule).

### 13.1 Overall

| Measure | Result | Spec 11 |
| --- | --- | --- |
| Window peak frequency, paired peaks | 2,355 paired (lab 3,251 peaks, engine 2,901). Median difference 0.031 Hz. **63.9% within 0.05 Hz** | Within 0.05 Hz: **not met** |
| Integrated frequency, paired tracks | 2,401 paired (lab 3,352, engine 2,901). Median difference 0.055 Hz. **46.9% within 0.05 Hz** | **Not met** |
| Same confirmed tracks | **995 of 1,843 windows (54%)** | Same tracks: **not met** |
| Gate-2 sine | 44 of 45 peaks paired, all within 0.05 Hz (median 0.001 Hz). Same set in 52 of 53 windows | Met |
| Background only, white noise | Neither confirms anything (0 and 0) | Met |
| Golden state intervals | Agree with lab T4 in 59 to 100% of windows per file, and with lab T3 in 16 to 100%. Entry times differ by 6 to 40 s where both enter | Within one slow frame: **not met** |

### 13.2 Disagreements, by file

| Fixture | What differs |
| --- | --- |
| `phi3_10db_loss1pct` | **The engine loses almost everything under 1% packet loss.** Its spectra are null with reason "gap" for 67% of site-windows (2,261 of 3,360). It confirms tracks in 24 windows, against the lab's 210, and never enters the golden state (lab T3: in state 63% of the time). The fixture marks each lost packet as 12 NaN samples, and spec 3 says gaps of up to 12 samples are repaired. The engine (through `hb-run`) treats them as gaps that void the window. Either the repair is not in this path, or `hb-run` should hand NaN runs to the device layer's gap API. As it stands, this fails 10.3 G ("up to 1% loss: within the uncertainty of the clean run") |
| `phi2_6db` | **Less sensitive at 6 dB.** The engine confirms 7 track-windows, the lab 42 peaks. Neither enters the golden state. The engine uses the analytic threshold split across sites (Bonferroni over 4 sites, each site's own spectrum). The lab uses a composite over channels with a tuned threshold. Per section 4.2, the analytic threshold alone is anti-conservative. The per-site split is the likely reason the engine is stricter here; not separated |
| `phi3_10db`, `phi5_15db` | Track counts differ: on `phi3_10db` the engine has fewer confirmed track-windows (188 against the lab's 268 peaks); on `phi5_15db` it has slightly more (483 against 459). Same set in only 32 and 25 of 113 windows. **Golden state:** the engine enters at 50.25 s and is in state 0.9% of the time on `phi3_10db`. The lab's T3 enters at 31 s and is in state 71% of the time; its T4 enters at 79 s. On `phi5_15db` the engine enters only at 119.5 s, the lab's T3 at 25 s. The engine's CFAR rule is much slower than the lab's T3, as section 7 found for T4-type rules |
| `nearmiss_1.7_10db`, `nearmiss_1.8_10db` | **The engine enters the golden state on near-miss controls:** at 55.75 and 89.5 s on the 1.7 file, and at 63.25 s on the 1.8 file. The lab's T3 does not. The lab's T4 enters on the 1.8 file at 81 s. This is the control-ratio test of 10.3 B, on one file each. Not conclusive, but it matches the lab's finding that CFAR on ln Λ is looser at the controls |
| `harmonic_8hz` | **The engine credits octave alignment to a harmonic.** At 53.25 s the 16 Hz track had lost its harmonic mark (`harmonic_of` null), and the octave state became active with cascade [8 Hz, 16 Hz]. It stayed active in 44 of 360 frames. The lab never enters the octave state on this file. This fails 10.3 D. The lab's "pending" rule (exclude until 3 tests have run) and "2 of the last 3" rule would hold the mark |
| `artifact_blinks`, `artifact_jaw_clench` | The engine confirms more tracks in artifact files: 141 against 115, and 129 against 88. Their frequencies differ more: within 0.05 Hz in 41% of pairs, against 70% on clean files. The engine detects muscle at 30–45 Hz; the lab moved to 65–95 Hz (section 10). Whether the extra tracks are artifacts was not attributed on the engine side |
| `harmonic_8hz` frequencies | Within 0.05 Hz in 41% of pairs, median 0.063 Hz. The engine reports each track from its strongest site; the lab from the channel composite |
| `nearmiss_1.55_10db` | The lab's T3 enters (30 and 67 s), the engine does not. The lab's T3 is the looser of the two at 1.55 (section 5: 0.31 of the golden rate) |
| `form_dissolve_120s` | Both enter during the schedule (25 to 70 s): the engine at 47.5 s, the lab's T3 at 42 and 67 s. Neither is in state outside it |
| `octave3_10db`, `random_bands`, `drift_band_edge`, `artifact_railed_mains60`, `phi3_10db_phase_randomized` | No golden state in either on the first four. On the phase-randomized copy, both enter, as the corrected rule expects (engine 48.25 s, lab 25 s). Frequencies within 0.05 Hz in 59 to 75% of pairs |

### 13.3 Why the two differ, and what is not a bug

Some of these differences are design differences, not errors on either side. Spec 11 still asks for agreement, so they need a decision:

1. **Per site against composite.** The engine scores each site and reports a track from its strongest site. The lab averages the spectra of clean channels. This alone moves a window centroid by a few hundredths of a hertz, and it moves which peaks pass.
2. **Threshold.** The engine uses the analytic threshold split across sites. The lab uses one tuned on simulation (section 10, first row).
3. **Spectrum.** The engine uses plain multitaper (S1) with a background curve. The lab uses S1Q with a power law.
4. **State rule.** The engine uses CFAR on ln Λ (T4-type). The lab recommends a fixed T3.
5. **Integrated frequency.** The engine uses the plain mean over 30 s at a 250 ms hop, as amended in 6.4. The lab uses a 1 s hop.

Until the engine and the lab run the same method, the fixtures can only confirm agreement where the methods coincide. That is the case for the sine (100% within 0.05 Hz) and the empty files (both silent).

**Disagreements that are engine faults whatever the method:**

- The loss of nearly every window under 1% packet loss.
- The octave state credited to a harmonic.

The near-miss entries and the slow golden entries are the expected cost of the T4-type rule (section 7).
