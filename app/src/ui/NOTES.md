# App shell notes: needs from other modules

Nothing here blocks the build. All four checks run in the real tree.

## Wanted from other modules

- **Engine (`crates/hb-engine`)**: an age-group or child preset. `params.rs` has none, so the app stores
  the age group per person (and with each session) and uses it for wording and fit tips only. If a
  preset appears (a named parameter set), `enginePrefs()` in `session/controller.ts` is the one place to
  pass it.
- **Engine**: the alignment response speed is the `integration_s` parameter (steady 30 s, quicker 15 s,
  slower 60 s); harmonics are `exclude_harmonics`. The quicker and slower values are the app's choice
  (`RESPONSE_SPEED_INTEGRATION_S`); the signal architect should confirm them, and that the chance level
  is recomputed for each.
- **Training**: `runner.rate` and `runner.report` work after a session has finished (the app relies on
  that for the journal). There is no ingest-ratings call, so `profileWithJournal` in `state/stores.ts`
  writes the journal's ease, depth and mood into the profile's session summary where the program's own
  ratings were empty. A first-class call in training would be better.
- **Training**: the runner has no pause, so programs have no pause button.
- **Device**: `Recorder.finish()` is final; the app wraps it in `session/linkRecorder.ts` for snapshots.
  `ReplaySource` drops NOTE records; the app re-injects markers and session start and end from its
  `input` events.
- **Audio**: the app creates a fresh `AudioEngine` for every session and drops it afterwards
  (`controller.releaseAudio`), so no binder state can carry over. If audio adds a documented
  `reset()` or `beginSession()`, reuse would be possible but is not needed.
- **Repo**: `.gitignore` should list `app/src/ui/test/out/` (screenshots). `app/e2e/ui-verify.cjs` is
  the Playwright check of the built app; `e2e/make-session.test.ts` writes the seed session it uses.

## Not verifiable here

- A live headset or chest strap (no Bluetooth). The live path is covered by the controller tests with
  a manual source and a fake engine, and the same screen was driven by replaying recordings through the
  real engine in the built app.
- The get-ready step with a live headset: its component is tested and screenshotted through the Fit
  screen during a replay; the start flow itself (`state/start.ts`) needs a connected headset.
- What the sound sounds like (no speaker).
