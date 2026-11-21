# Fake test report: hurricane and sound, end to end through the built app

Nothing in the app was changed by this test. Tooling is in `app/e2e/`; generated recordings and screenshots are in `app/e2e/out/` (git-ignored).

## Second run (21 November 2026): summary

The first-run failures that mattered are mostly fixed: noise-only input is now exact digital silence with no bed in the audio control stream, the 5-member golden ratio cascade and the octave cascade now reach their states and bloom, the harmonic recording gets no octave credit, a second session in one page load has sound, and the live screen stays after the replay ends. **Remaining failures:** (1) the new recording with BOTH cascades never reaches "Both at once" (the golden chain is not distinguishable from chance when seven peaks are present, so only the octave side holds); (2) `nearmiss_1.55_10db` draws a golden ratio spiral (2 arms, 0.83) although its state never holds and no bloom sounds; (3) in "as fast as possible" replay the banner says "the numbers below show not measured" while the numbers still show a held golden ratio state and the picture is still dissolving 4 to 6 s after the end; (4) in `form_dissolve_120s` the golden state enters 22.5 s late, leaves 3.75 s early and re-enters 6.75 s after the cascade is gone (spurious 2 s); (5) the golden state holds only 84 of 320 slow frames in `phi3_10db` and the first entry is at 70 s, so the chord is late and intermittent (this is a sensitivity note, not a pass-rule failure).

### Build and which numbers come from where

