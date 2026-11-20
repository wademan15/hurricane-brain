"""Independent implementations of the candidate methods in spec section 10.1.

Stage            Candidates here
---------------  -----------------------------------------------------------------------------
Spectrum         S1 multitaper (W = 0.5 Hz), S2 Welch (2 s Hann, 50 % overlap),
                 S3 IRASA (irregular resampling, h = 1.10..1.90; total spectrum = Welch)
Confirmation     P1 robust 1/f fit + chi-squared height test with multiple-bin correction
                 P2 prominence over the median of neighbouring bins
                 P3 multitaper harmonic F-test (Thomson)
                 P4 specparam-style Gaussians over an aperiodic fit (the `fooof` package, v1.1)
Peak frequency   centroid above half height, Gaussian fit (log-parabola least squares),
                 parabolic interpolation on the native frequency grid
Fast tracking    F1 complex demodulation (band-pass + analytic signal), F2 phase-locked loop,
                 F3 short overlapping spectra, F4 extended Kalman oscillator, F5 cycle-by-cycle
Aligned state    T1 fixed tolerance, T2 scaled tolerance, T3 evidence ratio, T4 constant false
                 alarm rate (applied to T3's statistic and, as T4c, to T1's closeness)
Chance           chance A (unrelated peaks), chance B (own wandering), same scoring path

Every provisional number comes from PARAMS, which mirrors spec section 14.
"""
from __future__ import annotations

import warnings
from fractions import Fraction

import numpy as np
from scipy import stats
from scipy.ndimage import median_filter
from scipy.signal import butter, resample_poly, sosfilt
from scipy.signal.windows import dpss, hann

FS = 256.0
PHI = (1 + 5 ** 0.5) / 2
NFFT = 8192                      # zero-padded grid, 0.03125 Hz
FREQS = np.fft.rfftfreq(NFFT, 1 / FS)
FMAX_KEEP = 60.0
KEEP = FREQS <= FMAX_KEEP
F = FREQS[KEEP]
DF = F[1] - F[0]

PARAMS = {
    "window_s": 8.0, "hop_s": 1.0, "search": (1.0, 45.0), "fit": (2.0, 45.0), "mains_excl": 2.0,
    "alpha_peak": 0.01, "width_max": 6.0, "persist_k": 2, "persist_n": 3, "hold_s": 2.0,
    "integ_s": 30.0, "join_hz": 1.0, "join_se": 3.0, "sx_limit": 0.03, "eps": 0.03, "tau": 0.01,
    "targets": {"phi": PHI, "octave": 2.0, "c1.5": 1.5, "c1.8": 1.8},
    "dwell_s": 5.0, "n_surr": 200, "chanceB_min_lag": 10.0, "chanceB_hist": 120.0,
    "pad_s": 0.25, "min_clean": 0.6, "min_stretch": 2.0, "repair_max": 12, "repaired_frac": 0.02,
    "hp_hz": 0.5, "T2_k": 2.0, "T3_entry": 2.0, "T3_exit": 1.0, "alpha_state": 1.0 / 120.0,
    "hyst": 1.33, "mt_w": 0.5,
}
TARGETS = PARAMS["targets"]
LN_T = {k: np.log(v) for k, v in TARGETS.items()}


# =============================================================================== spectra

_DPSS = {}


def _tapers(L, w_hz):
    nw = w_hz * L / FS
    k = max(1, int(np.floor(2 * nw)) - 1)
    key = (L, round(nw, 4), k)
    if key not in _DPSS:
        if nw < 1.0:  # very short stretch: single Hann-like taper
            t = dpss(L, max(nw, 0.5), 1).reshape(1, L)
        else:
            t = dpss(L, nw, k).reshape(k, L)
        _DPSS[key] = (t, t.sum(axis=1))
    return _DPSS[key]


class ChannelSpectrum:
    """Spectrum of one channel in one window, built from its clean stretches.

    eig: (K, F) unit spectra whose plain mean is the channel spectrum (tapers or segments).
    dof: equivalent chi-squared degrees of freedom of the mean.
    coef: complex eigencoefficients per stretch (multitaper only) for the F-test.
    bg:  optional estimator-supplied background (IRASA fractal component).
    """

    def __init__(self, eig, dof, coef=None, bg=None, group=None):
        self.eig, self.dof, self.coef, self.bg = eig, dof, coef, bg
        # jackknife group of each unit: taper order (multitaper) or segment position (Welch).  The same
        # group across channels is deleted together, because a rhythm is common to all channels.
        self.group = np.arange(eig.shape[0]) if group is None else np.asarray(group)


