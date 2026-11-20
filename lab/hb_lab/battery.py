"""The test battery of spec section 10.2 and the metrics behind every pass mark in 10.3.

Seeds
-----
* TUNING seeds 1_000_000 + i: background-only files used only to calibrate the confirmation
  thresholds (alpha_peak = 1 % of windows).  Nothing else is tuned.
* TEST seeds 2_000_000 + set offset + i: every number in the report comes from these.
* BLIND seeds: lab/make_blind.py, from a file that is not committed (set I).
"""
from __future__ import annotations

import math
import os
import time
from multiprocessing import Pool

import numpy as np

from . import candidates as C
from . import generators as G
from . import pipeline as P

PHI = G.PHI
TUNE_BASE = 1_000_000
TEST_BASE = 2_000_000

# ------------------------------------------------------------------ candidate configurations

STAGE_CONFIGS = {
    # spectrum stage (confirmation P1, centroid)
    "S1-P1": {"spectrum": "S1", "confirm": "P1"},
    "S1-P1-analytic": {"spectrum": "S1", "confirm": "P1", "thr_mode": "analytic"},
    "S2-P1": {"spectrum": "S2", "confirm": "P1"},
    "S3-P1": {"spectrum": "S3", "confirm": "P1"},
    "S1W1-P1": {"spectrum": "S1W1", "confirm": "P1"},
    "S1Q-P1": {"spectrum": "S1Q", "confirm": "P1"},
    "S1Q-P1-excess": {"spectrum": "S1Q", "confirm": "P1", "freq": "centroid_excess"},
    # confirmation stage (spectrum S1)
    "S1-P2": {"spectrum": "S1", "confirm": "P2"},
    "S1-P3": {"spectrum": "S1", "confirm": "P3"},
    "S1-P4": {"spectrum": "S1", "confirm": "P4"},
    # peak frequency stage (S1-P1)
    "S1-P1-excess": {"spectrum": "S1", "confirm": "P1", "freq": "centroid_excess"},
    "S1-P1-gauss": {"spectrum": "S1", "confirm": "P1", "freq": "gauss"},
    "S1-P1-parabolic": {"spectrum": "S1", "confirm": "P1", "freq": "parabolic"},
}
DEFAULT = "S1-P1"
TUNED_KEYS = ["S1/P1", "S2/P1", "S3/P1", "S1W1/P1", "S1Q/P1", "S1/P2", "S1/P3", "S1/P4"]

# deliberately broken builds: each should fail the test named beside it
BROKEN = {
    "broken-no-multibin": ({"spectrum": "S1", "confirm": "P1", "thr_mode": "analytic", "sidak": False}, "C"),
    "broken-no-logbias": ({"spectrum": "S1", "confirm": "P1", "thr_mode": "analytic", "bias_correct": False}, "C"),
    "broken-se-jackknife-only": ({"spectrum": "S1", "confirm": "P1", "se_mode": "jackknife", "se_inflation": False}, "A"),
    "broken-no-gating": ({"spectrum": "S1", "confirm": "P1", "gating": False}, "E"),
    "broken-no-harmonic-test": ({"spectrum": "S1", "confirm": "P1", "harmonic_test": False}, "D"),
    "broken-t2-uncapped": ({"spectrum": "S1", "confirm": "P1", "t2_cap": False}, "B"),
    "broken-chance-single-pair": ({"spectrum": "S1", "confirm": "P1", "chance_same_search": False}, "C"),
}

RULES = ("T1", "T2", "T3", "T4", "T4c")


# ------------------------------------------------------------------ job lists

def jobs_tuning(n=48):
    return [{"set": "tune", "kind": "background_only", "seed": TUNE_BASE + i} for i in range(n)]


