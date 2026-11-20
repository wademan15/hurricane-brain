"""Seeded generators for the bake-off battery (spec section 10.2).

Everything is synthetic. There are no real Muse recordings in the lab yet, so every
"recording" used by the surrogate transforms is itself a synthetic recording.

Conventions
-----------
* 4 channels named TP9, AF7, AF8, TP10, 256 Hz, microvolts.
* A Recording holds data (n_ch, n) float64 in microvolts, with NaN where packets were lost.
* SNR of a rhythm is defined as in lab/precision_and_chance_sketch.py: the peak spectral
  density of the rhythm's nominal Gaussian spectral shape over the background density at f0,
  i.e. the flattened spectrum would read 10**(snr/10) at f0 with infinite resolution and no
  drift or bursting.  Bursting, drift and the estimator's own smoothing lower the height that an
  8 s window actually sees (a 0.25 Hz wide rhythm at "10 dB" reads about 8 dB with a 0.5 Hz
  half-bandwidth multitaper).  This is the same convention the spec's precision table used.
* Rhythm width bw is the standard deviation (Hz) of the Gaussian spectral shape.
* Every generator takes a numpy Generator; every file is built from one integer seed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction

import numpy as np
from scipy.signal import resample_poly

FS = 256.0
CHANNELS = ("TP9", "AF7", "AF8", "TP10")
FRONTAL = (1, 2)
TEMPORAL = (0, 3)
PHI = (1 + 5 ** 0.5) / 2
MOTION_FS = 52.0
RAIL_UV = 1682.8  # Muse Classic converter span in microvolts (unverified, from memory; only used for the railed case)


@dataclass
class Recording:
    data: np.ndarray                    # (n_ch, n) microvolts, NaN where lost
    fs: float = FS
    channels: tuple = CHANNELS
    kind: str = ""
    seed: int = 0
    truth: dict = field(default_factory=dict)
    artifact_mask: np.ndarray | None = None   # (n_ch, n) bool, samples truly corrupted (for scoring only)
    motion: np.ndarray | None = None          # (3, n_m) accelerometer in g, at MOTION_FS

    @property
    def n(self):
        return self.data.shape[1]

    @property
    def duration(self):
        return self.n / self.fs


# ---------------------------------------------------------------- background


def bg_psd(f, chi, scale):
    """One-sided background density (uV^2/Hz) of the 1/f^chi process the generator makes."""
    return scale * np.maximum(f, 0.5) ** (-chi)


def _shaped_noise(rng, n, psd_fn, fs=FS):
    """Real Gaussian noise whose expected one-sided periodogram equals psd_fn(f)."""
    freqs = np.fft.rfftfreq(n, 1 / fs)
    a = np.sqrt(psd_fn(freqs) * fs * n / 4.0)
    spec = a * (rng.standard_normal(freqs.size) + 1j * rng.standard_normal(freqs.size))
    spec[0] = 0
    if n % 2 == 0:
        spec[-1] = spec[-1].real * np.sqrt(2)
    return np.fft.irfft(spec, n)


def background_scale_for_sd(chi, sd_uv, fs=FS):
    """Scale so that the background has standard deviation sd_uv over 0.5..fs/2."""
    f = np.linspace(0.0, fs / 2, 20001)
    var_unit = np.trapezoid(bg_psd(f, chi, 1.0), f)
    return sd_uv ** 2 / var_unit


def background(rng, n, chi=1.5, sd_uv=15.0, common=0.3, n_ch=4):
    """1/f^chi background on every channel; a shared component mimics the common reference.

    Returns (data, scale) where scale gives the per-channel background density bg_psd(f, chi, scale).
    """
    scale = background_scale_for_sd(chi, sd_uv)
    psd = lambda f: bg_psd(f, chi, scale)
    shared = _shaped_noise(rng, n, psd)
    out = np.empty((n_ch, n))
    for c in range(n_ch):
        out[c] = np.sqrt(1 - common) * _shaped_noise(rng, n, psd) + np.sqrt(common) * shared
    return out, scale


def white(rng, n, sd_uv=15.0, n_ch=4):
    return sd_uv * rng.standard_normal((n_ch, n))


# ---------------------------------------------------------------- rhythms


def _ou(rng, n, tau_s, fs=FS, step=16):
    """Unit-variance Ornstein-Uhlenbeck process, computed on a coarse grid and interpolated."""
    m = n // step + 2
    a = np.exp(-step / fs / tau_s)
    z = np.empty(m)
    z[0] = rng.standard_normal()
    e = rng.standard_normal(m) * np.sqrt(1 - a * a)
    for i in range(1, m):
        z[i] = a * z[i - 1] + e[i]
    return np.interp(np.arange(n) / step, np.arange(m), z)


def _narrowband(rng, n, bw, fs=FS):
    """Complex baseband Gaussian noise with Gaussian power spectrum of sd bw (Hz), E|z|^2 = 2."""
    freqs = np.fft.fftfreq(n, 1 / fs)
    w = np.exp(-0.25 * (freqs / bw) ** 2)
    z = np.fft.ifft(w * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
    return z * np.sqrt(2.0 / np.mean(np.abs(z) ** 2))


def default_width(rng, f0):
    """Realistic width: grows with frequency, clipped to the spec's 0.25..1.5 Hz."""
    return float(np.clip(rng.uniform(0.03, 0.08) * f0, 0.25, 1.5))


