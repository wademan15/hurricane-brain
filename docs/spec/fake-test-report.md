# Fake test report: hurricane and sound, end to end through the built app

Author: skeptic's runner. Date: 20 November 2026. Nothing in the app was changed. Tooling is in `app/e2e/` (outputs in `app/e2e/out/`, git-ignored).

## Verdict in one paragraph

The built app does not invent a storm or a chord from noise: pure background, white noise and a per-sample shuffle of the cascade file all give calm water, no tones and nothing on any tone layer. Planted golden ratio cascades make a spiral and (for the 3-member case) a bloom. But there are real failures: (1) 2 s-block shuffling still forms a spiral and a bloom (see the note on what that does and does not prove); (2) the 5-member cascade and the octave cascade never reach the "aligned state", so no bloom is ever sent for them; (3) the harmonic recording earns octave alignment of 0.83 to 0.998 shown as "over chance" for about 30 s; (4) on noise-only input a soft bed layer is still sounding at about -38 dBFS RMS, so it is not silent; (5) a bug makes the sound dead in the second and later sessions of one page load. Details below.

## How it was run

- Build: wasm built once at 19:12 UTC (`CARGO_TARGET_DIR=/home/user/targets/wasm pnpm build:wasm`, then `pnpm build` at 19:13), served with `vite preview` on port 4391 (the production build, not the dev server). Another agent was editing `crates/hb-engine` at the same time (git shows `engine.rs`, `params.rs`, `spectral.rs` modified), so these results describe the wasm as built at 19:12, not later changes.
- Port 4173 was already taken by someone else's preview of an older copy (`scratchpad/appcopy`). My first probe hit it and showed "no data" for ever; I switched to my own port. Use `--strictPort` and check the served bundle hash.
- Recordings: HBRAW made from the lab fixtures as a Muse 2 (Classic) would: fixture microvolts -> 12-bit raw (`uV = 0.48828125 * (raw - 2048)`) -> real Classic EEG packets (device test encoder) -> `ReplaySource` (real decode) -> `Recorder`, with free-session start/end notes as the app writes them. Quantisation to 12 bits (0.488 uV steps) is in every recording; 0 samples clipped. Each is about 1 s shorter than its fixture (whole 12-sample packets), 119 s instead of 120, and so on. Engine seed 1. Shuffles are per-channel and seeded (20260101 samples, 20260102 for 512-sample blocks).
- Driver: Chromium 1440x900, onboarding clicked through, Settings > Replay speed chosen in the UI, "Open a recording file" through the file chooser, screenshots, readout text and tap-to-inspect (eye plus six probe points) collected during the replay.
- Three browser passes: **4x** (coarse, no sound, the app only starts sound at real time), **real time all in one page load** (sound on), and **real time with a fresh browser per recording** (`run-fresh.sh`, the valid in-app audio capture; see the sound bug). The real-time passes are the ones to read. In the 4x pass the screenshot loop is slow (WebGL readbacks), so the late marks were missed and the clock label drifts from the mark names.
- Audio in the built app: `AudioEngine.getDebug()` is not reachable (no window hook). Two substitutes: (a) a test-side wrapper around `AudioWorkletNode` records every message the real `AudioEngine` posts to its worklet (voices on/off, pitch, `phi` and `octave` bloom amounts, bed on/warmth), real time only; (b) the offline path (recording -> real decode -> wasm engine in Node -> `FrameBinder` + `SynthCore` at 48 kHz) gives RMS of the full mix, the tone layer alone and the bloom layer alone. The headless browser plays to no speaker, so actual sound output was not heard.

## Verdict table

"Spiral" and "ring" are from screenshots plus tap-to-inspect (real-time pass, `app/e2e/out/speed1/`). Bloom levels are in-app control values (fresh-browser pass: `phi`/`octave` 0..1 of any sounding voice) and offline RMS (full mix / tones / bloom layer, linear, 1.0 = full scale, 10 s bins).