def s1_multitaper(stretches, w_hz=None):
    w_hz = PARAMS["mt_w"] if w_hz is None else w_hz
    eigs, coefs, grp = [], [], []
    for x in stretches:
        x = x - x.mean()
        t, u0 = _tapers(len(x), w_hz)
        Y = np.fft.rfft(t * x[None, :], NFFT, axis=1)[:, KEEP]
        eigs.append(2.0 * np.abs(Y) ** 2 / FS)
        coefs.append((Y, u0))
        grp.append(np.arange(t.shape[0]))
    eig = np.vstack(eigs)
    return ChannelSpectrum(eig, 2.0 * eig.shape[0], coef=coefs, group=np.concatenate(grp))


_HANN = {}


def _welch_segments(x, nper=512):
    if nper not in _HANN:
        w = hann(nper, sym=False)
        _HANN[nper] = (w, (w ** 2).sum())
    w, s2 = _HANN[nper]
    step = nper // 2
    segs = [x[i:i + nper] for i in range(0, len(x) - nper + 1, step)]
    if not segs:
        return None
    S = np.array(segs)
    S = S - S.mean(axis=1, keepdims=True)
    P = 2.0 * np.abs(np.fft.rfft(S * w[None, :], NFFT, axis=1)[:, KEEP]) ** 2 / (FS * s2)
    return P


def welch_dof(k):
    """Equivalent dof of a Welch average of k Hann segments at 50 % overlap (Welch 1967)."""
    c = 0.1667  # squared correlation of adjacent 50 %-overlapped Hann segments
    if k <= 1:
        return 2.0
    return 2.0 * k / (1 + 2 * c * (k - 1) / k)


def s2_welch(stretches):
    eigs = []
    k_tot = 0
    dof = 0.0
    for x in stretches:
        P = _welch_segments(x)
        if P is None:
            continue
        eigs.append(P)
        dof += welch_dof(P.shape[0])
    if not eigs:
        return None
    grp = np.concatenate([np.arange(e.shape[0]) for e in eigs])
    return ChannelSpectrum(np.vstack(eigs), dof, group=grp)


IRASA_H = np.round(np.arange(1.10, 1.901, 0.10), 2)  # 9 factors (yasa uses 17 at 0.05 steps; 9 for run time)


def _irasa_fractal(x):
    fr = []
    for h in IRASA_H:
        q = Fraction(float(h)).limit_denominator(20)
        up = resample_poly(x, q.numerator, q.denominator)
        dn = resample_poly(x, q.denominator, q.numerator)
        pu = _welch_segments(up)
        pd = _welch_segments(dn)
        if pu is None or pd is None:
            return None
        fr.append(np.sqrt(pu.mean(axis=0) * pd.mean(axis=0)))
    return np.median(np.array(fr), axis=0)


def s3_irasa(stretches):
    base = s2_welch(stretches)
    if base is None:
        return None
    frs, wts = [], []
    for x in stretches:
        if len(x) < int(2.0 * 1.9 * FS) + 2:
            continue
        fr = _irasa_fractal(x - x.mean())
        if fr is not None:
            frs.append(fr)
            wts.append(len(x))
    if not frs:
        return None
    base.bg = np.average(np.array(frs), axis=0, weights=wts)
    return base


Q_REL = 0.08  # S1Q: total smoothing width as a fraction of frequency (never below the 1 Hz of S1)


def _q_edges():
    half = np.maximum(0.0, 0.5 * Q_REL * F - 0.5)  # extra half-width beyond S1's own 0.5 Hz
    lo = np.searchsorted(F, F - half, side="left")
    hi = np.searchsorted(F, F + half, side="right")
    return lo, hi


_QE = None


def s1q_multitaper(stretches):
    """S1 variant with constant relative resolution: S1 (W = 0.5 Hz) eigenspectra, each then averaged over
    a frequency-dependent boxcar so that the total smoothing is max(1 Hz, 8 % of f).  Brain rhythms get
    wider with frequency; a fixed 1 Hz resolution splits a 1.5 Hz wide beta rhythm into lumps."""
    global _QE
    if _QE is None:
        _QE = _q_edges()
    lo, hi = _QE
    cs = s1_multitaper(stretches)
    c = np.concatenate([np.zeros((cs.eig.shape[0], 1)), np.cumsum(cs.eig, axis=1)], axis=1)
    cs.eig = (c[:, hi] - c[:, lo]) / (hi - lo)[None, :]
    cs.coef = None
    return cs