def rhythm(rng, n, f0, snr_db, chi, scale, bw=None, drift_rel_sd=0.005, drift_tau=20.0,
           burst_sd=0.5, burst_tau=1.0, envelope=None, freq_traj=None, harmonics=None, fs=FS):
    """A realistic rhythm: narrow-band, bursty, slowly drifting.

    freq_traj: optional array (n,) of centre frequency over time, overriding f0 and drift.
    envelope: optional array (n,) multiplying amplitude (0..1), e.g. a form/dissolve schedule.
    harmonics: optional list of (multiple, relative amplitude) for a non-sinusoidal waveform; the
               harmonics are phase locked to the base by construction.
    Returns (x, info) with info holding the realised centre-frequency trajectory.
    """
    if bw is None:
        bw = default_width(rng, f0)
    if freq_traj is None:
        freq_traj = f0 * (1 + drift_rel_sd * _ou(rng, n, drift_tau))
    phase = 2 * np.pi * np.cumsum(freq_traj) / fs + rng.uniform(0, 2 * np.pi)
    z = _narrowband(rng, n, bw) * np.exp(1j * phase)
    g = np.exp(burst_sd * _ou(rng, n, burst_tau)) if burst_sd > 0 else np.ones(n)
    g /= np.sqrt(np.mean(g ** 2))
    if envelope is not None:
        g = g * envelope
    peak_density = (10 ** (snr_db / 10) - 1) * bg_psd(f0, chi, scale)
    amp = np.sqrt(peak_density * bw * np.sqrt(2 * np.pi))  # rhythm variance so the peak density matches
    if harmonics:
        r = np.abs(z)
        psi = np.angle(z)
        x = r * np.cos(psi)
        for mult, rel in harmonics:
            x = x + rel * r * np.cos(mult * psi + rng.uniform(0, 2 * np.pi))
        x = amp * g * x  # r*cos(psi) has variance 1 because E r^2 = 2, so the base matches snr_db
    else:
        x = amp * g * z.real
    return x, {"f0": float(f0), "bw": float(bw), "snr_db": float(snr_db),
               "traj": freq_traj}


# ---------------------------------------------------------------- artifacts (each returns (n_ch, n) and a mask)


def _bump(n, centre, sigma, fs=FS):
    t = np.arange(n) / fs
    return np.exp(-0.5 * ((t - centre) / sigma) ** 2)


def blinks(rng, n, times, fs=FS):
    out = np.zeros((4, n))
    mask = np.zeros((4, n), bool)
    for tc in times:
        a = rng.uniform(100, 200)
        s = rng.uniform(0.07, 0.12)
        b = a * _bump(n, tc, s)
        gains = (rng.uniform(0.03, 0.08), rng.uniform(0.9, 1.1), rng.uniform(0.9, 1.1), rng.uniform(0.03, 0.08))
        for c in range(4):
            out[c] += gains[c] * b
        lo, hi = int((tc - 3 * s) * fs), int((tc + 3 * s) * fs)
        mask[:, max(lo, 0):min(hi, n)] = True
    return out, mask


