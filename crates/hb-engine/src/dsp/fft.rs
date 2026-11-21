//! A plain iterative radix-2 FFT.
//!
//! Written in-crate rather than taken from a SIMD library so that the order of every
//! floating point operation is the same on native and wasm32 builds (spec 11): twiddles are
//! computed with `libm`, and the butterfly order is fixed.

use crate::m;
use core::ops::{Add, Mul, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct C {
    pub re: f64,
    pub im: f64,
}

impl C {
    #[inline]
    pub const fn new(re: f64, im: f64) -> Self {
        C { re, im }
    }
    #[inline]
    pub fn conj(self) -> Self {
        C::new(self.re, -self.im)
    }
    #[inline]
    pub fn norm_sqr(self) -> f64 {
        self.re * self.re + self.im * self.im
    }
    #[inline]
    pub fn abs(self) -> f64 {
        m::hypot(self.re, self.im)
    }
    #[inline]
    pub fn arg(self) -> f64 {
        m::atan2(self.im, self.re)
    }
    #[inline]
    pub fn scale(self, s: f64) -> Self {
        C::new(self.re * s, self.im * s)
    }
    #[inline]
    pub fn cis(phase: f64) -> Self {
        C::new(m::cos(phase), m::sin(phase))
    }
}

impl Add for C {
    type Output = C;
    #[inline]
    fn add(self, o: C) -> C {
        C::new(self.re + o.re, self.im + o.im)
    }
}
impl Sub for C {
    type Output = C;
    #[inline]
    fn sub(self, o: C) -> C {
        C::new(self.re - o.re, self.im - o.im)
    }
}
impl Mul for C {
    type Output = C;
    #[inline]
    fn mul(self, o: C) -> C {
        C::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
}

/// Smallest power of two at or above `n` (at least 1).
pub fn next_pow2(n: usize) -> usize {
    let mut p = 1;
    while p < n {
        p <<= 1;
    }
    p
}

/// A precomputed plan for one transform size.
#[derive(Clone, Debug)]
pub struct Fft {
    n: usize,
    tw: Vec<C>,
    rev: Vec<u32>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 2, "FFT size must be a power of two");
        let tw = (0..n / 2).map(|k| C::cis(-m::TAU * k as f64 / n as f64)).collect();
        let bits = n.trailing_zeros();
        let rev = (0..n as u32).map(|i| i.reverse_bits() >> (32 - bits)).collect();
        Fft { n, tw, rev }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// In-place forward transform, X[k] = sum x[n] e^{-2 pi i k n / N}.
    pub fn forward(&self, a: &mut [C]) {
        self.run(a, false);
    }

    /// In-place inverse transform including the 1/N scale.
    pub fn inverse(&self, a: &mut [C]) {
        self.run(a, true);
        let s = 1.0 / self.n as f64;
        for v in a.iter_mut() {
            *v = v.scale(s);
        }
    }

    fn run(&self, a: &mut [C], inverse: bool) {
        let n = self.n;
        assert_eq!(a.len(), n);
        for i in 0..n {
            let j = self.rev[i] as usize;
            if i < j {
                a.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let w = self.tw[k * step];
                    let w = if inverse { w.conj() } else { w };
                    let u = a[start + k];
                    let v = a[start + k + half] * w;
                    a[start + k] = u + v;
                    a[start + k + half] = u - v;
                }
                start += len;
            }
            len <<= 1;
        }
    }

    /// Transform two real sequences at once (zero padded to N) and return their spectra's
    /// squared magnitudes for bins 0..nbins. Packs `x + i y` into one complex transform.
    pub fn two_real_power(&self, x: &[f64], y: Option<&[f64]>, nbins: usize, buf: &mut Vec<C>, px: &mut [f64], py: &mut [f64]) {
        let n = self.n;
        buf.clear();
        buf.resize(n, C::default());
        for (i, v) in x.iter().enumerate() {
            buf[i].re = *v;
        }
        if let Some(y) = y {
            for (i, v) in y.iter().enumerate() {
                buf[i].im = *v;
            }
        }
        self.forward(buf);
        for k in 0..nbins {
            let zk = buf[k];
            let zn = buf[(n - k) % n].conj();
            let a = (zk + zn).scale(0.5);
            px[k] = a.norm_sqr();
            if y.is_some() {
                let d = zk - zn; // = 2i B
                let b = C::new(d.im * 0.5, -d.re * 0.5);
                py[k] = b.norm_sqr();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_tone() {
        let n = 64;
        let f = Fft::new(n);
        let mut a: Vec<C> = (0..n).map(|i| C::new(m::cos(m::TAU * 5.0 * i as f64 / n as f64), 0.0)).collect();
        let orig = a.clone();
        f.forward(&mut a);
        assert!((a[5].re - 32.0).abs() < 1e-9 && (a[59].re - 32.0).abs() < 1e-9);
        f.inverse(&mut a);
        for (x, y) in a.iter().zip(orig.iter()) {
            assert!((x.re - y.re).abs() < 1e-12 && x.im.abs() < 1e-12);
        }
        let x: Vec<f64> = (0..40).map(|i| m::sin(i as f64 * 0.3)).collect();
        let y: Vec<f64> = (0..40).map(|i| m::cos(i as f64 * 0.7) + 0.1).collect();
        let mut buf = Vec::new();
        let (mut px, mut py) = (vec![0.0; 33], vec![0.0; 33]);
        f.two_real_power(&x, Some(&y), 33, &mut buf, &mut px, &mut py);
        let mut b: Vec<C> = (0..n).map(|i| C::new(if i < 40 { y[i] } else { 0.0 }, 0.0)).collect();
        f.forward(&mut b);
        for k in 0..33 {
            assert!((py[k] - b[k].norm_sqr()).abs() < 1e-9);
        }
    }
}
