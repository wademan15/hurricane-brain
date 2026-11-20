//! Slow path, spectral part (spec 6.1 to 6.4): multitaper spectra on clean stretches,
//! robust 1/f background, chi-squared peak confirmation, centroid frequency with a
//! jackknife standard error, and band summaries.

use crate::dsp::dpss::dpss;
use crate::dsp::fft::{next_pow2, Fft, C};
use crate::dsp::special::{chi2_isf, trigamma};
use crate::m;
use crate::params::Params;
use crate::types::{BandMap, BandSummary, Measured, Reason};

/// Multitaper estimator with tapers precomputed for every stretch length it accepts.
#[derive(Clone, Debug)]
pub struct Multitaper {
    pub rate: f64,
    pub w_hz: f64,
    pub nfft: usize,
    pub df: f64,
    /// Bins kept, 0..nstore.
    pub nstore: usize,
    /// Stretch lengths are multiples of this many samples.
    pub quantum: usize,
    pub min_len: usize,
    pub max_len: usize,
    fft: Fft,
    /// tapers[len / quantum]
    tapers: Vec<Vec<Vec<f64>>>,
}

impl Multitaper {
    pub fn new(rate: f64, max_len: usize, min_len: usize, quantum: usize, w_hz: f64, grid_hz: f64, store_hi_hz: f64) -> Self {
        let nfft = next_pow2(max_len.max(m::ceil(rate / grid_hz) as usize));
        let df = rate / nfft as f64;
        let nstore = ((m::ceil(store_hi_hz / df) as usize) + 1).min(nfft / 2 + 1);
        let quantum = quantum.max(1);
        let mut tapers = vec![Vec::new(); max_len / quantum + 1];
        let mut len = min_len.div_ceil(quantum) * quantum;
        while len <= max_len {
            let k = Self::k_for_len(len, rate, w_hz);
            if k >= 1 {
                let nw = w_hz * len as f64 / rate;
                tapers[len / quantum] = dpss(len, nw, k);
            }
            len += quantum;
        }
        Multitaper { rate, w_hz, nfft, df, nstore, quantum, min_len, max_len, fft: Fft::new(nfft), tapers }
    }

    /// K = floor(2NW) - 1 tapers for a stretch of `len` samples.
    pub fn k_for_len(len: usize, rate: f64, w_hz: f64) -> usize {
        let nw = w_hz * len as f64 / rate;
        let k2 = m::floor(2.0 * nw + 1e-9) as i64 - 1;
        k2.max(0) as usize
    }

    /// Largest accepted stretch length not above `len`, or None.
    pub fn usable_len(&self, len: usize) -> Option<usize> {
        let l = (len.min(self.max_len) / self.quantum) * self.quantum;
        if l >= self.min_len && !self.tapers[l / self.quantum].is_empty() {
            Some(l)
        } else {
            None
        }
    }

    /// Eigenspectra (one-sided PSD, uV^2/Hz) of one stretch, appended to `out`.
    /// The stretch length must be one returned by `usable_len`.
    pub fn eigenspectra(&self, x: &[f64], out: &mut Vec<Vec<f64>>) {
        let len = x.len();
        let tapers = &self.tapers[len / self.quantum];
        assert!(!tapers.is_empty(), "no tapers for length {len}");
        // Remove the least-squares line.
        let n = len as f64;
        let tm = (n - 1.0) / 2.0;
        let mean = x.iter().sum::<f64>() / n;
        let (mut sxy, mut sxx) = (0.0, 0.0);
        for (i, v) in x.iter().enumerate() {
            let d = i as f64 - tm;
            sxy += d * (v - mean);
            sxx += d * d;
        }
        let slope = if sxx > 0.0 { sxy / sxx } else { 0.0 };
        let y: Vec<f64> = x.iter().enumerate().map(|(i, v)| v - mean - slope * (i as f64 - tm)).collect();
        let scale_one = 1.0 / self.rate;
        let mut buf: Vec<C> = Vec::with_capacity(self.nfft);
        let mut a = vec![0.0; len];
        let mut b = vec![0.0; len];
        let mut pa = vec![0.0; self.nstore];
        let mut pb = vec![0.0; self.nstore];
        let nyq_bin = self.nfft / 2;
        let mut k = 0;
        while k < tapers.len() {
            for i in 0..len {
                a[i] = tapers[k][i] * y[i];
            }
            let two = k + 1 < tapers.len();
            if two {
                for i in 0..len {
                    b[i] = tapers[k + 1][i] * y[i];
                }
            }
            self.fft.two_real_power(&a, if two { Some(&b) } else { None }, self.nstore, &mut buf, &mut pa, &mut pb);
            for (p, used) in [(&pa, true), (&pb, two)] {
                if !used {
                    continue;
                }
                let mut s = vec![0.0; self.nstore];
                for (j, v) in p.iter().enumerate() {
                    let one_sided = if j == 0 || j == nyq_bin { 1.0 } else { 2.0 };
                    s[j] = v * scale_one * one_sided;
                }
                out.push(s);
            }
            k += 2;
        }
    }

    pub fn freq(&self, bin: usize) -> f64 {
        bin as f64 * self.df
    }
}

/// One member's eigenspectra (a channel's clean stretches).
#[derive(Clone, Debug)]
pub struct Member {
    pub eig: Vec<Vec<f64>>,
    pub mean: Vec<f64>,
}