def jobs_A(per_cell=6):
    out = []
    k = 0
    for n_m in (2, 3, 4, 5):
        for snr in (3, 6, 10, 15):
            for r in range(per_cell):
                seed = TEST_BASE + 10_000 + k
                rng = np.random.default_rng(seed + 555)
                f_hi = min(8.0, 40.0 / PHI ** (n_m - 1))
                out.append({"set": "A", "kind": "cascade", "seed": seed, "n_members": n_m, "ratio": PHI,
                            "snr": snr, "f_start": float(rng.uniform(3.0, f_hi))})
                k += 1
    return out


B_RATIOS = (1.45, 1.5, 1.55, 1.58, PHI, 1.65, 1.7, 1.75, 1.8, 1.9, 2.0, 2.1)


def jobs_B(per_ratio=8, octave_extra=12):
    out = []
    k = 0
    for ratio in B_RATIOS:
        for r in range(per_ratio):
            seed = TEST_BASE + 20_000 + k
            rng = np.random.default_rng(seed + 555)
            out.append({"set": "B", "kind": "cascade", "seed": seed, "n_members": 3, "ratio": float(ratio),
                        "snr": 10, "f_start": float(rng.uniform(3.5, 6.0))})
            k += 1
    for r in range(octave_extra):
        seed = TEST_BASE + 21_000 + r
        rng = np.random.default_rng(seed + 555)
        n_m = 3 + r % 2
        out.append({"set": "B", "kind": "cascade", "seed": seed, "n_members": n_m, "ratio": 2.0, "snr": 10,
                    "f_start": float(rng.uniform(3.0, 40.0 / 2 ** (n_m - 1))), "octave_cascade": True})
    return out


def jobs_C():
    out = []
    spec = [("background_only", 30), ("white_noise", 10), ("random_loguniform", 30), ("random_bands", 30),
            ("headset_on_table", 10), ("surrogate_sample_shuffle", 8), ("surrogate_block_shuffle", 8),
            ("surrogate_phase_randomize", 8), ("surrogate_channel_shift", 8)]
    k = 0
    for kind, n in spec:
        for i in range(n):
            out.append({"set": "C", "kind": kind, "seed": TEST_BASE + 30_000 + k})
            k += 1
    return out


def jobs_D(n=24):
    out = []
    for i in range(n):
        seed = TEST_BASE + 40_000 + i
        rng = np.random.default_rng(seed + 555)
        out.append({"set": "D", "kind": "harmonic", "seed": seed, "f0": float(rng.uniform(5.0, 12.0))})
    return out


def jobs_E(per_kind=4):
    out = []
    k = 0
    for kind in G.ARTIFACT_KINDS:
        for i in range(per_kind):
            out.append({"set": "E", "kind": kind, "seed": TEST_BASE + 50_000 + k})
            k += 1
    return out


def jobs_F(per_case=4):
    out = []
    k = 0
    for case in ("drift_band_edge", "close_double", "split", "crossing", "short_bursts", "form_dissolve"):
        n = 6 if case == "form_dissolve" else per_case
        for i in range(n):
            out.append({"set": "F", "kind": case, "seed": TEST_BASE + 60_000 + k})
            k += 1
    for i in range(6):
        for tr in ("none", "phase_randomize", "block_shuffle"):
            out.append({"set": "F", "kind": "steady_long", "transform": tr, "seed": TEST_BASE + 61_000 + i})
    return out


def jobs_G(n=8):
    out = []
    for i in range(n):
        seed = TEST_BASE + 70_000 + i
        rng = np.random.default_rng(seed + 555)
        base = {"set": "G", "kind": "cascade", "seed": seed, "n_members": 3, "ratio": PHI, "snr": 10,
                "f_start": float(rng.uniform(3.5, 6.0))}
        for fault in ("clean", "loss0.1", "loss1", "loss5", "burst1", "clock0.5"):
            out.append(dict(base, fault=fault))
    return out


