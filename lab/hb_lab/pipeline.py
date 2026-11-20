"""The slow path assembled from interchangeable candidates, plus conditioning and gating.

analyze(rec, cfg) runs one configuration over one recording and returns a compact result:
per analysis window (8 s, hop 1 s in the lab; the engine's hop is 250 ms) the confirmed peaks,
tracks with integrated frequencies, pair scores, cascades, chance A / chance B and the states under
every rule T1..T4.  Everything is deterministic given the recording and cfg["seed"].
"""
from __future__ import annotations

import hashlib

import numpy as np
from scipy.signal import butter, filtfilt, iirnotch, lfilter, sosfilt, sosfiltfilt

from . import candidates as C
from .candidates import F, FS, PARAMS

MUSCLE_BAND = (65.0, 95.0)

DEFAULT_CFG = {
    "spectrum": "S1", "confirm": "P1", "freq": "centroid", "thr_mode": "calibrated",
    "thresholds": {},           # calibrated thresholds keyed by "S1/P1" etc. (filled from tuning)
    "gating": True, "bias_correct": True, "sidak": True, "se_inflation": True, "harmonic_test": True,
    "t2_cap": True, "chance_same_search": True, "seed": 0, "chance": True, "fit_err_max": 0.3,
}


# =============================================================================== conditioning


def repair_gaps(data):
    """Linear-interpolate NaN runs. Runs <= repair_max samples are 'repaired'; longer are 'invalid'."""
    data = data.copy()
    n = data.shape[1]
    nanm = np.isnan(data).any(axis=0)
    repaired = np.zeros(n, bool)
    invalid = np.zeros(n, bool)
    if nanm.any():
        d = np.diff(np.concatenate([[0], nanm.astype(int), [0]]))
        starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
        for s, e in zip(starts, ends):
            (repaired if e - s <= PARAMS["repair_max"] else invalid)[s:e] = True
        good = ~nanm
        idx = np.arange(n)
        for c in range(data.shape[0]):
            data[c, nanm] = np.interp(idx[nanm], idx[good], data[c, good])
    return data, repaired, invalid


def detect_mains(x):
    """Pick 50 or 60 Hz from the first 4 s: the line that stands highest over its neighbours."""
    seg = x[:, :int(4 * FS)]
    P = np.abs(np.fft.rfft(seg - seg.mean(axis=1, keepdims=True), axis=1)) ** 2
    fq = np.fft.rfftfreq(seg.shape[1], 1 / FS)
    score = {}
    for hz in (50.0, 60.0):
        on = np.abs(fq - hz) <= 0.5
        nb = (np.abs(fq - hz) > 2) & (np.abs(fq - hz) < 6)
        score[hz] = P[:, on].mean() / max(P[:, nb].mean(), 1e-12)
    best = max(score, key=score.get)
    return best if score[best] > 5.0 else None


def condition(data):
    """Causal high-pass, then the detected mains notch.  Returns conditioned data and mains Hz."""
    sos = butter(2, PARAMS["hp_hz"], btype="high", fs=FS, output="sos")
    x = sosfilt(sos, data, axis=1)
    mains = detect_mains(x)
    if mains:
        b, a = iirnotch(mains, 30.0, FS)
        x = lfilter(b, a, x, axis=1)
    return x, mains


# =============================================================================== quality and gating


CONTACT_MAINS_UV = 80.0  # lab value: raw mains-line amplitude above this means poor contact (spec 5.2)


def quality(raw, x, mains=None, contact=True):
    """Per channel, per second: plausible sd after conditioning (1..100 uV), not railed/flat, and (contact)
    raw mains-line amplitude under CONTACT_MAINS_UV.  A failing channel stays excluded until it has passed
    for 3 s in a row.  Returns (n_ch, n) ok."""
    n_ch, n = x.shape
    sec = int(FS)
    m = n // sec + 1
    ok = np.ones((n_ch, n), bool)
    ph = None
    if contact and mains:
        ph = np.exp(-2j * np.pi * mains * np.arange(sec) / FS)
    for c in range(n_ch):
        run = 3
        for k in range(m):
            sl = slice(k * sec, min((k + 1) * sec, n))
            if sl.start >= n:
                break
            sd = x[c, sl].std()
            rng_ = np.ptp(raw[c, sl])
            passed = (1.0 <= sd <= 100.0) and rng_ > 0.5
            if ph is not None and sl.stop - sl.start == sec:
                seg = raw[c, sl] - raw[c, sl].mean()
                amp = 2 * np.abs(seg @ ph) / sec
                passed = passed and amp < CONTACT_MAINS_UV
            run = run + 1 if passed else 0
            ok[c, sl] = passed and run >= 3
    return ok