impl Member {
    pub fn new(eig: Vec<Vec<f64>>) -> Self {
        let n = eig[0].len();
        let mut mean = vec![0.0; n];
        for e in &eig {
            for (m, v) in mean.iter_mut().zip(e.iter()) {
                *m += v;
            }
        }
        let k = eig.len() as f64;
        for v in mean.iter_mut() {
            *v /= k;
        }
        Member { eig, mean }
    }
}

/// A site's spectrum: the mean of its members' spectra. Channels have one member.
#[derive(Clone, Debug)]
pub struct SiteSpec {
    pub members: Vec<Member>,
    pub s: Vec<f64>,
    /// Degrees of freedom parameter K for the chi-squared law: the smallest member K
    /// (members share a reference and are correlated, so this is the conservative choice).
    pub k: usize,
    /// Jackknife groups: deleting group g removes eigenspectrum g from every member.
    pub groups: usize,
}

impl SiteSpec {
    pub fn from_members(members: Vec<Member>) -> Self {
        let n = members[0].mean.len();
        let mut s = vec![0.0; n];
        for mb in &members {
            for (a, b) in s.iter_mut().zip(mb.mean.iter()) {
                *a += b;
            }
        }
        let mm = members.len() as f64;
        for v in s.iter_mut() {
            *v /= mm;
        }
        let k = members.iter().map(|m| m.eig.len()).min().unwrap_or(0);
        let groups = members.iter().map(|m| m.eig.len()).max().unwrap_or(0);
        SiteSpec { members, s, k, groups }
    }

    /// The spectrum at bin `i` with jackknife group `g` deleted.
    #[inline]
    pub fn s_del(&self, g: usize, i: usize) -> f64 {
        let mut acc = 0.0;
        for mb in &self.members {
            let kk = mb.eig.len();
            if g < kk && kk >= 2 {
                acc += (mb.mean[i] * kk as f64 - mb.eig[g][i]) / (kk as f64 - 1.0);
            } else {
                acc += mb.mean[i];
            }
        }
        acc / self.members.len() as f64
    }
}

/// Most coefficients the background curve may have (a quartic in log frequency).
pub const BG_MAX_TERMS: usize = 5;

/// Fitted background (spec 6.2).
///
/// `exponent` and `offset` describe the best single power law, 10^offset / f^exponent, and
/// are what the frames report. The background that the spectrum is actually flattened by is
/// the curve: log10 power as a polynomial in log10 frequency with `terms` coefficients
/// (2 is the plain power law), continued as a straight line (its tangent) outside the fitted
/// range. A real spectrum is rarely one power law from 2 to 45 Hz: it has a knee, an
/// amplifier noise floor, filter edges. Where a straight line misfits by 10 % the height
/// test's false-positive rate rises about fourfold, so the curve has to follow the shape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BgFit {
    pub exponent: f64,
    pub exponent_se: f64,
    pub offset: f64,
    pub offset_se: f64,
    /// Inlier RMS residual of the curve over the expected log-SD.
    pub fit_ratio: f64,
    /// Lack of fit of the curve: RMS of the residuals averaged over blocks about 2 Hz wide,
    /// over what estimator noise alone gives (1 = no misfit).
    pub lack_of_fit: f64,
    /// Power-law stage, kept for reference: mean of log10 f over its inliers, their sum of
    /// squares about it, the inflated residual variance, and their number.
    pub xbar: f64,
    pub sxx: f64,
    pub s2: f64,
    pub n: f64,
    /// The curve: number of coefficients, coefficients on powers of u = (log10 f - x_mid) / x_half,
    /// the fitted range in log10 f, and the coefficient covariance (inflated for correlated bins).
    pub terms: usize,
    pub coef: [f64; BG_MAX_TERMS],
    pub x_mid: f64,
    pub x_half: f64,
    pub x_lo: f64,
    pub x_hi: f64,
    pub cov: [[f64; BG_MAX_TERMS]; BG_MAX_TERMS],
}

impl BgFit {
    /// Basis vector g with curve(x) = g . coef, tangent-continued outside [x_lo, x_hi].
    fn basis(&self, x: f64) -> [f64; BG_MAX_TERMS] {
        let xc = x.clamp(self.x_lo, self.x_hi);
        let uc = (xc - self.x_mid) / self.x_half;
        let du = (x - xc) / self.x_half;
        let mut g = [0.0; BG_MAX_TERMS];
        let mut pw = 1.0; // uc^k
        let mut pw_prev = 0.0; // uc^(k-1)
        for (k, gk) in g.iter_mut().enumerate().take(self.terms) {
            *gk = pw + k as f64 * pw_prev * du;
            pw_prev = pw;
            pw *= uc;
        }
        g
    }

    /// log10 of the fitted background at log10 frequency `x`.
    pub fn log10_at_x(&self, x: f64) -> f64 {
        let g = self.basis(x);
        let mut acc = 0.0;
        for k in 0..self.terms {
            acc += g[k] * self.coef[k];
        }
        acc
    }

    /// The fitted background at `f` Hz, uV^2/Hz: the underlying spectrum, before the
    /// estimator's smoothing and the conditioning filters.
    pub fn at(&self, f: f64) -> f64 {
        m::pow(10.0, self.log10_at_x(m::log10(f.max(1e-6))))
    }

    /// The best single power law, 10^offset / f^exponent (what the frames report).
    pub fn power_law_at(&self, f: f64) -> f64 {
        m::pow(10.0, self.offset - self.exponent * m::log10(f.max(1e-6)))
    }

