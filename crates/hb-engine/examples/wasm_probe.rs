//! Exports the engine's determinism digest from a wasm module (see `hb_engine::selfcheck`).

#[no_mangle]
pub extern "C" fn hb_selfcheck(seed: u32, secs: u32) -> u64 {
    hb_engine::selfcheck::digest(seed as u64, secs)
}