| Recording | Planted | Confirmed peaks shown | Steps shown (phi / oct) | Golden / octave / chance A shown | Spiral formed (screenshot) | Chord bloom | Expected | Verdict |
|---|---|---|---|---|---|---|---|---|
| `phi3_10db` | 3-member phi cascade 4.6, 7.44, 12.04 Hz, 10 dB | alpha ~11.9 to 12.3, theta ~7.4, theta ~4.6 intermittently (2 to 4 at a time) | phi 1 mostly, 2 at best (offline max 2); oct 0 | phi 0.86 to 0.99 (over chance 0.85 to 0.99), oct 0.000, chance A 0.046 to 0.056, p(A) 0.015 to 0.020 | Yes: `speed1/phi3_10db-t30-full.png`, `-t60-full.png`; thinner at t99, near calm at ~59 s and ~100 s | Rises: in-app `phi` 0.93 to 1.0 from ~40 s; bloom-layer RMS 1e-3 to 7e-3 against tone RMS 2e-2 to 5e-2 (about 20 dB under the tones) | spiral and bloom | **PASS** (intermittent: 3rd member rarely confirmed, only 2 steps at best) |
| `phi5_15db` | 5-member phi cascade 3.4 to 23.3 Hz, 15 dB | 6 to 7 at times (alpha 9.0, beta 14.2, beta 22.9, theta 5.4, delta 3.4) | phi 4 at times, 1 mostly; oct 0 | phi 0.82 to 0.99 (0.65 to 0.99 over chance), oct 0.00 to 0.03, chance A 0.485, p(A) 0.005 | Yes, strong, many arms: `speed1/phi5_15db-t60-full.png` (bright fraction 0.54 to 0.74) | **None**: `states.phi.active` in 0 of 320 slow frames, in-app `phi` 0.00 all run, bloom RMS 0 | spiral and bloom | **FAIL** (bloom) |
| `octave3_10db` | 3-member octave cascade 4.5, 9, 18 Hz | alpha 9.0, beta 16.5 to 18, theta 4.5 to 4.7 (3 to 5) | phi 0; oct 1 mostly, 2 at best | phi 0.000, oct 0.49 to 0.98 (0.41 to 0.98 over chance), chance A 0.084 to 0.184, p(A) 0.28 to 0.42 | No spiral. Yes, three rings plus cloud bands: `speed1/octave3_10db-t99-full.png` | **None**: `states.octave.active` in 0 of 320 slow frames, in-app `octave` 0.00 all run | rings, octave bloom, no phi bloom | **FAIL** (octave bloom); ring PASS |
| `background_only` | nothing | none ("none confirmed against the background yet") | 0 / 0, both "not measured: no confirmed peak" | not measured beside not measured beside not measured, all with reasons | No: calm water, `speed1/background_only-t60-full.png` | Tone layer 0 exactly, bloom 0. Bed layer on all the time: full-mix RMS 1.2e-2 (-38 dBFS), peak 0.057 | calm, no tones, exact or near silence | **FAIL** on silence (bed, see Failure 4); visual and tones PASS |
| `white_noise` | nothing | none | 0 / 0 | as above | No: calm water | tones 0, bloom 0, bed RMS 1.2e-2 | as above | **FAIL** on silence (bed); visual and tones PASS |
| `random_bands` | unrelated 7.87 Hz and 12.18 Hz | theta ~7.7, alpha ~12.1 (2 to 3) | phi 0 to 1; oct 0 | phi 0.24 to 0.66, oct 0.000, chance shown | Briefly at ~70 s (arm probe hit "Spiral arm" at 1 step, chance shown beside); otherwise cloud bands | None (`phi` 0.00; state active in 3 slow frames only) | tones allowed, no spiral unless chance shown and at most 2 steps | **PASS** (a 1-step chance spiral appeared, with chance alongside) |
| `harmonic_8hz` | 8 Hz plus 16 and 24 Hz harmonics | 8.0, 15.7 to 16.5 (sometimes tagged "harmonic x2"), 23.8 to 24.7 (tagged "harmonic x3" only early) | phi 0 to 1; oct 1 | oct **0.83 to 0.998 (over chance 0.80 to 0.998) from ~43 s to 60 s and 0.89 at 74 s**, phi up to 0.94 | No steady spiral; "Spiral arm" probes at ~30 s and ~60 s (1 step) | Not active (`octave` 0, `phi` 0); tones present | no octave credit | **FAIL** (octave credit from a harmonic series; Failure 3) |
| `artifact_blinks` | alpha and beta plus 20 blinks | alpha ~9.55, beta ~22.8 only (planted: 9.36 and 22.8) | 0 / 0 | phi 0.000, oct 0.000 throughout | No, cloud bands for the two real rhythms only | tones for the two rhythms only, bloom 0 | no storm from blinks | **PASS** (no delta or theta peak at any time) |
| `artifact_jaw_clench` | alpha and beta plus 6 clenches | alpha ~10.7 to 10.9, beta 22.9 to 26.8 wandering (planted: 10.78 and 24.64) | 0 / 0 | phi 0.000, oct 0.00 to 0.05 | No spiral; one calm stretch at ~60 s ("not enough clean data") | tones, bloom 0 | no storm from clenches | **PASS**, with a note: the beta track wanders 23 to 26.8 Hz around the 24.6 Hz truth; I cannot say from this data how much is clench leakage |
| `nearmiss_1.8_10db` | cascade with ratio 1.8 (4.5, 8.1, 14.58) | beta 14.1 to 14.3, 15.4 to 16.5, theta 4.5, alpha 8.0 (3 to 5) | phi 0 on screen (offline: 1 at an instant); oct 0 | phi 0.00 to 0.03 (over chance 0), oct 0.2 to 0.5 | No: `speed1/nearmiss_1.8_10db-t60-full.png` (cloud bands) | None | no golden ratio spiral | **PASS** |
| `phi3_10db_shuffled_samples` | phi3 with samples shuffled per channel in time | none | 0 / 0 | not measured, reasons shown | No: calm water, `speed1/phi3_10db_shuffled_samples-t60-full.png` | tones 0, bloom 0, bed RMS 1.3e-2 | calm and silent | **FAIL** on silence (bed); visual and tones PASS |
| `phi3_10db_shuffled_2s_blocks` | phi3 with 2 s blocks shuffled per channel | alpha ~12.2, theta ~4.6, theta ~7.4 (3 to 4) | phi 2 | phi 0.79 to 0.99, oct 0.000, chance A 0.099, p(A) 0.005 | **Yes, full spiral**: `speed1/phi3_10db_shuffled_2s_blocks-t99-full.png` | **Yes**: in-app `phi` 0.91 to 1.0 from ~60 s, bloom RMS up to 1.1e-2 | calm and silent | **FAIL** (see Failure 1) |

