"""Turn lab/out/bakeoff_results.json into markdown tables (lab/out/bakeoff_tables.md).

Every number in docs/spec/bakeoff-report.md's tables is produced here, not typed by hand.

    python3 lab/report_tables.py [results.json] [out.md]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = ("T1", "T2", "T3", "T4", "T4c")


def pct(x, d=1):
    if x is None:
        return "n/a"
    return f"{100 * x:.{d}f}%"


def fr(f, d=1):
    """k/n (rate)"""
    if not f or f.get("n", 0) == 0:
        return "n/a"
    return f"{pct(f['rate'], d)} ({f['k']}/{f['n']})"


def num(x, d=3):
    return "n/a" if x is None else f"{x:.{d}f}"


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "| " + " | ".join("---" for _ in head) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def pooled(a, snrs, key):
    k = sum(a[str(s)][key]["k"] for s in snrs)
    n = sum(a[str(s)][key]["n"] for s in snrs)
    return {"k": k, "n": n, "rate": (k / n if n else None)}


def stage_rows(R, cfgs):
    S = R["sets"]
    rows = []
    for c in cfgs:
        A = S["A"]["configs"].get(c)
        Cc = S["C"]["configs"].get(c)
        D = S["D"]["configs"].get(c)
        E = S["E"]["configs"].get(c)
        if not A or "error" in A:
            continue
        nopeak = [k for k in ("background_only", "white_noise", "headset_on_table", "surrogate_sample_shuffle") if k in Cc]
        k = sum(Cc[x]["peak_window_rate"]["k"] for x in nopeak)
        n = sum(Cc[x]["peak_window_rate"]["n"] for x in nopeak)
        bo = Cc["background_only"]["peak_window_rate"]
        rnd = [x for x in ("random_loguniform", "random_bands") if x in Cc]
        rk = sum(Cc[x]["peak_window_rate"]["k"] for x in rnd)
        rn = sum(Cc[x]["peak_window_rate"]["n"] for x in rnd)
        casc4 = sum(v["phi_casc_ge4_files"] for kk, v in Cc.items() if kk != "_total")
        casc3 = sum(v["phi_casc_ge3_files"] for kk, v in Cc.items() if kk != "_total")
        rows.append([c,
                     fr(A["6"]["peaks_confirmed"]),
                     fr(pooled(A, (10, 15), "peaks_confirmed")),
                     fr(A["3"]["peaks_confirmed"]),
                     fr(pooled(A, (10, 15), "cascade_length_correct_final")),
                     fr(A["6"]["files_with_false_cascade_member"]),
                     fr(pooled(A, (6, 10, 15), "false_peak_window_rate"), 2),
                     fr(pooled(A, (6, 10, 15), "duplicate_peak_window_rate"), 2) if "duplicate_peak_window_rate" in A["6"] else "n/a",
                     fr({"k": k, "n": n, "rate": k / n if n else None}, 2),
                     fr(bo, 2),
                     fr({"k": rk, "n": rn, "rate": rk / rn if rn else None}, 2),
                     f"{casc3} / {casc4}",
                     fr(D["marked_x2"]), fr(D["marked_x3"]),
                     fr(D["octave_state_entered"]["T4"]),
                     E["_total"]["attrib_peak_windows"], E["_total"]["files_with_attrib_peak"],
                     E["_total"]["attrib_state_entries"]["T4"], E["_total"]["attrib_cascades"],
                     fr(E["_total"]["recovery_3s"])])
    head = ["config", "A 6 dB peaks confirmed", "A >=10 dB peaks confirmed", "A 3 dB peaks confirmed",
            "A >=10 dB cascade length right", "A 6 dB files with false cascade member",
            "A >=6 dB windows with an unmatched peak", "A >=6 dB windows with a duplicate peak",
            "C no-rhythm files: windows with any peak", "C background-only: windows with any peak",
            "C random-peak files: windows with an unmatched peak", "C files with golden cascade >=3 / >=4 members",
            "D 2x marked harmonic (windows)", "D 3x marked harmonic (windows)", "D octave state entered (T4)",
            "E attributable peak windows", "E files with attributable peak", "E attributable state entries (T4)",
            "E attributable cascades", "E recovery within 3 s"]
    return head, rows


def freq_rows(R, cfgs):
    S = R["sets"]
    rows = []
    for c in cfgs:
        A = S["A"]["configs"].get(c)
        if not A or "error" in A:
            continue
        rows.append([c,
                     fr(pooled(A, (10, 15), "int_freq_within_1pct")),
                     num(A["10"]["int_freq_rel_err_median"], 4), num(A["10"]["int_freq_rel_err_p95"], 4),
                     num(A["6"]["int_freq_rel_err_median"], 4),
                     num(A["calibration_z_sd_6dB_up"], 2), num(A["calibration_z_robust_sd_6dB_up"], 2),
                     fr(pooled(A, (6, 10, 15), "z_within_1.96")), A["calibration_n"]])
    head = ["config", "A >=10 dB integrated freq within 1%", "A 10 dB median rel. error", "A 10 dB 95th pct rel. error",
            "A 6 dB median rel. error", "z sd (>=6 dB)", "z robust sd", "|z| <= 1.96", "n z"]
    return head, rows


def tuning_curve(R, cfg, key="phi_frac"):
    B = R["sets"]["B"]["configs"][cfg]
    rows = []
    for ratio, v in B["curve"].items():
        rows.append([ratio, v["n"]] + [pct(v[key][r]) for r in RULES] + [fr(v["phi_entered"]["T4"]), fr(v["oct_entered"]["T4"])])
    head = ["true step ratio", "files"] + [f"time in golden state {r}" for r in RULES] + ["golden entered T4", "octave entered T4"]
    return head, rows


def control_rows(R, cfgs):
    rows = []
    for c in cfgs:
        B = R["sets"]["B"]["configs"].get(c)
        if not B or "error" in B:
            continue
        for rule in RULES:
            co = B["control_over_phi_rate"][rule]
            rows.append([c, rule] + [num(co[k], 3) for k in ("1.500", "1.550", "1.700", "1.800")] +
                        [fr(B["labels"]["octave_files_labelled_golden"][rule]),
                         fr(B["labels"]["golden_files_labelled_octave"][rule])])
    head = ["config", "rule", "rate(1.5)/rate(phi)", "rate(1.55)/rate(phi)", "rate(1.7)/rate(phi)",
            "rate(1.8)/rate(phi)", "octave files labelled golden", "golden files labelled octave"]
    return head, rows


def c_rules(R, cfg):
    Cc = R["sets"]["C"]["configs"][cfg]
    rows = []
    for k, v in Cc.items():
        if k == "_total":
            continue
        rows.append([k, v["n_files"], v["minutes"]] + [f'{v["states"]["phi"][r]["per_10min"]:.2f} ({fr(v["states"]["phi"][r]["files_with_entry"])})' for r in RULES]
                    + [f'{v["states"]["octave"]["T4"]["per_10min"]:.2f}', v["phi_casc_ge3_files"], pct(v["excessA_gt05_window_frac"]),
                       pct(v["chA_pct_ge99_window_frac"])])
    t = Cc["_total"]
    rows.append(["ALL", "", t["minutes"]] + [f'{t["per_10min"]["phi"][r]:.2f} ({fr(t["files_with_entry"]["phi"][r])})' for r in RULES]
                + [f'{t["per_10min"]["octave"]["T4"]:.2f}', "", "", ""])
    head = ["C file kind", "files", "minutes"] + [f"golden entries per 10 min {r} (files with entry)" for r in RULES] + \
           ["octave entries per 10 min T4", "files with golden cascade >=3", "windows with excess alignment > 0.5",
            "windows at chance-A percentile >= 99%"]
    return head, rows


def a_rule_rows(R, cfg):
    A = R["sets"]["A"]["configs"][cfg]
    rows = []
    for snr in ("3", "6", "10", "15"):
        rows.append([snr + " dB"] + [fr(A[snr]["phi_state_entered"][r]) for r in RULES])
    return ["A SNR"] + [f"golden state entered {r}" for r in RULES], rows


def e_rows(R, cfg):
    E = R["sets"]["E"]["configs"][cfg]
    rows = []
    for k, v in E.items():
        if k == "_total":
            continue
        ent = v["attrib_state_entries"]
        rows.append([k, v["n_files"], v["attrib_peak_windows"], v["files_with_attrib_peak"],
                     " ".join(f'{r}:{sum(ent[tk][r] for tk in ent)}' for r in RULES), v["attrib_cascades"],
                     fr(v["recovery_3s"]), pct(v["gate_sensitivity"]), pct(v["gate_false_flag"], 2), pct(v["null_frac"]),
                     ",".join(str(m) for m in sorted(set(map(str, v["mains_detected"]))))])
    head = ["artifact", "files", "attributable peak windows", "files with one", "attributable state entries (all targets)",
            "attributable cascades", "recovery within 3 s", "gating sensitivity", "clean samples gated", "null windows",
            "mains detected"]
    return head, rows


def f_rows(R, cfg):
    F = R["sets"]["F"]["configs"][cfg]
    fd = F["form_dissolve"]
    rows = []
    for r in RULES:
        d = fd[r]
        rows.append([r, num(d["entry_median_s"], 1), ", ".join("miss" if v is None else f"{v:.0f}" for v in d["entry_delays"]),
                     num(d["exit_median_s"], 1), d["missed_formations"], d["on_outside_schedule_windows"]])
    t1 = table(["rule", "median entry delay (s)", "entry delays (s)", "median exit delay (s)", "missed formations",
                "windows in state outside schedule"], rows)
    cd = fd["cascade3_formation_delays"]
    t1 += "\n\nCascade of 3 formation delays (s): " + ", ".join("miss" if v is None else f"{v:.0f}" for v in cd)
    rows = []
    for k in ("drift_band_edge", "close_double", "split", "crossing", "short_bursts"):
        v = F[k]
        rows.append([k, pct(v["all_present_frac"]), num(v["window_err_median_hz"], 3), v["track_births_mean"], v["merges_mean"],
                     v["false_peak_windows"]])
    t2 = table(["case", "windows with every planted peak confirmed", "median window frequency error (Hz)",
                "tracks born per file", "merges per file", "windows with unmatched peak"], rows)
    rows = []
    for tr, v in F["steady_long"].items():
        rows.append([tr] + [pct(v["phi_state_frac"][r]) for r in RULES] +
                    [", ".join(num(x, 2) for x in v["chA_pct_final"]), ", ".join(num(x, 2) for x in v["chB_pct_final"])])
    t3 = table(["180 s steady golden cascade, transform", ] + [f"time in golden state {r}" for r in RULES] +
               ["chance A percentile at end", "chance B percentile at end"], rows)
    return t1, t2, t3


def g_rows(R, cfg):
    G = R["sets"]["G"]["configs"][cfg]
    rows = []
    for k in ("loss0.1", "loss1", "burst1", "loss5", "clock0.5"):
        v = G[k]
        rows.append([k, pct(v["null_frac"]), fr(v["tracks_within_2se_of_clean"]), v["false_peak_windows"],
                     v["attrib_peak_windows"], fr(v["phi_entered_T4"]), fr(v["phi_entered_T1"]),
                     fr(v.get("int_freq_within_1pct_of_scaled_truth")) if "int_freq_within_1pct_of_scaled_truth" in v else ""])
    rows.append(["clean", "", "", "", "", fr(G["clean"]["phi_entered_T4"]), fr(G["clean"]["phi_entered_T1"]), ""])
    return ["fault", "null windows", "tracks within 2 SE of clean run", "unmatched-peak windows",
            "peak windows not in clean run", "golden entered T4", "golden entered T1",
            "integrated freq within 1% of scaled truth"], rows


def h_text(R, cfg):
    H = R["sets"]["H"]["configs"][cfg]
    rep = H["identical_on_repeat"]
    off = H["offset"]
    return (f"Identical output on repeat: {sum(rep)}/{len(rep)} files. Offset start (64, 137, 200 samples): "
            f"integrated frequency differences within the combined reported SE in {fr(H['offset_within_se'])}; "
            f"largest |difference| {max(abs(o['diff_hz']) for o in off):.3f} Hz" if off else "no offset data")


def tracker_rows(R):
    T = R.get("trackers", {})
    rows = []
    for k, v in T.items():
        rows.append([k, num(v["rms_err_hz"]["10Hz_10dB"], 3), num(v["rms_err_hz"]["10Hz_6dB"], 3), num(v["rms_err_hz"]["20Hz_10dB"], 3),
                     num(v["rms_err_hz"]["6Hz_10dB"], 3), num(v["bias_hz"]["10Hz_6dB"], 3), pct(v["null_frac"]["10Hz_10dB"]),
                     num(v["step_delay_ms"], 0), num(v["step_measured_hz"] / 0.5, 2), num(v["us_per_sample"], 2)])
    return ["tracker", "RMS error 10 Hz 10 dB (Hz)", "10 Hz 6 dB", "20 Hz 10 dB", "6 Hz 10 dB", "bias 10 Hz 6 dB (Hz)",
            "null frames 10 Hz 10 dB", "50% step delay (ms)", "step gain", "cost (us/sample, Python)"], rows


def broken_rows(R):
    S = R["sets"]
    rows = []
    def cbg(c):
        v = S["C"]["configs"].get(c, {})
        if not v or "error" in v:
            return "n/a"
        k = sum(v[x]["peak_window_rate"]["k"] for x in ("background_only", "white_noise", "surrogate_sample_shuffle", "headset_on_table") if x in v)
        n = sum(v[x]["peak_window_rate"]["n"] for x in ("background_only", "white_noise", "surrogate_sample_shuffle", "headset_on_table") if x in v)
        return fr({"k": k, "n": n, "rate": k / n if n else None}, 2)
    rows.append(["broken-no-multibin (per-bin chi-squared threshold)", "C windows with a peak, no-rhythm files",
                 cbg("broken-no-multibin"), cbg("S1-P1-analytic"), cbg("S1-P1")])
    rows.append(["broken-no-logbias (log-fit bias not corrected)", "C windows with a peak, no-rhythm files",
                 cbg("broken-no-logbias"), cbg("S1-P1-analytic"), cbg("S1-P1")])
    A = S["A"]["configs"]
    if "broken-se-jackknife-only" in A:
        rows.append(["broken-se-jackknife-only (no overlap or scatter correction)", "A calibration z sd (pass 0.67-1.5)",
                     num(A["broken-se-jackknife-only"]["calibration_z_sd_6dB_up"], 2), "", num(A["S1-P1"]["calibration_z_sd_6dB_up"], 2)])
    E = S["E"]["configs"]
    if "broken-no-gating" in E:
        rows.append(["broken-no-gating", "E attributable peak windows / state entries T1",
                     f'{E["broken-no-gating"]["_total"]["attrib_peak_windows"]} / {E["broken-no-gating"]["_total"]["attrib_state_entries"]["T1"]}',
                     "", f'{E["S1-P1"]["_total"]["attrib_peak_windows"]} / {E["S1-P1"]["_total"]["attrib_state_entries"]["T1"]}'])
    D = S["D"]["configs"]
    if "broken-no-harmonic-test" in D:
        rows.append(["broken-no-harmonic-test", "D octave state entered T1 / T4",
                     f'{fr(D["broken-no-harmonic-test"]["octave_state_entered"]["T1"])} / {fr(D["broken-no-harmonic-test"]["octave_state_entered"]["T4"])}',
                     "", f'{fr(D["S1-P1"]["octave_state_entered"]["T1"])} / {fr(D["S1-P1"]["octave_state_entered"]["T4"])}'])
    B = S["B"]["configs"]
    if "broken-t2-uncapped" in B:
        b, d = B["broken-t2-uncapped"]["curve"], B["S1-P1"]["curve"]
        rows.append(["broken-t2-uncapped", "B time in golden state T2 at 1.55 / 1.618 / 1.7",
                     " / ".join(pct(b[k]["phi_frac"]["T2"]) for k in ("1.550", "1.618", "1.700")), "",
                     " / ".join(pct(d[k]["phi_frac"]["T2"]) for k in ("1.550", "1.618", "1.700"))])
    Cc = S["C"]["configs"]
    if "broken-chance-single-pair" in Cc:
        bb, dd = Cc["broken-chance-single-pair"], Cc["S1-P1"]
        rows.append(["broken-chance-single-pair (chance not computed for the search performed)",
                     "C random log-uniform: golden entries T4 per 10 min (files) / windows at chance pct >= 99%",
                     f'{bb["random_loguniform"]["states"]["phi"]["T4"]["per_10min"]:.2f} ({fr(bb["random_loguniform"]["states"]["phi"]["T4"]["files_with_entry"])}) / {pct(bb["random_loguniform"]["chA_pct_ge99_window_frac"])}',
                     "", f'{dd["random_loguniform"]["states"]["phi"]["T4"]["per_10min"]:.2f} ({fr(dd["random_loguniform"]["states"]["phi"]["T4"]["files_with_entry"])}) / {pct(dd["random_loguniform"]["chA_pct_ge99_window_frac"])}'])
    return ["deliberately broken build", "test that should catch it", "broken", "analytic S1-P1", "default S1-P1"], rows


def passmarks(R, cfg, rule="T1", fghcfg=None):
    """Spec 10.3 pass marks for one configuration and one aligned-state rule."""
    S = R["sets"]
    A, B, Cc, D, E = (S[k]["configs"].get(cfg) for k in "ABCDE")
    rows = []

    def mark(test, req, meas, ok):
        rows.append([test, req, meas, "met" if ok else ("MISSED" if ok is not None else "not measured")])

    p = pooled(A, (10, 15), "peaks_confirmed")
    mark("A >=10 dB", "every planted peak confirmed in >= 95% of files", fr(p), p["rate"] >= 0.95)
    p = pooled(A, (10, 15), "int_freq_within_1pct")
    mark("A >=10 dB", "integrated frequency within 1% of truth", fr(p) + " of matched tracks", p["rate"] >= 0.95)
    p = pooled(A, (10, 15), "cascade_length_correct_final")
    mark("A >=10 dB", "correct cascade length in >= 90%", fr(p), p["rate"] >= 0.90)
    p = A["6"]["peaks_confirmed"]
    mark("A 6 dB", ">= 80% of planted peaks confirmed", fr(p), p["rate"] >= 0.80)
    p = A["6"]["files_with_false_cascade_member"]
    mark("A 6 dB", "no false cascade members", fr(p) + " files with one", p["k"] == 0)
    p = A["3"]["files_with_false_cascade_member"]
    mark("A 3 dB", "silence acceptable, wrong answer not", fr(p) + " files with a false cascade member", p["k"] == 0)
    lab = B["labels"]
    o, g = lab["octave_files_labelled_golden"][rule], lab["golden_files_labelled_octave"][rule]
    mark("B", "octave cascades labelled golden in < 1% of files", f"{fr(o)}, 95% CI upper {pct(o['ci95'][1])}",
         o["k"] == 0 and (o["ci95"][1] or 1) < 0.01 if o["n"] else None)
    mark("B", "golden cascades labelled octave in < 1% of files", f"{fr(g)}, 95% CI upper {pct(g['ci95'][1])}",
         g["k"] == 0 and (g["ci95"][1] or 1) < 0.01 if g["n"] else None)
    co = B["control_over_phi_rate"][rule]
    mark("B", "aligned-state rate at 1.5 and 1.8 under 10% of the rate at 1.618",
         f"1.5: {num(co['1.500'], 3)}, 1.8: {num(co['1.800'], 3)}",
         co["1.500"] is not None and co["1.500"] < 0.1 and co["1.800"] < 0.1)
    nopeak = [k for k in ("background_only", "white_noise", "headset_on_table", "surrogate_sample_shuffle") if k in Cc]
    k = sum(Cc[x]["peak_window_rate"]["k"] for x in nopeak)
    n = sum(Cc[x]["peak_window_rate"]["n"] for x in nopeak)
    mark("C", "confirmed peaks in no-rhythm noise at or under alpha_peak = 1% of windows",
         fr({"k": k, "n": n, "rate": k / n}, 2), k / n <= 0.01)
    # spectrum-preserving surrogates (block shuffle with blocks longer than a cycle, phase randomization,
    # channel shift) SHOULD keep the source's peaks and ratios, so they are not counted as false entries
    keep = [k for k in ("background_only", "white_noise", "headset_on_table", "surrogate_sample_shuffle",
                        "random_loguniform", "random_bands") if k in Cc]
    mins = sum(Cc[k]["minutes"] for k in keep)
    rate = sum(Cc[k]["states"]["phi"][rule]["per_10min"] * Cc[k]["minutes"] for k in keep) / mins
    nf = sum(Cc[k]["states"]["phi"][rule]["files_with_entry"]["k"] for k in keep)
    nn = sum(Cc[k]["states"]["phi"][rule]["files_with_entry"]["n"] for k in keep)
    mark("C", "aligned state entered at or under 1 false entry per 10 min (C files without spectrum-preserving surrogates)",
         f'{rate:.2f} per 10 min over {mins:.0f} min; files with an entry {nf}/{nn}', rate <= 1.0)
    c4 = sum(Cc[k]["phi_casc_ge4_files"] for k in keep)
    c3 = sum(Cc[k]["phi_casc_ge3_files"] for k in keep)
    mark("C", "golden cascades of 3 or more steps (4 members): none", f"{c4} files", c4 == 0)
    mark("C", "hurricane structure (golden cascade of 3 members, two arms or more): none", f"{c3} files", c3 == 0)
    mark("D", ">= 95% of harmonics marked harmonic (2x)", fr(D["marked_x2"]), D["marked_x2"]["rate"] >= 0.95)
    mark("D", ">= 95% of harmonics marked harmonic (3x)", fr(D["marked_x3"]), D["marked_x3"]["rate"] >= 0.95)
    oc = D["octave_state_entered"][rule]
    mark("D", "no octave alignment credited", f"octave state entered in {fr(oc)}; octave pair or cascade at any time in {fr(D['octave_cascade_files'])}",
         oc["k"] == 0 and D["octave_cascade_files"]["k"] == 0)
    et = E["_total"]
    mark("E", "no confirmed peak attributable to an artifact", f'{et["attrib_peak_windows"]} windows in {et["files_with_attrib_peak"]} files',
         et["attrib_peak_windows"] == 0)
    mark("E", "no aligned state or cascade attributable to an artifact",
         f'state entries {et["attrib_state_entries"][rule]}, cascades {et["attrib_cascades"]}',
         et["attrib_state_entries"][rule] == 0 and et["attrib_cascades"] == 0)
    mark("E", "recovery within 3 s of the artifact ending", fr(et["recovery_3s"]), et["recovery_3s"]["rate"] == 1.0)
    z = A["calibration_z_sd_6dB_up"]
    mark("Calibration", "reported SEs match the spread of errors within a factor 1.5", f"sd of error/SE = {num(z, 2)}",
         z is not None and 1 / 1.5 <= z <= 1.5)
    fc = fghcfg or cfg
    if fc in S.get("F", {}).get("configs", {}):
        fd = S["F"]["configs"][fc]["form_dissolve"][rule]
        mark("F", "cascade schedule recovered, median delay under 20 s",
             f'median entry delay {num(fd["entry_median_s"], 1)} s, exit {num(fd["exit_median_s"], 1)} s, missed {fd["missed_formations"]}',
             fd["entry_median_s"] is not None and fd["entry_median_s"] < 20)
    if fc not in S.get("G", {}).get("configs", {}):
        fc = fc.replace("-band", "")  # chance placement does not change the G and H measures used here
    if fc in S.get("G", {}).get("configs", {}):
        G = S["G"]["configs"][fc]
        w1 = G["loss1"]["tracks_within_2se_of_clean"]
        mark("G", "up to 1% loss: results within the uncertainty of the clean run", f"{fr(w1)} tracks within 2 SE",
             w1["rate"] is not None and w1["rate"] >= 0.95)
        mark("G", "5% loss: null with the reason, never a wrong value",
             f'null windows {pct(G["loss5"]["null_frac"])}; extra peak windows {G["loss5"]["attrib_peak_windows"]}',
             G["loss5"]["attrib_peak_windows"] == 0)  # non-null windows are those under the 2% repaired limit
    if fc in S.get("H", {}).get("configs", {}):
        H = S["H"]["configs"][fc]
        mark("H", "bit-identical on repeat", f'{sum(H["identical_on_repeat"])}/{len(H["identical_on_repeat"])}', all(H["identical_on_repeat"]))
        mark("H", "offset changes results by no more than the reported uncertainty", fr(H["offset_within_se"]),
             H["offset_within_se"]["rate"] is not None and H["offset_within_se"]["rate"] >= 0.68)
    return ["test", "requirement (spec 10.3)", "measured", "result"], rows


def merge(rs):
    """Merge several results files: later files add configurations (and sets) to earlier ones."""
    R = rs[0]
    for o in rs[1:]:
        R["tuning"].update(o.get("tuning", {}))
        for sname, sv in o.get("sets", {}).items():
            R["sets"].setdefault(sname, {"n_files": sv["n_files"], "configs": {}})["configs"].update(sv["configs"])
        if o.get("trackers") and not R.get("trackers"):
            R["trackers"] = o["trackers"]
    return R


def main():
    args = sys.argv[1:]
    dst = args.pop() if args and args[-1].endswith(".md") else os.path.join(HERE, "out", "bakeoff_tables.md")
    srcs = args or [os.path.join(HERE, "out", f) for f in ("bakeoff_results_pass1.json", "bakeoff_results_pass2.json",
                                                         "bakeoff_results_pass3_band.json", "bakeoff_results_pass4_a033.json",
                                                         "bakeoff_results_pass5_t3min.json")]
    R = merge([json.load(open(s)) for s in srcs])
    parts = []
    parts.append("## Tuned thresholds (tuning seeds only)\n")
    parts.append(table(["key", "threshold", "windows", "files"],
                       [[k, num(v["threshold"], 3), v.get("n_windows", ""), v.get("n_files", "")] for k, v in R["tuning"].items()]))
    spec_c = [c for c in ("S1-P1", "S1-P1-analytic", "S2-P1", "S3-P1", "S1W1-P1", "S1Q-P1") if c in R["sets"]["A"]["configs"]]
    conf_c = [c for c in ("S1-P1", "S1-P2", "S1-P3", "S1-P4") if c in R["sets"]["A"]["configs"]]
    freq_c = [c for c in ("S1-P1", "S1-P1-excess", "S1-P1-gauss", "S1-P1-parabolic", "S1Q-P1", "S1Q-P1-excess", "S1Q-P1-band", "S1Q-P1-excess-band", "S1Q-P1-excess-band-a033", "S1Q-P1-excess-band-a033-t3min")
              if c in R["sets"]["A"]["configs"]]
    for title, cs in (("Spectrum stage", spec_c), ("Confirmation stage", conf_c), ("Peak frequency stage (detection columns)", freq_c)):
        h, r = stage_rows(R, cs)
        parts.append(f"\n## {title}\n")
        parts.append(table(h, r))
    h, r = freq_rows(R, sorted(set(spec_c + conf_c + freq_c), key=(spec_c + conf_c + freq_c).index))
    parts.append("\n## Frequency accuracy and calibration (set A)\n")
    parts.append(table(h, r))
    for cfg in [c for c in ("S1-P1", "S1W1-P1", "S1-P1-excess", "S1Q-P1", "S1Q-P1-excess", "S1Q-P1-excess-band", "S1Q-P1-excess-band-a033", "S1Q-P1-excess-band-a033-t3min") if c in R["sets"]["B"]["configs"]]:
        h, r = tuning_curve(R, cfg)
        parts.append(f"\n## Tuning curve, set B, {cfg}\n")
        parts.append(table(h, r))
    h, r = control_rows(R, [c for c in ("S1-P1", "S1W1-P1", "S1-P1-excess", "S2-P1", "S1Q-P1", "S1Q-P1-excess", "S1Q-P1-band", "S1Q-P1-excess-band", "S1Q-P1-excess-band-a033", "S1Q-P1-excess-band-a033-t3min") if c in R["sets"]["B"]["configs"]])
    parts.append("\n## Control ratios and labelling, set B\n")
    parts.append(table(h, r))
    for cfg in [c for c in ("S1-P1", "S1W1-P1", "S1Q-P1", "S1Q-P1-excess", "S1Q-P1-band", "S1Q-P1-excess-band", "S1Q-P1-excess-band-a033", "S1Q-P1-excess-band-a033-t3min") if c in R["sets"]["C"]["configs"]]:
        h, r = c_rules(R, cfg)
        parts.append(f"\n## Set C by file kind, {cfg}\n")
        parts.append(table(h, r))
        h, r = a_rule_rows(R, cfg)
        parts.append(f"\n## Set A golden state entry by rule, {cfg}\n")
        parts.append(table(h, r))
    for cfg in [c for c in ("S1-P1", "S1W1-P1", "S1Q-P1", "S1Q-P1-excess") if c in R["sets"]["E"]["configs"]]:
        h, r = e_rows(R, cfg)
        parts.append(f"\n## Set E by artifact, {cfg}\n")
        parts.append(table(h, r))
    for cfg in R["sets"].get("F", {}).get("configs", {}):
        t1, t2, t3 = f_rows(R, cfg)
        parts.append(f"\n## Set F, {cfg}: form and dissolve schedule (golden state)\n")
        parts.append(t1)
        parts.append(f"\n\n## Set F, {cfg}: hard cases\n")
        parts.append(t2)
        parts.append(f"\n\n## Set F, {cfg}: steady cascade and heavier surrogates\n")
        parts.append(t3)
    for cfg in R["sets"].get("G", {}).get("configs", {}):
        h, r = g_rows(R, cfg)
        parts.append(f"\n## Set G, {cfg}\n")
        parts.append(table(h, r))
    for cfg in R["sets"].get("H", {}).get("configs", {}):
        parts.append(f"\n## Set H, {cfg}\n")
        parts.append(h_text(R, cfg))
    if R.get("trackers"):
        h, r = tracker_rows(R)
        parts.append("\n## Fast trackers\n")
        parts.append(table(h, r))
    for cfg, rule in (("S1Q-P1-excess-band-a033-t3min", "T4"), ("S1Q-P1-excess-band-a033-t3min", "T3"), ("S1Q-P1-excess-band-a033", "T4c"), ("S1Q-P1-excess-band-a033", "T4"), ("S1Q-P1-excess-band", "T4c"), ("S1Q-P1-excess-band", "T4"), ("S1Q-P1-excess", "T4c"), ("S1Q-P1-excess", "T1"), ("S1Q-P1", "T4c"), ("S1-P1", "T4c"), ("S1-P1", "T1")):
        if cfg in R["sets"]["A"]["configs"]:
            h, r = passmarks(R, cfg, rule)
            parts.append(f"\n## Pass marks (spec 10.3), {cfg}, rule {rule}\n")
            parts.append(table(h, r))
    h, r = broken_rows(R)
    parts.append("\n## Deliberately broken builds\n")
    parts.append(table(h, r))
    with open(dst, "w") as fh:
        fh.write("\n".join(parts) + "\n")
    print("wrote", dst)


if __name__ == "__main__":
    main()
