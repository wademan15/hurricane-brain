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
    srcs = args or [os.path.join(HERE, "out", "bakeoff_results.json")]
    R = merge([json.load(open(s)) for s in srcs])
    parts = []
    parts.append("## Tuned thresholds (tuning seeds only)\n")
    parts.append(table(["key", "threshold", "windows", "files"],
                       [[k, num(v["threshold"], 3), v.get("n_windows", ""), v.get("n_files", "")] for k, v in R["tuning"].items()]))
    spec_c = [c for c in ("S1-P1", "S1-P1-analytic", "S2-P1", "S3-P1", "S1W1-P1", "S1Q-P1") if c in R["sets"]["A"]["configs"]]
    conf_c = [c for c in ("S1-P1", "S1-P2", "S1-P3", "S1-P4") if c in R["sets"]["A"]["configs"]]
    freq_c = [c for c in ("S1-P1", "S1-P1-excess", "S1-P1-gauss", "S1-P1-parabolic", "S1Q-P1", "S1Q-P1-excess")
              if c in R["sets"]["A"]["configs"]]
    for title, cs in (("Spectrum stage", spec_c), ("Confirmation stage", conf_c), ("Peak frequency stage (detection columns)", freq_c)):
        h, r = stage_rows(R, cs)
        parts.append(f"\n## {title}\n")
        parts.append(table(h, r))
    h, r = freq_rows(R, sorted(set(spec_c + conf_c + freq_c), key=(spec_c + conf_c + freq_c).index))
    parts.append("\n## Frequency accuracy and calibration (set A)\n")
    parts.append(table(h, r))
    for cfg in [c for c in ("S1-P1", "S1W1-P1", "S1-P1-excess") if c in R["sets"]["B"]["configs"]]:
        h, r = tuning_curve(R, cfg)
        parts.append(f"\n## Tuning curve, set B, {cfg}\n")
        parts.append(table(h, r))
    h, r = control_rows(R, [c for c in ("S1-P1", "S1W1-P1", "S1-P1-excess", "S2-P1") if c in R["sets"]["B"]["configs"]])
    parts.append("\n## Control ratios and labelling, set B\n")
    parts.append(table(h, r))
    for cfg in [c for c in ("S1-P1", "S1W1-P1") if c in R["sets"]["C"]["configs"]]:
        h, r = c_rules(R, cfg)
        parts.append(f"\n## Set C by file kind, {cfg}\n")
        parts.append(table(h, r))
        h, r = a_rule_rows(R, cfg)
        parts.append(f"\n## Set A golden state entry by rule, {cfg}\n")
        parts.append(table(h, r))
    for cfg in [c for c in ("S1-P1", "S1W1-P1") if c in R["sets"]["E"]["configs"]]:
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
    h, r = broken_rows(R)
    parts.append("\n## Deliberately broken builds\n")
    parts.append(table(h, r))
    with open(dst, "w") as fh:
        fh.write("\n".join(parts) + "\n")
    print("wrote", dst)


if __name__ == "__main__":
    main()
