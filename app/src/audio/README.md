# Sound layer (`app/src/audio`)

The sound of Hurricane Brain. Most sessions are eyes closed, so the sound alone carries the state.
It is designed to calm: a warm mid register (tones roughly 100 to 1,000 Hz, rolled off above 700 Hz),
slow predictable change, no beeps, chimes, clicks or sudden changes, and no penalty sound. Leaving a
state is a gentle thinning. This borrows the design instinct of the Safe and Sound Protocol without
claiming to deliver that protocol.

No binaural, monaural or isochronic entrainment. Both channels carry the same dry signal. The only
left/right difference is the decorrelated tail of a static room on bloom and anchor sends. Nothing is
amplitude-modulated at a brainwave rate except the measured content itself (two measured tracks close
in frequency will beat against each other, because that is what they are).

## Files

| File | What it is |
| --- | --- |
| `synth-core.ts` | Pure DSP core, no dependencies. Renders sample by sample from control values. Runs in the worklet and in tests. |
| `bindings.ts` | `FrameBinder`: frames in, controls out, plus a trace of which field drives each sound (spec 9.1 as code). |
| `settings.ts` | Every tunable number, with defaults and clamping (`DEFAULT_AUDIO_SETTINGS`, `mergeSettings`). |
| `anchors.ts` | `AnchorSynthParams`, seeded generation, candidate sets, distance, neutral control. |
| `worklet.ts` | `AudioWorkletProcessor` hosting the core. |
| `audio-engine.ts` | `AudioEngine`, the main-thread class the app uses. |
| `messages.ts` | Main thread to worklet message types. |
| `test/` | Numeric tests (vitest) and helpers (frame builders, offline renderer, FFT). |

## Public API

```ts
const audio = new AudioEngine({ settings?: AudioSettingsPatch });
await audio.start();                 // from a user gesture (autoplay policy). Idempotent.
audio.handleFrame(frame);            // every SlowFrame, FastFrame and HeartFrame, in order
audio.setSettings({ pitchTauS: 0.2, gains: { heart: 0.5 }, breathGuide: { enabled: true, bpm: 6 } });
audio.setBaseline({ alphaAboveBgDbMean: 3.1, alphaAboveBgDbSd: 1.2 });   // or null
audio.reset();                       // new session (start() and stop() also do this)
audio.setSettings({ blooms: { both: { on: true, level: 0.8 } }, bloomChance: 'b' });
audio.playAnchor(anchorFromSeed(seed));  audio.playAnchor(neutralControlFor(anchor));  audio.stopAnchor();
audio.getDebug();                    // AudioDebug: sounding voices, each with frame field + value + smoothing
await audio.stop();                  // master fades over ~1.5 s, then the context closes
```

`getDebug().sounding` lists every element currently audible or fading, each with `fields` (exact frame
paths and values, for example `fast.tracks[id=3].freq.v: 10.21`), `mapping` ("pitch 326.72 Hz = 10.210 Hz x 32"),
`smoothing` and level. `getDebug().bindings` lists every binding, sounding or not, with the null reason
when it is silent. `getDebug().settings` is the full settings object to record with the session.

For offline renders and replay, use `FrameBinder` and `SynthCore` directly (see `test/helpers.ts`,
`renderSession`): pass the frame time as the core time and the result is bit-for-bit repeatable.

Anchor helpers: `anchorFromSeed(seed)`, `anchorCandidates(seed, count, existing, minDistance)`,
`anchorDistance(a, b)`, `neutralControlFor(anchor)`, `sanitizeAnchor(p)`, `anchorDurationS(p)`.

## Binding table as implemented

Every audible change traces to a frame field with a declared smoothing. Nothing else moves.