    /// Standard deviation of the fitted background's log10 at `f` (prediction error of the
    /// curve; it grows quickly outside the fitted range).
    pub fn pred_sd_log10(&self, f: f64) -> f64 {
        let g = self.basis(m::log10(f.max(1e-6)));
        let mut v = 0.0;
        for a in 0..self.terms {
            for b in 0..self.terms {
                v += g[a] * self.cov[a][b] * g[b];
            }
        }
        m::sqrt(v.max(0.0))
    }
}

/// Solve the symmetric system A z = b in place (Gaussian elimination with partial pivoting)
/// and return A^-1. None if singular.
fn solve_sym(a: &[[f64; BG_MAX_TERMS]; BG_MAX_TERMS], b: &[f64; BG_MAX_TERMS], mm: usize) -> Option<([f64; BG_MAX_TERMS], [[f64; BG_MAX_TERMS]; BG_MAX_TERMS])> {
    // Augmented [A | I | b].
    let w = 2 * mm + 1;
    let mut t = [[0.0f64; 2 * BG_MAX_TERMS + 1]; BG_MAX_TERMS];
    for i in 0..mm {
        for j in 0..mm {
            t[i][j] = a[i][j];
        }
        t[i][mm + i] = 1.0;
        t[i][2 * mm] = b[i];
    }
    for c in 0..mm {
        let mut piv = c;
        for r in (c + 1)..mm {
            if t[r][c].abs() > t[piv][c].abs() {
                piv = r;
            }
        }
        if !(t[piv][c].abs() > 1e-12) {
            return None;
        }
        t.swap(c, piv);
        let d = t[c][c];
        for j in 0..w {
            t[c][j] /= d;
        }
        for r in 0..mm {
            if r != c {
                let f = t[r][c];
                if f != 0.0 {
                    for j in 0..w {
                        t[r][j] -= f * t[c][j];
                    }
                }
            }
        }
    }
    let mut z = [0.0; BG_MAX_TERMS];
    let mut inv = [[0.0; BG_MAX_TERMS]; BG_MAX_TERMS];
    for i in 0..mm {
        z[i] = t[i][2 * mm];
        for j in 0..mm {
            inv[i][j] = t[i][mm + j];
        }
    }
    Some((z, inv))
}

/// True if `f` lies within the exclusion zone of any mains line or harmonic.
pub fn in_mains_zone(f: f64, mains: &[f64], half: f64) -> bool {
    mains.iter().any(|&mf| {
        let mut h = mf;
        while h < f + half + 1.0 {
            if (f - h).abs() <= half {
                return true;
            }
            h += mf;
        }
        false
    })
}

/// The estimator's expected value for an underlying spectrum `under` (per grid bin): times
/// the conditioning filters' power response, averaged over the multitaper's +-W smoothing
/// window (a box to good approximation). On a steep 1/f spectrum the smoothing alone lifts
/// 1 Hz by 10 to 30 %, which an unsmoothed model would read as a peak.
fn smoothed(under: &[f64], df: f64, w_hz: f64, response: &[f64]) -> Vec<f64> {
    let n = under.len();
    let hw = (m::round(w_hz / df) as usize).max(1);
    let g: Vec<f64> = (0..n).map(|i| under[i] * response.get(i).copied().unwrap_or(1.0)).collect();
    // Prefix sums for the moving average.
    let mut cs = vec![0.0; n + 1];
    for i in 0..n {
        cs[i + 1] = cs[i] + g[i];
    }
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(hw).max(1);
            let hi = (i + hw).min(n - 1);
            if hi < lo {
                g[i]
            } else {
                (cs[hi + 1] - cs[lo]) / (hi + 1 - lo) as f64
            }
        })
        .collect()
}

/// f^b on the grid (bin 0 takes half a bin's frequency).
fn power_law_grid(b: f64, n: usize, df: f64) -> Vec<f64> {
    (0..n).map(|i| m::pow((i as f64 * df).max(df * 0.5), b)).collect()
}

fn smoothed_shape(b: f64, n: usize, df: f64, w_hz: f64, response: &[f64]) -> Vec<f64> {
    smoothed(&power_law_grid(b, n, df), df, w_hz, response)
}

