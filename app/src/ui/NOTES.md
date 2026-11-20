# App shell notes: needs from other modules

## Blocked
- `src/engine/worker-client.ts` does not exist yet. `src/engine/index.ts` re-exports `createEngineClient` from it, so `npx tsc -b` and `npx vite build` fail in the real tree until it lands. `createEngineClient()` is called only in `src/ui/state/app.tsx` (createServices). It must return an `EngineClient` (engine/client.ts).

## Requests
- Engine: viz `HurricaneView` hard-wires chance A (`excess_a`). The app swaps fields for chance B before handing frames to viz and audio (`ui/session/hub.ts swapToChanceB`). A first-class chance driver option in viz/audio would remove the swap.
- Device: `Recorder.finish()` is final. The app wraps it in `ui/session/linkRecorder.ts` for non-destructive snapshots (autosave). A `snapshot()` in device/ would replace that.
- Device: `ReplaySource` drops NOTE records. The app re-injects markers and session start/end from the `input` events. Emitting NOTE records as events would simplify this.
- Training: the runner has no pause. The app has no pause button for programs.
- Repo: `.gitignore` lists only `app/src/viz/test/out/`. Add `app/src/ui/test/out/` (screenshots).

## Not verified
- Live session screen with a real headset (no hardware here). Layout was checked only for the non-session screens.