## Failures

### 1. The 2 s-block shuffle still forms a spiral and a chord

Evidence: spiral from ~17 s, `phi` bloom 0.91 to 1.0 from ~60 s, readout 0.971 over chance 0.968, p(A) 0.005, 2 steps, tracks at 4.52, 7.39, 11.92 Hz (planted 4.6, 7.44, 12.04). The per-sample shuffle of the same file is calm.

What it does and does not mean: a 2 s block still holds 9 to 24 cycles of each planted rhythm, so each narrow-band rhythm is still in the data; only the phase continuity across block edges is broken, and an 8 s spectral window cannot see phase. The engine is measuring something that really is in the recording, not inventing it. So this is not evidence that the app fabricates. It is a failure of the pass rule as I was given it: the rule assumed block shuffling kills the structure. It does not, and the result says the app's measure does not need phase coherence across seconds. If the owner wants a measure that does, that is a spec question for the signal architect. For a true "destroy the structure" test use sample-level shuffle, phase-randomised surrogates, or shuffle blocks shorter than about 0.2 s. I did not change the threshold.

### 2. The aligned state never fires for the 5-member cascade or the octave cascade, so no bloom

Evidence (engine frames in Node, after 40 s, `states.<target>.stat` against `enter_at`): `phi5_15db` phi stat median 3.66, max 4.26, enter threshold median 3.90, held up to 46 s, active in 0 of 320 slow frames; `octave3_10db` octave stat median 3.66, max 4.15, enter threshold median 3.77, held up to 37 s, active 0 of 320. `phi3_10db` phi stat median 3.68 against threshold 1.90, active 161 of 320. The spiral and rings (continuous values) show; the chord (state-gated) never does. The stronger 15 dB, 5-member cascade gets less bloom than the weaker 3-member one because the adaptive threshold sits higher when there are more members. Origin: the state and threshold logic in `crates/hb-engine` (spec 8.4, `states.phi` and `states.octave` in the frame); I did not trace the code. Octave bloom is therefore untested by a positive case.