| Sound element | Frame field | Mapping | Declared smoothing (setting, default) |
| --- | --- | --- | --- |
| Tracking tone pitch | `FastFrame.tracks[i].freq.v` | x 32 exactly (in the core, on log pitch) | one-pole on log pitch, `pitchTauS` 150 ms |
| Tracking tone loudness | `FastFrame.tracks[i].height_db.v` | linear 0..1 between `heightFloorDb` 0 and `heightFullDb` 15, then roll-off `rolloffDbPerOctave` 6 above `rolloffStartHz` 700 | one-pole `toneLoudnessTauS` 250 ms |
| Tone present or absent | `SlowFrame.tracks[id].state === 'confirmed'`, `FastFrame.tracks[i].locked`, `freq` and `height_db` not null, `FastFrame.artifact` false, frames fresh | on or off | raised-cosine fade `toneFadeS` 1.5 s (min 1 s). Fades at the last measured pitch; when fully faded the slot and its pitch are forgotten, and a returning tone starts at its new measured pitch |
| Warmth of the bed | `SlowFrame.spectra[site=bedSite].bands.alpha.above_bg_db.v` minus baseline mean | `(x - baseline) / warmthRangeDb` (6 dB), clamped 0..1; lowers the bed's cutoff from 1,500 to 380 Hz and raises its level | one-pole `warmthTauS` 2 s |
| Steadiness of the bed ("how long it has held") | the same field | adds a warm low body as the value holds | one-pole `steadyTauS` 8 s |
| Bed present or absent | that field not null AND a `SlowFrame.tracks[k]` with `band === 'alpha'`, `state` `confirmed` or `fading`, followed at `bedSite` (or one of its channels: temporal = TP9, TP10), slow frame fresh. A measurable band power alone is not a rhythm: with no confirmed peak anywhere the output is exact silence | on or off | raised-cosine fade `bedFadeS` 2 s |
| Thinning of the bed | `FastFrame.artifact` | level x `thinLevel` 0.35 | raised-cosine fade `thinFadeS` 1 s |
| Golden ratio bloom | `SlowFrame.states.phi.active`, `SlowFrame.cascades.phi.excess_a.v` (or `excess_b.v` when `bloomChance` is `'b'`), `SlowFrame.cascades.phi.tracks` | each member's own tone gains its sub-octave and a doubling, sent to a soft room, level = excess x the tone's loudness x `blooms.phi.level` (muted by `blooms.phi.on: false`) | one-pole `bloomTauS` 3 s rising, `bloomReleaseTauS` 2 s thinning; mute and level ramp over `gainTauS` |
| Octave bloom (sounds different) | `SlowFrame.states.octave.active`, `cascades.octave.excess_a.v` (or `excess_b.v`), `cascades.octave.tracks` | each member's tone gains hollow upper octaves (2x, 4x), mostly dry; `blooms.octave` mute and level | same as above |
| Combined bloom (both at once; sounds different again) | `SlowFrame.states.both.active` only, scaled by min(`cascades.phi.excess`, `cascades.octave.excess`) with the chosen chance level; members are the tracks in either cascade | each member's tone gains its fifth (1.5x) and twelfth (3x) above, the 3rd and 6th harmonics of its own sub-octave, so it is phase-locked to the measured tone and cannot beat; deep in the room, so the two blooms resolve into something fuller and wider. Silent unless `states.both.active` and both excesses are measured; `blooms.both` mute and level | one-pole `combinedBloomTauS` 5 s rising (it gathers), `bloomReleaseTauS` 2 s thinning |
| Heartbeat | `HeartFrame.beats[j].t` (and `.flagged`), `HeartFrame.source` | one low rounded pulse (58 Hz falling 20%, 40 ms raised-cosine attack, 420 ms) per beat; flagged beats at `heartFlaggedLevel` 0.5 | fixed latency `heartLatencyS` 300 ms after `Beat.t`; beats later than that by more than `heartLateToleranceS` 100 ms are dropped, never shifted |
| Breath guide (NOT a measurement) | settings `breathGuide.enabled` (default **false**), `breathGuide.bpm` | slow swell of soft air at the pacer rate, louder and brighter on the in-breath | on/off fade `breathFadeS` 2 s |
| Personal anchor | explicit `playAnchor(params)` only | parametric voice | its own attack and release (each >= 1 s) |