def jobs_H(n=4):
    out = []
    for i in range(n):
        seed = TEST_BASE + 80_000 + i
        rng = np.random.default_rng(seed + 555)
        base = {"set": "H", "kind": "cascade", "seed": seed, "n_members": 3, "ratio": PHI, "snr": 10,
                "f_start": float(rng.uniform(3.5, 6.0))}
        for rep in ("a", "b"):
            out.append(dict(base, rep=rep, offset=0))
        for off in (64, 137, 200):
            out.append(dict(base, rep="off", offset=off))
    return out


# ------------------------------------------------------------------ recordings


def build(job):
    k, s = job["kind"], job["seed"]
    if k == "cascade":
        rec = G.make_cascade(s, job["n_members"], job["ratio"], job["snr"], job["f_start"],
                             kind="octave_cascade" if job["ratio"] == 2.0 else "cascade")
        fault = job.get("fault", "clean")
        rng = np.random.default_rng(s + 31)
        if fault.startswith("loss"):
            rec.data, frac = G.drop_packets(rng, rec.data, float(fault[4:]) / 100)
            rec.truth["lost_frac"] = frac
        elif fault == "burst1":
            rec.data, frac = G.drop_packets(rng, rec.data, 0.01, burst=True)
            rec.truth["lost_frac"] = frac
        elif fault == "clock0.5":
            rec.data = G.clock_skew(rec.data, 1.005)
            rec.truth["freq_scale"] = 1 / 1.005
        return rec
    if k == "background_only":
        return G.make_background_only(s)
    if k == "white_noise":
        return G.make_white(s)
    if k == "random_loguniform":
        return G.make_random_peaks(s, mode="loguniform")
    if k == "random_bands":
        return G.make_random_peaks(s, mode="bands")
    if k == "headset_on_table":
        return G.make_table(s, mains_hz=50.0 if s % 2 else 60.0)
    if k.startswith("surrogate_"):
        return G.make_surrogate(s, k[len("surrogate_"):])
    if k == "harmonic":
        return G.make_harmonic(s, job["f0"])
    if job["set"] == "E":
        return G.make_artifact(s, k)
    if k == "steady_long":
        rng = np.random.default_rng(s + 555)
        rec = G.make_cascade(s, 3, PHI, 10, float(rng.uniform(3.5, 6.0)), duration=180.0)
        tr = job["transform"]
        if tr != "none":
            rr = np.random.default_rng(s + 77)
            rec.data = G.phase_randomize(rr, rec.data) if tr == "phase_randomize" else G.block_shuffle(rr, rec.data)
        return rec
    if job["set"] == "F":
        return G.make_hard(s, k)
    raise ValueError(job)


# ------------------------------------------------------------------ per-file summaries


def _truth_at(pk, t, span):
    tr = pk["traj_1hz"]
    a, b = max(0, int(t - span)), max(1, int(t))
    return float(np.mean(tr[a:b])) if a < len(tr) else float(tr[-1])


def _match(f, truths, rel=0.05, abs_hz=0.6, widths=None):
    """Index of the planted rhythm this frequency belongs to: within 0.6 Hz, 5 %, or 1.5 times the
    rhythm's own spectral sd (a lump inside a broad rhythm's bump belongs to that rhythm)."""
    best, bd = None, None
    for k, tf in enumerate(truths):
        tol = max(abs_hz, rel * tf, 1.5 * widths[k] if widths is not None and k < len(widths) else 0.0)
        d = abs(f - tf)
        if d <= tol and (bd is None or d < bd):
            best, bd = k, d
    return best


def _state_summary(res, t_from=40.0):
    out = {}
    ts = np.array([w["t"] for w in res["windows"]])
    sel = ts >= t_from
    for tk in C.TARGETS:
        out[tk] = {}
        for rule in RULES:
            st = res["states"][tk][rule]
            on = np.array(st["on"], bool)
            out[tk][rule] = {"entered": len(st["entries"]) > 0, "n_entries": len(st["entries"]),
                             "frac": float(on[sel].mean()) if sel.any() else 0.0, "entries": st["entries"]}
    return out


