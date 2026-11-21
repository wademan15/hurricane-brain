//! Deterministic maths.
//!
//! Every transcendental function in the engine goes through `libm`, a pure Rust port of
//! musl's libm, so that the native build and the WebAssembly build produce the same bits
//! (spec section 11). `std`'s `f64::sin` and friends call the platform's C library and may
//! differ in the last place between platforms. `sqrt` is correctly rounded by IEEE 754 on
//! every platform, but it goes through here too for uniformity.

pub const PI: f64 = core::f64::consts::PI;
pub const TAU: f64 = core::f64::consts::TAU;
pub const LN10: f64 = core::f64::consts::LN_10;

#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}
#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}
#[inline]
pub fn expm1(x: f64) -> f64 {
    libm::expm1(x)
}
#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}
#[inline]
pub fn ln1p(x: f64) -> f64 {
    libm::log1p(x)
}
#[inline]
pub fn log10(x: f64) -> f64 {
    libm::log10(x)
}
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}
#[inline]
pub fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}
#[inline]
pub fn sqrt(x: f64) -> f64 {
    libm::sqrt(x)
}
#[inline]
pub fn lgamma(x: f64) -> f64 {
    libm::lgamma(x)
}
#[inline]
pub fn hypot(x: f64, y: f64) -> f64 {
    libm::hypot(x, y)
}
#[inline]
pub fn floor(x: f64) -> f64 {
    libm::floor(x)
}
#[inline]
pub fn round(x: f64) -> f64 {
    libm::round(x)
}
#[inline]
pub fn ceil(x: f64) -> f64 {
    libm::ceil(x)
}

/// Power ratio in decibels.
#[inline]
pub fn db(x: f64) -> f64 {
    10.0 * log10(x)
}

/// Wrap an angle to (-pi, pi].
pub fn wrap_pi(x: f64) -> f64 {
    let mut y = x % TAU;
    if y > PI {
        y -= TAU;
    } else if y <= -PI {
        y += TAU;
    }
    y
}

/// Median of a slice (copied and sorted). None for an empty slice.
pub fn median(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut w: Vec<f64> = v.to_vec();
    w.sort_by(|a, b| a.total_cmp(b));
    let n = w.len();
    Some(if n % 2 == 1 { w[n / 2] } else { 0.5 * (w[n / 2 - 1] + w[n / 2]) })
}

/// Quantile by linear interpolation between order statistics (type 7). `q` in [0, 1].
pub fn quantile_sorted(sorted: &[f64], q: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let h = (sorted.len() - 1) as f64 * q.clamp(0.0, 1.0);
    let lo = floor(h) as usize;
    let hi = (lo + 1).min(sorted.len() - 1);
    Some(sorted[lo] + (h - lo as f64) * (sorted[hi] - sorted[lo]))
}