def _smooth_step(n, t0, t1, rise, fs=FS):
    t = np.arange(n) / fs
    up = 0.5 * (1 + np.tanh((t - t0) / rise))
    down = 0.5 * (1 + np.tanh((t - t1) / rise))
    return up - down


def eye_movements(rng, n, times, fs=FS):
    """Horizontal saccades: frontal pair in opposite polarity; vertical: same polarity."""
    out = np.zeros((4, n))
    mask = np.zeros((4, n), bool)
    for tc in times:
        dur = rng.uniform(0.3, 1.5)
        a = rng.uniform(50, 100)
        s = a * _smooth_step(n, tc, tc + dur, 0.02)
        horizontal = rng.random() < 0.5
        out[1] += s
        out[2] += -s if horizontal else s
        out[0] += 0.05 * s
        out[3] += -0.05 * s if horizontal else 0.05 * s
        lo, hi = int((tc - 0.1) * fs), int((tc + dur + 0.1) * fs)
        mask[:, max(lo, 0):min(hi, n)] = True
    return out, mask


def _hf_noise(rng, n, lo=20.0, hi=100.0, fs=FS):
    freqs = np.fft.rfftfreq(n, 1 / fs)
    spec = (rng.standard_normal(freqs.size) + 1j * rng.standard_normal(freqs.size)) * ((freqs > lo) & (freqs < hi))
    x = np.fft.irfft(spec, n)
    return x / x.std()


def muscle(rng, n, times, kind="jaw", fs=FS):
    """Broadband 20-100 Hz bursts. jaw: temporal strong; frown: frontal strong."""
    out = np.zeros((4, n))
    mask = np.zeros((4, n), bool)
    for tc in times:
        dur = rng.uniform(0.5, 2.0)
        sd = rng.uniform(15, 40)
        env = _smooth_step(n, tc, tc + dur, 0.05)
        gains = (1.0, 0.5, 0.5, 1.0) if kind == "jaw" else (0.3, 1.0, 1.0, 0.3)
        for c in range(4):
            out[c] += gains[c] * sd * env * _hf_noise(rng, n)
        lo, hi = int((tc - 0.1) * fs), int((tc + dur + 0.1) * fs)
        mask[:, max(lo, 0):min(hi, n)] = True
    return out, mask


def swallows(rng, n, times, fs=FS):
    """A swallow: short muscle burst plus a slow deflection on all channels."""
    out, mask = muscle(rng, n, times, kind="jaw")
    for tc in times:
        out += rng.uniform(30, 60) * _bump(n, tc + 0.3, 0.25)[None, :]
        lo, hi = int((tc - 0.5) * fs), int((tc + 1.3) * fs)
        mask[:, max(lo, 0):min(hi, n)] = True
    return out, mask


def pops(rng, n, times, fs=FS):
    """Electrode pop: a step on one channel decaying exponentially, no partner."""
    out = np.zeros((4, n))
    mask = np.zeros((4, n), bool)
    t = np.arange(n) / fs
    for tc in times:
        c = int(rng.integers(4))
        a = rng.uniform(100, 400) * rng.choice([-1, 1])
        tau = rng.uniform(0.3, 1.0)
        out[c] += np.where(t >= tc, a * np.exp(-(t - tc) / tau), 0.0)
        lo, hi = int(tc * fs), int((tc + 5 * tau) * fs)
        mask[c, max(lo - 10, 0):min(hi, n)] = True
    return out, mask


def mains(rng, n, hz, fs=FS):
    t = np.arange(n) / fs
    a = rng.uniform(5, 50, 4)
    ph = rng.uniform(0, 2 * np.pi, 4)
    return a[:, None] * np.sin(2 * np.pi * hz * t[None, :] + ph[:, None])


def railed(n, ch, t_from, fs=FS):
    """Channel ch stuck at the rail from t_from onward (replaces data, use apply_railed)."""
    return ch, int(t_from * fs)


def loose_electrode(rng, n, ch, t_from, fs=FS):
    out = np.zeros((4, n))
    mask = np.zeros((4, n), bool)
    i0 = int(t_from * fs)
    drift = np.cumsum(rng.standard_normal(n)) * 3.0
    drift -= drift[i0]
    t = np.arange(n) / fs
    out[ch, i0:] = drift[i0:] + 80 * np.sin(2 * np.pi * 60 * t[i0:]) + 40 * rng.standard_normal(n - i0)
    mask[ch, i0:] = True
    return out, mask