def _casc_len(w, tk, truths=None, scale=1.0):
    o = w.get("targets", {}).get(tk)
    if not o:
        return 0, 0
    ids = o["casc"]
    if not ids:
        return 0, 0
    fmap = {q[0]: q[1] for q in w["tracks"]}
    false_m = 0
    if truths is not None:
        for i in ids:
            if _match(fmap[i], truths) is None:
                false_m += 1
    return len(ids), false_m


def summarize(job, rec, res, clean=None):
    win = res["windows"]
    truth_peaks = rec.truth.get("peaks", [])
    scale = rec.truth.get("freq_scale", 1.0)
    T = rec.duration
    s = {"seed": job["seed"], "kind": job["kind"], "n_win": len(win),
         "null_win": sum(1 for w in win if w["null"]), "digest": res["digest"]}
    s["states"] = _state_summary(res)
    # confirmed peaks vs truth, per window
    elig = [w for w in win if w["t"] >= 24.0 and not w["null"]]
    false_win = 0
    n_false = 0
    dup_win = 0
    det = np.zeros((len(truth_peaks), max(len(elig), 1)), bool)
    widths = [pk["bw"] for pk in truth_peaks]
    for wi, w in enumerate(elig):
        tf = [_truth_at(pk, w["t"], 8) * scale for pk in truth_peaks]
        extra = rec.truth.get("harmonics", [])
        tf_all = tf + list(extra)
        wd = widths + [m * truth_peaks[0]["bw"] for m in (2, 3)][:len(extra)] if truth_peaks else None
        fw = 0
        seen = set()
        dup = 0
        for pk in w.get("peaks", []):
            m = _match(pk[0], tf_all, widths=wd)
            if m is None:
                fw += 1
            else:
                if m in seen:
                    dup += 1
                seen.add(m)
                if m < len(tf):
                    det[m, wi] = True
        n_false += fw
        false_win += fw > 0
        dup_win += dup > 0
    s["n_elig"] = len(elig)
    s["false_peak_windows"] = false_win
    s["false_peaks"] = n_false
    s["dup_peak_windows"] = dup_win
    s["any_peak_windows"] = sum(1 for w in elig if w.get("peaks"))
    s["det_rate"] = det.mean(axis=1).tolist() if truth_peaks else []
    # integrated frequencies at three late times, for accuracy and calibration
    cal = []
    final = {}
    for tt in (T - 40, T - 20, T):
        w = min(win, key=lambda q: abs(q["t"] - tt))
        if w["null"] or "tracks" not in w:
            continue
        for k, pk in enumerate(truth_peaks):
            tf = _truth_at(pk, w["t"], 38) * scale
            best = None
            for q in w["tracks"]:
                if abs(q[1] - tf) <= max(0.6, 0.05 * tf) and (best is None or abs(q[1] - tf) < abs(best[1] - tf)):
                    best = q
            if best is not None:
                cal.append((k, round(tt), (best[1] - tf) / tf, (best[1] - tf) / best[2] if best[2] > 0 else None,
                            truth_peaks[k]["bw"]))
                if tt == T:
                    final[k] = (best[1], best[2], tf)
    s["cal"] = cal
    s["final_tracks"] = {str(k): v for k, v in final.items()}
    lastw = win[-1]
    tf_final = [_truth_at(pk, T, 38) * scale for pk in truth_peaks] + list(rec.truth.get("harmonics", []))
    for tk in ("phi", "octave"):
        L, fm = _casc_len(lastw, tk, tf_final)
        s[f"casc_{tk}_final"] = L
        s[f"casc_{tk}_false_members"] = fm
        ls = [_casc_len(w, tk)[0] for w in win if w["t"] >= T - 30]
        s[f"casc_{tk}_late"] = ls
        allc = [_casc_len(w, tk, None)[0] for w in win]
        s[f"casc_{tk}_max"] = max(allc) if allc else 0
        fm_all = 0
        for w in win:
            if w["t"] < 24:
                continue
            tfw = [_truth_at(pk, w["t"], 38) * scale for pk in truth_peaks] + list(rec.truth.get("harmonics", []))
            fm_all += _casc_len(w, tk, tfw)[1]
        s[f"casc_{tk}_false_members_all"] = fm_all
    # chance A percentiles and excess at the final window and over time
    for tk in ("phi", "octave"):
        o = lastw.get("targets", {}).get(tk, {})
        s[f"chA_pct_{tk}"] = o.get("chA_pct")
        s[f"chA_exp_{tk}"] = o.get("chA_exp")
        s[f"c_{tk}"] = o.get("c")
        s[f"chB_pct_{tk}"] = o.get("chB_pct")
        s[f"chB_exp_{tk}"] = o.get("chB_exp")
        ex = [w["targets"][tk].get("excessA", 0.0) for w in win if w.get("targets") and w["targets"].get(tk)]
        s[f"excessA_gt05_{tk}"] = float(np.mean([e > 0.5 for e in ex])) if ex else 0.0
        pcts = [w["targets"][tk].get("chA_pct") for w in win if w.get("targets") and w["targets"].get(tk)
                and w["targets"][tk].get("chA_pct") is not None]
        s[f"chA_pct_ge99_frac_{tk}"] = float(np.mean([p >= 0.99 for p in pcts])) if pcts else 0.0
    s["harmonic_pairs"] = []
    if job["kind"] == "harmonic":
        f0 = rec.truth["f0"]
        n_pair = {2: 0, 3: 0}
        n_marked = {2: 0, 3: 0}
        for w in win:
            if w["t"] < 24 or "tracks" not in w:
                continue
            fmap = {q[0]: q[1] for q in w["tracks"]}
            base = [i for i, f in fmap.items() if abs(f - f0) < max(0.6, 0.05 * f0)]
            for mult in (2, 3):
                up = [i for i, f in fmap.items() if abs(f - mult * f0) < max(0.6, 0.05 * mult * f0)]
                if base and up:
                    n_pair[mult] += 1
                    hp = set(map(tuple, w.get("harmonic", [])))
                    if (base[0], up[0]) in hp:
                        n_marked[mult] += 1
        s["harm_pair_windows"] = n_pair
        s["harm_marked_windows"] = n_marked
        s["harm_marked_majority"] = {m: (n_marked[m] >= 0.5 * n_pair[m]) if n_pair[m] else None for m in (2, 3)}
    if "harmonic" in str(job.get("kind")) or job["set"] == "B":
        hp_any = sum(1 for w in win if w.get("harmonic"))
        s["windows_with_harmonic_mark"] = hp_any
    # gating truth
    if rec.artifact_mask is not None and job["set"] in ("E", "C"):
        fl = res["_flagged"] | ~res["_qok"]
        am = rec.artifact_mask[:, :fl.shape[1]]
        s["gate_sens"] = float(fl[am].mean()) if am.any() else None
        s["gate_false"] = float(fl[~am].mean()) if (~am).any() else None
    s["mains"] = res["mains"]
    s["events"] = res["events"]
    s["n_tracks_total"] = res["n_tracks_total"]
    if clean is not None:
        s.update(compare_to_clean(rec, res, clean))
    return s


