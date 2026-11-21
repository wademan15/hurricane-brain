#!/usr/bin/env node
// Builds the signal engine (crates/hb-wasm: hb-engine + hb-heart) to WebAssembly and writes the
// JavaScript bindings to app/src/wasm/pkg/ (git-ignored).
//
//   pnpm build:wasm          (also run first by `pnpm build`)
//
// Steps:
//   1. rustup target add wasm32-unknown-unknown            (if missing)
//   2. cargo install wasm-bindgen-cli --version <pinned>   (if missing or a different version)
//   3. cargo build -p hb-wasm --target wasm32-unknown-unknown --profile wasm-release
//   4. wasm-bindgen --target web --out-dir src/wasm/pkg --out-name hb_wasm
//   5. wasm-opt -O3 (binaryen, from node_modules) in place
//
// CARGO_TARGET_DIR is respected (default: <repo>/target). SKIP_WASM_OPT=1 skips step 5.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..');
const out = join(app, 'src', 'wasm', 'pkg');
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, 'target');

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts });
  if (r.status !== 0) {
    console.error(`build-wasm: ${cmd} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
    process.exit(1);
  }
}

function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// The wasm-bindgen CLI must match the crate version exactly; read the pin from Cargo.toml.
const manifest = readFileSync(join(repo, 'crates', 'hb-wasm', 'Cargo.toml'), 'utf8');
const pin = /^wasm-bindgen\s*=\s*"=([0-9.]+)"/m.exec(manifest)?.[1];
if (!pin) {
  console.error('build-wasm: wasm-bindgen must be pinned with "=x.y.z" in crates/hb-wasm/Cargo.toml');
  process.exit(1);
}

// 1. Rust target.
const targets = capture('rustup', ['target', 'list', '--installed']);
if (targets !== null && !targets.split('\n').includes('wasm32-unknown-unknown')) {
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
}

// 2. wasm-bindgen CLI.
const have = capture('wasm-bindgen', ['--version'])?.trim().split(' ')[1];
if (have !== pin) {
  console.log(`build-wasm: wasm-bindgen ${have ?? 'not found'}, need ${pin}; installing`);
  run('cargo', ['install', 'wasm-bindgen-cli', '--version', pin, '--locked']);
}

// 3. Compile.
run('cargo', ['build', '-p', 'hb-wasm', '--target', 'wasm32-unknown-unknown', '--profile', 'wasm-release']);
const raw = join(targetDir, 'wasm32-unknown-unknown', 'wasm-release', 'hb_wasm.wasm');

// 4. Bindings.
mkdirSync(out, { recursive: true });
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'hb_wasm', raw]);

// 5. Optimize. wasm-opt keeps IEEE semantics (no fast-math), so output stays bit-identical to the
// native build; the identity test in src/engine/test checks it.
const wasm = join(out, 'hb_wasm_bg.wasm');
const before = statSync(wasm).size;
const wasmOpt = join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'wasm-opt.cmd' : 'wasm-opt');
if (process.env.SKIP_WASM_OPT === '1') {
  console.log('build-wasm: SKIP_WASM_OPT=1, not optimizing');
} else if (existsSync(wasmOpt)) {
  run(wasmOpt, [
    '-O3',
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    '--enable-sign-ext',
    '--enable-mutable-globals',
    '--enable-reference-types',
    '--enable-multivalue',
    wasm,
    '-o',
    wasm,
  ]);
} else {
  console.warn('build-wasm: wasm-opt not found (run pnpm install); module left unoptimized');
}
const after = statSync(wasm).size;
console.log(`build-wasm: ${wasm}\n  ${(before / 1024).toFixed(0)} KiB from wasm-bindgen, ${(after / 1024).toFixed(0)} KiB final`);