- Built once: wasm and `tsc -b` and `vite build --outDir /home/user/dist-faketest` finished **00:29:50 UTC on 21 Nov** (wasm md5 prefix 48a30a344ed5, the same wasm as the earlier 23:18 build). `tsc -b` printed one error in a test file (`src/ui/test/appearance.test.ts`, a type error from the app engineer's work in progress), so the build is not clean; the bundle was still produced and is the one tested. Served by `vite preview --outDir /home/user/dist-faketest --port 4391 --strictPort`. The UI was being re-themed concurrently: this build is the new theme (state badges, plain wording "Random peaks did this well: 7 in 100"); my driver reads the `state-phi`, `state-oct`, `state-both` badges, `cell-*` cells and the replay-finished banner.
- **Visual numbers** (screenshots, tap-to-inspect, readout text, pixel pairs): replay speed **4x** in one page load, 24 recordings, `out/v2speed4/`. I did not use "as fast as possible" for the timeline because the whole recording then plays in under 1 s of wall time, so there is no 30 s or 60 s moment to look at; I used it only for the end-of-replay check (`out/fastcheck/`, two recordings). The 4x pass has no sound (the app starts sound only at 1x) and samples about every 2 to 7 s of recording time, so state "holding" counts from it are coarse.
- **Audio control stream in the app** (what the real `AudioEngine` posts to its worklet: voices on, golden/octave/both bloom amounts, bed on): replay speed **1x with sound**, a fresh browser per recording, 24 recordings, `out/fresh2_*`, summarised by `analyze-audio-msgs2.py`.
- **Offline audio render and engine states** (RMS of full mix, tone layer and bloom layer; state edges): recording -> real decode -> wasm engine in Node -> `FrameBinder` and `SynthCore` at 48 kHz, `out/audio-offline2.json`. Run twice; identical both times (so the engine and audio are deterministic here).
- **Two sessions back to back, one page load, 1x** (`out/twosess`): see below.
- Recordings made as before (12-bit Muse 2 Classic packets through the real decode path), plus the new ones (`out/recordings/index.json`). `phi3_10db_loss1pct` has 29 lost packets (NaN runs) made into dropped packets; `artifact_railed_mains60` has 12,800 samples clipped by the 12-bit range (the railed channel); a 20 ms block shuffle (5-sample blocks, seed 20260103) was added; `both_phi_octave_12db` was generated with `lab/hb_lab/generators.py` (`app/e2e/make_both.py`): golden ratio cascade 3.0, 4.85, 7.85 Hz plus an independent octave cascade 6.2, 12.4, 24.8 Hz, 12 dB each, 120 s, truth in `out/fixtures-extra/both_phi_octave_12db.json`.

### Second-run verdict table (failures first)

"State on" is from the app's state badges (4x pass, coarse) and from the engine frames (offline, exact). Bloom: in-app control stream max over the run, and offline RMS. "Spiral" and "rings" from tap-to-inspect probes (6 points at each of 3 to 4 marks) and screenshots.

| Recording | Planted | Peaks shown | Steps / alignment shown | Spiral / rings / combined look | States holding (offline frames) | Blooms (in-app max voice value; offline bloom-layer RMS) | Expected | Verdict |
|---|---|---|---|---|---|---|---|---|
| `both_phi_octave_12db` | golden 3.0/4.85/7.85 plus octave 6.2/12.4/24.8, 12 dB | 7 confirmed at once; golden members flicker (3.0, 5.0, 7.5 Hz), octave members steady (12, 24.5) | golden 0 to 1 step, alignment 0.00 to 0.69; octave 1 step, 0.89 to 1.0; chance A golden 0.09 to 0.18 | Rings yes (4 ring probes); **no spiral, no combined look** (`faketest2-1-both-recording-FAIL-octave-only-no-both-state.png`) | octave from 38.5 s (327 frames); golden never; **both never** | octave bloom 1.0 in-app, RMS up to 5.1e-3; golden 0; both 0 | spiral, rings, combined look, three blooms, "Both at once" | **FAIL** |
| `nearmiss_1.55_10db` | steps of 1.55 (hard) | 3 to 4 | golden alignment up to 0.83 at 1 step | **2 arm probes, a spiral with an eye** | not holding (offline phi steps 1, active 0) | none | state mostly absent | **FAIL** (soft: continuous spiral without state or bloom) |
| `phi3_10db_shuffled_2s_blocks` | phi3, 2 s blocks shuffled | alpha 12.1, theta 4.6, 7.4 | golden 2 steps, up to 1.0 | spiral yes (2 arm probes) | golden 123 frames | phi bloom 1.0 in-app, bloom RMS 6.4e-3 | matches source | **PASS** (source: phi bloom 0.98, 84 frames) |
| `phi3_10db_shuffled_20ms_blocks` | phi3, 5-sample blocks shuffled | none | not measured | calm water, 0 changed pixels in 2 s pairs | none | none; exact digital silence in the offline render (peak 0.0, both channels) | calm, silent | **PASS** |
| `phi3_10db_shuffled_samples` | phi3 shuffled per sample | none | not measured | calm water, 0 changed pixels | none | none; exact silence; in-app bed on 0.0 of frames | calm, silent | **PASS** |
| `background_only` | nothing | none | not measured, reason shown | calm water (`faketest2-4-background-calm-water.png`), 0 changed pixels in 2 s pairs | none | none; exact silence offline; in-app bed on 0.0 of frames, voices 0 | calm, silent | **PASS** |
| `white_noise` | nothing | none | not measured | calm water | none | none; exact silence; in-app bed 0.0 | calm, silent | **PASS** |
| `phi3_3db` | 3-member phi at 3 dB | none | not measured | calm water | none | none; exact silence; bed 0.0 | silence acceptable, no wrong answer | **PASS** |
| `phi2_6db` | 2-member phi at 6 dB | 1 at times | not measured / 0 steps | cloud band only | none | none (RMS 0 median; one short tone) | usually both confirmed | **PASS** (it did not confirm the pair; silence is acceptable) |
| `phi3_10db` | 3-member phi 4.6/7.44/12.04, 10 dB | alpha ~11.9 to 12.3, theta ~7.4, theta ~4.6 | golden up to 0.98, 2 steps | spiral yes (3 arm probes) | golden 84 of 320 frames, on at 70, 88, 114.75 s | phi bloom 0.98 in-app; bloom RMS up to 2.0e-3 (tones median 1.2e-2) | spiral and bloom | **PASS** (late and intermittent) |
| `phi5_15db` | 5-member phi, 15 dB | 6 to 7 | golden up to 0.96, 4 steps, "a chain of 5 peaks" | spiral yes, 5 arm probes (`faketest2-3-phi5-spiral-holding.png`) | golden 291 of 320 frames, on at 29 s (first-run: 0) | phi bloom 0.999 in-app; bloom RMS up to 1.2e-2 | spiral and bloom | **PASS** (first-run FAIL fixed) |
| `octave3_10db` | 3-member octave 4.5/9/18 | alpha 9.0, beta 16 to 18, theta 4.6 | octave up to 0.99, 1 to 2 steps, "5 in 100" / "1 in 100" | rings yes (`faketest2-2-octave-holding-rings.png`), no spiral | octave 122 frames, on at 89.75 s (first-run: 0) | octave bloom 0.999 in-app; RMS up to 4.1e-3; phi 0 | rings, octave bloom, no phi | **PASS** (late: on only from 89.75 s; the state badge held at 60 s in the 4x pass because the 4x clock label runs ahead of the mark names) |
| `phi3_10db_phase_randomized` | phi3 phase-randomised | same as source | golden 2 steps up to 1.0 | spiral yes (7 arm probes) | 193 frames, on at 32.5 s and 5 more times | phi bloom 0.9994; RMS up to 7.9e-3 | matches source | **PASS** (more state time than the source, 193 against 84 frames; peaks and ratios match) |
| `phi3_10db_loss1pct` | phi3 with 1% lost packets | same | golden 2 steps | spiral yes | 100 frames, on at 69.5, 88, 111.75 s (source: 70, 88, 114.75) | phi 0.98 | matches source within reason | **PASS** |
| `form_dissolve_120s` | cascade, outer members present 25 to 70 s | 3 | golden 2 steps | spiral yes (3 arm probes) | on 47.5 s, off 66.25 s, on again 76.75 to 79 s | phi bloom 0.97; RMS up to 2.8e-3 | enter after 25 s, leave after 70 s, delays reported | **FAIL-ish, reported**: entry delay **22.5 s**, exit **3.75 s before** the schedule end (66.25 against 70), spurious re-entry 76.75 to 79 s (6.75 s after the cascade left) |
| `harmonic_8hz` | 8 Hz plus 16, 24 Hz harmonics | 8.0, 15.7 to 16.5, 23.8 to 24.7 | golden 0 steps; octave 0 steps and 0.00 (first-run 0.83 to 0.998) | cloud bands only | none | none | no octave credit | **PASS** (first-run FAIL fixed) |
| `random_bands` | unrelated 7.87, 12.18 Hz | theta ~7.7, alpha ~12.1 | golden up to 0.52, 0 to 1 step | no arm probes (first-run: a 1-step spiral) | none | none | tones allowed, no spiral | **PASS** |
| `artifact_blinks` | alpha, beta plus 20 blinks | alpha and beta only | 0.00 / 0.00 | cloud bands | none | none; offline peak 0.233 | no storm from blinks | **PASS** |
| `artifact_jaw_clench` | alpha, beta plus 6 clenches | alpha, beta | 0.00, octave up to 0.06 | cloud bands | none | none | no storm from clenches | **PASS** |
| `artifact_railed_mains60` | one channel railed from 40 s, 60 Hz mains | 3 confirmed offline | 0.00 / 0.00 | cloud bands only | none | none | railed channel excluded, mains detected | **PASS on storm; mains detection and the excluded channel were not read off the screen** |
| `drift_band_edge` | one rhythm drifting 7.4 to 8.6 Hz | at most 1 confirmed | not measured | one cloud band, 1 voice max | none | none | one track, not two | **PASS** |
| `nearmiss_1.5_10db` | ratio 1.5 | 3 | golden up to 0.53, 0 steps | no arm probes | none | none | state mostly absent | **PASS** |
| `nearmiss_1.7_10db` | ratio 1.7 | 3 to 4 | golden up to 0.14 | no arm probes | none | none | state mostly absent | **PASS** |
| `nearmiss_1.8_10db` | ratio 1.8 | 4 | 0.00 | no arm probes | none | none | no golden spiral | **PASS** |

### Pass rules you asked me to check

1. **2 s block shuffle matches its source: PASS.** Both give a golden spiral and a phi bloom with the same peaks (4.6, 7.4, 12 Hz); state time differs (123 and 84 frames). The 20 ms block shuffle (sub-cycle) is calm, silent and has no peaks: PASS.
2. **Both cascades in one recording: FAIL** (above). Diagnosis: all six planted rhythms are confirmed, but with seven confirmed peaks in the background the golden chain does not beat chance (p(A) 0.45 at 100 s, excess 0 for the whole run, no frame with 2 steps). Under the new rule (excess zero unless p <= 5%) the app reports golden alignment 0.00 even though the golden cascade really is present. That is a statistical sensitivity limit of the search with many peaks, or a design weakness of my recording (six peaks plus a 3.0 Hz member at the edge of delta), and I did not retune it. A test of "both" that the app can pass needs a recording whose peak count does not swamp the chance baseline; I have not made one. "Both at once" appears on screen as a badge and a cell (`state-both`), text "Both at once Not holding" throughout.
3. **Extra fixtures:** done, see the table.
4. **Two sessions back to back in one page load, real time, `out/twosess`: PASS.** Session 1 (`phi3_10db`): voices 1 to 3, phi bloom 0.98 from 60 s. Session 2 (`phi5_15db`) in the same page load: voices 3 to 6, phi bloom 0.92 to 1.0 from 20 s. The first-run bug (second session silent) is fixed.
5. **Noise-only input: PASS.** Offline: exact digital silence (every sample 0.0, both channels) for `background_only`, `white_noise`, `phi3_10db_shuffled_samples`, `phi3_10db_shuffled_20ms_blocks` and `phi3_3db`. In-app control stream: voices 0 and bed on in 0.0 of frames for the same five.

### Honesty of the screen, second run

- Golden ratio alignment, octave alignment and chance are always shown together; chance A and B are listed for both targets, each "Golden" and "Octave" on its own line, and "Random peaks did this well: 7 in 100" gives the chance beside the number. Nulls carry a reason ("no confirmed peak", "frames stopped arriving", "not available"). Chance B still reads "not measured (chance B needs about 2 to 3 minutes of data)" in every recording of two minutes or less.
- Calm water pairs (2 s apart, late in the replay, 4x): 0 changed pixels for background, shuffled samples, 20 ms shuffle and the other calm recordings; storms change. (The earlier clock-label pixels are gone: the stage no longer redraws the label in that region.)
- **New finding, as-fast-as-possible replay end (`faketest2-5-fast-replay-end-stale-numbers.png`):** `phi3_10db` at "As fast as possible": the replay finished in under 1 s of wall time. About 4 s later the banner reads "Frames have stopped, so the picture has dissolved and nothing is measured now. The numbers below show not measured." while the state badge still reads "Golden ratio Holding 0:05" and the cell reads 0.95 with chance 0.26; the picture says "No data" but a faint spiral was still changing between two shots 2 s apart (197,139 pixels changed; background shows 0). Two possible readings: the engine was still draining a backlog (frames are still arriving, so the banner is premature), or stale values survive the staleness check. I did not trace which. At 4x and 1x the numbers do show "not measured / frames stopped arriving" at the end.
- When the replay ends the live screen now stays (with a banner and "Play again" buttons), as intended.

### What could not be tested

- Real headset, Web Bluetooth, chest strap, heart and HRV; the recordings carry EEG only.
- Actual sound out of speakers (headless Chromium): RMS values come from the app's own synth code offline, and the in-app control stream is what the worklet is told.
- The `both` bloom and the combined hurricane look (never triggered).
- Mains detection and the excluded railed channel in `artifact_railed_mains60` (not read off the screen).
- Blink and clench attribution beyond "no delta or theta peak" and "no storm".
- The 4x pass samples coarsely; state "holding" times from it are not exact, use the offline edges.
- The build has one type error in a test file (app engineer's work in progress); the bundle was built anyway.

### Rerun (second run)

```
cd /home/user/hurricane-brain/app
CARGO_TARGET_DIR=/home/user/targets/wasm pnpm build:wasm && npx tsc -b; npx vite build --outDir /home/user/dist-faketest --emptyOutDir
npx vite preview --outDir /home/user/dist-faketest --port 4391 --strictPort &
python3 e2e/make_both.py && npx vitest run e2e/make-recordings.test.ts      # recordings (24) + index.json
npx vitest run e2e/audio-offline.test.ts                                     # offline audio and state edges -> out/audio-offline2.json
PREVIEW_URL=http://localhost:4391 node e2e/fake-test.mjs --speed 4 --tag v2speed4   # visual pass
PREVIEW_URL=http://localhost:4391 sh e2e/run-fresh.sh fresh2                         # real-time, fresh browser each (audio control stream)
PREVIEW_URL=http://localhost:4391 node e2e/fake-test.mjs --speed 1 --only phi3_10db,phi5_15db --tag twosess   # back to back
cd e2e && python3 analyze.py v2speed4 && python3 analyze-audio-msgs2.py fresh2
```

Screenshots copied to `/mnt/project-files/hurricane-brain/`: `faketest2-1-both-recording-FAIL-octave-only-no-both-state.png` (concentric rings, octave "Holding 1:19", golden and both "Not holding"), `faketest2-2-octave-holding-rings.png` (three violet rings, octave 0.99, "1 in 100"), `faketest2-3-phi5-spiral-holding.png` (a tight spiral, golden "Holding 0:22", 0.90, chain of 5 peaks), `faketest2-4-background-calm-water.png`, `faketest2-5-fast-replay-end-stale-numbers.png`.

## First run (20 November 2026): what failed

Built 19:12 UTC. 12 recordings. Failures then: (1) the 2 s block shuffle formed a spiral and a chord (the rule was wrong; spec 10.2 C2 now says it should); (2) the aligned state never fired for `phi5_15db` or `octave3_10db`, so no bloom (state statistic 3.66 against an enter threshold of 3.9 and 3.77); (3) `harmonic_8hz` earned octave alignment 0.83 to 0.998 while the 16 Hz track was not marked harmonic; (4) noise-only input was not silent: the bed layer sounded at about -38 dBFS (RMS 1.2e-2) with no confirmed peak; (5) bug: the second and later sessions in one page load were silent (`FrameBinder.latestT` never reset, `bindings.ts` lines 67, 101, 140 to 142; `AudioEngine.stop()` did not reset the binder; `controller.ts` reused `this.audio`). Passes then: `phi3_10db` spiral and bloom, octave rings, calm water for background, white noise and per-sample shuffle, blinks and jaw clenches made no storm, the 1.8 near miss made no spiral, `random_bands` made one brief 1-step chance spiral with chance shown. The first-run screenshots are in `/mnt/project-files/hurricane-brain/faketest-*.png`.