def motion_resting(rng, n_eeg, fs=FS):
    n_m = int(n_eeg / fs * MOTION_FS)
    acc = np.zeros((3, n_m))
    acc[2] = 1.0
    acc += 0.003 * rng.standard_normal((3, n_m))
    return acc


def head_turns(rng, n, times, acc, fs=FS):
    """Head turn: slow EEG swing on all channels, a little muscle, and a motion signature."""
    out = np.zeros((4, n))
    mask = np.zeros((4, n), bool)
    for tc in times:
        dur = rng.uniform(0.6, 1.5)
        a = rng.uniform(40, 90)
        swing = a * np.sin(np.pi * np.clip((np.arange(n) / fs - tc) / dur, 0, 1))
        for c in range(4):
            out[c] += swing * rng.uniform(0.6, 1.2) * rng.choice([-1, 1])
        m, _ = muscle(rng, n, [tc], kind="jaw")
        out += 0.4 * m
        tm = np.arange(acc.shape[1]) / MOTION_FS
        sel = (tm >= tc) & (tm <= tc + dur)
        acc[0, sel] += 0.15 * np.sin(np.pi * (tm[sel] - tc) / dur)
        lo, hi = int((tc - 0.1) * fs), int((tc + dur + 0.2) * fs)
        mask[:, max(lo, 0):min(hi, n)] = True
    return out, mask


def walking(rng, n, t0, t1, acc, fs=FS):
    """Walking: periodic swings at the step rate with harmonics, on all channels, plus motion."""
    t = np.arange(n) / fs
    step = rng.uniform(1.7, 2.0)
    env = _smooth_step(n, t0, t1, 0.3)
    w = (np.sin(2 * np.pi * step * t) + 0.5 * np.sin(4 * np.pi * step * t + 1.0)
         + 0.25 * np.sin(6 * np.pi * step * t + 2.0))
    out = np.stack([rng.uniform(15, 35) * env * w for _ in range(4)])
    tm = np.arange(acc.shape[1]) / MOTION_FS
    envm = np.interp(tm, t, env)
    acc[2] += 0.2 * envm * np.sin(2 * np.pi * step * tm)
    acc[0] += 0.08 * envm * np.sin(np.pi * step * tm)
    mask = np.zeros((4, n), bool)
    mask[:, int(t0 * fs):int(t1 * fs)] = True
    return out, mask, step


# ---------------------------------------------------------------- link faults and surrogates


def drop_packets(rng, data, p, packet=12, burst=False):
    """Replace lost 12-sample packets with NaN on all channels. burst=True loses runs of 1-4 packets."""
    data = data.copy()
    n = data.shape[1]
    n_pk = n // packet
    lost = rng.random(n_pk) < (p / 2.5 if burst else p)
    if burst:
        idx = np.flatnonzero(lost)
        for i in idx:
            lost[i:i + int(rng.integers(1, 5))] = True
    for i in np.flatnonzero(lost):
        data[:, i * packet:(i + 1) * packet] = np.nan
    return data, float(lost.mean())


def sample_shuffle(rng, data):
    out = data.copy()
    for c in range(out.shape[0]):
        out[c] = rng.permutation(out[c])
    return out


def block_shuffle(rng, data, block_s=1.0, fs=FS):
    """Same block permutation on all channels; keeps within-block structure and inter-channel relations."""
    b = int(block_s * fs)
    m = data.shape[1] // b
    perm = rng.permutation(m)
    blocks = data[:, :m * b].reshape(data.shape[0], m, b)[:, perm, :]
    out = data.copy()
    out[:, :m * b] = blocks.reshape(data.shape[0], m * b)
    return out


def phase_randomize(rng, data, common=True):
    """Keeps each channel's amplitude spectrum. common=True applies the same random phases to every
    channel (keeps cross-spectra); False randomizes each channel independently."""
    n = data.shape[1]
    X = np.fft.rfft(data, axis=1)
    ph = rng.uniform(0, 2 * np.pi, X.shape[1])
    out = np.empty_like(data)
    for c in range(data.shape[0]):
        p = ph if common else rng.uniform(0, 2 * np.pi, X.shape[1])
        Y = X[c] * np.exp(1j * p)
        Y[0] = X[c, 0]
        out[c] = np.fft.irfft(Y, n)
    return out