SPECTRA = {"S1": s1_multitaper, "S2": s2_welch, "S3": s3_irasa,
           "S1W1": lambda st: s1_multitaper(st, 1.0),   # S1 variant: half-bandwidth 1.0 Hz instead of 0.5
           "S1Q": s1q_multitaper}                       # S1 variant: resolution max(1 Hz, 8 % of f)
RESOLUTION = {"S1": 1.0, "S2": 1.0, "S3": 1.0, "S1W1": 2.0, "S1Q": 1.0}  # Hz, full width of the smoothing


def resolution_at(spectrum, f):
    if spectrum == "S1Q":
        return max(1.0, Q_REL * f)
    return RESOLUTION[spectrum]


class Composite:
    """Mean of the clean channels' spectra, with the pooled unit spectra kept for the jackknife."""

    def __init__(self, chans):
        self.chans = chans
        n = len(chans)
        self.units = np.vstack([c.eig for c in chans])
        self.w = np.concatenate([np.full(c.eig.shape[0], 1.0 / (n * c.eig.shape[0])) for c in chans])
        self.p = self.w @ self.units
        g = np.concatenate([c.group for c in chans])
        self.groups = [np.flatnonzero(g == k) for k in np.unique(g)]
        self.dof = float(sum(c.dof for c in chans))
        bgs = [c.bg for c in chans if c.bg is not None]
        self.bg_est = np.mean(bgs, axis=0) if bgs else None


# =============================================================================== background


def search_mask(mains_hz):
    lo, hi = PARAMS["search"]
    m = (F >= lo) & (F <= hi)
    if mains_hz:
        m &= np.abs(F - mains_hz) > PARAMS["mains_excl"]
    return m


def fit_mask(mains_hz):
    lo, hi = PARAMS["fit"]
    m = (F >= lo) & (F <= hi)
    if mains_hz:
        m &= np.abs(F - mains_hz) > PARAMS["mains_excl"]
    return m


_TRUNC = {}


def _trunc_mean_fn(dof):
    """Returns u -> E[Y | Y < u] for Y = log10(chi2_dof / dof), on a grid (cached per dof)."""
    key = round(float(dof), 1)
    if key not in _TRUNC:
        x = np.exp(np.linspace(np.log(stats.chi2.ppf(1e-7, dof) / dof), np.log(stats.chi2.ppf(1 - 1e-7, dof) / dof), 4000))
        pdf = stats.chi2.pdf(x * dof, dof) * dof
        y = np.log10(x)
        w = pdf * np.gradient(x)
        cw = np.cumsum(w)
        cy = np.cumsum(w * y)
        _TRUNC[key] = (y, cy / np.maximum(cw, 1e-300))
    y, m = _TRUNC[key]
    return lambda u: float(np.interp(u, y, m))


def robust_background(p, dof, mains_hz, bias_correct=True, n_iter=8, drop_sd=1.5):
    """Robust log-log line fit (spec 6.2): fit, drop bins above the line by more than drop_sd standard
    deviations of a log chi-squared variable, refit, repeat.

    Bias: in log power the background sits above the mean of the log spectrum, and dropping the upper
    bins pulls the fit lower still.  With bias_correct, the offset is solved so that the mean of the kept
    residuals equals the mean of a log chi-squared variable truncated at the same cut, which uses only
    the kept (background) bins and so is not lifted by peaks.  Returns (bg, chi, offset, fit_error)."""
    m = fit_mask(mains_hz)
    idx = np.flatnonzero(m)[::4]  # 0.125 Hz spacing is plenty for a 2-parameter fit
    lx = np.log10(F[idx])
    ly = np.log10(np.maximum(p[idx], 1e-30))
    keep = np.ones(idx.size, bool)
    sd_chi = np.sqrt(2.0 / dof) / np.log(10)  # approximate sd of log10(chi2_dof / dof)
    cut = drop_sd * max(sd_chi, 1e-3)
    for _ in range(n_iter):
        b, a = np.polyfit(lx[keep], ly[keep], 1)
        r = ly - (a + b * lx)
        new = r < cut
        if new.sum() < 10:
            break
        if (new == keep).all():
            break
        keep = new
    b, a = np.polyfit(lx[keep], ly[keep], 1)
    r = ly - (a + b * lx)
    kept = r[r < cut]
    if kept.size < 10:
        kept = r
    if bias_correct:
        # r = d + Y with Y = log10(chi2/dof); kept iff r < cut, i.e. Y < cut - d.  Solve
        # mean(kept) = d + E[Y | Y < cut - d] for d by bisection (the right side increases with d).
        tm = _trunc_mean_fn(dof)
        target = float(kept.mean())
        lo, hi = -1.0, 1.0
        for _ in range(50):
            mid = 0.5 * (lo + hi)
            if mid + tm(cut - mid) < target:
                lo = mid
            else:
                hi = mid
        a += 0.5 * (lo + hi)
    err = float(np.sqrt(np.mean((kept - kept.mean()) ** 2)))
    bg = 10 ** (a + b * np.log10(np.maximum(F, 0.5)))
    return bg, float(-b), float(a), err


