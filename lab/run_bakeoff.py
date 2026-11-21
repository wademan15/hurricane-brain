"""Run the bake-off (spec section 10) and write lab/out/bakeoff_results.json and lab/out/bakeoff_tables.md.

    python3 lab/run_bakeoff.py            # full battery (about 30-40 minutes on 4 cores)
    python3 lab/run_bakeoff.py --quick    # smoke test with a handful of files per set

Deterministic: every file is generated from a fixed seed; tuning seeds and test seeds never overlap.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hb_lab import battery as B  # noqa: E402
from hb_lab import candidates as C  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
RULES = B.RULES


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(max(0, c - h), 4), round(min(1, c + h), 4))


def frac(k, n):
    return {"k": int(k), "n": int(n), "rate": (round(k / n, 4) if n else None), "ci95": wilson(k, n)}


# ------------------------------------------------------------------ aggregation


def agg_A(rows, cfg):
    out = {}
    for snr in (3, 6, 10, 15):
        rs = [r["by_cfg"][cfg] | {"job": r["job"]} for r in rows if r["job"]["snr"] == snr]
        det_k = sum(sum(d >= 0.5 for d in r["det_rate"]) for r in rs)
        det_n = sum(len(r["det_rate"]) for r in rs)
        win_rate = float(np.mean([d for r in rs for d in r["det_rate"]])) if rs else None
        fin = [abs(c[2]) for r in rs for c in r["cal"] if c[1] == 90]
        within = sum(f <= 0.01 for f in fin)
        casc_ok = sum(r["casc_phi_final"] == r["job"]["n_members"] for r in rs)
        casc_late = float(np.mean([np.mean([L == r["job"]["n_members"] for L in r["casc_phi_late"]])
                                   for r in rs])) if rs else None
        false_mem = sum(r["casc_phi_false_members_all"] > 0 for r in rs)
        fpw = sum(r["false_peak_windows"] for r in rs)
        dpw = sum(r["dup_peak_windows"] for r in rs)
        nel = sum(r["n_elig"] for r in rs)
        z = [c[3] for r in rs for c in r["cal"] if c[3] is not None]
        by_n = {}
        for nm in (2, 3, 4, 5):
            rr = [r for r in rs if r["job"]["n_members"] == nm]
            by_n[nm] = frac(sum(r["casc_phi_final"] == nm for r in rr), len(rr))
        out[snr] = {
            "peaks_confirmed": frac(det_k, det_n),
            "mean_window_detection": round(win_rate, 4) if win_rate is not None else None,
            "int_freq_within_1pct": frac(within, len(fin)),
            "int_freq_rel_err_median": round(float(np.median(fin)), 5) if fin else None,
            "int_freq_rel_err_p95": round(float(np.percentile(fin, 95)), 5) if fin else None,
            "cascade_length_correct_final": frac(casc_ok, len(rs)),
            "cascade_length_correct_by_n": by_n,
            "cascade_length_correct_late_windows": round(casc_late, 4) if casc_late is not None else None,
            "files_with_false_cascade_member": frac(false_mem, len(rs)),
            "false_peak_window_rate": frac(fpw, nel),
            "duplicate_peak_window_rate": frac(dpw, nel),
            "z_sd": round(float(np.std(z)), 3) if len(z) > 2 else None,
            "z_within_1.96": frac(sum(abs(v) <= 1.96 for v in z), len(z)),
            "n_z": len(z),
            "phi_state_entered": {rule: frac(sum(r["states"]["phi"][rule]["entered"] for r in rs), len(rs))
                                  for rule in RULES},
        }
    z = [c[3] for r in rows for c in r["by_cfg"][cfg]["cal"] if c[3] is not None and r["job"]["snr"] >= 6]
    out["calibration_z_sd_6dB_up"] = round(float(np.std(z)), 3) if len(z) > 2 else None
    out["calibration_z_robust_sd_6dB_up"] = round(float(1.4826 * np.median(np.abs(z))), 3) if z else None
    out["calibration_n"] = len(z)
    # integrated-frequency error against the rhythm's own width (>= 10 dB, final window)
    wb = {}
    for lo, hi in ((0.25, 0.5), (0.5, 0.8), (0.8, 1.51)):
        e = [abs(c[2]) for r in rows if r["job"]["snr"] >= 10 for c in r["by_cfg"][cfg]["cal"]
             if c[1] == 90 and len(c) > 4 and lo <= c[4] < hi]
        wb[f"{lo}-{hi} Hz"] = {"n": len(e), "within_1pct": frac(sum(v <= 0.01 for v in e), len(e)),
                               "median": round(float(np.median(e)), 5) if e else None}
    out["int_err_by_width_10dB_up"] = wb
    return out


def agg_B(rows, cfg):
    curve = {}
    for ratio in B.B_RATIOS:
        rs = [r["by_cfg"][cfg] for r in rows if abs(r["job"]["ratio"] - ratio) < 1e-9 and not r["job"].get("octave_cascade")]
        curve[f"{ratio:.3f}"] = {
            "n": len(rs),
            "phi_frac": {rule: round(float(np.mean([r["states"]["phi"][rule]["frac"] for r in rs])), 4) for rule in RULES},
            "phi_entered": {rule: frac(sum(r["states"]["phi"][rule]["entered"] for r in rs), len(rs)) for rule in RULES},
            "oct_frac": {rule: round(float(np.mean([r["states"]["octave"][rule]["frac"] for r in rs])), 4) for rule in RULES},
            "oct_entered": {rule: frac(sum(r["states"]["octave"][rule]["entered"] for r in rs), len(rs)) for rule in RULES},
            "phi_casc3_any": frac(sum(r["casc_phi_max"] >= 3 for r in rs), len(rs)),
            "oct_casc3_any": frac(sum(r["casc_octave_max"] >= 3 for r in rs), len(rs)),
        }
    octs = [r["by_cfg"][cfg] for r in rows if abs(r["job"]["ratio"] - 2.0) < 1e-9]
    phis = [r["by_cfg"][cfg] for r in rows if abs(r["job"]["ratio"] - B.PHI) < 1e-9]
    lab = {
        "octave_files_labelled_golden": {rule: frac(sum(r["states"]["phi"][rule]["entered"] or r["casc_phi_max"] >= 3
                                                         for r in octs), len(octs)) for rule in RULES},
        "golden_files_labelled_octave": {rule: frac(sum(r["states"]["octave"][rule]["entered"] or r["casc_octave_max"] >= 3
                                                         for r in phis), len(phis)) for rule in RULES},
        "octave_files_marked_harmonic": frac(sum(r.get("windows_with_harmonic_mark", 0) > 0 for r in octs), len(octs)),
        "octave_windows_marked_harmonic": frac(sum(r.get("windows_with_harmonic_mark", 0) for r in octs),
                                               sum(r["n_win"] for r in octs)),
    }
    ratio_ok = {}
    for rule in RULES:
        base = curve[f"{B.PHI:.3f}"]["phi_frac"][rule]
        ratio_ok[rule] = {k: (round(curve[k]["phi_frac"][rule] / base, 4) if base > 0 else None)
                          for k in ("1.500", "1.550", "1.700", "1.800")}
    return {"curve": curve, "labels": lab, "control_over_phi_rate": ratio_ok}


C_NOPEAK = ("background_only", "white_noise", "headset_on_table", "surrogate_sample_shuffle")


def agg_C(rows, cfg):
    out = {}
    kinds = sorted(set(r["job"]["kind"] for r in rows))
    tot_min = 0.0
    tot_entries = {tk: {rule: 0 for rule in RULES} for tk in C.TARGETS}
    files_entry = {tk: {rule: 0 for rule in RULES} for tk in C.TARGETS}
    for k in kinds:
        rs = [r["by_cfg"][cfg] for r in rows if r["job"]["kind"] == k]
        nel = sum(r["n_elig"] for r in rs)
        if k in C_NOPEAK:
            pw = sum(r["any_peak_windows"] for r in rs)
        else:
            pw = sum(r["false_peak_windows"] for r in rs)
        minutes = sum(r["n_win"] for r in rs) / 60.0
        tot_min += minutes
        ent = {}
        for tk in C.TARGETS:
            ent[tk] = {}
            for rule in RULES:
                n_e = sum(r["states"][tk][rule]["n_entries"] for r in rs)
                f_e = sum(r["states"][tk][rule]["entered"] for r in rs)
                tot_entries[tk][rule] += n_e
                files_entry[tk][rule] += f_e
                ent[tk][rule] = {"entries": n_e, "files_with_entry": frac(f_e, len(rs)),
                                 "per_10min": round(10 * n_e / minutes, 3) if minutes else None}
        out[k] = {
            "n_files": len(rs),
            "minutes": round(minutes, 1),
            "peak_window_rate": frac(pw, nel),
            "null_window_frac": round(sum(r["null_win"] for r in rs) / max(1, sum(r["n_win"] for r in rs)), 4),
            "states": ent,
            "phi_casc_ge3_files": sum(r["casc_phi_max"] >= 3 for r in rs),
            "phi_casc_ge4_files": sum(r["casc_phi_max"] >= 4 for r in rs),
            "oct_casc_ge3_files": sum(r["casc_octave_max"] >= 3 for r in rs),
            "excessA_gt05_window_frac": round(float(np.mean([r["excessA_gt05_phi"] for r in rs])), 4),
            "chA_pct_ge99_window_frac": round(float(np.mean([r["chA_pct_ge99_frac_phi"] for r in rs])), 4),
            "final_chA_pct_phi": [r["chA_pct_phi"] for r in rs],
        }
    out["_total"] = {"minutes": round(tot_min, 1),
                     "per_10min": {tk: {rule: round(10 * tot_entries[tk][rule] / tot_min, 3) for rule in RULES}
                                   for tk in C.TARGETS},
                     "files_with_entry": {tk: {rule: frac(files_entry[tk][rule], len(rows)) for rule in RULES}
                                          for tk in C.TARGETS}}
    return out


def agg_D(rows, cfg):
    rs = [r["by_cfg"][cfg] for r in rows]
    out = {}
    for m in ("2", "3"):
        pw = sum(r["harm_pair_windows"][int(m)] if int(m) in r["harm_pair_windows"] else r["harm_pair_windows"].get(m, 0) for r in rs)
        mk = sum(r["harm_marked_windows"][int(m)] if int(m) in r["harm_marked_windows"] else r["harm_marked_windows"].get(m, 0) for r in rs)
        out[f"marked_x{m}"] = frac(mk, pw)
    for m in (2, 3):
        vals = [r["harm_marked_majority"][m] for r in rs if r["harm_marked_majority"][m] is not None]
        out[f"marked_majority_files_x{m}"] = frac(sum(vals), len(vals))
    out["octave_state_entered"] = {rule: frac(sum(r["states"]["octave"][rule]["entered"] for r in rs), len(rs)) for rule in RULES}
    out["octave_cascade_files"] = frac(sum(r["casc_octave_max"] >= 2 for r in rs), len(rs))
    out["c1.5_state_entered"] = {rule: frac(sum(r["states"]["c1.5"][rule]["entered"] for r in rs), len(rs)) for rule in RULES}
    out["phi_state_entered"] = {rule: frac(sum(r["states"]["phi"][rule]["entered"] for r in rs), len(rs)) for rule in RULES}
    out["harmonic_tracks_detected_files"] = frac(sum(1 for r in rs if (r["harm_pair_windows"].get(2, 0) or r["harm_pair_windows"].get("2", 0)) > 0), len(rs))
    return out


def agg_E(rows, cfg):
    out = {}
    for k in sorted(set(r["job"]["kind"] for r in rows)):
        rs = [r["by_cfg"][cfg] for r in rows if r["job"]["kind"] == k]
        st = {}
        for tk in C.TARGETS:
            st[tk] = {rule: sum(r["attrib_state_entries"][tk][rule] for r in rs) for rule in RULES}
        out[k] = {
            "n_files": len(rs),
            "attrib_peak_windows": sum(r["attrib_peak_windows"] for r in rs),
            "files_with_attrib_peak": sum(r["attrib_peak_windows"] > 0 for r in rs),
            "attrib_state_entries": st,
            "attrib_cascades": sum(r["attrib_casc"]["phi"] + r["attrib_casc"]["octave"] for r in rs),
            "recovery_3s": frac(sum(r["recovery"][0] for r in rs), sum(r["recovery"][1] for r in rs)),
            "gate_sensitivity": round(float(np.mean([r["gate_sens"] for r in rs if r["gate_sens"] is not None])), 4)
            if any(r["gate_sens"] is not None for r in rs) else None,
            "gate_false_flag": round(float(np.mean([r["gate_false"] for r in rs if r["gate_false"] is not None])), 4),
            "null_frac": round(float(np.mean([r["null_frac"] for r in rs])), 4),
            "mains_detected": [r["mains"] for r in rs],
        }
    tot = {"attrib_peak_windows": sum(v["attrib_peak_windows"] for v in out.values()),
           "files_with_attrib_peak": sum(v["files_with_attrib_peak"] for v in out.values()),
           "attrib_cascades": sum(v["attrib_cascades"] for v in out.values()),
           "attrib_state_entries": {rule: sum(v["attrib_state_entries"][tk][rule] for v in out.values() for tk in C.TARGETS)
                                    for rule in RULES},
           "recovery_3s": frac(sum(v["recovery_3s"]["k"] for v in out.values()), sum(v["recovery_3s"]["n"] for v in out.values()))}
    out["_total"] = tot
    return out


def agg_F(rows, cfg):
    out = {}
    fd = [r["by_cfg"][cfg] for r in rows if r["job"]["kind"] == "form_dissolve"]
    d = {}
    for rule in RULES:
        ent = [v for r in fd for v in r["form_dissolve"][rule]["entry_delay"]]
        ext = [v for r in fd for v in r["form_dissolve"][rule]["exit_delay"]]
        d[rule] = {"entry_delays": ent, "exit_delays": ext,
                   "entry_median_s": float(np.median([v for v in ent if v is not None])) if any(v is not None for v in ent) else None,
                   "exit_median_s": float(np.median([v for v in ext if v is not None])) if any(v is not None for v in ext) else None,
                   "missed_formations": sum(v is None for v in ent),
                   "on_outside_schedule_windows": sum(r["form_dissolve"][rule]["on_outside_windows"] for r in fd)}
    cd = [v for r in fd for v in r["form_dissolve"]["casc3_delay"]]
    d["cascade3_formation_delays"] = cd
    out["form_dissolve"] = d
    st = {}
    for tr in ("none", "phase_randomize", "block_shuffle"):
        rs = [r["by_cfg"][cfg] for r in rows if r["job"]["kind"] == "steady_long" and r["job"]["transform"] == tr]
        st[tr] = {"phi_state_frac": {rule: round(float(np.mean([r["steady_frac"][rule] for r in rs])), 4) for rule in RULES},
                  "chB_pct_final": [r["chB_pct_phi"] for r in rs], "chB_exp_final": [r["chB_exp_phi"] for r in rs],
                  "c_final": [r["c_phi"] for r in rs], "chA_pct_final": [r["chA_pct_phi"] for r in rs]}
    out["steady_long"] = st
    for k in ("drift_band_edge", "close_double", "split", "crossing", "short_bursts"):
        rs = [r["by_cfg"][cfg] for r in rows if r["job"]["kind"] == k]
        out[k] = {"all_present_frac": round(float(np.mean([r["all_present_frac"] for r in rs])), 4),
                  "window_err_median_hz": round(float(np.median([r["win_err_median"] for r in rs if r["win_err_median"] is not None])), 4)
                  if any(r["win_err_median"] is not None for r in rs) else None,
                  "track_births_mean": round(float(np.mean([r["track_births"] for r in rs])), 2),
                  "merges_mean": round(float(np.mean([r["merges"] for r in rs])), 2),
                  "false_peak_windows": sum(r["false_peak_windows"] for r in rs)}
    return out


def agg_G(rows, cfg):
    out = {}
    for fault in ("loss0.1", "loss1", "burst1", "loss5", "clock0.5"):
        rs = [r for r in rows if r["job"].get("fault") == fault]
        rr = [r["by_cfg"][cfg] for r in rs]
        within = [abs(d[0]) <= 2 * np.hypot(d[1], d[2]) for r in rr for d in r["vs_clean"]]
        out[fault] = {
            "null_frac": round(float(np.mean([r["null_frac"] for r in rr])), 4),
            "tracks_within_2se_of_clean": frac(sum(within), len(within)),
            "false_peak_windows": sum(r["false_peak_windows"] for r in rr),
            "attrib_peak_windows": sum(r["attrib_peak_windows"] for r in rr),
            "phi_entered_T4": frac(sum(r["states"]["phi"]["T4"]["entered"] for r in rr), len(rr)),
            "phi_entered_T1": frac(sum(r["states"]["phi"]["T1"]["entered"] for r in rr), len(rr)),
        }
        if fault == "clock0.5":
            fin = [abs(c[2]) for r in rr for c in r["cal"] if c[1] == 90]
            out[fault]["int_freq_within_1pct_of_scaled_truth"] = frac(sum(f <= 0.01 for f in fin), len(fin))
    clean = [r["by_cfg"][cfg] for r in rows if r["job"].get("fault") == "clean"]
    out["clean"] = {"phi_entered_T4": frac(sum(r["states"]["phi"]["T4"]["entered"] for r in clean), len(clean)),
                    "phi_entered_T1": frac(sum(r["states"]["phi"]["T1"]["entered"] for r in clean), len(clean))}
    return out


def agg_H(rows, cfg):
    out = {"identical_on_repeat": [], "offset": []}
    seeds = sorted(set(r["job"]["seed"] for r in rows))
    for s in seeds:
        a = [r for r in rows if r["job"]["seed"] == s and r["job"]["rep"] == "a"][0]["by_cfg"][cfg]
        b = [r for r in rows if r["job"]["seed"] == s and r["job"]["rep"] == "b"][0]["by_cfg"][cfg]
        out["identical_on_repeat"].append(a["digest"] == b["digest"])
        for r in [r for r in rows if r["job"]["seed"] == s and r["job"]["rep"] == "off"]:
            o = r["by_cfg"][cfg]
            for k, (f, se, tf) in a["final_tracks"].items():
                if k in o["final_tracks"]:
                    f2, se2, _ = o["final_tracks"][k]
                    out["offset"].append({"offset_samples": r["job"]["offset"], "diff_hz": round(f2 - f, 4),
                                          "se_hz": round(float(np.hypot(se, se2)), 4),
                                          "within": bool(abs(f2 - f) <= np.hypot(se, se2))})
    out["offset_within_se"] = frac(sum(o["within"] for o in out["offset"]), len(out["offset"]))
    return out


AGG = {"A": agg_A, "B": agg_B, "C": agg_C, "D": agg_D, "E": agg_E, "F": agg_F, "G": agg_G, "H": agg_H}


# ------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--procs", type=int, default=4)
    ap.add_argument("--configs", default=",".join(B.STAGE_CONFIGS))
    ap.add_argument("--sets", default="A,B,C,D,E,F,G,H")
    ap.add_argument("--fgh-configs", default="S1-P1,S1-P1-excess")
    ap.add_argument("--no-broken", action="store_true")
    ap.add_argument("--no-trackers", action="store_true")
    ap.add_argument("--out", default=os.path.join(OUT, "bakeoff_results.json"))
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    cfgs = a.configs.split(",")
    sets = a.sets.split(",")
    t0 = time.time()
    results = {"meta": {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "quick": a.quick, "params": {
        k: (v if not isinstance(v, dict) else {kk: float(vv) for kk, vv in v.items()}) for k, v in C.PARAMS.items()}}}
    q = a.quick
    # ---- 1. tuning thresholds on tuning seeds only
    tune_jobs = B.jobs_tuning(6 if q else 48)
    # one representative configuration per spectrum/confirmation pair (the threshold depends on nothing else)
    rep = {}
    for n in cfgs:
        if n in B.STAGE_CONFIGS and B.STAGE_CONFIGS[n].get("thr_mode") != "analytic":
            rep.setdefault(f'{B.STAGE_CONFIGS[n]["spectrum"]}/{B.STAGE_CONFIGS[n]["confirm"]}', n)
    tune_cfgs = sorted(rep.values())
    print("tuning thresholds:", tune_cfgs, flush=True)
    tr = B.run_pool([(j, tune_cfgs, {}) for j in tune_jobs], a.procs, "tune")
    thresholds = {}
    tune_info = {}
    for n in tune_cfgs:
        st = np.concatenate([np.asarray(r["by_cfg"][n]["stats"], float) for r in tr])
        key = f'{B.STAGE_CONFIGS[n]["spectrum"]}/{B.STAGE_CONFIGS[n]["confirm"]}'
        thresholds[key] = float(np.quantile(st, 1 - C.PARAMS["alpha_peak"]))
        tune_info[key] = {"threshold": thresholds[key], "n_windows": int(st.size), "n_files": len(tr),
                          "median_stat": float(np.median(st)),
                          "meaning": ("factor on the analytic chi-squared threshold" if key.endswith("/P1")
                                      else "absolute threshold on the confirmation statistic")}
    # analytic P1 threshold for comparison (dof of a fully clean 4-channel S1 window)
    tune_info["S1/P1 analytic (dof 56)"] = {"threshold": C.p1_threshold(56.0, 1.0)}
    results["tuning"] = tune_info
    print("thresholds", thresholds, flush=True)
    # ---- 2. battery
    builders = {"A": lambda: B.jobs_A(1 if q else 6), "B": lambda: B.jobs_B(1 if q else 8, 2 if q else 12),
                "C": lambda: B.jobs_C()[::10] if q else B.jobs_C(), "D": lambda: B.jobs_D(3 if q else 24),
                "E": lambda: B.jobs_E(1), "F": lambda: B.jobs_F(1)[::3] if q else B.jobs_F(4),
                "G": lambda: B.jobs_G(1 if q else 8), "H": lambda: B.jobs_H(1 if q else 4)}
    if q:
        builders["E"] = lambda: B.jobs_E(1)[::3]
    else:
        builders["E"] = lambda: B.jobs_E(4)
    fgh = a.fgh_configs.split(",")
    broken = {} if a.no_broken else B.BROKEN
    results["sets"] = {}
    results["files"] = {}
    for sname in sets:
        jobs = builders[sname]()
        names = fgh if sname in ("F", "G", "H") else list(cfgs)
        names += [b for b, (_, tset) in broken.items() if tset == sname]
        if sname == "C" and not a.no_broken:
            names = names  # broken C builds run on the whole of C
        print(f"set {sname}: {len(jobs)} files x {len(names)} configs", flush=True)
        rows = B.run_pool([(j, names, thresholds) for j in jobs], a.procs, sname)
        results["sets"][sname] = {"n_files": len(jobs), "configs": {}}
        for n in names:
            try:
                results["sets"][sname]["configs"][n] = AGG[sname](rows, n)
            except Exception as e:  # report, do not hide
                results["sets"][sname]["configs"][n] = {"error": repr(e)}
                print("aggregation error", sname, n, repr(e), flush=True)
        results["files"][sname] = [{"job": r["job"], "sec": round(r["sec"], 2),
                                    "by_cfg": {n: {k: v for k, v in r["by_cfg"][n].items() if k not in ("casc_phi_late", "casc_octave_late")}
                                               for n in names}} for r in rows]
        with open(a.out, "w") as fh:
            json.dump(results, fh, default=_js)
    # ---- 3. fast-path trackers
    if not a.no_trackers:
        print("trackers", flush=True)
        results["trackers"] = B.run_trackers()
    results["meta"]["seconds"] = round(time.time() - t0, 1)
    with open(a.out, "w") as fh:
        json.dump(results, fh, default=_js)
    print(f"done in {time.time() - t0:.0f}s -> {a.out}", flush=True)


def _js(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


if __name__ == "__main__":
    main()