def channel_shift(rng, data, min_shift_s=10.0, fs=FS):
    """Circularly shift each channel by an independent lag of at least min_shift_s."""
    n = data.shape[1]
    out = np.empty_like(data)
    lo = int(min_shift_s * fs)
    for c in range(data.shape[0]):
        out[c] = np.roll(data[c], int(rng.integers(lo, n - lo)))
    return out


def clock_skew(data, factor):
    """Samples taken by a clock running `factor` fast are labelled 256 Hz: every frequency reads
    1/factor of its true value.  Implemented by resampling."""
    fr = Fraction(factor).limit_denominator(1000)
    return resample_poly(data, fr.numerator, fr.denominator, axis=1)


# ---------------------------------------------------------------- assembled recordings


def _new(seed, duration, chi=None, sd=None):
    rng = np.random.default_rng(seed)
    n = int(duration * FS)
    chi = rng.uniform(1.0, 2.0) if chi is None else chi
    sd = rng.uniform(10, 20) if sd is None else sd
    data, scale = background(rng, n, chi, sd)
    return rng, n, chi, sd, data, scale


def _add_rhythms(rng, n, data, chi, scale, freqs, snrs, widths=None, gains=None, **kw):
    infos = []
    for i, (f, s) in enumerate(zip(freqs, snrs)):
        bw = None if widths is None else widths[i]
        x, info = rhythm(rng, n, f, s, chi, scale, bw=bw, **kw)
        g = np.ones(4) if gains is None else np.asarray(gains[i])
        data += g[:, None] * x[None, :]
        infos.append(info)
    return infos


def _truth_peaks(infos, n, fs=FS, every_s=1.0):
    step = int(every_s * fs)
    out = []
    for inf in infos:
        out.append({"f0": inf["f0"], "bw": inf["bw"], "snr_db": inf["snr_db"],
                    "traj_1hz": [round(float(v), 4) for v in inf["traj"][::step]]})
    return out


def make_cascade(seed, n_members, ratio, snr_db, f_start, duration=90.0, kind="phi_cascade", chi=None,
                 extra_unrelated=0):
    """A cascade of n_members rhythms with a constant step `ratio` from f_start."""
    rng, n, chi, sd, data, scale = _new(seed, duration, chi)
    freqs = [f_start * ratio ** k for k in range(n_members)]
    infos = _add_rhythms(rng, n, data, chi, scale, freqs, [snr_db] * n_members)
    unrelated = []
    if extra_unrelated:
        for _ in range(extra_unrelated):
            for _try in range(100):
                f = float(np.exp(rng.uniform(np.log(2), np.log(40))))
                if all(abs(np.log(f / g)) > 0.15 for g in freqs + unrelated):
                    unrelated.append(f)
                    break
        infos += _add_rhythms(rng, n, data, chi, scale, unrelated, [snr_db] * len(unrelated))
    truth = {"chi": chi, "sd_uv": sd, "ratio": ratio, "n_members": n_members, "snr_db": snr_db,
             "f_start": f_start, "cascade_freqs": freqs, "unrelated_freqs": unrelated,
             "peaks": _truth_peaks(infos, n)}
    return Recording(data, kind=kind, seed=seed, truth=truth, artifact_mask=np.zeros(data.shape, bool),
                     motion=motion_resting(rng, n))


def make_background_only(seed, duration=90.0):
    rng, n, chi, sd, data, scale = _new(seed, duration)
    return Recording(data, kind="background_only", seed=seed, truth={"chi": chi, "sd_uv": sd, "peaks": []},
                     artifact_mask=np.zeros(data.shape, bool), motion=motion_resting(rng, n))


def make_white(seed, duration=90.0):
    rng = np.random.default_rng(seed)
    n = int(duration * FS)
    sd = rng.uniform(10, 20)
    return Recording(white(rng, n, sd), kind="white_noise", seed=seed, truth={"sd_uv": sd, "peaks": []},
                     artifact_mask=np.zeros((4, n), bool), motion=motion_resting(rng, n))