def compare_to_clean(rec, res, clean):
    """E and G: what the faulty file reports that its clean twin does not."""
    out = {}
    cw = {w["t"]: w for w in clean["windows"]}
    genuine = rec.truth.get("genuine_freqs") or [pk["f0"] for pk in rec.truth.get("peaks", [])]
    gw = [pk["bw"] for pk in rec.truth.get("peaks", [])]
    # an extra peak is attributed to the artifact only if (1) it matches no planted rhythm (within 0.6 Hz,
    # 5 % or 1.5 rhythm widths), (2) the clean twin has no peak within 1 Hz in the same window, and (3) the
    # window, or the 16 s persistence look-back before it, overlaps a truly corrupted stretch
    am = rec.artifact_mask.any(axis=0) if rec.artifact_mask is not None else None
    attrib = 0
    attrib_win = 0
    for w in res["windows"]:
        c = cw.get(w["t"])
        if c is None or w["null"]:
            continue
        if am is not None:
            i1 = int(w["t"] * G.FS)
            i0 = max(0, i1 - int(24 * G.FS))
            if not am[i0:i1].any():
                continue
        cp = [q[0] for q in c.get("peaks", [])]
        k = 0
        for pk in w.get("peaks", []):
            if all(abs(pk[0] - f) > 1.0 for f in cp) and _match(pk[0], genuine, widths=gw) is None:
                k += 1
        attrib += k
        attrib_win += k > 0
    out["attrib_peaks"] = attrib
    out["attrib_peak_windows"] = attrib_win
    st_a = res["states"]
    st_c = clean["states"]
    out["attrib_state_entries"] = {tk: {r: max(0, len(st_a[tk][r]["entries"]) - len(st_c[tk][r]["entries"]))
                                        for r in RULES} for tk in C.TARGETS}
    ca = max([len(w.get("targets", {}).get("phi", {}).get("casc", [])) for w in res["windows"]] or [0])
    cc = max([len(w.get("targets", {}).get("phi", {}).get("casc", [])) for w in clean["windows"]] or [0])
    oa = max([len(w.get("targets", {}).get("octave", {}).get("casc", [])) for w in res["windows"]] or [0])
    oc = max([len(w.get("targets", {}).get("octave", {}).get("casc", [])) for w in clean["windows"]] or [0])
    out["attrib_casc"] = {"phi": int(ca > cc), "octave": int(oa > oc), "phi_len": [ca, cc], "oct_len": [oa, oc]}
    # recovery: genuine alpha confirmed 3 s after each artifact ends, where the clean twin has it
    fa = genuine[0]
    rec_ok = rec_n = 0
    for te in rec.truth.get("artifact_ends", []):
        tt = math.ceil(te + 3.0)
        w = next((q for q in res["windows"] if q["t"] >= tt), None)
        c = cw.get(w["t"]) if w else None
        if w is None or c is None:
            continue
        if any(abs(q[0] - fa) < 0.6 for q in c.get("peaks", [])):
            rec_n += 1
            rec_ok += any(abs(q[0] - fa) < 0.6 for q in w.get("peaks", []))
    out["recovery"] = [rec_ok, rec_n]
    # G: integrated frequencies vs the clean run at the final window
    dif = []
    both = [(w, cw[w["t"]]) for w in res["windows"] if w["t"] in cw and w.get("tracks") and cw[w["t"]].get("tracks")
            and not w["null"]]
    lw, lc = both[-1] if both else ({}, {})
    out["compared_at_t"] = lw.get("t")
    if "tracks" in lw and "tracks" in lc:
        for q in lc["tracks"]:
            m = min(lw["tracks"], key=lambda r: abs(r[1] - q[1]), default=None)
            if m is not None and abs(m[1] - q[1]) < 1.0:
                dif.append((m[1] - q[1], q[2], m[2]))
    out["vs_clean"] = dif
    out["null_frac"] = float(np.mean([w["null"] is not None for w in res["windows"]]))
    return out