/// Robust background fit (spec 6.2).
///
/// Fit log10 power on log10 frequency over the fit range, dropping bins that sit above the
/// line and refitting, with the model's shape corrected for the estimator's smoothing and the
/// conditioning filters (`response`, squared magnitude per bin; empty for none). Then set
/// the level so that the flattened spectrum's median over the fit bins equals the median of
/// chi2_2K / 2K: under pure background the flattened spectrum then follows chi2_2K / 2K,
/// which is what the height test in 6.3 assumes. Returns the fit and the background on the
/// full grid.
pub fn fit_background(s: &[f64], df: f64, k: usize, p: &Params, mains: &[f64], response: &[f64]) -> Result<(BgFit, Vec<f64>), Reason> {
    if k == 0 {
        return Err(Reason::InsufficientClean);
    }
    let nb = s.len();
    let dec = (m::round(0.25 / df) as usize).max(1);
    let lo = m::ceil(p.bg_fit_lo_hz / df) as usize;
    let hi = (m::floor(p.bg_fit_hi_hz / df) as usize).min(nb - 1);
    let mut idx = Vec::new();
    let mut i = lo.max(1);
    while i <= hi {
        let f = i as f64 * df;
        if !in_mains_zone(f, mains, p.mains_exclusion_hz) && s[i] > 0.0 {
            idx.push(i);
        }
        i += dec;
    }
    if idx.len() < 12 {
        return Err(Reason::BadFit);
    }
    let xs: Vec<f64> = idx.iter().map(|&i| m::log10(i as f64 * df)).collect();
    let sigma = m::sqrt(trigamma(k as f64)) / m::LN10;
    let mut corr = vec![0.0f64; idx.len()]; // log10 of shape correction
    let mut fit = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0); // a, b, se_a, se_b, rms, mx, sxx, s2
    let mut n_in = 0.0;
    for outer in 0..3 {
        let ys: Vec<f64> = idx.iter().zip(corr.iter()).map(|(&i, c)| m::log10(s[i]) - c).collect();
        let mut inl = vec![true; xs.len()];
        for _ in 0..25 {
            let n = inl.iter().filter(|v| **v).count();
            if n < 10 {
                return Err(Reason::BadFit);
            }
            let (mut sx, mut sy) = (0.0, 0.0);
            for j in 0..xs.len() {
                if inl[j] {
                    sx += xs[j];
                    sy += ys[j];
                }
            }
            let (mx, my) = (sx / n as f64, sy / n as f64);
            let (mut sxx, mut sxy) = (0.0, 0.0);
            for j in 0..xs.len() {
                if inl[j] {
                    sxx += (xs[j] - mx) * (xs[j] - mx);
                    sxy += (xs[j] - mx) * (ys[j] - my);
                }
            }
            if sxx <= 0.0 {
                return Err(Reason::BadFit);
            }
            let b = sxy / sxx;
            let a = my - b * mx;
            let mut ss = 0.0;
            for j in 0..xs.len() {
                if inl[j] {
                    let r = ys[j] - (a + b * xs[j]);
                    ss += r * r;
                }
            }
            let rms = m::sqrt(ss / n as f64);
            let s2 = ss / (n as f64 - 2.0).max(1.0);
            fit = (a, b, m::sqrt(s2 * (1.0 / n as f64 + mx * mx / sxx)), m::sqrt(s2 / sxx), rms, mx, sxx, s2);
            n_in = n as f64;
            let mut changed = false;
            for j in 0..xs.len() {
                let r = ys[j] - (a + b * xs[j]);
                let keep = r <= p.bg_drop_sigma * sigma;
                if keep != inl[j] {
                    changed = true;
                    inl[j] = keep;
                }
            }
            if !changed {
                break;
            }
        }
        if outer < 2 {
            let shape = smoothed_shape(fit.1, nb, df, p.mt_half_bandwidth_hz, response);
            for (j, &i) in idx.iter().enumerate() {
                let f = (i as f64 * df).max(df * 0.5);
                corr[j] = m::log10(shape[i] / m::pow(f, fit.1));
            }
        }
    }
    let (_a, b, se_a, se_b, rms, mx, sxx, s2) = fit;
    let fit_ratio = rms / sigma;
    if !(fit_ratio <= p.bg_fit_max_ratio) {
        return Err(Reason::BadFit);
    }
    // Level by the median of all fit bins (robust to the few peak bins).
    let shape = smoothed_shape(b, nb, df, p.mt_half_bandwidth_hz, response);
    let ratios: Vec<f64> = idx.iter().map(|&i| s[i] / shape[i]).collect();
    let med = m::median(&ratios).ok_or(Reason::BadFit)?;
    let dof = 2.0 * k as f64;
    let chi_med = chi2_isf(0.5, dof) / dof;
    let level = med / chi_med;
    let offset = m::log10(level);
    // Fit bins on the 0.25 Hz grid are correlated over the 2W resolution: inflate.
    let infl2 = (2.0 * p.mt_half_bandwidth_hz / (dec as f64 * df)).max(1.0);
    let infl = m::sqrt(infl2);
    let (x_lo, x_hi) = (xs[0], xs[xs.len() - 1]);
    let x_mid = 0.5 * (x_lo + x_hi);
    let x_half = (0.5 * (x_hi - x_lo)).max(1e-9);
    let mut out = BgFit {
        exponent: -b,
        exponent_se: se_b * infl,
        offset,
        offset_se: se_a * infl,
        fit_ratio,
        lack_of_fit: 1.0,
        xbar: mx,
        sxx,
        s2: s2 * infl2,
        n: n_in,
        terms: 2,
        coef: [0.0; BG_MAX_TERMS],
        x_mid,
        x_half,
        x_lo,
        x_hi,
        cov: [[0.0; BG_MAX_TERMS]; BG_MAX_TERMS],
    };
    // The power law written as a curve with two coefficients on u = (x - x_mid) / x_half.
    out.coef[0] = offset + b * x_mid;
    out.coef[1] = b * x_half;
    {
        // Covariance of (value at x_mid, slope per u) from the straight-line fit.
        let s2i = s2 * infl2;
        let d = x_mid - mx;
        let var_b = s2i / sxx;
        out.cov[0][0] = s2i / n_in + d * d * var_b;
        out.cov[0][1] = d * var_b * x_half;
        out.cov[1][0] = out.cov[0][1];
        out.cov[1][1] = var_b * x_half * x_half;
    }
    let terms = p.bg_curve_terms.clamp(2, BG_MAX_TERMS);
    let mut bg = shape.iter().map(|v| v * level).collect::<Vec<f64>>();
    let mut inl_final: Vec<bool> = Vec::new();
    let mut corr_final = corr.clone();
    if terms > 2 {
        // Curve stage: the same robust fit with a polynomial in u, starting from the power
        // law's smoothing correction. The underlying curve is tangent-continued outside the
        // fitted range, so nothing is extrapolated as a polynomial.
        let us: Vec<f64> = xs.iter().map(|x| (x - x_mid) / x_half).collect();
        let grid_x: Vec<f64> = (0..nb).map(|i| m::log10((i as f64 * df).max(df * 0.5))).collect();
        let mut cv = out;
        cv.terms = terms;
        let mut corr2 = corr.clone();
        let mut ok = true;
        let mut inl = vec![true; xs.len()];
        let mut last_s2 = 0.0;
        let mut last_inv = [[0.0; BG_MAX_TERMS]; BG_MAX_TERMS];
        let mut last_rms = 0.0;
        'outer: for outer in 0..3 {
            let ys: Vec<f64> = idx.iter().zip(corr2.iter()).map(|(&i, c)| m::log10(s[i]) - c).collect();
            inl = vec![true; xs.len()];
            for _ in 0..25 {
                let n = inl.iter().filter(|v| **v).count();
                if n < 10 + terms {
                    ok = false;
                    break 'outer;
                }
                let mut a = [[0.0; BG_MAX_TERMS]; BG_MAX_TERMS];
                let mut rhs = [0.0; BG_MAX_TERMS];
                for j in 0..xs.len() {
                    if !inl[j] {
                        continue;
                    }
                    let mut pw = [0.0; BG_MAX_TERMS];
                    let mut v = 1.0;
                    for slot in pw.iter_mut().take(terms) {
                        *slot = v;
                        v *= us[j];
                    }
                    for r in 0..terms {
                        rhs[r] += pw[r] * ys[j];
                        for c in 0..terms {
                            a[r][c] += pw[r] * pw[c];
                        }
                    }
                }
                let Some((z, inv)) = solve_sym(&a, &rhs, terms) else {
                    ok = false;
                    break 'outer;
                };
                cv.coef = z;
                let mut ss = 0.0;
                let mut changed = false;
                let mut keepv = vec![true; xs.len()];
                for j in 0..xs.len() {
                    let r = ys[j] - cv.log10_at_x(xs[j]);
                    if inl[j] {
                        ss += r * r;
                    }
                    keepv[j] = r <= p.bg_drop_sigma * sigma;
                    if keepv[j] != inl[j] {
                        changed = true;
                    }
                }
                last_rms = m::sqrt(ss / n as f64);
                last_s2 = ss / (n as f64 - terms as f64).max(1.0);
                last_inv = inv;
                if !changed {
                    break;
                }
                inl = keepv;
            }
            if outer < 2 {
                let under: Vec<f64> = grid_x.iter().map(|x| m::pow(10.0, cv.log10_at_x(*x))).collect();
                let sm = smoothed(&under, df, p.mt_half_bandwidth_hz, response);
                for (j, &i) in idx.iter().enumerate() {
                    corr2[j] = m::log10(sm[i] / under[i]);
                }
            }
        }
        if !ok {
            return Err(Reason::BadFit);
        }
        let under: Vec<f64> = grid_x.iter().map(|x| m::pow(10.0, cv.log10_at_x(*x))).collect();
        let sm = smoothed(&under, df, p.mt_half_bandwidth_hz, response);
        let ratios: Vec<f64> = idx.iter().map(|&i| s[i] / sm[i]).collect();
        let med = m::median(&ratios).ok_or(Reason::BadFit)?;
        let lv = med / chi_med;
        cv.coef[0] += m::log10(lv);
        for r in 0..terms {
            for c in 0..terms {
                cv.cov[r][c] = last_inv[r][c] * last_s2 * infl2;
            }
        }
        cv.fit_ratio = last_rms / sigma;
        if !(cv.fit_ratio <= p.bg_fit_max_ratio) {
            return Err(Reason::BadFit);
        }
        bg = sm.iter().map(|v| v * lv).collect();
        for (j, &i) in idx.iter().enumerate() {
            corr_final[j] = m::log10(sm[i] / under[i]);
        }
        inl_final = inl;
        out = cv;
    }
    let _ = (&inl_final, &corr_final);
    // Lack of fit. The robust fit drops what sits above the line, so its inlier residual
    // cannot see a background the model does not follow. Average the flattened spectrum's
    // log over blocks about 2 Hz wide (peaks excluded by a median within the block) and
    // compare the spread of the block values with what estimator noise alone gives.
    out.lack_of_fit = lack_of_fit(s, &bg, &idx, df, k, p);
    if !(out.lack_of_fit <= p.bg_lack_of_fit_max) {
        return Err(Reason::BadFit);
    }
    Ok((out, bg))
}

