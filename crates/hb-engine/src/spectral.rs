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

/// Fitted background psd_bg(f) = 10^offset / f^exponent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BgFit {
    pub exponent: f64,
    pub exponent_se: f64,
    pub offset: f64,
    pub offset_se: f64,
    /// Inlier RMS residual over the expected log-SD.
    pub fit_ratio: f64,
}

impl BgFit {
    pub fn at(&self, f: f64) -> f64 {
        m::pow(10.0, self.offset - self.exponent * m::log10(f.max(1e-6)))
    }
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

/// Robust background fit (spec 6.2). Fit log10 power on log10 frequency, drop bins sitting
/// above the line, refit; then set the level so that the flattened spectrum's median equals
/// the chi-squared median, which makes the flattened spectrum follow chi2_2K / 2K under
/// pure background. That calibration is what the height test in 6.3 assumes.
pub fn fit_background(s: &[f64], df: f64, k: usize, p: &Params, mains: &[f64]) -> Result<BgFit, Reason> {
    if k == 0 {
        return Err(Reason::InsufficientClean);
    }
    let dec = (m::round(0.25 / df) as usize).max(1);
    let lo = m::ceil(p.bg_fit_lo_hz / df) as usize;
    let hi = (m::floor(p.bg_fit_hi_hz / df) as usize).min(s.len() - 1);
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    let mut raw = Vec::new();
    let mut i = lo.max(1);
    while i <= hi {
        let f = i as f64 * df;
        if !in_mains_zone(f, mains, p.mains_exclusion_hz) && s[i] > 0.0 {
            xs.push(m::log10(f));
            ys.push(m::log10(s[i]));
            raw.push(s[i]);
        }
        i += dec;
    }
    if xs.len() < 12 {
        return Err(Reason::BadFit);
    }
    let sigma = m::sqrt(trigamma(k as f64)) / m::LN10;
    let mut inl = vec![true; xs.len()];
    let mut fit = (0.0, 0.0, 0.0, 0.0, 0.0); // a, b, se_a, se_b, rms
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
        let se_b = m::sqrt(s2 / sxx);
        let se_a = m::sqrt(s2 * (1.0 / n as f64 + mx * mx / sxx));
        fit = (a, b, se_a, se_b, rms);
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
    let (a, b, se_a, se_b, rms) = fit;
    let fit_ratio = rms / sigma;
    if !(fit_ratio <= p.bg_fit_max_ratio) {
        return Err(Reason::BadFit);
    }
    // Level calibration by the median of all fit bins (robust to the few peak bins).
    let ratios: Vec<f64> = xs.iter().zip(raw.iter()).map(|(x, sv)| sv / m::pow(10.0, a + b * x)).collect();
    let med = m::median(&ratios).ok_or(Reason::BadFit)?;
    let dof = 2.0 * k as f64;
    let chi_med = chi2_isf(0.5, dof) / dof;
    let offset = a + m::log10(med / chi_med);
    // Bins on the 0.25 Hz grid are correlated over the 2W resolution; inflate the OLS SE.
    let infl = m::sqrt((2.0 * p.mt_half_bandwidth_hz / (dec as f64 * df)).max(1.0));
    Ok(BgFit { exponent: -b, exponent_se: se_b * infl, offset, offset_se: se_a * infl, fit_ratio })
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
/// maximum anywhere in the search range with probability `alpha` (spec 6.3, item 1).
/// `m_bins` independent bins of width 2W are searched; the per-bin level is Sidak-corrected.
pub fn height_threshold(k: usize, alpha: f64, m_bins: f64) -> f64 {
    let dof = 2.0 * k as f64;
    let p_bin = -m::expm1(m::ln1p(-alpha) / m_bins.max(1.0));
    chi2_isf(p_bin, dof) / dof
}

pub struct PeakSearch<'a> {
    pub p: &'a Params,
    pub df: f64,
    pub mains: &'a [f64],
    /// False-peak probability for this site and window (alpha_peak split across sites).
    pub alpha_site: f64,
}

pub struct PeakResult {
    pub peaks: Vec<Peak>,
    /// Number of local maxima above the height threshold (before width checks).
    pub height_passes: usize,
    pub threshold: f64,
}

/// Contiguous region around `i` where `flat > level`; returns (left crossing Hz, right crossing Hz, lo bin, hi bin)
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
    let m_bins = searched as f64 * df / w2;
    let thr = height_threshold(spec.k, ps.alpha_site, m_bins);
    let mut cands: Vec<usize> = Vec::new();
    for i in lo..=hi {
        if flat[i] > thr && flat[i] > flat[i - 1] && flat[i] >= flat[i + 1] && !in_mains_zone(i as f64 * df, ps.mains, p.mains_exclusion_hz) {
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
    for &i in &cands {
        if consumed.iter().any(|(a, b)| i >= *a && i <= *b) {
            continue;
        }
        let h = flat[i];
        let level = 1.0 + (h - 1.0) / 2.0;
        let Some((fl, fr, l, r)) = half_region(flat, i, level, min_bin, max_bin, df) else {
            consumed.push((i, i));
            continue;
        };
        consumed.push((l, r));
        let width = fr - fl;
        if width < min_w || width > p.peak_width_max_hz {
            continue;
        }
        let Some(f) = centroid(flat, l, r, level, df) else { continue };
        // Jackknife over groups (tapers).
        let g = spec.groups;
        if g < 2 || spec.k < 2 {
            continue;
        }
        let ext = (m::ceil(1.0 / df) as usize).max(1);
        let a = l.saturating_sub(ext).max(min_bin);
        let b = (r + ext).min(max_bin);
        let mut fl_del = vec![0.0; n];
        let mut cs = Vec::with_capacity(g);
        let mut hs = Vec::with_capacity(g);
        let mut ok = true;
        for gi in 0..g {
            for j in a..=b {
                fl_del[j] = spec.s_del(gi, j) / bg[j];
            }
            // Maximum within the original half-height region.
            let mut im = l;
            for j in l..=r {
                if fl_del[j] > fl_del[im] {
                    im = j;
                }
            }
            let hg = fl_del[im];
            if hg <= 1.0 {
                ok = false;
                break;
            }
            let lev = 1.0 + (hg - 1.0) / 2.0;
            let mut ll = im;
            while ll > a && fl_del[ll - 1] > lev {
                ll -= 1;
            }
            let mut rr = im;
            while rr < b && fl_del[rr + 1] > lev {
                rr += 1;
            }
            match centroid(&fl_del, ll, rr, lev, df) {
                Some(c) => cs.push(c),
                None => {
                    ok = false;
                    break;
                }
            }
            hs.push(m::db(hg));
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

pub fn analyse_site(spec: SiteSpec, df: f64, p: &Params, mains: &[f64], alpha_site: f64) -> SiteAnalysis {
    let bg_fit = fit_background(&spec.s, df, spec.k, p, mains);
    match bg_fit {
        Ok(fit) => {
            let bg: Vec<f64> = (0..spec.s.len()).map(|i| fit.at((i as f64 * df).max(df * 0.5))).collect();
            let flat: Vec<f64> = spec.s.iter().zip(bg.iter()).map(|(s, b)| s / b).collect();
            let ps = PeakSearch { p, df, mains, alpha_site };
            let pr = find_peaks(&spec, &bg, &flat, &ps);
            SiteAnalysis { spec, bg_fit, bg, flat, peaks: pr.peaks, height_passes: pr.height_passes, threshold: pr.threshold }
        }
        Err(_) => SiteAnalysis { spec, bg_fit, bg: Vec::new(), flat: Vec::new(), peaks: Vec::new(), height_passes: 0, threshold: f64::NAN },
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
        analyse_site(spec, self.mt.df, &self.p, mains, self.p.alpha_peak)
    }
}
