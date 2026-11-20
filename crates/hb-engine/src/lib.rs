//! Hurricane Brain EEG signal engine.
//!
//! Implements `docs/spec/signal-engine.md` sections 3 to 9 for EEG: conditioning, signal
//! quality, artifact gating, multitaper spectra, robust 1/f background, chi-squared peak
//! confirmation, peak tracks with integrated frequency, the fast tracking path, golden ratio
//! and octave alignment with controls, cascades, chance levels A and B computed by the same
//! scoring code, the aligned state with dwell and hysteresis, and hemisphere and front-back
//! comparisons. Output frames match `app/src/engine/frames.ts` (schema 1).
//!
//! Pure library: no I/O, no threads, no clock, no unseeded randomness. Compiles for native
//! targets and `wasm32-unknown-unknown`. All transcendental maths goes through `libm` and the
//! FFT is in-crate, so native and wasm builds produce identical output.
//!
//! ```no_run
//! use hb_engine::{Engine, types::*};
//! let cfg = EngineConfig {
//!     streams: StreamDescription {
//!         eeg: Some(EegStream { channels: vec!["TP9".into(), "AF7".into(), "AF8".into(), "TP10".into()], rate_hz: 256.0, bits: 12, model: "muse2".into() }),
//!         ..Default::default()
//!     },
//!     params: None,
//!     seed: 1,
//!     mains_hz: None,
//! };
//! let mut e = Engine::new(cfg).unwrap();
//! e.push_eeg(0, &[0.0; 4 * 12]);
//! let frames = e.drain();
//! ```

pub mod compare;
pub mod dsp;
pub mod engine;
pub mod fast;
pub mod m;
pub mod params;
pub mod prng;
pub mod ratios;
pub mod spectral;
pub mod tracks;
pub mod types;

pub use engine::{Diagnostics, Engine, EngineError, TrackEvent, ENGINE_VERSION};
pub use params::Params;
pub use types::{EngineConfig, Frame, Marker, Measured, Reason};