/// Lack-of-fit statistic for a fitted background: the fit bins are grouped into blocks
/// `bg_lof_block_hz` wide; each block's value is the median of ln(S / bg) over its bins
/// minus the median expected under chi2_2K / 2K. The statistic is the RMS of the block
/// values that lie below +`bg_drop_sigma` block SDs (real peaks lift blocks, and must not
/// fail the fit) over the block SD under noise. About 1 for a background the model follows.
fn lack_of_fit(s: &[f64], bg: &[f64], idx: &[usize], df: f64, k: usize, p: &Params) -> f64 {
    let dof = 2.0 * k as f64;
    let ln_med = m::ln(chi2_isf(0.5, dof) / dof);
    let sd1 = m::sqrt(trigamma(k as f64));
    // Independent cells per block: block width over the 2W resolution; the median of c
    // independent values has SD about 1.25 sd1 / sqrt(c).
    let cells = (p.bg_lof_block_hz / (2.0 * p.mt_half_bandwidth_hz)).max(1.0);
    let sd_block = 1.2533 * sd1 / m::sqrt(cells);
    let mut vals: Vec<f64> = Vec::new();
    let mut cur: Vec<f64> = Vec::new();
    let mut block_start = idx[0] as f64 * df;
    for &i in idx {
        let f = i as f64 * df;
        if f - block_start >= p.bg_lof_block_hz {
            if cur.len() >= 3 {
                if let Some(md) = m::median(&cur) {
                    vals.push(md - ln_med);
                }
            }
            cur.clear();
            block_start = f;
        }
        cur.push(m::ln(s[i] / bg[i]));
    }
    if cur.len() >= 3 {
        if let Some(md) = m::median(&cur) {
            vals.push(md - ln_med);
        }
    }
    let kept: Vec<f64> = vals.iter().copied().filter(|v| *v <= p.bg_drop_sigma * sd_block).collect();
    if kept.len() < 4 {
        return 1.0;
    }
    m::sqrt(kept.iter().map(|v| v * v).sum::<f64>() / kept.len() as f64) / sd_block
}