def random_peak_freqs(rng, mode="loguniform", k=None):
    """Unrelated peaks. loguniform: 2-5 peaks log-uniform over 2..40 Hz, at least 15% apart.
    bands: one peak uniform in theta 4-8, one in alpha 8-13, and sometimes one in beta 13-30
    (the realistic case where band centres are naturally 1.6 to 2 apart)."""
    if mode == "bands":
        fr = [rng.uniform(4, 8), rng.uniform(8, 13)]
        if rng.random() < 0.5:
            fr.append(rng.uniform(13, 30))
        fr = sorted(fr)
        ok = all(np.log(b / a) > 0.15 for a, b in zip(fr, fr[1:]))
        return fr if ok else random_peak_freqs(rng, mode, k)
    k = int(rng.integers(2, 6)) if k is None else k
    fr = []
    while len(fr) < k:
        f = float(np.exp(rng.uniform(np.log(2), np.log(40))))
        if all(abs(np.log(f / g)) > 0.15 for g in fr):
            fr.append(f)
    return sorted(fr)


def make_random_peaks(seed, duration=90.0, mode="loguniform", snr_db=None):
    rng, n, chi, sd, data, scale = _new(seed, duration)
    fr = random_peak_freqs(rng, mode)
    snrs = [rng.uniform(6, 15) if snr_db is None else snr_db for _ in fr]
    infos = _add_rhythms(rng, n, data, chi, scale, fr, snrs)
    return Recording(data, kind=f"random_peaks_{mode}", seed=seed,
                     truth={"chi": chi, "sd_uv": sd, "unrelated_freqs": fr, "peaks": _truth_peaks(infos, n)},
                     artifact_mask=np.zeros(data.shape, bool), motion=motion_resting(rng, n))


def make_table(seed, duration=90.0, mains_hz=50.0):
    """A headset lying on a table: no scalp contact. Small amplifier noise, big mains, slow drift."""
    rng = np.random.default_rng(seed)
    n = int(duration * FS)
    t = np.arange(n) / FS
    data = 0.5 * rng.standard_normal((4, n))
    data += np.cumsum(rng.standard_normal((4, n)), axis=1) * 0.2
    data += rng.uniform(100, 300, (4, 1)) * np.sin(2 * np.pi * mains_hz * t + rng.uniform(0, 6.3, (4, 1)))
    return Recording(data, kind="headset_on_table", seed=seed, truth={"mains_hz": mains_hz, "peaks": []},
                     artifact_mask=np.ones((4, n), bool), motion=motion_resting(rng, n))


def make_surrogate(seed, transform, duration=90.0):
    """A surrogate of a recording of unrelated peaks (a stand-in for a real recording)."""
    base = make_random_peaks(seed, duration, mode="loguniform")
    rng = np.random.default_rng(seed + 7)
    fn = {"sample_shuffle": sample_shuffle, "block_shuffle": block_shuffle,
          "phase_randomize": phase_randomize, "channel_shift": channel_shift}[transform]
    data = fn(rng, base.data)
    peaks = [] if transform == "sample_shuffle" else base.truth["peaks"]
    truth = dict(base.truth, transform=transform, peaks=peaks)
    return Recording(data, kind=f"surrogate_{transform}", seed=seed, truth=truth,
                     artifact_mask=np.zeros(data.shape, bool), motion=base.motion)


def make_harmonic(seed, f0, duration=90.0, snr_db=12.0, h2=0.6, h3=0.4):
    """A non-sinusoidal rhythm (arch-shaped, like mu) with true phase-locked harmonics at 2f0 and 3f0."""
    rng, n, chi, sd, data, scale = _new(seed, duration)
    x, info = rhythm(rng, n, f0, snr_db, chi, scale, harmonics=[(2, h2), (3, h3)])
    data += x[None, :]
    truth = {"chi": chi, "sd_uv": sd, "f0": f0, "harmonics": [2 * f0, 3 * f0], "h2": h2, "h3": h3,
             "peaks": _truth_peaks([info], n)}
    return Recording(data, kind="harmonic", seed=seed, truth=truth, artifact_mask=np.zeros(data.shape, bool),
                     motion=motion_resting(rng, n))


