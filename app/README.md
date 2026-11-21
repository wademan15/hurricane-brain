# Hurricane Brain app

Vite + React + TypeScript. The signal engine is Rust (`crates/hb-engine` for EEG, `crates/hb-heart`
for heart and breath) compiled to WebAssembly through `crates/hb-wasm`, and runs in a dedicated
worker.

## Build

From a clean checkout (needs Rust via rustup, Node 22 and pnpm):

```sh
cd app && pnpm install && pnpm build
```

`pnpm build` runs `pnpm build:wasm` first, then `tsc -b` and `vite build`. For `pnpm dev` or
`npx tsc -b` on a fresh checkout, run `pnpm build:wasm` once first: the generated bindings in
`src/wasm/pkg/` are git-ignored and the engine worker imports them.

`pnpm build:wasm` (`scripts/build-wasm.mjs`):

1. adds the `wasm32-unknown-unknown` Rust target if it is missing;
2. installs `wasm-bindgen-cli` at the exact version pinned in `crates/hb-wasm/Cargo.toml` if the
   installed one differs;
3. `cargo build -p hb-wasm --target wasm32-unknown-unknown --profile wasm-release`
   (opt-level 3, fat LTO, one codegen unit, abort on panic; `CARGO_TARGET_DIR` is respected);
4. `wasm-bindgen --target web --out-dir src/wasm/pkg --out-name hb_wasm`;
5. `wasm-opt -O3` from the `binaryen` dev dependency (`SKIP_WASM_OPT=1` skips it).

After changing Rust code, run `pnpm build:wasm` again.

## Engine

The UI uses only `createEngineClient()` and the `EngineClient` interface (`src/engine/index.ts`,
`client.ts`) and the frame contract (`frames.ts`).

- `worker-client.ts`: the `EngineClient`. Pushes copy their samples into a fresh buffer that is
  transferred to the worker, so callers may reuse their arrays. Frames arrive as one JSON string
  per worker drain and are parsed on the UI thread (about 0.2 ms for a slow frame).
- `worker.ts`: hosts the WebAssembly session, handles messages in order, drains after every push.
- `protocol.ts`: the messages between the two.

Configuration: `EngineConfig.params` keys starting with `heart.` go to the heart engine, all others
to the EEG engine; an unknown name makes `init` reject. `streams.eeg` may be null for a heart-only
session. Heart frames start once a chest strap or PPG stream is declared, or on the first
`pushRr` / `pushPpg`.

## Tests

```sh
pnpm build:wasm
pnpm test:engine        # Node: wasm vs native, every lab fixture byte for byte; merged session; heart
pnpm test:engine:e2e    # Chromium via Playwright: EngineClient end to end, cascade checks, latency
HB_E2E_BUILD=1 pnpm test:engine:e2e   # the same against a production build
```

The test page in `src/engine/test/e2e/` is not part of the shipped app.