/// A peak that passed the height and width tests in one window at one site.
#[derive(Clone, Debug, PartialEq)]
pub struct Peak {
    /// Centroid frequency, Hz.
    pub f: f64,
    /// Jackknife standard error, Hz (floored).
    pub se: f64,
    /// Flattened height at the maximum (1 = background).
    pub h: f64,
    pub h_db_se: Option<f64>,
    /// Full width at half height, Hz.
    pub width: f64,
}

impl Peak {
    pub fn h_db(&self) -> f64 {
        m::db(self.h)
    }
}

/// The height threshold for a window: flattened height at which pure background produces a
/// maximum anywhere in the search range with probability `alpha` (spec 6.3, item 1), from
/// the chi-squared law with 2K degrees of freedom. `m_bins` is the effective number of
/// independent tries in the search range; the per-try level is Sidak-corrected. Returns the
/// threshold and the per-try tail probability.
pub fn height_threshold(k: usize, alpha: f64, m_bins: f64) -> (f64, f64) {
    let dof = 2.0 * k as f64;
    let p_bin = -m::expm1(m::ln1p(-alpha) / m_bins.max(1.0));
    (chi2_isf(p_bin, dof) / dof, p_bin)
}

pub struct PeakSearch<'a> {
    pub p: &'a Params,
    pub df: f64,
    pub mains: &'a [f64],
    /// False-peak probability for this site and window (alpha_peak split across sites).
    pub alpha_site: f64,
    pub fit: &'a BgFit,
    /// Window length T, s.
    pub window_s: f64,
}

pub struct PeakResult {
    pub peaks: Vec<Peak>,
    /// Number of local maxima above the height threshold (before width checks).
    pub height_passes: usize,
    pub threshold: f64,
}

/// Contiguous region around `i` where `vals > level`; returns (left crossing Hz, right crossing Hz, lo bin, hi bin)
/// or None if a crossing is not found inside [min_bin, max_bin].
fn half_region(flat: &[f64], i: usize, level: f64, min_bin: usize, max_bin: usize, df: f64) -> Option<(f64, f64, usize, usize)> {
    let mut l = i;
    while l > min_bin && flat[l - 1] > level {
        l -= 1;
    }
    if l == min_bin {
        return None;
    }
    let mut r = i;
    while r < max_bin && flat[r + 1] > level {
        r += 1;
    }
    if r == max_bin {
        return None;
    }
    // Interpolated crossings between (l-1, l) and (r, r+1).
    let fl = {
        let (y0, y1) = (flat[l - 1], flat[l]);
        let t = if y1 != y0 { (level - y0) / (y1 - y0) } else { 0.5 };
        (l as f64 - 1.0 + t) * df
    };
    let fr = {
        let (y0, y1) = (flat[r], flat[r + 1]);
        let t = if y1 != y0 { (y0 - level) / (y0 - y1) } else { 0.5 };
        (r as f64 + t) * df
    };
    Some((fl, fr, l, r))
}

fn centroid(flat: &[f64], l: usize, r: usize, level: f64, df: f64) -> Option<f64> {
    let (mut sw, mut sfw) = (0.0, 0.0);
    for j in l..=r {
        let w = flat[j] - level;
        if w > 0.0 {
            sw += w;
            sfw += w * j as f64 * df;
        }
    }
    if sw > 0.0 {
        Some(sfw / sw)
    } else {
        None
    }
}