ARTIFACT_KINDS = ("blinks", "eye_movements", "jaw_clench", "frown", "swallow", "head_turn", "walking",
                  "loose_electrode", "electrode_pop", "mains50", "mains60", "railed")


def make_artifact(seed, kind, duration=90.0):
    """Two genuine, unrelated rhythms (alpha near 10 Hz and one in beta, ratio well away from every
    target) plus artifacts of one kind.  The same seed without artifacts is make_artifact_clean."""
    rng, n, chi, sd, data, scale = _new(seed, duration)
    fa = rng.uniform(9.0, 11.0)
    fb = fa * rng.uniform(2.25, 2.45)
    infos = _add_rhythms(rng, n, data, chi, scale, [fa, fb], [12.0, 9.0])
    acc = motion_resting(rng, n)
    clean = data.copy()
    art_rng = np.random.default_rng(seed + 99)
    times = sorted(art_rng.uniform(15, duration - 8, 6))
    mask = np.zeros(data.shape, bool)
    extra = {}
    if kind == "blinks":
        times = sorted(art_rng.uniform(12, duration - 4, 20))
        a, mask = blinks(art_rng, n, times)
    elif kind == "eye_movements":
        a, mask = eye_movements(art_rng, n, times)
    elif kind == "jaw_clench":
        a, mask = muscle(art_rng, n, times, "jaw")
    elif kind == "frown":
        a, mask = muscle(art_rng, n, times, "frown")
    elif kind == "swallow":
        a, mask = swallows(art_rng, n, times)
    elif kind == "head_turn":
        a, mask = head_turns(art_rng, n, times, acc)
    elif kind == "walking":
        a, mask, step = walking(art_rng, n, 30.0, 60.0, acc)
        extra["step_hz"] = step
        times = [30.0]
    elif kind == "loose_electrode":
        ch = int(art_rng.integers(4))
        a, mask = loose_electrode(art_rng, n, ch, 40.0)
        extra["channel"] = CHANNELS[ch]
        times = [40.0]
    elif kind == "electrode_pop":
        a, mask = pops(art_rng, n, times)
    elif kind in ("mains50", "mains60"):
        hz = 50.0 if kind == "mains50" else 60.0
        a = mains(art_rng, n, hz)
        extra["mains_hz"] = hz
        times = []
    elif kind == "railed":
        ch = int(art_rng.integers(4))
        a = np.zeros_like(data)
        i0 = int(40.0 * FS)
        data[ch, i0:] = RAIL_UV
        mask[ch, i0:] = True
        extra["channel"] = CHANNELS[ch]
        times = [40.0]
    else:
        raise ValueError(kind)
    data = data + a
    # artifact end times for recovery scoring
    ends = []
    any_mask = mask.any(axis=0)
    d = np.diff(any_mask.astype(int))
    for i in np.flatnonzero(d == -1):
        ends.append(round((i + 1) / FS, 3))
    truth = {"chi": chi, "sd_uv": sd, "artifact": kind, "artifact_onsets": [round(float(t), 3) for t in times],
             "artifact_ends": ends, "genuine_freqs": [fa, fb], "peaks": _truth_peaks(infos, n), **extra}
    rec = Recording(data, kind=f"artifact_{kind}", seed=seed, truth=truth, artifact_mask=mask, motion=acc)
    rec_clean = Recording(clean, kind="artifact_clean", seed=seed, truth=truth,
                          artifact_mask=np.zeros(data.shape, bool), motion=motion_resting(rng, n))
    return rec, rec_clean