# ------------------------------------------------------------------ hard cases (F)


def summarize_F(job, rec, res):
    s = summarize(job, rec, res)
    k = job["kind"]
    win = res["windows"]
    if k == "form_dissolve":
        sched = rec.truth["schedule"]
        d = {}
        for rule in RULES:
            st = res["states"]["phi"][rule]
            on = np.array(st["on"], bool)
            ts = np.array([w["t"] for w in win])
            ent, ext = [], []
            for a, b in sched:
                after = np.flatnonzero((ts >= a) & on & (ts <= b + 30))
                ent.append(float(ts[after[0]] - a) if after.size else None)
                off = np.flatnonzero((ts >= b) & ~on)
                ext.append(float(ts[off[0]] - b) if off.size else None)
            outside = 0
            for i, t in enumerate(ts):
                inside = any(a <= t <= b + 25 for a, b in sched)
                if on[i] and not inside:
                    outside += 1
            d[rule] = {"entry_delay": ent, "exit_delay": ext, "on_outside_windows": outside}
        # cascade of 3 formation delay
        ts = np.array([w["t"] for w in win])
        cl = np.array([len(w.get("targets", {}).get("phi", {}).get("casc", [])) for w in win])
        d["casc3_delay"] = [float(ts[np.flatnonzero((ts >= a) & (cl >= 3))[0]] - a)
                            if np.any((ts >= a) & (cl >= 3)) else None for a, _ in sched]
        s["form_dissolve"] = d
    elif k == "steady_long":
        s["transform"] = job["transform"]
        frac = {r: s["states"]["phi"][r]["frac"] for r in RULES}
        s["steady_frac"] = frac
    else:
        traj = [pk["traj_1hz"] for pk in rec.truth["peaks"]]
        n_both = 0
        n_el = 0
        err = []
        for w in win:
            if w["t"] < 24 or w["null"]:
                continue
            n_el += 1
            tf = [_truth_at(pk, w["t"], 8) for pk in rec.truth["peaks"]]
            got = [any(abs(q[0] - f) < 0.5 for q in w.get("peaks", [])) for f in tf]
            n_both += all(got)
            for f in tf:
                m = [q[0] for q in w.get("peaks", []) if abs(q[0] - f) < 0.6]
                if m:
                    err.append(abs(min(m, key=lambda v: abs(v - f)) - f))
        s["all_present_frac"] = n_both / max(n_el, 1)
        s["win_err_median"] = float(np.median(err)) if err else None
        s["track_births"] = res["events"]["births"]
        s["merges"] = res["events"]["merges"]
    return s


