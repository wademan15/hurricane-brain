//! Small numeric toolkit: math wrappers (libm, for bit-identical native and wasm output),
//! seeded PRNG, radix-2 FFT, detrending, periodogram, analytic band-pass, biquads, statistics.

use std::f64::consts::PI;

// ---------------------------------------------------------------------------
// Math (libm everywhere, so wasm and native agree bit for bit)
// ---------------------------------------------------------------------------

#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}
#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}
#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}
#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}
#[inline]
pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}

/// Wrap an angle to (-pi, pi].
pub fn wrap_pi(x: f64) -> f64 {
    let mut y = x % (2.0 * PI);
    if y > PI {
        y -= 2.0 * PI;
    } else if y <= -PI {
        y += 2.0 * PI;
    }
    y
}

// ---------------------------------------------------------------------------
// PRNG: SplitMix64. Used only for surrogate lags (and test data).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Uniform integer in [lo, hi] inclusive.
    pub fn range(&mut self, lo: usize, hi: usize) -> usize {
        debug_assert!(hi >= lo);
        lo + (self.next_u64() % ((hi - lo + 1) as u64)) as usize
    }
    /// Standard normal (Box-Muller).
    pub fn normal(&mut self) -> f64 {
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        (-2.0 * ln(u1)).sqrt() * cos(2.0 * PI * u2)
    }
}

/// FNV-1a hash, for deriving per-series seeds deterministically.
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, in place)
// ---------------------------------------------------------------------------

pub fn next_pow2(n: usize) -> usize {
    let mut m = 1;
    while m < n {
        m <<= 1;
    }
    m
}

/// In-place complex FFT. Length must be a power of two. `inverse` includes the 1/n scaling.
pub fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    assert_eq!(n, im.len());
    assert!(n.is_power_of_two());
    if n <= 1 {
        return;
    }
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2;
    while len <= n {
        let ang = sign * 2.0 * PI / len as f64;
        let half = len / 2;
        // Twiddles computed directly per index (no accumulated rounding).
        let tw: Vec<(f64, f64)> = (0..half).map(|k| (cos(ang * k as f64), sin(ang * k as f64))).collect();
        let mut i = 0;
        while i < n {
            for k in 0..half {
                let (wr, wi) = tw[k];
                let a = i + k;
                let b = a + half;
                let xr = re[b] * wr - im[b] * wi;
                let xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
            i += len;
        }
        len <<= 1;
    }
    if inverse {
        let s = 1.0 / n as f64;
        for k in 0..n {
            re[k] *= s;
            im[k] *= s;
        }
    }
}

// ---------------------------------------------------------------------------
// Detrending and statistics
// ---------------------------------------------------------------------------

/// Least-squares line through (i, x[i]) over the samples where `mask` is true (all if None).
/// Returns (intercept, slope) in index units, or None when fewer than 2 points.
pub fn fit_line(x: &[f64], mask: Option<&[bool]>) -> Option<(f64, f64)> {
    let (mut n, mut si, mut sx) = (0.0, 0.0, 0.0);
    for (i, &v) in x.iter().enumerate() {
        if mask.is_none_or(|m| m[i]) {
            n += 1.0;
            si += i as f64;
            sx += v;
        }
    }
    if n < 2.0 {
        return None;
    }
    let (mi, mx) = (si / n, sx / n);
    let (mut sii, mut six) = (0.0, 0.0);
    for (i, &v) in x.iter().enumerate() {
        if mask.is_none_or(|m| m[i]) {
            let di = i as f64 - mi;
            sii += di * di;
            six += di * (v - mx);
        }
    }
    let slope = if sii > 0.0 { six / sii } else { 0.0 };
    Some((mx - slope * mi, slope))
}

/// Remove the least-squares line (fitted on masked samples) from every sample.
pub fn detrend(x: &[f64], mask: Option<&[bool]>) -> Vec<f64> {
    match fit_line(x, mask) {
        Some((a, b)) => x.iter().enumerate().map(|(i, &v)| v - (a + b * i as f64)).collect(),
        None => x.to_vec(),
    }
}

pub fn mean(x: &[f64]) -> f64 {
    if x.is_empty() {
        return f64::NAN;
    }
    x.iter().sum::<f64>() / x.len() as f64
}

/// Sample standard deviation (n - 1).
pub fn sd(x: &[f64]) -> f64 {
    if x.len() < 2 {
        return f64::NAN;
    }
    let m = mean(x);
    (x.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / (x.len() - 1) as f64).sqrt()
}

pub fn median(x: &[f64]) -> f64 {
    quantile(x, 0.5)
}

/// Linear-interpolated quantile (type 7). NaN on empty input.
pub fn quantile(x: &[f64], q: f64) -> f64 {
    if x.is_empty() {
        return f64::NAN;
    }
    let mut v = x.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let h = (v.len() - 1) as f64 * q.clamp(0.0, 1.0);
    let lo = h.floor() as usize;
    let hi = h.ceil() as usize;
    v[lo] + (h - lo as f64) * (v[hi] - v[lo])
}

