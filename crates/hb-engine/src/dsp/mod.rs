//! Signal processing building blocks. All deterministic, no allocation in the hot loops
//! beyond what the callers pass in.

pub mod biquad;
pub mod dpss;
pub mod fft;
pub mod special;