### 3. A harmonic series earns octave alignment

`harmonic_8hz` shows octave alignment 0.998 (over chance 0.998, 1 step) at 43 s, then 0.83 to 0.98 until 60 s and 0.89 at 74 s, with chance A 0.14 to 0.16 and p(A) 0.18. At those times the chips read 8 Hz, 15.7 to 15.8 Hz and 23.8 to 24.3 Hz with no "(harmonic)" tag on the 15.8 Hz track; early on (22 s) the same tracks were tagged "harmonic x2" and "x3". So the harmonic mark is intermittent and the octave pair is credited while it is missing. The octave state itself did not turn on, so no octave bloom, but the number on screen claims alignment beyond chance. Origin: the harmonic trap (spec 6.6) in `crates/hb-engine`, in how `harmonic_of` is kept stable across slow frames.

### 4. Noise-only input is not silent: the bed layer sounds

Real in-app control stream (fresh browser): for `background_only`, `white_noise` and `phi3_10db_shuffled_samples`, voices on = 0 and bloom 0, but the bed is `on` for 100 % of frames after the first seconds. Offline render: full-mix RMS 1.2e-2 to 1.3e-2 (about -38 dBFS), peak 0.057 to 0.072 (about -25 dBFS), tone and bloom layers exactly 0. The bed is bound to `alpha.above_bg_db` being measurable, so it sounds whenever the signal is good, even when that value is about zero; the declared mapping scales its warmth by the value but not its presence. The owner's rule for this test was "exact or near silence". -38 dBFS is quiet but not near silence; an eyes-closed listener hears a continuous soft noise on pure noise input. Origin: `app/src/audio/bindings.ts` (bed on/off from `spec.bands.alpha.above_bg_db` being non-null, around lines 225 to 277) and the bed level in `synth-core.ts` (`LAYER_LEVELS.bed` 0.22). A decision for the owner: is the bed allowed on a measured but null-result signal, or should it need a confirmed peak (CLAUDE.md rule 2 is about tones)?

### 5. Sound is dead in the second and later sessions of one page load (bug)

Real-time pass, all recordings in one page load: the first recording (`phi3_10db`) drives voices, bloom and bed as expected. Every later recording sends control messages with all voices `on: false` and the bed off until the recording's time passes the previous recording's length (last bins of `phi5_15db` and `octave3_10db` finally show voices, shorter ones never). The fresh-browser pass gives correct sound for all twelve. Cause (read in the code): `FrameBinder` keeps `latestT` as the maximum frame time ever seen (`bindings.ts` lines 67 and 101) and judges staleness against it (lines 140 to 142); `AudioEngine.stop()` (`audio-engine.ts` lines 155 to 166) resets the context and `coreOffset` but not the binder, and `controller.ts` line 551 reuses `this.audio` across sessions. A new session's frame time restarts at 0, so every frame looks stale. `lastBeatT` (line 69) has the same problem, so heartbeats in a second session would be dropped as well. This hits live sessions too (stop, then start again without reloading). The visual is not affected (it passed the same sequence).

## Honesty of the screen during replay