def _dilate(mask, pad):
    if pad <= 0 or not mask.any():
        return mask
    k = np.ones(2 * pad + 1)
    return np.convolve(mask.astype(float), k, mode="same") > 0


def gate(x, motion):
    """Artifact gating (spec 5.3).  Thresholds scale to each channel's own resting signal, estimated
    robustly (median statistics) over the first 60 s.  Returns (n_ch, n) bool 'flagged', reasons."""
    n_ch, n = x.shape
    base_n = min(n, int(60 * FS))
    flagged = np.zeros((n_ch, n), bool)
    reasons = {}
    # (a) slow large excursions: blinks, eye movements, pops, head swings (0-8 Hz band)
    b, a = butter(2, 8.0, fs=FS)
    lp = filtfilt(b, a, x, axis=1)
    sig = 1.4826 * np.median(np.abs(lp[:, :base_n] - np.median(lp[:, :base_n], axis=1, keepdims=True)), axis=1)
    amp = np.abs(lp - np.median(lp[:, :base_n], axis=1, keepdims=True)) > 5.0 * sig[:, None]
    flagged |= amp
    reasons["amplitude"] = amp
    # (b) muscle: broadband power in 0.25 s blocks over the channel's resting median.  The default band
    # is 65-95 Hz, above every scored rhythm and clear of 50/60 Hz mains: the spec's 30-45 Hz band also
    # fires on strong, bursty gamma rhythms (bake-off finding), which would delete real peaks.
    lo_m, hi_m = MUSCLE_BAND
    sos = butter(4, [lo_m, hi_m], btype="band", fs=FS, output="sos")
    hf = sosfiltfilt(sos, x, axis=1) ** 2
    blk = int(0.25 * FS)
    m = n // blk
    pw = hf[:, :m * blk].reshape(n_ch, m, blk).mean(axis=2)
    base = np.median(pw[:, :max(1, base_n // blk)], axis=1)
    mus_b = pw > 4.0 * base[:, None]
    mus = np.zeros((n_ch, n), bool)
    mus[:, :m * blk] = np.repeat(mus_b, blk, axis=1)
    flagged |= mus
    reasons["muscle"] = mus
    # (c) motion: accelerometer deviation from gravity above 4x its resting level (all channels)
    if motion is not None:
        g = np.linalg.norm(motion, axis=0)
        acc = np.abs(motion - np.median(motion, axis=1, keepdims=True)).sum(axis=0) + np.abs(g - np.median(g))
        k = max(1, int(0.5 * 52))
        sm = np.convolve(acc, np.ones(k) / k, mode="same")
        rest = np.percentile(sm, 25)  # resting level: robust to motion in up to 75 % of the file
        mot = sm > max(4 * rest, 0.03)
        idx = np.clip((np.arange(n) / FS * 52).astype(int), 0, mot.size - 1)
        mot_e = np.broadcast_to(mot[idx], (n_ch, n))
        flagged |= mot_e
        reasons["motion"] = mot_e
    pad = int(PARAMS["pad_s"] * FS)
    for c in range(n_ch):
        flagged[c] = _dilate(flagged[c], pad)
    return flagged, reasons


def stretches(valid, i0, i1, min_len):
    """Clean stretches of at least min_len samples, lengths rounded down to a multiple of 64."""
    v = valid[i0:i1]
    d = np.diff(np.concatenate([[0], v.astype(int), [0]]))
    out = []
    for s, e in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
        L = (e - s) // 64 * 64
        if L >= min_len:
            out.append((i0 + s, i0 + s + L))
    return out


# =============================================================================== per-window peaks


def _thr_key(cfg):
    return f'{cfg["spectrum"]}/{cfg["confirm"]}'


def window_peaks(comp, cfg, mains, thr, native_df, want_stats=False):
    """Candidate peaks of one window.  If want_stats: return the max confirmation statistic among
    width-valid candidates (for threshold tuning).  Else: list of passed peaks (f, se, stat, width, hdb)."""
    p = comp.p
    res = C.RESOLUTION[cfg["spectrum"]]
    smask = C.search_mask(mains)
    conf = cfg["confirm"]
    if conf == "P4":
        pk, bg = C.p4_fooof(p, mains, 0.0 if want_stats else thr)
        if bg is None:
            return (0.0 if want_stats else []), None
        flat = p / bg
        if want_stats:
            return max([pw for _, pw, _ in pk], default=0.0), bg
        out = []
        for cf, pw, bw in pk:
            if pw < thr or not smask[min(np.searchsorted(F, cf), F.size - 1)]:
                continue
            width = bw * 2.355 / 2  # fooof bw is 2 sd; FWHM = 2.355 sd
            if not (0.8 * res <= width <= PARAMS["width_max"]):
                continue
            i = int(np.searchsorted(F, cf))
            se = C.jackknife_se(comp, bg, "centroid", cf, width, native_df)
            out.append((cf, se, pw, width, 10 * np.log10(max(flat[i], 1e-6))))
        return out, bg
    if cfg["spectrum"] == "S3":
        bg = comp.bg_est
        if bg is None:
            return (0.0 if want_stats else []), None
    else:
        bg, chi, off, err = C.robust_background(p, comp.dof, mains, bias_correct=cfg["bias_correct"])
        if err > cfg["fit_err_max"]:
            return (0.0 if want_stats else []), None
    if conf == "P2":
        flat = C.prominence_spectrum(p, mains)
        # P2 has no background of its own; its standard error is the jackknife of the same
        # estimator on the P1-flattened spectrum (stated in the report)
        flat_for_freq = flat
    else:
        flat = p / bg
        flat_for_freq = flat
    idx = C.local_maxima(flat, smask & (flat > 1.0))
    idx = idx[np.argsort(-flat[idx])]
    best = 0.0
    out = []
    covered = []
    for i in idx:
        # one candidate per bump: a maximum inside the half-height region of a taller one is ripple
        if any(a <= i <= b for a, b in covered):
            continue
        l, r, half, width = C._half_region(flat, i)
        if any(l <= (a + b) // 2 <= r for a, b in covered):
            continue  # a shoulder whose own half-height region swallows a taller, accepted peak
        covered.append((l, r))
        res_f = C.resolution_at(cfg["spectrum"], F[i])
        if not (0.8 * res_f <= width <= PARAMS["width_max"]):
            continue
        if conf == "P3":
            stat = C.ftest_stat(comp, F[i], 2 * PARAMS["mt_w"])
        else:
            stat = float(flat[i])
        if want_stats:
            best = max(best, stat)
            continue
        if not stat >= thr:
            continue
        method = cfg["freq"]
        excess = method.endswith("_excess")
        if excess:  # estimate on the background-subtracted peak, scaled so the base is 1
            method = method[:-len("_excess")]
            ex = 1.0 + (p - bg) / bg[i]
            l2, r2, half2, _ = C._half_region(ex, i)
            f_hat = C.estimate_freq(method, ex, i, l2, r2, half2, native_df)
        else:
            f_hat = C.estimate_freq(method, flat_for_freq, i, l, r, half, native_df)
        se = C.jackknife_se(comp, bg, method, f_hat, width, native_df, excess=excess)
        out.append((f_hat, se, stat, width, 10 * np.log10(max(p[i] / bg[i], 1e-6))))
    return (best if want_stats else out), bg


def threshold_for(cfg, dof):
    if cfg["thr_mode"] == "analytic":
        if cfg["confirm"] != "P1":
            raise ValueError("analytic thresholds exist only for P1")
        if cfg["sidak"]:
            return C.p1_threshold(dof, C.RESOLUTION[cfg["spectrum"]])
        import scipy.stats as st
        return float(st.chi2.ppf(1 - PARAMS["alpha_peak"], dof) / dof)
    if cfg["confirm"] == "P1":
        return cfg["thresholds"][_thr_key(cfg)] * C.p1_threshold(dof, C.RESOLUTION[cfg["spectrum"]])
    return cfg["thresholds"][_thr_key(cfg)]


# =============================================================================== harmonic test


def harmonic_plv(xw, f_lo, f_hi, n_mult, w_lo, rng):
    """Phase locking of the upper rhythm to n x the lower rhythm's phase over one window, averaged
    over clean channels, against 19 circular time-shift surrogates.  Returns (plv, max of null)."""
    L = xw.shape[1]
    fq = np.fft.fftfreq(L, 1 / FS)
    X = np.fft.fft(xw - xw.mean(axis=1, keepdims=True), axis=1)
    sd_lo = max(0.4, w_lo / 2.355)
    g_lo = np.exp(-0.5 * ((fq - f_lo) / sd_lo) ** 2) * (fq > 0)
    g_hi = np.exp(-0.5 * ((fq - f_hi) / (n_mult * sd_lo)) ** 2) * (fq > 0)
    zl = np.fft.ifft(X * g_lo, axis=1)
    zh = np.fft.ifft(X * g_hi, axis=1)
    edge = int(0.5 * FS)
    zl, zh = zl[:, edge:-edge], zh[:, edge:-edge]
    # amplitude-weighted phase locking, pooled over channels: moments where both rhythms are strong
    # count most, which is where the phase of each is well defined
    ul = (zl / (np.abs(zl) + 1e-12)) ** n_mult
    uh = zh / (np.abs(zh) + 1e-12)
    al = np.abs(zl) ** n_mult
    ah = np.abs(zh)
    m = ul.shape[1]

    def _plv(shift):
        a_l = np.roll(al, shift, axis=1) if shift else al
        u_l = np.roll(ul, shift, axis=1) if shift else ul
        w = a_l * ah
        return float(np.abs((w * uh * np.conj(u_l)).sum()) / max(w.sum(), 1e-12))

    plv = _plv(0)
    null = [_plv(int(rng.integers(int(FS), m - int(FS)))) for _ in range(19)]
    return plv, float(np.max(null))


# =============================================================================== main


def analyze(rec, cfg_in=None, start_offset=0, tuning=False, t_max=None):
    cfg = dict(DEFAULT_CFG)
    if cfg_in:
        cfg.update(cfg_in)
    rng = np.random.default_rng(cfg["seed"] * 1000003 + rec.seed % 1000003)
    C.T3_OPTS["min_at_sx0"] = bool(cfg.get("t3_min_sx0", False))
    raw = rec.data[:, start_offset:]
    data, repaired, invalid = repair_gaps(raw)
    x, mains = condition(data)
    qok = quality(data, x, mains, contact=cfg.get("contact_check", True))
    if cfg["gating"]:
        flagged, _ = gate(x, None if rec.motion is None else rec.motion[:, int(start_offset / FS * 52):])
    else:
        flagged = np.zeros_like(qok)
    valid = qok & ~flagged
    n = x.shape[1]
    W = int(PARAMS["window_s"] * FS)
    hop = int(PARAMS["hop_s"] * FS)
    min_len = int(PARAMS["min_stretch"] * FS)
    native_df = 1.0 / PARAMS["window_s"]
    spec_fn = C.SPECTRA[cfg["spectrum"]]
    ends = np.arange(W, n + 1, hop)
    if t_max is not None:
        ends = ends[ends <= int(t_max * FS)]
    lag_n = int(PARAMS["window_s"] / PARAMS["hop_s"])     # windows between non-overlapping windows
    hold_n = int(PARAMS["hold_s"] / PARAMS["hop_s"])
    win = []
    tune_stats = []
    passed_hist = []
    tracks = []
    next_id = 0
    events = {"merges": 0, "births": 0}
    harm_hist = {}
    integ_hist = {}
    states_cond = {k: {r: [] for r in ("T1", "T2", "T3", "T4", "T4c")} for k in C.TARGETS}
    chanceA_cache = None
    for wi, e in enumerate(ends):
        s0 = e - W
        t = e / FS
        rec_w = {"t": round(t + start_offset / FS, 4), "null": None}
        if repaired[s0:e].mean() > PARAMS["repaired_frac"] or invalid[s0:e].any():
            rec_w["null"] = "link"
        chans = []
        used = []
        if rec_w["null"] is None:
            for c in range(x.shape[0]):
                v = valid[c, s0:e]
                if v.mean() < PARAMS["min_clean"]:
                    continue
                st = stretches(valid[c], s0, e, min_len)
                if not st:
                    continue
                cs = spec_fn([x[c, a:b] for a, b in st])
                if cs is None:
                    continue
                chans.append(cs)
                used.append(c)
            if not chans:
                rec_w["null"] = "no_clean_channel"
        rec_w["channels"] = used
        peaks = []
        if rec_w["null"] is None:
            comp = C.Composite(chans)
            if tuning:
                stat, _ = window_peaks(comp, cfg, mains, None, native_df, want_stats=True)
                if cfg["confirm"] == "P1":
                    # P1 is tuned as a factor on the analytic chi-squared threshold, so that the tuned
                    # threshold still follows the window's degrees of freedom (fewer clean channels or
                    # shorter clean stretches give a higher threshold)
                    stat = stat / C.p1_threshold(comp.dof, C.RESOLUTION[cfg["spectrum"]])
                tune_stats.append(stat)
                win.append(rec_w)
                continue
            thr = threshold_for(cfg, comp.dof)
            peaks, bg = window_peaks(comp, cfg, mains, thr, native_df)
            if bg is None:
                rec_w["null"] = "background_fit"
        elif tuning:
            win.append(rec_w)
            continue
        passed_hist.append(peaks)
        # ---- persistence: present in >= k of the last n non-overlapping windows (incl. this one)
        confirmed = []
        for pk in peaks:
            cnt = 1
            for back in range(1, PARAMS["persist_n"]):
                j = len(passed_hist) - 1 - back * lag_n
                if j < 0:
                    continue
                for q in passed_hist[j]:
                    tol = max(3 * np.hypot(np.nan_to_num(pk[1], nan=0.5), np.nan_to_num(q[1], nan=0.5)), 0.25)
                    if abs(q[0] - pk[0]) <= tol:
                        cnt += 1
                        break
            if cnt >= PARAMS["persist_k"]:
                confirmed.append(pk)
        rec_w["peaks"] = [(round(p[0], 4), round(float(np.nan_to_num(p[1], nan=-1)), 4), round(p[4], 2), round(p[3], 3))
                          for p in confirmed]
        # ---- tracks
        live = [tr for tr in tracks if tr["alive"]]
        used_tr = set()
        for pk in sorted(confirmed, key=lambda q: -q[2]):
            best, bd = None, None
            for tr in live:
                if tr["id"] in used_tr:
                    continue
                d = abs(tr["f_last"] - pk[0])
                lim = max(PARAMS["join_se"] * np.hypot(tr["se_last"], np.nan_to_num(pk[1], nan=1.0)), PARAMS["join_hz"])
                if d <= lim and (bd is None or d < bd):
                    best, bd = tr, d
            se = float(pk[1]) if np.isfinite(pk[1]) and pk[1] > 0 else np.nan
            if best is None:
                best = {"id": next_id, "birth": t, "alive": True, "hist": [], "f_last": pk[0], "se_last": 0.5,
                        "last_seen": wi}
                next_id += 1
                events["births"] += 1
                tracks.append(best)
                live.append(best)
            used_tr.add(best["id"])
            best["hist"].append((wi, pk[0], se, pk[4], pk[3]))
            best["f_last"] = pk[0]
            best["se_last"] = se if np.isfinite(se) else 0.5
            best["last_seen"] = wi
        for tr in live:
            if tr["id"] not in used_tr and wi - tr["last_seen"] > hold_n:
                tr["alive"] = False
        live = sorted([tr for tr in tracks if tr["alive"]], key=lambda q: q["f_last"])
        for a, b in zip(live, live[1:]):
            if a["alive"] and b["alive"] and abs(a["f_last"] - b["f_last"]) < 0.5:
                old, new = (a, b) if a["birth"] <= b["birth"] else (b, a)
                old["hist"] += new["hist"]
                old["hist"].sort()
                new["alive"] = False
                events["merges"] += 1
        live = sorted([tr for tr in tracks if tr["alive"]], key=lambda q: q["f_last"])
        # ---- integrated frequency
        integ = []
        int_n = int(PARAMS["integ_s"] / PARAMS["hop_s"])
        for tr in live:
            h = [q for q in tr["hist"] if q[0] > wi - int_n and np.isfinite(q[2]) and q[2] > 0]
            fading = tr["last_seen"] != wi
            if len(h) < 3:
                continue
            fs_ = np.array([q[1] for q in h])
            se_ = np.maximum(np.array([q[2] for q in h]), 0.01)
            wts = 1 / se_ ** 2
            fi = float((fs_ * wts).sum() / wts.sum())
            se_i = float(np.sqrt(1 / wts.sum()))
            if cfg.get("se_mode", "max") in ("scatter", "max") and len(h) >= 5:
                # empirical: scatter of this track's own window estimates over the integration time,
                # divided by the number of non-overlapping windows that time spans
                n_eff = (len(h) * PARAMS["hop_s"] + PARAMS["window_s"] - PARAMS["hop_s"]) / PARAMS["window_s"]
                se_sc = float(np.std(fs_, ddof=1) / np.sqrt(max(n_eff, 1.0)))
            else:
                se_sc = 0.0
            if cfg.get("se_mode", "max") == "scatter":
                se_i = se_sc
            elif cfg["se_inflation"]:
                m = len(h)
                rho = np.clip(1 - np.arange(1, m) * PARAMS["hop_s"] / PARAMS["window_s"], 0, None)
                infl = 1 + 2 * np.sum((1 - np.arange(1, m) / m) * rho)
                se_i *= np.sqrt(infl)
            if cfg.get("se_mode", "max") == "max":
                se_i = max(se_i, se_sc)
            integ.append({"id": tr["id"], "f": fi, "se": se_i, "fading": fading, "n": len(h),
                          "hdb": float(np.mean([q[3] for q in h]))})
            integ_hist.setdefault(tr["id"], {})[wi] = (fi, se_i)
        rec_w["tracks"] = [(q["id"], round(q["f"], 4), round(q["se"], 5)) for q in integ]
        # ---- pairs, harmonic test, scoring
        fl = np.array([q["f"] for q in integ])
        sl = np.array([q["se"] for q in integ])
        ids = [q["id"] for q in integ]
        harmonic = set()
        pending = set()
        if len(integ) >= 2:
            pi, pj, px, psx = C.pair_arrays(fl, sl)
            if cfg["harmonic_test"]:
                width_of = {tr["id"]: tr["hist"][-1][4] for tr in tracks if tr["hist"]}
                xw = None
                for a_, b_, xv in zip(pi, pj, px):
                    for nm in (2, 3):
                        if abs(xv - np.log(nm)) < 0.05:
                            key = (ids[a_], ids[b_], nm)
                            if xw is None:
                                cl = [c for c in range(x.shape[0]) if valid[c, s0:e].mean() > 0.9]
                                xw = x[cl or used or [0], s0:e]
                            w_lo = width_of.get(ids[a_], 1.0)
                            plv, nul = harmonic_plv(xw, fl[a_], fl[b_], nm, w_lo, rng)
                            harm_hist.setdefault(key, []).append(plv > max(nul, 0.2))
                            hh = harm_hist[key][-3:]
                            if sum(hh) >= 2:
                                harmonic.add((a_, b_))
                            elif cfg.get("harmonic_pending", True) and len(hh) < 3:
                                # not yet shown to be independent: excluded until 3 tests have run
                                pending.add((a_, b_))
                if cfg.get("harmonic_family", True) and harmonic:
                    # two harmonics of the same base (e.g. 2f and 3f, a 1.5 step) are one rhythm too
                    by_base = {}
                    for a_, b_ in harmonic:
                        by_base.setdefault(a_, set()).add(b_)
                    for a_, ups in by_base.items():
                        ups = sorted(ups)
                        for u in ups:
                            for v in ups:
                                if u < v:
                                    harmonic.add((u, v))
            resolved = psx <= PARAMS["sx_limit"]
            nonharm = np.array([(a_, b_) not in harmonic and (a_, b_) not in pending for a_, b_ in zip(pi, pj)])
            rec_w["harmonic"] = [(ids[a_], ids[b_]) for a_, b_ in harmonic]
        tgt_out = {}
        for tk in C.TARGETS:
            if len(integ) < 2:
                tgt_out[tk] = {"c": None, "lnL": None, "t1": False, "t1h": False, "t2": False, "t2h": False, "casc": []}
                continue
            r_ok = resolved & nonharm
            stp = C.pair_stats(px, psx, tk, r_ok)
            if not cfg["t2_cap"]:
                lim = PARAMS["T2_k"] * psx
                stp["t2_in"] = (np.abs(stp["miss"]) < lim) & nonharm
                stp["t2_hold"] = (np.abs(stp["miss"]) < PARAMS["hyst"] * lim) & nonharm
            ok = {(int(a_), int(b_)): bool(v) for a_, b_, v in zip(pi, pj, stp["t1_in"])}
            chain = C.longest_chain(list(fl), ok)
            tgt_out[tk] = {"c": float(stp["c"].max()), "lnL": float(stp["lnL"].max()),
                           "t1": bool(stp["t1_in"].any()), "t1h": bool(stp["t1_hold"].any()),
                           "t2": bool(stp["t2_in"].any()), "t2h": bool(stp["t2_hold"].any()),
                           "casc": [ids[k] for k in chain] if len(chain) >= 2 else []}
        # ---- chance A (refreshed every 5 s) and chance B
        refresh = int(5.0 / PARAMS["hop_s"])
        if cfg["chance"] and len(integ) >= 2 and (chanceA_cache is None or wi % refresh == 0 or
                                                   chanceA_cache[0] != len(integ)):
            srng = np.random.default_rng([cfg["seed"], rec.seed % (2 ** 31), wi])
            fs_s, ss_s = C.surrogate_sets(srng, len(integ), sl / fl, PARAMS["n_surr"],
                                           freqs=fl if cfg.get("chance_band") else None)
            ca = {}
            for tk in C.TARGETS:
                if cfg["chance_same_search"]:
                    cc, ll = C.best_scores(fs_s, ss_s, tk)
                else:  # broken build: chance computed for a single random pair, not the full search
                    cc, ll = C.best_scores(fs_s[:, :2], ss_s[:, :2], tk)
                casc = C.surrogate_cascades(fs_s, ss_s, tk) if tk in ("phi", "octave") else None
                a_st = cfg.get("alpha_state", PARAMS["alpha_state"])
                ca[tk] = {"cc": cc, "ll": ll, "casc": casc,
                          "thr_l": float(np.quantile(ll, 1 - a_st)), "thr_l_exit": float(np.quantile(ll, 0.95)),
                          "thr_c": float(np.quantile(cc, 1 - a_st)), "thr_c_exit": float(np.quantile(cc, 0.95))}
            chanceA_cache = (len(integ), ca)
        if len(integ) < 2:
            chanceA_cache = None
        for tk in C.TARGETS:
            o = tgt_out[tk]
            if chanceA_cache is not None and o["c"] is not None and cfg["chance"]:
                ca = chanceA_cache[1][tk]
                exp_c = float(ca["cc"].mean())
                o["chA_exp"] = exp_c
                o["chA_pct"] = float((ca["cc"] < o["c"]).mean() + 0.5 * (ca["cc"] == o["c"]).mean())
                o["excessA"] = max(0.0, (o["c"] - exp_c) / (1 - exp_c)) if exp_c < 1 else 0.0
                o["t4"] = o["lnL"] >= ca["thr_l"] and np.isfinite(o["lnL"])
                o["t4h"] = o["lnL"] >= min(ca["thr_l_exit"], ca["thr_l"]) and np.isfinite(o["lnL"])
                o["t4c"] = o["c"] >= ca["thr_c"] and o["c"] > 0
                o["t4ch"] = o["c"] >= min(ca["thr_c_exit"], ca["thr_c"]) and o["c"] > 0
                if ca["casc"] is not None:
                    o["chA_casc_ge3"] = float((ca["casc"] >= 3).mean())
            else:
                o["t4"] = o["t4h"] = o["t4c"] = o["t4ch"] = False
        # chance B: tracks with integrated values over the whole last 120 s
        hist_n = int(PARAMS["chanceB_hist"] / PARAMS["hop_s"])
        if cfg["chance"] and len(integ) >= 2:
            full = [q for q in integ if all((wi - k) in integ_hist.get(q["id"], {}) for k in range(0, hist_n, 5))
                    and (wi - hist_n + 1) in integ_hist.get(q["id"], {})]
            if len(full) >= 2:
                brng = np.random.default_rng([cfg["seed"], rec.seed % (2 ** 31), wi, 7])
                H = np.array([[integ_hist[q["id"]].get(wi - hist_n + 1 + k, integ_hist[q["id"]][wi])[0]
                               for k in range(hist_n)] for q in full])
                Sx = np.array([q["se"] for q in full])
                min_lag = int(PARAMS["chanceB_min_lag"] / PARAMS["hop_s"])
                lags = brng.integers(min_lag, hist_n - min_lag + 1, (PARAMS["n_surr"], len(full)))
                fsB = H[np.arange(len(full))[None, :], (hist_n - 1 - lags) % hist_n]
                order = np.argsort(fsB, axis=1)
                fsB = np.take_along_axis(fsB, order, 1)
                ssB = np.take_along_axis(np.broadcast_to(Sx, fsB.shape), order, 1)
                obs_f = np.sort(H[:, -1])
                obs_s = Sx[np.argsort(H[:, -1])]
                for tk in ("phi", "octave"):
                    cb, _ = C.best_scores(fsB, ssB, tk)
                    co, _ = C.best_scores(obs_f[None, :], obs_s[None, :], tk)
                    tgt_out[tk]["chB_exp"] = float(cb.mean())
                    tgt_out[tk]["chB_pct"] = float((cb < co[0]).mean() + 0.5 * (cb == co[0]).mean())
        rec_w["targets"] = tgt_out
        win.append(rec_w)
    if tuning:
        return {"tune_stats": tune_stats, "mains": mains}
    # ---- states with dwell and hysteresis
    n_dwell = int(round(PARAMS["dwell_s"] / PARAMS["hop_s"])) + 1
    states = {}
    for tk in C.TARGETS:
        states[tk] = {}
        for rule, (ki, kh) in {"T1": ("t1", "t1h"), "T2": ("t2", "t2h"), "T3": ("t3", "t3h"),
                               "T4": ("t4", "t4h"), "T4c": ("t4c", "t4ch")}.items():
            st, run, seq, entries = False, 0, [], []
            for w in win:
                o = w.get("targets", {}).get(tk)
                if o is None or w["null"]:
                    a_in = a_hold = False
                elif rule == "T3":
                    lv = o["lnL"]
                    a_in = lv is not None and lv >= PARAMS["T3_entry"]
                    a_hold = lv is not None and lv >= PARAMS["T3_exit"]
                else:
                    a_in, a_hold = bool(o.get(ki)), bool(o.get(kh))
                if not st:
                    run = run + 1 if a_in else 0
                    if run >= n_dwell:
                        st = True
                        entries.append(w["t"])
                else:
                    if not a_hold:
                        st, run = False, 0
                seq.append(st)
            states[tk][rule] = {"on": seq, "entries": entries}
    out = {"windows": win, "states": states, "mains": mains, "events": events,
           "n_tracks_total": next_id,
           "gated_frac": float((~valid).mean()), "valid": None}
    out["digest"] = hashlib.sha256(repr([(w["t"], w.get("peaks"), w.get("tracks")) for w in win]).encode()
                                   + repr(states).encode()).hexdigest()
    out["_flagged"] = flagged
    out["_qok"] = qok
    return out