/// Find peaks passing the height and width tests (spec 6.3 items 1, 2 and 4), with centroid
/// frequency and jackknife standard errors (6.4).
pub fn find_peaks(spec: &SiteSpec, bg: &[f64], flat: &[f64], ps: &PeakSearch) -> PeakResult {
    let p = ps.p;
    let df = ps.df;
    let n = flat.len();
    let lo = (m::ceil(p.peak_search_lo_hz / df) as usize).max(1);
    let hi = (m::floor(p.peak_search_hi_hz / df) as usize).min(n - 2);
    let w2 = 2.0 * p.mt_half_bandwidth_hz;
    let mut searched = 0usize;
    for i in lo..=hi {
        if !in_mains_zone(i as f64 * df, ps.mains, p.mains_exclusion_hz) {
            searched += 1;
        }
    }
    // Effective independent tries. The maximum of a finely sampled multitaper spectrum
    // behaves like a search over one try per Rayleigh bin (1/T), not one per 2W: simulation
    // on background-only noise (tests/engine.rs) shows the per-2W count understates false
    // peaks about eightfold at T = 8 s. Spec 6.3: "then verified by simulation".
    let m_bins = searched as f64 * df * ps.window_s * p.peak_tries_per_rayleigh;
    let (thr, p_bin) = height_threshold(spec.k, ps.alpha_site, m_bins);
    // The fitted background is itself uncertain (most at the ends of the fit range). A
    // lognormal error of SD sigma on the background makes the flattened tail heavier by
    // exp(lambda^2 sigma^2 / 2), lambda = K h - (K - 1) the local log-slope of the chi2_2K/2K
    // tail at h; holding the per-try probability fixed moves the threshold up by
    // exp(lambda sigma^2 / 2). First-order, per bin.
    let kf = spec.k as f64;
    let lam = (kf * thr - (kf - 1.0)).max(0.0);
    let thr_at = |i: usize| {
        let sg = m::LN10 * ps.fit.pred_sd_log10(i as f64 * df);
        thr * m::exp(0.5 * lam * sg * sg)
    };
    let _ = p_bin;
    let mut cands: Vec<usize> = Vec::new();
    for i in lo..=hi {
        if flat[i] > thr_at(i) && flat[i] > flat[i - 1] && flat[i] >= flat[i + 1] && !in_mains_zone(i as f64 * df, ps.mains, p.mains_exclusion_hz) {
            cands.push(i);
        }
    }
    let height_passes = cands.len();
    cands.sort_by(|a, b| flat[*b].total_cmp(&flat[*a]).then(a.cmp(b)));
    let min_bin = (m::ceil(0.5 / df) as usize).max(1);
    let max_bin = n - 2;
    let min_w = p.peak_width_min_factor * w2;
    let mut consumed: Vec<(usize, usize)> = Vec::new();
    let mut peaks = Vec::new();
    // Region, width and centre use the rhythm's own power above the background, e = S - bg:
    // "half height" is half of the peak's excess. The flattened spectrum S / bg would weight
    // each bin by (f / f0)^chi relative to the rhythm's power and shift a broad low-frequency
    // rhythm upward by about chi sigma^2 / f0 (1 % at 5 Hz); the excess has no such skew.
    let excess: Vec<f64> = spec.s.iter().zip(bg.iter()).map(|(s, b)| s - b).collect();
    for &i0 in &cands {
        if consumed.iter().any(|(a, b)| i0 >= *a && i0 <= *b) {
            continue;
        }
        // Move to the top: from the candidate, take the highest excess inside its half-height
        // region and repeat until the region's maximum is its own. A ripple or shoulder thus
        // becomes the larger peak it belongs to, and a peak already taken is not taken twice.
        let mut i = i0;
        let mut region = None;
        for _ in 0..16 {
            let level = excess[i] / 2.0;
            if !(level > 0.0) {
                break;
            }
            let Some(rg) = half_region(&excess, i, level, min_bin, max_bin, df) else { break };
            let (_, _, l, r) = rg;
            let mut top = i;
            for j in l..=r {
                if excess[j] > excess[top] {
                    top = j;
                }
            }
            if top == i {
                region = Some(rg);
                break;
            }
            i = top;
        }
        let Some((fl, fr, l, r)) = region else { continue };
        let level = excess[i] / 2.0;
        if consumed.iter().any(|(a, b)| l <= *b && r >= *a) {
            continue;
        }
        consumed.push((l, r));
        // Height: the flattened maximum within the peak's own region (spec 9: at the peak).
        let h = flat[l..=r].iter().fold(flat[i0], |a, b| a.max(*b));
        let width = fr - fl;
        if width < min_w || width > p.peak_width_max_hz {
            continue;
        }
        let Some(f) = centroid(&excess, l, r, level, df) else { continue };
        // Jackknife over groups (tapers), repeating the whole estimate on each delete-one spectrum.
        let g = spec.groups;
        if g < 2 || spec.k < 2 {
            continue;
        }
        let ext = (m::ceil(1.0 / df) as usize).max(1);
        let a = l.saturating_sub(ext).max(min_bin);
        let b = (r + ext).min(max_bin);
        let mut e_del = vec![0.0; n];
        let mut cs = Vec::with_capacity(g);
        let mut hs = Vec::with_capacity(g);
        let mut ok = true;
        for gi in 0..g {
            let mut hmax: f64 = 0.0;
            for j in a..=b {
                let sd = spec.s_del(gi, j);
                e_del[j] = sd - bg[j];
                if j >= l && j <= r {
                    hmax = hmax.max(sd / bg[j]);
                }
            }
            let mut im = l;
            for j in l..=r {
                if e_del[j] > e_del[im] {
                    im = j;
                }
            }
            let lev = e_del[im] / 2.0;
            if !(lev > 0.0) || hmax <= 0.0 {
                ok = false;
                break;
            }
            let mut ll = im;
            while ll > a && e_del[ll - 1] > lev {
                ll -= 1;
            }
            let mut rr = im;
            while rr < b && e_del[rr + 1] > lev {
                rr += 1;
            }
            match centroid(&e_del, ll, rr, lev, df) {
                Some(c) => cs.push(c),
                None => {
                    ok = false;
                    break;
                }
            }
            hs.push(m::db(hmax));
        }
        if !ok {
            continue;
        }
        let gf = g as f64;
        let jk = |v: &[f64]| {
            let mean = v.iter().sum::<f64>() / gf;
            m::sqrt((gf - 1.0) / gf * v.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>())
        };
        let se = jk(&cs).max(p.freq_se_floor_hz);
        let h_se = jk(&hs);
        peaks.push(Peak { f, se, h, h_db_se: Some(h_se), width });
    }
    peaks.sort_by(|a, b| a.f.total_cmp(&b.f));
    PeakResult { peaks, height_passes, threshold: thr }
}