def make_hard(seed, case, duration=None, schedule=None):
    """Hard cases of set F.  form_dissolve takes an optional schedule [[on, off], ...] in seconds."""
    if case == "form_dissolve":
        duration = duration or 240.0
    duration = duration or 120.0
    rng, n, chi, sd, data, scale = _new(seed, duration)
    t = np.arange(n) / FS
    truth = {"chi": chi, "sd_uv": sd, "case": case}
    if case == "drift_band_edge":
        traj = 7.4 + 1.2 * np.clip((t - 20) / (duration - 40), 0, 1)
        x, info = rhythm(rng, n, 8.0, 12.0, chi, scale, bw=0.35, freq_traj=traj)
        data += x
        infos = [info]
        truth["description"] = "single rhythm drifting 7.4 to 8.6 Hz across the theta/alpha edge"
    elif case == "close_double":
        f1 = rng.uniform(9.0, 9.6)
        f2 = f1 + rng.uniform(1.0, 1.4)
        infos = _add_rhythms(rng, n, data, chi, scale, [f1, f2], [12.0, 12.0], widths=[0.3, 0.3])
        truth["description"] = "two alpha peaks 1.0 to 1.4 Hz apart"
    elif case == "split":
        f = 10.0
        sep = np.clip((t - 30) / 40, 0, 1) * 0.75
        x1, i1 = rhythm(rng, n, f, 12.0, chi, scale, bw=0.3, freq_traj=f - sep)
        x2, i2 = rhythm(rng, n, f, 12.0, chi, scale, bw=0.3, freq_traj=f + sep,
                        envelope=np.clip((t - 30) / 5, 0, 1))
        data += x1 + x2
        infos = [i1, i2]
        truth["description"] = "one 10 Hz rhythm splitting into 9.25 and 10.75 Hz between 30 and 70 s"
    elif case == "crossing":
        a = 8.0 + 4.0 * t / duration
        b = 12.0 - 4.0 * t / duration
        x1, i1 = rhythm(rng, n, 10.0, 12.0, chi, scale, bw=0.3, freq_traj=a)
        x2, i2 = rhythm(rng, n, 10.0, 12.0, chi, scale, bw=0.3, freq_traj=b)
        data += x1 + x2
        infos = [i1, i2]
        truth["description"] = "tracks crossing: 8 to 12 Hz and 12 to 8 Hz"
    elif case == "short_bursts":
        env = np.zeros(n)
        on = []
        tt = 5.0
        while tt < duration - 3:
            d = rng.uniform(0.5, 2.0)
            env += _smooth_step(n, tt, tt + d, 0.1)
            on.append([round(tt, 2), round(tt + d, 2)])
            tt += d + rng.uniform(1.0, 6.0)
        x, info = rhythm(rng, n, 10.0, 15.0, chi, scale, bw=0.4, envelope=np.clip(env, 0, 1), burst_sd=0.0)
        data += x
        infos = [info]
        truth["bursts"] = on
        truth["description"] = "10 Hz rhythm in short bursts of 0.5 to 2 s"
    elif case == "form_dissolve":
        f_start = rng.uniform(3.6, 4.4)
        freqs = [f_start * PHI ** k for k in range(3)]
        sched = schedule or [[40.0, 110.0], [160.0, 220.0]]
        env = np.zeros(n)
        for a, b in sched:
            env += _smooth_step(n, a, b, 1.0)
        infos = []
        # middle member always present; outer members form and dissolve on the schedule
        for k, f in enumerate(freqs):
            x, info = rhythm(rng, n, f, 12.0, chi, scale, envelope=None if k == 1 else env)
            data += x
            infos.append(info)
        truth["cascade_freqs"] = freqs
        truth["schedule"] = sched
        truth["description"] = "3-member golden ratio cascade: middle member always on, outer two on during the schedule"
    else:
        raise ValueError(case)
    truth["peaks"] = _truth_peaks(infos, n)
    return Recording(data, kind=f"hard_{case}", seed=seed, truth=truth, artifact_mask=np.zeros(data.shape, bool),
                     motion=motion_resting(rng, n))


def make_tracker_signal(seed, f0=10.0, snr_db=10.0, bw=0.4, duration=40.0, step_at=None, step_hz=0.5, chi=1.5):
    """Single channel rhythm for fast-path tests. Optional frequency step at step_at seconds."""
    rng = np.random.default_rng(seed)
    n = int(duration * FS)
    scale = background_scale_for_sd(chi, 15.0)
    bg = _shaped_noise(rng, n, lambda f: bg_psd(f, chi, scale))
    t = np.arange(n) / FS
    traj = f0 * (1 + 0.005 * _ou(rng, n, 10.0))
    if step_at is not None:
        traj = np.where(t >= step_at, traj + step_hz, traj)
    x, info = rhythm(rng, n, f0, snr_db, chi, scale, bw=bw, freq_traj=traj)
    return bg + x, info
