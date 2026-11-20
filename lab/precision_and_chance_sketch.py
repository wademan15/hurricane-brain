"""Back-of-envelope checks behind the provisional numbers in docs/spec/signal-engine.md.

Two questions:
  1. How precisely can the centre frequency of a realistic (broad, wandering) brain rhythm
     be read from a 4 s, 8 s or 30 s window?  (Spec section 6.4)
  2. How often do unrelated peaks land on the golden ratio or the octave by accident?
     (Spec section 8.5)

This is a sketch to set starting values. It is not the bake-off in spec section 10.
Needs numpy and scipy. Run: python3 lab/precision_and_chance_sketch.py
Deterministic: fixed seed.
"""
import numpy as np
from scipy.signal.windows import dpss

FS = 256.0
PHI = (1 + 5 ** 0.5) / 2
rng = np.random.default_rng(20261120)


def synth(n, f0, bw, snr_db, chi=1.5):
    """1/f^chi background plus a narrow-band Gaussian rhythm.

    bw is the standard deviation (Hz) of the rhythm's Gaussian spectral shape.
    snr_db is the rhythm's peak spectral density over the background at f0.
    """
    freqs = np.fft.rfftfreq(n, 1 / FS)
    f = np.maximum(freqs, 0.5)
    bg = f ** (-chi)
    peak = (10 ** (snr_db / 10) - 1) * f0 ** (-chi) * np.exp(-0.5 * ((freqs - f0) / bw) ** 2)
    amp = np.sqrt(bg + peak)
    spec = amp * (rng.standard_normal(freqs.size) + 1j * rng.standard_normal(freqs.size))
    spec[0] = 0
    return np.fft.irfft(spec, n)


_TAPERS = {}


def peak_freq(x, f_lo, f_hi, w_hz=0.5, chi=1.5):
    """Multitaper spectrum, divide out the (known) background, centroid of the top of the peak."""
    n = x.size
    t = n / FS
    nw = max(w_hz * t, 1.5)
    k = int(2 * nw - 1)
    if n not in _TAPERS:
        _TAPERS[n] = dpss(n, nw, k)
    nfft = 1 << int(np.ceil(np.log2(n * 4)))
    p = (np.abs(np.fft.rfft(_TAPERS[n] * x, nfft)) ** 2).mean(axis=0)
    freqs = np.fft.rfftfreq(nfft, 1 / FS)
    flat = p * np.maximum(freqs, 0.5) ** chi
    m = (freqs >= f_lo) & (freqs <= f_hi)
    i = np.argmax(np.where(m, flat, 0))
    sel = np.abs(freqs - freqs[i]) <= 1.5
    w = np.clip(flat[sel] - 0.5 * flat[i], 0, None)  # centroid of the part above half height
    return float((freqs[sel] * w).sum() / w.sum())


def precision_table(trials=300):
    print("1. Peak frequency precision (standard deviation, Hz), rhythm at 10 Hz")
    print("   window  rhythm width   +3 dB   +6 dB  +10 dB")
    for t in (4, 8, 30):
        for bw in (0.25, 0.5, 1.0):
            row = []
            for snr in (3, 6, 10):
                est = [peak_freq(synth(int(t * FS), 10.0, bw, snr), 7, 13) for _ in range(trials)]
                row.append(np.std(est))
            print(f"   {t:>3d} s   {bw:>5.2f} Hz    " + "  ".join(f"{r:6.3f}" for r in row))


def chance_table(n=2_000_000, tols=(0.01, 0.02, 0.03, 0.05)):
    print("\n2. Chance of landing on a target ratio, two unrelated peaks")
    print("   peaks drawn uniformly: lower in 4-8 Hz, upper in 8-13 Hz")
    lo = rng.uniform(4, 8, n)
    hi = rng.uniform(8, 13, n)
    lr = np.log(hi / lo)
    print("   tolerance (log units)   golden ratio   octave   control 1.5   control 1.8")
    for tol in tols:
        cells = [np.mean(np.abs(lr - np.log(r)) < tol) for r in (PHI, 2.0, 1.5, 1.8)]
        print(f"   {tol:>6.2f}                  " + "      ".join(f"{100*c:5.1f}%" for c in cells))

    print("\n   three peaks (4-8, 8-13, 13-30 Hz), both steps on the golden ratio")
    top = rng.uniform(13, 30, n)
    lr2 = np.log(top / hi)
    for tol in tols:
        c = np.mean((np.abs(lr - np.log(PHI)) < tol) & (np.abs(lr2 - np.log(PHI)) < tol))
        print(f"   {tol:>6.2f}                  {100*c:6.2f}%")

    print("\n   any pair among 5 unrelated peaks spread log-uniformly over 2-45 Hz")
    m = 200_000
    pk = np.exp(rng.uniform(np.log(2), np.log(45), (m, 5)))
    for tol in tols:
        hit = np.zeros(m, bool)
        for a in range(5):
            for b in range(5):
                if a != b:
                    hit |= np.abs(np.log(pk[:, a] / pk[:, b]) - np.log(PHI)) < tol
        print(f"   {tol:>6.2f}                  {100*hit.mean():6.1f}%")


if __name__ == "__main__":
    precision_table()
    chance_table()