Safety rules in the code:

- No layer sounds without a measurement behind it, except the labelled breath guide and an anchor
  explicitly played. Tested: all-null frames from the start give exact digital silence.
- Freshness: fast frames older than `staleFastS` (250 ms) and slow frames older than `staleSlowS` (1 s)
  are not used. A watchdog in the worklet fades every measured layer if no control update arrives for
  `watchdogS` (500 ms), so a stalled engine or a lost device never leaves a tone hanging.
- Every fade is a raised cosine or one-pole ramp of at least 1 s (the heartbeat pulse and the pitch
  glide excepted, both declared). Gains and master changes ramp with `gainTauS` (250 ms).
- Master: per-layer gains (0..2), `masterDb` (-60..+6), a peak leveller (2 ms attack, 400 ms release,
  threshold at 0.8 x ceiling) and a tanh soft clipper. No output sample can exceed `ceilingDb`
  (default -6 dBFS, max -1 dBFS).

## Sessions

A session's frame clock restarts at 0. The binder judges staleness against the latest frame time it
has seen, so a new session must start clean. Three ways it does:

- `AudioEngine.start()` begins a new session every time it is called (the context is still created once).
- `AudioEngine.stop()` and `AudioEngine.reset()` reset too.
- Automatic: a frame whose time is earlier than the latest seen by more than `sessionJumpS` (2 s) is
  taken as a new session (`BinderOutput.reset`), for callers that reuse the engine without calling either.

A reset forgets the previous session's frames, clock mapping and beat history, and the worklet retires
every measured voice (`SynthCore.newSession()`): old tones and the bed fade over their declared fades,
the new session's track ids never pick up an old voice or its pitch, pending beats are dropped. No click.
Anchors and the breath guide carry on (they are not measurements). Settings and the baseline are kept.

## Settings and defaults

All in `settings.ts` (`DEFAULT_AUDIO_SETTINGS`), clamped by `mergeSettings`:

| Setting | Default | Range |
| --- | --- | --- |
| `pitchTauS` | 0.15 s | 0.02..1 |
| `toneFadeS` | 1.5 s | 1..10 |
| `toneLoudnessTauS` | 0.25 s | 0.05..2 |
| `heightFloorDb`, `heightFullDb` | 0, 15 dB | |
| `rolloffStartHz`, `rolloffDbPerOctave` | 700 Hz, 6 dB/oct | |
| `toneHarmonic2` | 0.1 (exact 2x, helps small speakers; 0 = pure sine) | 0..0.3 |
| `maxVoices` | 6 | 1..8 |
| `bedSite` | `'temporal'` | any Site |
| `warmthRangeDb` | 6 dB | 1..30 |
| `warmthTauS`, `steadyTauS` | 2 s, 8 s | >= 1 |
| `bedFadeS`, `thinLevel`, `thinFadeS` | 2 s, 0.35, 1 s | fades >= 1 |
| `bloomTauS`, `bloomReleaseTauS` | 3 s, 2 s | >= 1 |
| `combinedBloomTauS` | 5 s | 1..15 |
| `blooms` | `{ phi, octave, both }`, each `{ on: true, level: 1 }` | level 0..2 |
| `bloomChance` | `'a'` (reads `excess_a`; `'b'` reads `excess_b`) | `'a'` or `'b'` |
| `sessionJumpS` | 2 s | 0.5..60 |
| `heartLatencyS`, `heartLateToleranceS` | 0.3 s, 0.1 s | |
| `heartPitchHz`, `heartPulseS`, `heartFlaggedLevel` | 58 Hz, 0.42 s, 0.5 | |
| `breathGuide` | `{ enabled: false, bpm: 6 }` | bpm 2..20 |
| `breathFadeS` | 2 s | >= 1 |
| `gains` | all 1 (tones, bed, bloom, heart, breath, anchor) | 0..2 |
| `gainTauS` | 0.25 s | |
| `masterDb`, `ceilingDb` | 0 dB, -6 dBFS | -60..+6, -40..-1 |
| `staleFastS`, `staleSlowS`, `watchdogS` | 0.25, 1.0, 0.5 s | |
| `seed` | 1 (the bed's fixed noise carrier) | |

## Latency budget

| Stage | Typical |
| --- | --- |
| Engine fast path (scalp to frame), reported per track as `delay_s` | <= 300 ms (spec 7, provisional) |
| Frame to worklet (postMessage) | < 5 ms |
| Worklet render quantum + context base latency | ~3 to 10 ms (`getDebug().outputLatencyS` reports what Chrome knows) |
| Output device: wired | ~5 to 20 ms |
| Output device: Bluetooth | 100 to 300 ms, often not reported to the browser |
| Pitch smoothing | `pitchTauS` 150 ms time constant (perceived lag ~1 tau) |

Target scalp to ear under about 350 ms. **Recommend wired headphones**: Bluetooth alone can use the whole
budget. Small speakers cannot reproduce delta tones (32 to 128 Hz after x32) or the 58 Hz heartbeat;
the UI should say so. The tone's second harmonic (`toneHarmonic2`) keeps some presence there.

The heartbeat is scheduled, not immediate: `Beat.t` is mapped to the audio clock using the smallest
observed (audio time minus frame time) over the last ~10 s of frames, then `heartLatencyS` is added.
Beats from a slow source (for example the headset's optical pulse) that arrive later than the latency
allows are dropped and counted (`getDebug().droppedLateBeats`), never shifted. If many are dropped,
raise `heartLatencyS`.

## Worklet loading (Vite)

`audio-engine.ts` imports the worklet as `import workletUrl from './worklet.ts?worker&url'`. Vite then
bundles `worklet.ts` with the core it imports into one self-contained script (an IIFE, which is valid
module code for `audioWorklet.addModule`), in dev and in production builds.

Caveat: the plain `new URL('./worklet.ts', import.meta.url)` pattern works in `vite dev` but in a
production build Vite copies the `.ts` file as a static asset, untranspiled and with its imports
unresolved, so `addModule` fails. Use the `?worker&url` import. Verified: `vite build` (v8.3.8) emits
`assets/worklet-*.js` (17.7 kB) and that file, loaded in headless Chromium through
`OfflineAudioContext.audioWorklet.addModule`, rendered a 10 Hz track at 320.00 Hz with peak 0.164
(ceiling 0.501) and posted status messages.

`audioWorklet` exists only in a secure context (https or localhost).

## Test results

`npx vitest run src/audio` (54 tests, all passing). Numbers from the run:

- Pitch after 7 x `pitchTauS`: |error| <= 0.073 cents across steps 10 to 10.37, 4.3 to 6.1, 16.18 to 12.5,
  2.2 to 2.6 and 23.5 to 28.9 Hz (limit 1 cent). Steady state: 0.0000 cents.
- Glide 8 to 12 Hz: max sample-to-sample change 5.312e-3, below the steady 384 Hz tone's own 5.348e-3.
- Roll-off: 896 Hz vs 640 Hz measured -2.14 dB, expected -2.14 dB.
- Null input: still sounding 0.9 s after null (fade >= 1 s), pitch unchanged while fading (< 1 cent),
  exact zero from 1.55 s after null onwards, slot released.
- All-null frames from the start (and no frames at all): every sample exactly 0.
- Frames stop with a bloom playing: last non-zero sample 5.19 s later (watchdog 0.5 s + fade 2 s + room tail).
- Worst case (8 voices at 60 dB height, all three blooms at excess 1, bed at +40 dB, beats every 125 ms,
  breath guide, anchor, all gains x2, master +6 dB): peak 0.48506 under a 0.50119 ceiling (-6 dBFS),
  0.86056 under 0.89125 (-1 dBFS), 0.09971 under 0.10000 (-20 dBFS).
- Attacks: first non-zero sample <= 2.3e-8 for every layer; within the first 50 ms the tone, bed, breath and
  anchor stay under 0.06% of their peak, the blooms under 1.7%; the heartbeat under 2.75% within 5 ms.
- Blooms: golden ratio centroid 305 Hz, octave 815 Hz, spectral cosine similarity 0.000. The golden
  ratio bloom contains the measured 320 and 517.8 Hz and their sub-octaves, nothing between. It reaches
  21% of its settled level 0.5 to 1 s after entry, and scales with excess_a (0.5 gives half).
- Bed: centroid 423 Hz at baseline, 157 Hz at +6 dB over baseline.
- Noise only: background-only frames (alpha above background 0.2 to 0.6 dB, measured, no tracks) render
  exact zeros for 12 s; a theta-only peak, an unconfirmed alpha peak, or an alpha peak at the wrong site
  also leave the bed silent.
- Two consecutive sessions (clock restarts at 0, same track id, 10 then 12 Hz, beats in both): session B
  plays 384.000 Hz (0 cents), all 14 beats sound (5 + 9), changeover max sample step 8.266e-3, equal to
  the steady-state maximum (no click). Same with the automatic detection and the explicit reset.
- Three blooms: centroids golden ratio 305 Hz, octave 815 Hz, combined 629 Hz; pairwise spectral cosine
  similarity 0.000 / 0.000 / 0.000. The combined bloom is exactly zero when `states.both` is inactive
  (even with both states active), when an excess is missing, and for non-member tracks; it reaches 13%
  of its settled level 0.5 to 1 s after entry; it scales with min(excess) (0.9 and 0.5 give 0.5), with
  its level setting, and mutes to exact zero. `bloomChance: 'b'` scales by `excess_b`.
- Heartbeat: centroid 59.9 Hz; energy above 300 Hz -91 dB, above 1 kHz -122 dB. A beat at t = 1.000 s
  sounds at 1.3000 s.
- Anchors: 24 seeded candidates with minimum pairwise distance 0.87; neutral control within 0.03 dB of
  its anchor's loudness; anchors end in exact silence.
- Determinism: the same session (tones, nulls, bed, bloom, beats, breath, anchor) renders bit-identical.

CPU: 10 s of the worst case renders in about 0.8 s in Node (V8), about 8% of one core. Expect more on
low-end Android.

## Requests to other roles

- Signal architect: the sound settings above that are declared smoothing (`pitchTauS`, `toneFadeS`,
  `toneLoudnessTauS`, `warmthTauS`, `steadyTauS`, `bedFadeS`, `thinFadeS`, `bloomTauS`, `bloomReleaseTauS`,
  `heartLatencyS`) belong in the spec section 14 table and in the session record.
- Signal architect: spec 9.1 says the bed's steadiness follows "how long [alpha] has held". There is no
  frame field for alpha hold time, so the sound uses a declared slow smoothing (`steadyTauS`) of the same
  measured field instead of computing a private hold timer. If a hold-time field is added, the bed will
  bind to it.
- App engineer: the session controller no longer needs to swap `excess_a`/`excess_b` before handing
  frames over; set `bloomChance` instead. Add the three bloom mutes and levels (`blooms.phi`,
  `blooms.octave`, `blooms.both`) to the Settings screen.
- Protocol designer / app engineer: pass the baseline block's alpha mean (at `bedSite`) through
  `setBaseline`. Without it the bed warms relative to the background (0 dB) and the trace says so.
- Protocol designer: when the pacer starts, call `EngineApi.setPacer(bpm)` and
  `audio.setSettings({ breathGuide: { enabled: true, bpm } })` together. The guide starts at the quiet
  point of its cycle; its phase is in `getDebug().status.breath.phase` for the visuals.
- App engineer: UI copy should say small speakers cannot play delta tones or the heartbeat, and
  recommend wired headphones.