# ------------------------------------------------------------------ worker


_CFG_THR = {}


def _cfg(name, thresholds):
    if name in STAGE_CONFIGS:
        base = dict(STAGE_CONFIGS[name])
    else:
        base = dict(BROKEN[name][0])
    base["thresholds"] = thresholds
    return base


def run_job(args):
    job, cfg_names, thresholds = args
    t0 = time.time()
    rec = build(job)
    out = {"job": job, "by_cfg": {}}
    clean_rec = None
    if job["set"] == "E":
        rec, clean_rec = rec
    for name in cfg_names:
        cfg = _cfg(name, thresholds)
        if job["set"] == "tune":
            r = P.analyze(rec, cfg, tuning=True)
            out["by_cfg"][name] = {"stats": r["tune_stats"]}
            continue
        off = job.get("offset", 0)
        res = P.analyze(rec, cfg, start_offset=off)
        if job["set"] == "E":
            cres = P.analyze(clean_rec, cfg)
            out["by_cfg"][name] = summarize(job, rec, res, clean=cres)
        elif job["set"] == "G" and job.get("fault") != "clean":
            base = dict(job, fault="clean")
            crec = build(base)
            cres = P.analyze(crec, cfg)
            out["by_cfg"][name] = summarize(job, rec, res, clean=cres)
        elif job["set"] == "F":
            out["by_cfg"][name] = summarize_F(job, rec, res)
        else:
            out["by_cfg"][name] = summarize(job, rec, res)
    out["sec"] = time.time() - t0
    return out


def run_pool(tasks, procs=4, label=""):
    t0 = time.time()
    res = []
    with Pool(procs) as pool:
        for i, r in enumerate(pool.imap_unordered(run_job, tasks, chunksize=1)):
            res.append(r)
            if (i + 1) % 25 == 0 or i + 1 == len(tasks):
                print(f"  {label} {i + 1}/{len(tasks)}  {time.time() - t0:.0f}s", flush=True)
    res.sort(key=lambda r: (r["job"]["seed"], str(r["job"].get("fault", "")), str(r["job"].get("rep", "")),
                            r["job"].get("offset", 0), str(r["job"].get("transform", ""))))
    return res