/// Band summary over [lo, hi) Hz (spec 9): power above background and total power, each
/// with a jackknife standard error.
pub fn band_summary(spec: &SiteSpec, bg: &[f64], df: f64, lo: f64, hi: f64) -> BandSummary {
    let a = (m::ceil(lo / df) as usize).max(1);
    let b = (m::ceil(hi / df) as usize).min(spec.s.len());
    if b <= a {
        return BandSummary { above_bg_db: Measured::null(Reason::NotAvailable), power: Measured::null(Reason::NotAvailable) };
    }
    let sum_bg: f64 = bg[a..b].iter().sum();
    let sum_s: f64 = spec.s[a..b].iter().sum();
    let g = spec.groups;
    let (mut ab, mut pw) = (Vec::new(), Vec::new());
    if g >= 2 {
        for gi in 0..g {
            let mut s = 0.0;
            for j in a..b {
                s += spec.s_del(gi, j);
            }
            ab.push(m::db(s / sum_bg));
            pw.push(s * df);
        }
    }
    let jk = |v: &[f64]| -> Option<f64> {
        if v.len() < 2 {
            return None;
        }
        let gf = v.len() as f64;
        let mean = v.iter().sum::<f64>() / gf;
        Some(m::sqrt((gf - 1.0) / gf * v.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>()))
    };
    BandSummary {
        above_bg_db: Measured::opt_se(m::db(sum_s / sum_bg), jk(&ab)),
        power: Measured::opt_se(sum_s * df, jk(&pw)),
    }
}

pub fn null_bands(why: Reason) -> BandMap<BandSummary> {
    BandMap::from_fn(|_| BandSummary { above_bg_db: Measured::null(why), power: Measured::null(why) })
}

/// The full analysis of one site in one window.
#[derive(Clone, Debug)]
pub struct SiteAnalysis {
    pub spec: SiteSpec,
    pub bg_fit: Result<BgFit, Reason>,
    /// Background and flattened spectrum on the internal grid (empty when the fit failed).
    pub bg: Vec<f64>,
    pub flat: Vec<f64>,
    pub peaks: Vec<Peak>,
    pub height_passes: usize,
    pub threshold: f64,
}

/// `response`: squared magnitude of the conditioning filters per grid bin (empty for none).
pub fn analyse_site(spec: SiteSpec, df: f64, p: &Params, mains: &[f64], alpha_site: f64, response: &[f64]) -> SiteAnalysis {
    let window_s = p.slow_window_s;
    match fit_background(&spec.s, df, spec.k, p, mains, response) {
        Ok((fit, bg)) => {
            let flat: Vec<f64> = spec.s.iter().zip(bg.iter()).map(|(s, b)| s / b).collect();
            let ps = PeakSearch { p, df, mains, alpha_site, fit: &fit, window_s };
            let pr = find_peaks(&spec, &bg, &flat, &ps);
            SiteAnalysis { spec, bg_fit: Ok(fit), bg, flat, peaks: pr.peaks, height_passes: pr.height_passes, threshold: pr.threshold }
        }
        Err(w) => SiteAnalysis { spec, bg_fit: Err(w), bg: Vec::new(), flat: Vec::new(), peaks: Vec::new(), height_passes: 0, threshold: f64::NAN },
    }
}

/// Analyse one fully clean window on its own, as a single site. Used by tests and the lab
/// comparison to check the confirmation test's false-positive rate on background noise.
pub struct WindowAnalyzer {
    pub mt: Multitaper,
    pub p: Params,
}

impl WindowAnalyzer {
    pub fn new(p: Params, rate: f64) -> Self {
        let wlen = m::round(p.slow_window_s * rate) as usize;
        let quantum = (m::round(p.slow_update_s * rate) as usize).max(1);
        let min_len = m::round(p.min_clean_stretch_s * rate) as usize;
        let mt = Multitaper::new(rate, wlen, min_len, quantum, p.mt_half_bandwidth_hz, p.spectrum_grid_hz, 64.0f64.min(rate / 2.0));
        WindowAnalyzer { mt, p }
    }

    pub fn window_len(&self) -> usize {
        self.mt.max_len
    }

    pub fn analyse(&self, x: &[f32], mains: &[f64]) -> SiteAnalysis {
        let len = self.mt.usable_len(x.len()).expect("window too short");
        let xs: Vec<f64> = x[x.len() - len..].iter().map(|v| *v as f64).collect();
        let mut eig = Vec::new();
        self.mt.eigenspectra(&xs, &mut eig);
        let spec = SiteSpec::from_members(vec![Member::new(eig)]);
        analyse_site(spec, self.mt.df, &self.p, mains, self.p.alpha_peak, &[])
    }
}