# =============================================================================== peaks


def local_maxima(flat, mask):
    i = np.flatnonzero((flat[1:-1] > flat[:-2]) & (flat[1:-1] >= flat[2:])) + 1
    return i[mask[i]]


def _half_region(flat, i, base=1.0):
    """Indices [l, r] of the contiguous region around i above half height (relative to `base`)."""
    h = flat[i]
    half = base + 0.5 * (h - base)
    l = i
    while l > 0 and flat[l - 1] > half:
        l -= 1
    r = i
    while r < flat.size - 1 and flat[r + 1] > half:
        r += 1
    # interpolated crossings for width
    fl = F[l] - DF * (flat[l] - half) / max(flat[l] - flat[l - 1], 1e-12) if l > 0 else F[l]
    fr = F[r] + DF * (flat[r] - half) / max(flat[r] - flat[r + 1], 1e-12) if r < flat.size - 1 else F[r]
    return l, r, half, fr - fl


def freq_centroid(flat, l, r, half):
    w = np.clip(flat[l:r + 1] - half, 0, None)
    s = w.sum()
    return float((F[l:r + 1] * w).sum() / s) if s > 0 else float(F[(l + r) // 2])


def freq_gauss(flat, l, r, half, base=1.0):
    """Gaussian fit to the excess over the background: least squares parabola on log(excess)."""
    ex = flat[l:r + 1] - base
    ok = ex > 0
    if ok.sum() < 3:
        return freq_centroid(flat, l, r, half)
    f = F[l:r + 1][ok]
    y = np.log(ex[ok])
    fc = f.mean()
    c2, c1, _ = np.polyfit(f - fc, y, 2, w=np.sqrt(ex[ok]))
    if c2 >= 0:
        return freq_centroid(flat, l, r, half)
    v = fc - c1 / (2 * c2)
    return float(np.clip(v, F[l], F[r]))


def freq_parabolic(flat, i, native_df):
    """3-point parabola on log power at the native grid spacing around the fine-grid maximum."""
    s = max(1, int(round(native_df / DF)))
    if i - s < 0 or i + s >= flat.size:
        return float(F[i])
    y0, y1, y2 = np.log(max(flat[i - s], 1e-12)), np.log(flat[i]), np.log(max(flat[i + s], 1e-12))
    den = y0 - 2 * y1 + y2
    d = 0.5 * (y0 - y2) / den if den < 0 else 0.0
    return float(F[i] + np.clip(d, -1, 1) * s * DF)


def estimate_freq(method, flat, i, l, r, half, native_df, base=1.0):
    if method == "centroid":
        return freq_centroid(flat, l, r, half)
    if method == "gauss":
        return freq_gauss(flat, l, r, half, base)
    if method == "parabolic":
        return freq_parabolic(flat, i, native_df)
    raise ValueError(method)


def jackknife_se(comp, bg, method, f_hat, width, native_df, excess=False):
    """Delete-one-group jackknife: each group is one taper order (or segment position) deleted from
    every clean channel at once.  excess=True re-estimates on the background-subtracted peak."""
    units, w, p = comp.units, comp.w, comp.p
    groups = comp.groups
    m = len(groups)
    if m < 3:
        return float("nan")
    lo = np.searchsorted(F, f_hat - max(1.5 * width, 1.0))
    hi = np.searchsorted(F, f_hat + max(1.5 * width, 1.0))
    pj = np.empty((m, hi - lo))
    for k, gi in enumerate(groups):
        wg = w[gi].sum()
        pj[k] = (p[lo:hi] - w[gi] @ units[gi, lo:hi]) / (1 - wg)
    c = int(np.clip(np.searchsorted(F[lo:hi], f_hat), 0, hi - lo - 1))
    if excess:
        flats = 1.0 + (pj - bg[None, lo:hi]) / bg[lo + c]
    else:
        flats = pj / bg[None, lo:hi]
    ests = np.empty(m)
    half_w = max(int(0.5 * width / DF), 2)
    s_par = max(1, int(round(native_df / DF)))
    for j in range(m):
        fl = flats[j]
        a, b = max(c - half_w, 1), min(c + half_w, fl.size - 2)
        if b <= a:
            ests[j] = f_hat
            continue
        i = a + int(np.argmax(fl[a:b + 1]))
        h = fl[i]
        half = 1.0 + 0.5 * (h - 1.0)
        if method == "parabolic":
            if s_par <= i < fl.size - s_par:
                y0, y1, y2 = (np.log(max(fl[i - s_par], 1e-12)), np.log(max(fl[i], 1e-12)),
                              np.log(max(fl[i + s_par], 1e-12)))
                den = y0 - 2 * y1 + y2
                d = 0.5 * (y0 - y2) / den if den < 0 else 0.0
                ests[j] = F[lo + i] + np.clip(d, -1, 1) * s_par * DF
            else:
                ests[j] = F[lo + i]
            continue
        l, r = i, i
        while l > 0 and fl[l - 1] > half:
            l -= 1
        while r < fl.size - 1 and fl[r + 1] > half:
            r += 1
        seg = fl[l:r + 1]
        ff = F[lo + l:lo + r + 1]
        if method == "gauss":
            ex = seg - 1.0
            ok = ex > 0
            if ok.sum() >= 3:
                fc = ff[ok].mean()
                c2, c1, _ = np.polyfit(ff[ok] - fc, np.log(ex[ok]), 2, w=np.sqrt(ex[ok]))
                if c2 < 0:
                    ests[j] = np.clip(fc - c1 / (2 * c2), ff[0], ff[-1])
                    continue
        wt = np.clip(seg - half, 0, None)
        ests[j] = (ff * wt).sum() / wt.sum() if wt.sum() > 0 else F[lo + i]
    return float(np.sqrt((m - 1) / m * np.sum((ests - ests.mean()) ** 2)))


# =============================================================================== confirmation


def p1_threshold(dof, res_hz, alpha=None):
    """Analytic height threshold: chi-squared law with a Sidak correction for the independent bins searched."""
    alpha = PARAMS["alpha_peak"] if alpha is None else alpha
    lo, hi = PARAMS["search"]
    m_ind = (hi - lo) / res_hz
    p_bin = 1 - (1 - alpha) ** (1 / m_ind)
    return float(stats.chi2.ppf(1 - p_bin, dof) / dof)


def ftest_stat(comp, f_hat, w_hz):
    """Max over clean channels and over +-W/2 of Thomson's harmonic F statistic."""
    best = 0.0
    lo = np.searchsorted(F, f_hat - 0.5 * w_hz)
    hi = np.searchsorted(F, f_hat + 0.5 * w_hz) + 1
    for ch in comp.chans:
        if ch.coef is None:
            return float("nan")
        for Y, u0 in ch.coef:
            k = Y.shape[0]
            if k < 3:
                continue
            Ys = Y[:, lo:hi]
            su2 = (u0 ** 2).sum()
            mu = (u0[:, None] * Ys).sum(axis=0) / su2
            num = (k - 1) * np.abs(mu) ** 2 * su2
            den = (np.abs(Ys - mu[None, :] * u0[:, None]) ** 2).sum(axis=0)
            best = max(best, float((num / den).max()))
    return best


_RING = None


def prominence_spectrum(p, mains_hz):
    """P2: the spectrum over the median of its neighbours 0.75 to 2.5 Hz away on both sides."""
    global _RING
    if _RING is None:
        n_out = int(2.5 / DF)
        n_in = int(0.75 / DF)
        fp = np.ones(2 * n_out + 1, bool)
        fp[n_out - n_in:n_out + n_in + 1] = False
        _RING = fp
    lp = np.log(np.maximum(p, 1e-30))
    med = median_filter(lp[::2], footprint=_RING[::2], mode="nearest")
    med = np.repeat(med, 2)[:p.size]
    return np.exp(lp - med)


def p4_fooof(p, mains_hz, min_height):
    """specparam-style fit (fooof 1.1).  Returns list of (cf, pw_log10, bw) and the aperiodic background."""
    from fooof import FOOOF
    lo, hi = PARAMS["search"]
    sel = (F >= lo) & (F <= hi)
    idx = np.flatnonzero(sel)[::4]
    fm = FOOOF(peak_width_limits=(0.85, 5.1), max_n_peaks=8, min_peak_height=max(min_height, 0.0),
               peak_threshold=2.0, aperiodic_mode="fixed", verbose=False)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            fm.fit(F[idx], p[idx])
        except Exception:
            return [], None
    if not fm.has_model:
        return [], None
    off, exp_ = fm.aperiodic_params_
    bg = 10 ** (off - exp_ * np.log10(np.maximum(F, 0.5)))
    peaks = [(float(cf), float(pw), float(bw)) for cf, pw, bw in fm.peak_params_] if fm.peak_params_.size else []
    return peaks, bg


# =============================================================================== fast trackers
# Each takes a 1-channel conditioned signal, the slow-path centre fc and half-width hw (Hz), and returns
# per output frame (every 8 samples): freq (Hz, NaN when null), amp (uV).  All are causal.

FRAME = 8


def _demod(x, fc, bw_hz, order=2):
    t = np.arange(x.size) / FS
    z = x * np.exp(-2j * np.pi * fc * t)
    sos = butter(order, bw_hz, btype="low", fs=FS, output="sos")
    return 2 * (sosfilt(sos, z.real) + 1j * sosfilt(sos, z.imag))


def f1_analytic(x, fc, hw, amp_floor=0.0):
    z = _demod(x, fc, hw)
    prod = z[1:] * np.conj(z[:-1])
    prod = np.concatenate([[0], prod])
    nfr = x.size // FRAME
    s = prod[:nfr * FRAME].reshape(nfr, FRAME).sum(axis=1)  # amplitude-weighted phase advance
    fr = fc + np.angle(s) * FS / (2 * np.pi)
    amp = np.abs(z[:nfr * FRAME]).reshape(nfr, FRAME).mean(axis=1)
    fr[amp < amp_floor] = np.nan
    return fr, amp


def f2_pll(x, fc, hw, amp_floor=0.0, bn_hz=1.5, zeta=0.707):
    """Second-order PLL on the complex baseband (wide pre-filter), NCO frequency is the output."""
    z = _demod(x, fc, 2.0 * hw)
    wn = 2 * np.pi * bn_hz
    T = 1 / FS
    kp = 2 * zeta * wn * T
    ki = (wn * T) ** 2
    theta, w = 0.0, 0.0
    nfr = x.size // FRAME
    fr = np.empty(nfr)
    amp = np.empty(nfr)
    a_run = 0.0
    for n in range(nfr * FRAME):
        zn = z[n]
        a_run = 0.99 * a_run + 0.01 * abs(zn)
        e = np.angle(zn * np.exp(-1j * theta)) if a_run > 0 else 0.0
        w += ki * e
        theta += w + kp * e
        if n % FRAME == FRAME - 1:
            fr[n // FRAME] = fc + w * FS / (2 * np.pi)
            amp[n // FRAME] = a_run
    fr[amp < amp_floor] = np.nan
    return fr, amp


def f3_short_spectra(x, fc, hw, amp_floor=0.0, win_s=1.0):
    L = int(win_s * FS)
    w = hann(L, sym=False)
    nfft = 4096
    fq = np.fft.rfftfreq(nfft, 1 / FS)
    sel = (fq >= fc - hw) & (fq <= fc + hw)
    fsel = fq[sel]
    nfr = x.size // FRAME
    fr = np.full(nfr, np.nan)
    amp = np.zeros(nfr)
    starts = np.arange(nfr) * FRAME + FRAME - L
    ok = starts >= 0
    idx = np.flatnonzero(ok)
    seg = np.lib.stride_tricks.sliding_window_view(x, L)[starts[ok]]
    P = np.abs(np.fft.rfft((seg - seg.mean(axis=1, keepdims=True)) * w, nfft, axis=1)[:, sel]) ** 2
    k = np.argmax(P, axis=1)
    k = np.clip(k, 1, fsel.size - 2)
    r = np.arange(k.size)
    y0, y1, y2 = np.log(P[r, k - 1] + 1e-12), np.log(P[r, k] + 1e-12), np.log(P[r, k + 1] + 1e-12)
    den = y0 - 2 * y1 + y2
    d = np.where(den < 0, 0.5 * (y0 - y2) / np.where(den < 0, den, -1), 0.0)
    fr[idx] = fsel[k] + np.clip(d, -1, 1) * (fsel[1] - fsel[0])
    amp[idx] = 2 * np.sqrt(P[r, k]) / w.sum()
    fr[amp < amp_floor] = np.nan
    return fr, amp


def f4_kalman(x, fc, hw, amp_floor=0.0, q_omega=None):
    """Extended Kalman filter: state (a, b, omega) of a rotating phasor; observation y = a + noise.
    The input is pre-filtered by the same band-pass as F1 (real part of the demodulated band)."""
    t = np.arange(x.size) / FS
    z = _demod(x, fc, 2.0 * hw)
    y = (z * np.exp(2j * np.pi * fc * t)).real
    w0 = 2 * np.pi * fc / FS
    s = np.array([0.0, 0.0, w0])
    P = np.diag([100.0, 100.0, 1e-3])
    q_omega = (2 * np.pi * 0.5 / FS) ** 2 * 0.02 if q_omega is None else q_omega
    var_y = np.var(y[:int(2 * FS)]) if x.size > 2 * FS else np.var(y)
    Q = np.diag([0.01 * var_y, 0.01 * var_y, q_omega])
    R = 0.2 * var_y + 1e-6
    rho = 0.998
    nfr = x.size // FRAME
    fr = np.empty(nfr)
    amp = np.empty(nfr)
    for n in range(nfr * FRAME):
        a, b, om = s
        c, sn = np.cos(om), np.sin(om)
        s = np.array([rho * (c * a - sn * b), rho * (sn * a + c * b), om])
        J = np.array([[rho * c, -rho * sn, rho * (-sn * a - c * b)],
                      [rho * sn, rho * c, rho * (c * a - sn * b)],
                      [0, 0, 1]])
        P = J @ P @ J.T + Q
        S = P[0, 0] + R
        K = P[:, 0] / S
        s = s + K * (y[n] - s[0])
        P = P - np.outer(K, P[0, :])
        lo, hi = 2 * np.pi * (fc - hw) / FS, 2 * np.pi * (fc + hw) / FS
        s[2] = min(max(s[2], lo), hi)
        if n % FRAME == FRAME - 1:
            fr[n // FRAME] = s[2] * FS / (2 * np.pi)
            amp[n // FRAME] = np.hypot(s[0], s[1])
    fr[amp < amp_floor] = np.nan
    return fr, amp


def f5_cycles(x, fc, hw, amp_floor=0.0):
    """Cycle-by-cycle: band-pass, rising zero crossings with linear interpolation, period of the
    latest two cycles."""
    sos = butter(2, [max(fc - hw, 0.3), fc + hw], btype="band", fs=FS, output="sos")
    y = sosfilt(sos, x)
    zc = np.flatnonzero((y[:-1] < 0) & (y[1:] >= 0))
    tz = zc + (-y[zc]) / (y[zc + 1] - y[zc])
    nfr = x.size // FRAME
    fr = np.full(nfr, np.nan)
    amp = np.zeros(nfr)
    env = np.abs(y)
    sos_e = butter(1, 2.0, fs=FS, output="sos")
    env = sosfilt(sos_e, env) * np.pi / 2
    j = 0
    for k in range(nfr):
        tn = (k + 1) * FRAME - 1
        while j + 1 < tz.size and tz[j + 1] <= tn:
            j += 1
        if j >= 2 and tz[j] <= tn:
            per = (tz[j] - tz[j - 2]) / 2
            fr[k] = FS / per
        amp[k] = env[tn]
    fr[amp < amp_floor] = np.nan
    return fr, amp


TRACKERS = {"F1": f1_analytic, "F2": f2_pll, "F3": f3_short_spectra, "F4": f4_kalman, "F5": f5_cycles}


# =============================================================================== ratios, rules, chance


def pair_arrays(f, s):
    """All pairs i<j (f sorted ascending): log ratio x and its sd s_x."""
    f = np.asarray(f, float)
    s = np.asarray(s, float)
    i, j = np.triu_indices(f.size, 1)
    x = np.log(f[j] / f[i])
    sx = np.sqrt((s[i] / f[i]) ** 2 + (s[j] / f[j]) ** 2)
    return i, j, x, sx


def chanceA_density(x, lo=None, hi=None):
    """Density of |ln f2/f1| for two peaks placed log-uniformly over the search range."""
    lo, hi = PARAMS["search"] if lo is None else (lo, hi)
    L = np.log(hi / lo)
    return np.clip(2 * (L - x) / L ** 2, 1e-6, None)


def pair_stats(x, sx, target, resolved):
    """Per pair: miss, closeness, ln-evidence (T3), and the T1/T2 entry/exit conditions."""
    eps, tau, k = PARAMS["eps"], PARAMS["tau"], PARAMS["T2_k"]
    hy = PARAMS["hyst"]
    miss = x - LN_T[target]
    c = np.exp(-0.5 * (miss / eps) ** 2)
    var = sx ** 2 + tau ** 2
    lnL = -0.5 * miss ** 2 / var - 0.5 * np.log(2 * np.pi * var) - np.log(chanceA_density(x))
    t1_in = np.abs(miss) < eps
    t1_hold = np.abs(miss) < hy * eps
    lim = np.minimum(k * sx, eps)
    t2_in = np.abs(miss) < lim
    t2_hold = np.abs(miss) < np.minimum(hy * k * sx, hy * eps)
    r = resolved
    return {"miss": miss, "c": np.where(r, c, 0.0), "lnL": np.where(r, lnL, -1e6),
            "t1_in": t1_in & r, "t1_hold": t1_hold & r, "t2_in": t2_in & r, "t2_hold": t2_hold & r}


def longest_chain(f, ok_pair):
    """Longest chain of tracks (sorted by frequency) in which every consecutive member pair is ok.
    Members may skip over unrelated tracks.  ok_pair: dict (i, j) -> bool for i < j."""
    n = len(f)
    best = [1] * n
    prev = [-1] * n
    for j in range(n):
        for i in range(j):
            if ok_pair.get((i, j), False) and best[i] + 1 > best[j]:
                best[j] = best[i] + 1
                prev[j] = i
    if n == 0:
        return []
    j = int(np.argmax(best))
    chain = []
    while j >= 0:
        chain.append(j)
        j = prev[j]
    return chain[::-1]


def surrogate_sets(rng, n_tracks, rel_se, n_surr, lo=None, hi=None, min_sep_hz=None):
    """Chance A surrogates: n_tracks peaks placed log-uniformly over the search range with at least the
    tracker's joining distance between them, carrying the observed relative standard errors."""
    lo, hi = PARAMS["search"] if lo is None else (lo, hi)
    min_sep_hz = PARAMS["join_hz"] if min_sep_hz is None else min_sep_hz
    got = []
    n_got = 0
    while n_got < n_surr:
        f = np.sort(np.exp(rng.uniform(np.log(lo), np.log(hi), (4 * n_surr, n_tracks))), axis=1)
        ok = np.all(np.diff(f, axis=1) > min_sep_hz, axis=1) if n_tracks > 1 else np.ones(f.shape[0], bool)
        got.append(f[ok])
        n_got += int(ok.sum())
    out_f = np.vstack(got)[:n_surr]
    rel = np.asarray(rel_se, float)
    perm = np.argsort(rng.random((n_surr, n_tracks)), axis=1)
    return out_f, out_f * rel[perm]


def best_scores(fsets, ssets, target):
    """Vectorised best-pair closeness and best-pair ln evidence for many peak sets at once,
    restricted to resolved pairs, exactly as the observed set is scored."""
    n = fsets.shape[1]
    if n < 2:
        z = np.zeros(fsets.shape[0])
        return z, np.full(fsets.shape[0], -np.inf)
    i, j = np.triu_indices(n, 1)
    x = np.log(fsets[:, j] / fsets[:, i])
    sx = np.sqrt((ssets[:, i] / fsets[:, i]) ** 2 + (ssets[:, j] / fsets[:, j]) ** 2)
    r = sx <= PARAMS["sx_limit"]
    st = pair_stats(x, sx, target, r)
    return st["c"].max(axis=1), st["lnL"].max(axis=1)


def surrogate_cascades(fsets, ssets, target):
    """Longest T1-aligned chain in each surrogate set (vectorised version of longest_chain)."""
    S, n = fsets.shape
    if n < 2:
        return np.ones(S, int)
    ok = np.zeros((S, n, n), bool)
    i, j = np.triu_indices(n, 1)
    x = np.log(fsets[:, j] / fsets[:, i])
    sx = np.sqrt((ssets[:, i] / fsets[:, i]) ** 2 + (ssets[:, j] / fsets[:, j]) ** 2)
    st = pair_stats(x, sx, target, sx <= PARAMS["sx_limit"])
    ok[:, i, j] = st["t1_in"]
    best = np.ones((S, n), int)
    for jj in range(1, n):
        cand = np.where(ok[:, :jj, jj], best[:, :jj] + 1, 1)
        best[:, jj] = cand.max(axis=1)
    return best.max(axis=1)
