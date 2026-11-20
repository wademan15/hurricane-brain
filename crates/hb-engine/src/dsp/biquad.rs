//! Second-order IIR sections (transposed direct form II), designed with the RBJ cookbook.
//! Causal. Each section can report its own group delay, so delays are computed from the
//! filters actually in use rather than written down as constants (spec 5.1, 7).

use crate::m;

#[derive(Clone, Debug, PartialEq)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0.0, z2: 0.0 }
    }

    pub fn lowpass(fs: f64, fc: f64, q: f64) -> Self {
        let w = m::TAU * fc / fs;
        let (c, s) = (m::cos(w), m::sin(w));
        let al = s / (2.0 * q);
        Self::norm((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al)
    }

    pub fn highpass(fs: f64, fc: f64, q: f64) -> Self {
        let w = m::TAU * fc / fs;
        let (c, s) = (m::cos(w), m::sin(w));
        let al = s / (2.0 * q);
        Self::norm((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al)
    }

    pub fn notch(fs: f64, f0: f64, q: f64) -> Self {
        let w = m::TAU * f0 / fs;
        let (c, s) = (m::cos(w), m::sin(w));
        let al = s / (2.0 * q);
        Self::norm(1.0, -2.0 * c, 1.0, 1.0 + al, -2.0 * c, 1.0 - al)
    }

    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    /// Set the state to the steady state for a constant input `x0`, so that starting on a
    /// signal with a large offset does not ring.
    pub fn prime(&mut self, x0: f64) {
        let y0 = self.dc_gain() * x0;
        self.z2 = self.b2 * x0 - self.a2 * y0;
        self.z1 = self.b1 * x0 - self.a1 * y0 + self.z2;
    }

    pub fn dc_gain(&self) -> f64 {
        let den = 1.0 + self.a1 + self.a2;
        if den.abs() < 1e-300 {
            0.0
        } else {
            (self.b0 + self.b1 + self.b2) / den
        }
    }

    /// Copy coefficients from another section and keep this one's state.
    pub fn retune_from(&mut self, o: &Biquad) {
        self.b0 = o.b0;
        self.b1 = o.b1;
        self.b2 = o.b2;
        self.a1 = o.a1;
        self.a2 = o.a2;
    }

    /// Group delay in samples at normalized angular frequency `w` (radians per sample).
    pub fn group_delay_samples(&self, w: f64) -> f64 {
        fn poly_gd(c: [f64; 3], w: f64) -> f64 {
            // tau = Re( sum k c_k e^{-ikw} / sum c_k e^{-ikw} )
            let (mut nr, mut ni, mut dr, mut di) = (0.0, 0.0, 0.0, 0.0);
            for (k, ck) in c.iter().enumerate() {
                let (cr, si) = (m::cos(k as f64 * w), -m::sin(k as f64 * w));
                dr += ck * cr;
                di += ck * si;
                nr += k as f64 * ck * cr;
                ni += k as f64 * ck * si;
            }
            let den = dr * dr + di * di;
            if den < 1e-300 {
                0.0
            } else {
                (nr * dr + ni * di) / den
            }
        }
        poly_gd([self.b0, self.b1, self.b2], w) - poly_gd([1.0, self.a1, self.a2], w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lowpass_delay_matches_butterworth() {
        let fs = 256.0;
        let lp = Biquad::lowpass(fs, 1.0, core::f64::consts::FRAC_1_SQRT_2);
        let tau = lp.group_delay_samples(0.0) / fs;
        let analog = core::f64::consts::SQRT_2 / (m::TAU * 1.0);
        assert!((tau - analog).abs() / analog < 0.02, "{tau} vs {analog}");
        let mut hp = Biquad::highpass(fs, 0.5, core::f64::consts::FRAC_1_SQRT_2);
        hp.prime(300.0);
        assert!(hp.process(300.0).abs() < 1e-9);
    }
}