// ---------------------------------------------------------------------------
// Periodogram
// ---------------------------------------------------------------------------

/// One-sided power spectral density (units of x squared per Hz) on a zero-padded grid.
#[derive(Debug, Clone)]
pub struct Spectrum {
    pub df: f64,
    pub psd: Vec<f64>,
    /// Length of the data behind it, s.
    pub duration_s: f64,
    /// Number of tapers averaged.
    pub tapers: usize,
}

impl Spectrum {
    /// Sine multitaper spectrum (Riedel and Sidorenko) of the linearly detrended series, averaged
    /// over `tapers` tapers: about 2 x tapers degrees of freedom per frequency at a half resolution of
    /// (tapers + 1) / (2 x duration). With tapers = 1 it is a single sine-windowed periodogram.
    pub fn multitaper(x: &[f64], fs: f64, pad_factor: f64, tapers: usize) -> Spectrum {
        let n = x.len();
        let k_max = tapers.max(1);
        let y = detrend(x, None);
        let nfft = next_pow2(((n as f64) * pad_factor.max(1.0)).ceil() as usize).max(2);
        let nb = nfft / 2 + 1;
        let mut psd = vec![0.0; nb];
        for k in 1..=k_max {
            let mut re = vec![0.0; nfft];
            let mut im = vec![0.0; nfft];
            let mut wss = 0.0;
            for i in 0..n {
                let w = sin(PI * k as f64 * (i + 1) as f64 / (n + 1) as f64);
                re[i] = y[i] * w;
                wss += w * w;
            }
            fft(&mut re, &mut im, false);
            let scale = 1.0 / (fs * wss * k_max as f64);
            for j in 0..nb {
                let p = (re[j] * re[j] + im[j] * im[j]) * scale;
                psd[j] += if j == 0 || j == nfft / 2 { p } else { 2.0 * p };
            }
        }
        Spectrum { df: fs / nfft as f64, psd, duration_s: n as f64 / fs, tapers: k_max }
    }

    pub fn freq(&self, k: usize) -> f64 {
        k as f64 * self.df
    }

    fn bin_range(&self, lo: f64, hi: f64) -> (usize, usize) {
        let a = (lo / self.df).ceil().max(0.0) as usize;
        let b = ((hi / self.df).floor() as usize).min(self.psd.len().saturating_sub(1));
        (a, b)
    }

    /// Integrated power over [lo, hi] Hz.
    pub fn band_power(&self, lo: f64, hi: f64) -> f64 {
        let (a, b) = self.bin_range(lo, hi);
        if b < a {
            return 0.0;
        }
        self.psd[a..=b].iter().sum::<f64>() * self.df
    }

    /// Median power density over [lo, hi] Hz.
    pub fn band_median(&self, lo: f64, hi: f64) -> f64 {
        let (a, b) = self.bin_range(lo, hi);
        if b < a {
            return f64::NAN;
        }
        median(&self.psd[a..=b])
    }

    /// Median power density over [lo, hi] Hz excluding [xlo, xhi].
    pub fn median_excluding(&self, lo: f64, hi: f64, xlo: f64, xhi: f64) -> f64 {
        let (a, b) = self.bin_range(lo.max(self.df), hi);
        let v: Vec<f64> = (a..=b.max(a)).filter(|&k| k <= b).filter(|&k| {
            let f = self.freq(k);
            f < xlo || f > xhi
        }).map(|k| self.psd[k]).collect();
        median(&v)
    }

    /// Tallest local maximum strictly inside [lo, hi] (not at a band edge), with its
    /// frequency refined by a parabola through the three highest grid points.
    pub fn peak(&self, lo: f64, hi: f64) -> Option<(f64, f64)> {
        let (a, b) = self.bin_range(lo, hi);
        if b < a + 2 {
            return None;
        }
        let mut best: Option<usize> = None;
        for k in (a + 1)..b {
            let p = self.psd[k];
            if p > self.psd[k - 1] && p >= self.psd[k + 1] && best.is_none_or(|j| p > self.psd[j]) {
                best = Some(k);
            }
        }
        let k = best?;
        let (y0, y1, y2) = (self.psd[k - 1], self.psd[k], self.psd[k + 1]);
        let den = y0 - 2.0 * y1 + y2;
        let d = if den != 0.0 { (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) } else { 0.0 };
        Some(((k as f64 + d) * self.df, y1))
    }
}

// ---------------------------------------------------------------------------
// Analytic band-pass (FFT, circular)
// ---------------------------------------------------------------------------

