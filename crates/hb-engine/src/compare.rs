//! Phase and amplitude comparisons between sites (spec 6.6 harmonics, spec 9 hemispheres
//! and front-back). Analytic band signals come from a Gaussian band-pass in the frequency
//! domain over a clean stretch of the slow window. Locking is always reported in excess of
//! time-shifted surrogates, because all Muse channels share one reference electrode.

use crate::dsp::fft::{next_pow2, Fft, C};
use crate::m;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Analytic {
    plans: BTreeMap<usize, Fft>,
}

impl Analytic {
    /// Analytic signal of `x` band-passed by a Gaussian of standard deviation `sd_hz`
    /// centred on `fc` (positive frequencies only, so the output is complex analytic).
    pub fn band(&mut self, x: &[f64], rate: f64, fc: f64, sd_hz: f64) -> Vec<C> {
        let len = x.len();
        let n = next_pow2(2 * len);
        let plan = self.plans.entry(n).or_insert_with(|| Fft::new(n));
        let mean = x.iter().sum::<f64>() / len.max(1) as f64;
        let mut buf = vec![C::default(); n];
        for (i, v) in x.iter().enumerate() {
            buf[i].re = v - mean;
        }
        plan.forward(&mut buf);
        let df = rate / n as f64;
        for (k, b) in buf.iter_mut().enumerate() {
            if k == 0 || k >= n / 2 {
                *b = C::default();
            } else {
                let f = k as f64 * df;
                let g = 2.0 * m::exp(-0.5 * ((f - fc) / sd_hz) * ((f - fc) / sd_hz));
                *b = b.scale(g);
            }
        }
        plan.inverse(&mut buf);
        buf.truncate(len);
        buf
    }
}

/// Phase locking of `hi` to `lo` at ratio n:1, |mean e^{i(phi_hi - n phi_lo)}|, over the
/// stretch with `trim` samples dropped at each end, and the mean over `nshift` circular
/// time shifts of `hi` of at least `min_shift` samples. None if too short.
pub fn locking(lo: &[C], hi: &[C], n: u32, trim: usize, nshift: usize, min_shift: usize) -> Option<(f64, f64)> {
    let len = lo.len().min(hi.len());
    if len <= 2 * trim {
        return None;
    }
    let l = len - 2 * trim;
    if l <= 2 * min_shift + 1 || nshift == 0 {
        return None;
    }
    let ua: Vec<C> = lo[trim..trim + l].iter().map(|z| C::cis(n as f64 * z.arg())).collect();
    let ub: Vec<C> = hi[trim..trim + l].iter().map(|z| C::cis(z.arg())).collect();
    let plv = |shift: usize| {
        let mut acc = C::default();
        for i in 0..l {
            acc = acc + ub[(i + shift) % l] * ua[i].conj();
        }
        acc.abs() / l as f64
    };
    let obs = plv(0);
    let span = l - 2 * min_shift;
    let mut sur = 0.0;
    for j in 0..nshift {
        let s = min_shift + if nshift > 1 { j * span / (nshift - 1) } else { span / 2 };
        sur += plv(s);
    }
    Some((obs, sur / nshift as f64))
}

/// Locking in excess of the surrogate, scaled to 0..1.
pub fn excess(obs: f64, sur: f64) -> f64 {
    if sur >= 1.0 {
        0.0
    } else {
        ((obs - sur) / (1.0 - sur)).clamp(0.0, 1.0)
    }
}

/// Mean amplitude of an analytic signal over the trimmed stretch.
pub fn mean_amp(z: &[C], trim: usize) -> f64 {
    let len = z.len();
    if len <= 2 * trim {
        return 0.0;
    }
    z[trim..len - trim].iter().map(|v| v.abs()).sum::<f64>() / (len - 2 * trim) as f64
}