# ------------------------------------------------------------------ fast-path tracker battery


def run_trackers():
    """Accuracy, null rate, delay and cost of F1..F5 on single-channel synthetic rhythms."""
    from .generators import make_tracker_signal
    out = {}
    hw = 1.0
    floors = {}
    for name, fn in C.TRACKERS.items():
        # amplitude floor: 90th percentile of the tracker's own amplitude on background alone (tuning seed)
        rng = np.random.default_rng(TUNE_BASE + 900)
        n = int(30 * G.FS)
        scale = G.background_scale_for_sd(1.5, 15.0)
        bg = G._shaped_noise(rng, n, lambda f: G.bg_psd(f, 1.5, scale))
        floors[name] = {}
        for fc in (6.0, 10.0, 20.0):
            _, a = fn(bg, fc, hw)
            floors[name][fc] = float(np.percentile(a[int(2 * G.FS / C.FRAME):], 90))
    for name, fn in C.TRACKERS.items():
        res = {"rms_err_hz": {}, "null_frac": {}, "bias_hz": {}}
        t_cost = 0.0
        n_samp = 0
        for fc in (6.0, 10.0, 20.0):
            for snr in (6, 10):
                errs, nulls, bias = [], [], []
                for i in range(8):
                    x, info = make_tracker_signal(TEST_BASE + 90_000 + i * 7 + int(fc) * 100 + snr, f0=fc,
                                                  snr_db=snr, bw=0.04 * fc, duration=30.0)
                    t0 = time.perf_counter()
                    fr, amp = fn(x, fc, hw)
                    t_cost += time.perf_counter() - t0
                    n_samp += x.size
                    fr = fr.copy()
                    fr[amp < floors[name][fc]] = np.nan
                    tt = info["traj"][C.FRAME - 1::C.FRAME][:fr.size]
                    sl = slice(int(3 * G.FS / C.FRAME), None)
                    e = fr[sl] - tt[sl]
                    nulls.append(float(np.isnan(e).mean()))
                    e = e[np.isfinite(e)]
                    if e.size:
                        errs.append(float(np.sqrt(np.mean(e ** 2))))
                        bias.append(float(np.mean(e)))
                key = f"{fc:g}Hz_{snr}dB"
                res["rms_err_hz"][key] = float(np.median(errs)) if errs else None
                res["null_frac"][key] = float(np.mean(nulls))
                res["bias_hz"][key] = float(np.median(bias)) if bias else None
        # delay: +0.5 Hz step at 15 s on a clean, narrow 10 Hz rhythm; mean over seeds; 50 % crossing
        outs = []
        for i in range(10):
            x, info = make_tracker_signal(TEST_BASE + 95_000 + i, f0=10.0, snr_db=25, bw=0.2, duration=25.0,
                                          step_at=15.0, step_hz=0.5)
            fr, amp = fn(x, 10.0, hw)
            outs.append(fr)
        m = np.nanmean(np.array(outs), axis=0)
        tfr = (np.arange(m.size) + 1) * C.FRAME / G.FS
        pre = np.nanmean(m[(tfr > 10) & (tfr < 15)])
        post = np.nanmean(m[(tfr > 20) & (tfr < 25)])
        half = pre + 0.5 * (post - pre)
        idx = np.flatnonzero((tfr >= 15) & (m >= half))
        res["step_delay_ms"] = float((tfr[idx[0]] - 15.0) * 1000) if idx.size else None
        res["step_measured_hz"] = float(post - pre)   # true step 0.5 Hz: the ratio is the step gain
        res["us_per_sample"] = 1e6 * t_cost / max(n_samp, 1)
        res["amp_floor_uv"] = floors[name]
        out[name] = res
    return out
