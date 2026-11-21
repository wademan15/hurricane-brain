# Hand-over notes

Where the build stands, what has been checked, what has not, and what to do first with a real headset.

## What is built

| Part | Where | Checked by |
|---|---|---|
| Signal engine (Rust) | `crates/hb-engine` | Unit and review tests, 22+ planted and shuffled fixtures, method bake-off (`docs/spec/bakeoff-report.md`) |
| Heart and breath | `crates/hb-heart` | Unit tests on synthetic beats |
| Browser build of the engine | `crates/hb-wasm`, `app/src/engine` | Output is byte-identical to the native build on every fixture |
| Muse and Polar H10 links | `app/src/device` | Decoder tests against published packet layouts and synthetic packets |
| Sound | `app/src/audio` | Unit tests and an offline render; nobody has listened to it yet |
| Hurricane picture | `app/src/viz` | Unit tests and browser screenshots |
| Training programs, profiles, sound anchors | `app/src/training` | Unit tests |
| Screens, themes, storage, offline install | `app/src/ui`, `app/src/storage` | Unit tests, about 430 browser checks including accessibility scans |
| Stream out (OSC, LSL) | `app/src/stream`, `tools/stream-bridge` | Unit tests and a bridge self-test |
| Whole-app fake test | `app/e2e`, `docs/spec/fake-test-report.md` | Two full runs with planted cascades, shuffles, near misses and artifacts |

## What has never been checked

These are the honest gaps. Everything so far ran on synthetic recordings in a cloud machine with no Bluetooth, no speakers and no real graphics card.

1. **No real brain recording.** Every number in the parameter table (spec section 14) is provisional until it is tuned on real sessions.
2. **No real headset.** The Muse 2 decoder has never seen a real packet. Athena firmware 4.x has no data at all. Connect, reconnect and dropout handling on Windows 11 and Android are untested.
3. **No real Polar H10.**
4. **Nobody has heard the sound.** Levels, gentleness and the blooms need a listening pass on headphones.
5. **Frame rate on a real phone** is unmeasured.
6. **Children.** The child preset is built from published differences (slower alpha, larger amplitude, more movement). It has not been tried on a child.
7. Engine weak spots found in review: broad rhythms (1 Hz or wider), weak rhythms near 6 dB, artifacts in the first seconds, the muscle band check, and the personal chance level (it needs two to three minutes of data and is fragile).

8. Known engine faults left open after the last round: a muscle-like hump between 25 and 45 Hz that stays under the muscle gate can produce a false rhythm near 33 Hz (no state came on from it); a rhythm planted at 7.89 Hz reads 0.11 Hz low for a reason not yet found; and when two rhythms are wide enough to overlap (for example 8.09 and 10 Hz, each over 1 Hz wide) they cannot be told apart in an 8 second window, so the combined state was reached in only 4 of 8 such trials. Details are in spec section 6.2 and `crates/hb-engine/NOTES.md`.
9. A state stays on for up to 5 seconds after its measurement drops (the exit dwell), so that it does not flicker.

## First steps with the real Muse 2

1. `pnpm --dir app install && pnpm --dir app build && pnpm --dir app preview`, then open the address in Chrome on the Windows laptop.
2. Pair the headset. If it does not connect, save the browser console text; the device layer logs every packet type it does not recognise.
3. In Settings, turn on the recorder and record five minutes eyes closed, sitting still. Export the recording.
4. Put that file in `lab/fixtures/real/` and replay it. This becomes the first real test: does alpha confirm, do the numbers look sane, is the picture calm when you are calm.
5. Do a listening pass with headphones and note anything harsh or sudden.
6. Repeat on the Android phone and install the app from Chrome's menu.
7. Pair the Polar H10 and check heart rate against the Polar app.
8. Record one session with each child, with the child preset on. Their recordings are the tuning data for that preset.

## How to rerun the checks

- Engine: `cargo test --workspace`
- App: `pnpm --dir app test` (404 tests)
- Whole-app fake test: commands are at the end of `docs/spec/fake-test-report.md`
- Lab comparison against the reference: `python3 lab/compare_rust.py`

## Questions waiting for the owner

1. Should a short sample recording ship with the app so new users can try a replay before they own a headset?
2. The kid screen: any extras wanted beyond the plain words and stepping stones (stickers, a story, a parent summary)?
3. Ending a session uses a Close button with a confirmation. Would hold-to-stop be preferred?