/// Analytic signal of x restricted to [lo, hi] Hz: positive-frequency bins in the band doubled,
/// everything else zero. Circular over a power-of-two length >= x.len() (zero padded);
/// the first x.len() samples are returned as (re, im).
pub fn analytic_bandpass(x: &[f64], fs: f64, lo: f64, hi: f64) -> (Vec<f64>, Vec<f64>) {
    let n = x.len();
    let nfft = next_pow2(n.max(2));
    let mut re = vec![0.0; nfft];
    let mut im = vec![0.0; nfft];
    re[..n].copy_from_slice(x);
    fft(&mut re, &mut im, false);
    let df = fs / nfft as f64;
    for k in 0..nfft {
        let f = k as f64 * df;
        let keep = k > 0 && k < nfft / 2 && f >= lo && f <= hi;
        if keep {
            re[k] *= 2.0;
            im[k] *= 2.0;
        } else {
            re[k] = 0.0;
            im[k] = 0.0;
        }
    }
    fft(&mut re, &mut im, true);
    re.truncate(n);
    im.truncate(n);
    (re, im)
}

// ---------------------------------------------------------------------------
// Biquads (RBJ cookbook) and zero-phase filtering
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
}

impl Biquad {
    pub fn lowpass(fc: f64, fs: f64) -> Self {
        let w = 2.0 * PI * fc / fs;
        let alpha = sin(w) / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        let c = cos(w);
        let a0 = 1.0 + alpha;
        Biquad {
            b: [(1.0 - c) / 2.0 / a0, (1.0 - c) / a0, (1.0 - c) / 2.0 / a0],
            a: [-2.0 * c / a0, (1.0 - alpha) / a0],
        }
    }
    pub fn highpass(fc: f64, fs: f64) -> Self {
        let w = 2.0 * PI * fc / fs;
        let alpha = sin(w) / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        let c = cos(w);
        let a0 = 1.0 + alpha;
        Biquad {
            b: [(1.0 + c) / 2.0 / a0, -(1.0 + c) / a0, (1.0 + c) / 2.0 / a0],
            a: [-2.0 * c / a0, (1.0 - alpha) / a0],
        }
    }
    /// Run over x from rest with the initial state set to the steady state for x[0].
    pub fn run(&self, x: &mut [f64]) {
        if x.is_empty() {
            return;
        }
        // Steady-state for a constant input x0: y = g * x0, g = sum(b) / (1 + sum(a)).
        let g = (self.b[0] + self.b[1] + self.b[2]) / (1.0 + self.a[0] + self.a[1]);
        let x0 = x[0];
        let y0 = g * x0;
        // Direct form II transposed state for constant input.
        let mut z1 = y0 - self.b[0] * x0;
        let mut z2 = self.b[2] * x0 - self.a[1] * y0;
        for v in x.iter_mut() {
            let xin = *v;
            let y = self.b[0] * xin + z1;
            z1 = self.b[1] * xin - self.a[0] * y + z2;
            z2 = self.b[2] * xin - self.a[1] * y;
            *v = y;
        }
    }
}

/// Zero-phase band-pass (forward and backward through high-pass and low-pass biquads)
/// with odd-reflection padding of `pad` samples at each end.
pub fn filtfilt_bandpass(x: &[f64], fs: f64, lo: f64, hi: f64, pad: usize) -> Vec<f64> {
    let n = x.len();
    if n < 3 {
        return vec![0.0; n];
    }
    let pad = pad.min(n - 1);
    let mut y = Vec::with_capacity(n + 2 * pad);
    for i in (1..=pad).rev() {
        y.push(2.0 * x[0] - x[i]);
    }
    y.extend_from_slice(x);
    for i in 1..=pad {
        y.push(2.0 * x[n - 1] - x[n - 1 - i]);
    }
    let hp = Biquad::highpass(lo, fs);
    let lp = Biquad::lowpass(hi, fs);
    hp.run(&mut y);
    lp.run(&mut y);
    y.reverse();
    hp.run(&mut y);
    lp.run(&mut y);
    y.reverse();
    y[pad..pad + n].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periodogram_parseval_for_sinusoid() {
        // Amplitude 30 ms sinusoid at 0.1 Hz over 120 s at 4 Hz: power A^2/2 = 450 ms^2.
        let fs = 4.0;
        let x: Vec<f64> = (0..480).map(|i| 30.0 * sin(2.0 * PI * 0.1 * i as f64 / fs)).collect();
        let s = Spectrum::multitaper(&x, fs, 4.0, 3);
        let p = s.band_power(0.04, 0.4);
        assert!((p - 450.0).abs() / 450.0 < 0.02, "band power {p}");
        let (f, _) = s.peak(0.04, 0.26).unwrap();
        assert!((f - 0.1).abs() < 0.002, "peak {f}");
    }

    #[test]
    fn fft_roundtrip() {
        let mut re: Vec<f64> = (0..64).map(|i| (i as f64 * 0.37).sin()).collect();
        let orig = re.clone();
        let mut im = vec![0.0; 64];
        fft(&mut re, &mut im, false);
        fft(&mut re, &mut im, true);
        for i in 0..64 {
            assert!((re[i] - orig[i]).abs() < 1e-12);
        }
    }
}