- Across 1,739 live-screen samples in the 4x and real-time passes the golden ratio cell, the octave cell and the chance cell were present in all of them (0 missing). The chance level shows chance A and B and p(A) beside both alignments.
- Every null carried a reason: 1,998 "not measured" cells, reasons "no confirmed peak" (1,908), "no data" (70), "uncertainty too large to score" (18); 2 cells did not match my text parse (probably a transition frame; not examined).
- Chance B reads "not measured (warming up: not enough data yet)" throughout all recordings, i.e. for the full 120 s. Honest, but it means the second chance procedure never becomes available inside a 2 minute session.
- The octave ring was drawn for `octave3_10db` while p(A) was 0.28 to 0.42; the number "over chance A 0.96" sits next to a p of 0.42 that says it is not unusual. Both are shown, but the headline number reads strongly. Worth a wording decision.
- Background and the per-sample shuffle: two canvas screenshots 2 s apart late in the replay (while frames were still arriving, at ~0:70 of the timeline) differ in 0 pixels outside the elapsed-time label (top-left; the only pixels that changed in the 4x pass were that label's: bounding box y 37 to 57, x 103 to 122). So the calm water does not move. Structured recordings change in every pair (the storm rotates with the data), as it should. A pair after the end of the replay could not be taken: when the replay ends the app replaces the live screen with "Replay finished", so there is no storm to dissolve and no live canvas to compare. The canvas also changes size by a few dozen pixels when the dock below changes height (one real-time pair differed in shape).
- Visual summary metrics (bright fraction inside the storm disc): calm water 0.0041 on background, white noise and the per-sample shuffle, identical to the pixel in every shot; structured recordings 0.02 to 0.74.

## What could not be tested

- Any real headset, Web Bluetooth, the chest strap, heart or HRV (the recordings carry EEG only).
- What the sound actually sounds like: headless Chromium, no speaker; RMS values come from the app's own synth code run offline.
- Frame timing against a slower machine: the 4x pass was too slow to hit late marks.
- A positive case for octave bloom and for the 5-member bloom (the state never fires, Failure 2).
- Blink and clench attribution beyond "no delta or theta peak": the fixtures give onset times, but the readouts were not aligned to them.
- `phi3_10db_phase_randomized`, `phi3_10db_loss1pct`, `phi2_6db`, `phi3_3db`, the railed/mains file, `form_dissolve_120s` and `drift_band_edge` were not in the brief and not run.
- Mobile layouts.

## Files and rerun

Key screenshots (also copied to `/mnt/project-files/hurricane-brain/`): `faketest-1-planted-phi-cascade-spiral.png`, `faketest-2-octave-rings.png`, `faketest-3-background-calm-water.png`, `faketest-4-shuffled-samples-calm-water.png`, `faketest-5-FAIL-2s-block-shuffle-still-spiral.png`. What they show: 1 is a two-arm bright spiral round a dark eye with golden ratio 0.933 over chance 0.929 beside octave 0.000 and chance 0.056; 2 is three warm thin rings with grey cloud bands and no arms, octave 0.969, golden 0.002; 3 and 4 are identical empty dark water with "Calm water: no confirmed peak" and every cell "not measured" with a reason; 5 is a full spiral at 0.971.

```
cd /home/user/hurricane-brain/app
CARGO_TARGET_DIR=/home/user/targets/wasm pnpm build            # wasm + tsc + vite build
npx vitest run e2e/make-recordings.test.ts                     # writes e2e/out/recordings/*.hbraw and index.json
npx vitest run e2e/audio-offline.test.ts                       # offline audio, writes e2e/out/audio-offline.json
npx vite preview --port 4391 --strictPort &                    # check the port is yours
PREVIEW_URL=http://localhost:4391 node e2e/fake-test.mjs --speed 4 --tag speed4     # coarse, no sound
PREVIEW_URL=http://localhost:4391 node e2e/fake-test.mjs --speed 1 --tag speed1     # real time, one page load
PREVIEW_URL=http://localhost:4391 sh e2e/run-fresh.sh                               # real time, fresh browser per recording (valid audio capture)
cd e2e && python3 analyze.py speed1 && python3 analyze-audio-msgs.py speed1         # image metrics, pixel pairs, in-app audio summary
```

Files: `app/e2e/make-recordings.test.ts`, `fake-test.mjs`, `audio-offline.test.ts`, `run-fresh.sh`, `analyze.py`, `analyze-audio-msgs.py`, `.gitignore` (ignores `out/`). The Playwright audio tap is an init script in `fake-test.mjs` that wraps `AudioWorkletNode`'s `port.postMessage`; it only observes.
