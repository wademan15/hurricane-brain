"""Compare the Rust engine (hb-run JSON Lines) with the Python lab on the cross-check fixtures (spec 11).

    hb-run lab/fixtures/<name> > <dir>/<name>.jsonl        (for every fixture)
    python3 lab/compare_rust.py <dir> [--config S1Q-P1-excess-band-a033-t3min] [--out lab/out/rust_vs_lab.md]

The lab runs once per fixture with the named configuration (thresholds from the pass-2 tuning), hop 1 s.
Each lab window (end time t) is paired with the engine slow frame whose time is nearest t (engine hop 250 ms).

Measures, per fixture:
  peaks    lab confirmed window peaks against the engine's confirmed tracks' window frequency ("freq");
           a pair is a match when within 0.5 Hz; spec 11 asks for agreement within 0.05 Hz.
  tracks   lab integrated tracks against the engine's confirmed tracks' "freq_integrated"; "same set" means
           the same number of confirmed tracks and every one paired within 0.5 Hz.
  states   golden-ratio state, lab rules T3 (recommended) and T4 (CFAR on ln evidence, the engine's rule)
           against the engine's states.phi.active; entry times and window-by-window agreement.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hb_lab import battery as B, pipeline as P  # noqa: E402
import make_fixtures as MF  # noqa: E402

MATCH_HZ = 0.5
AGREE_HZ = 0.05


def load_engine(path):
    fr = []
    with open(path) as fh:
        for line in fh:
            if '"kind":"slow"' in line:
                fr.append(json.loads(line))
    return fr


def conf_tracks(f, key):
    out = []
    for tr in f.get("tracks") or []:
        if tr.get("state") != "confirmed":
            continue
        v = (tr.get(key) or {}).get("v")
        if v is not None:
            out.append(float(v))
    return out


def pair_up(a, b):
    """Greedy nearest pairing of two frequency lists; returns list of |diff| for pairs within MATCH_HZ."""
    a, b = list(a), list(b)
    d = []
    while a and b:
        best = min(((abs(x - y), i, j) for i, x in enumerate(a) for j, y in enumerate(b)))
        if best[0] > MATCH_HZ:
            break
        d.append(best[0])
        a.pop(best[1])
        b.pop(best[2])
    return d, len(a), len(b)


def entries(seq, times):
    return [round(float(t), 2) for k, t in enumerate(times) if seq[k] and (k == 0 or not seq[k - 1])]


def compare(name, rec, eng, cfg):
    out = P.analyze(rec, cfg)
    et = np.array([f["t"] for f in eng])
    r = {"name": name, "lab_windows": 0, "pk_lab": 0, "pk_eng": 0, "pk_d": [], "tr_lab": 0, "tr_eng": 0,
         "tr_d": [], "same_set": 0, "st": {}}
    lab_on = {rule: out["states"]["phi"][rule]["on"] for rule in ("T1", "T3", "T4")}
    eng_on, lab_seq = [], {rule: [] for rule in lab_on}
    times = []
    for k, w in enumerate(out["windows"]):
        if w["null"]:
            continue
        j = int(np.argmin(np.abs(et - w["t"])))
        if abs(et[j] - w["t"]) > 0.26:
            continue
        f = eng[j]
        r["lab_windows"] += 1
        lp = [p[0] for p in (w.get("peaks") or [])]
        ep = conf_tracks(f, "freq")
        d, ul, ue = pair_up(lp, ep)
        r["pk_lab"] += len(lp)
        r["pk_eng"] += len(ep)
        r["pk_d"] += d
        lt = [t[1] for t in (w.get("tracks") or [])]
        eti = conf_tracks(f, "freq_integrated")
        d2, ul2, ue2 = pair_up(lt, eti)
        r["tr_lab"] += len(lt)
        r["tr_eng"] += len(eti)
        r["tr_d"] += d2
        r["same_set"] += int(ul2 == 0 and ue2 == 0)
        st = ((f.get("states") or {}).get("phi") or {}).get("active")
        eng_on.append(bool(st))
        for rule in lab_on:
            lab_seq[rule].append(bool(lab_on[rule][k]))
        times.append(w["t"])
    # engine entries at its own 250 ms resolution
    eact = [bool(((f.get("states") or {}).get("phi") or {}).get("active")) for f in eng]
    r["st"]["engine_entries"] = entries(eact, et)
    for rule, seq in lab_seq.items():
        r["st"][rule + "_entries"] = entries(seq, times)
        r["st"][rule + "_agree"] = float(np.mean(np.array(seq) == np.array(eng_on))) if seq else None
    r["st"]["engine_frac"] = float(np.mean(eng_on)) if eng_on else None
    r["st"]["T3_frac"] = float(np.mean(lab_seq["T3"])) if eng_on else None
    return r


def fmt_d(d, n_lab, n_eng):
    if not d:
        return f"0 matched (lab {n_lab}, engine {n_eng})"
    d = np.array(d)
    return (f"{len(d)} matched of lab {n_lab} / engine {n_eng}; median |diff| {np.median(d):.3f} Hz; "
            f"within 0.05 Hz {np.mean(d <= AGREE_HZ):.0%}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--config", default="S1Q-P1-excess-band-a033-t3min")
    ap.add_argument("--results", default=os.path.join(HERE, "out", "bakeoff_results_pass2.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "out", "rust_vs_lab.md"))
    a = ap.parse_args()
    res = json.load(open(a.results))
    thr = {k: v["threshold"] for k, v in res["tuning"].items() if "analytic" not in k}
    cfg = dict(B.STAGE_CONFIGS[a.config], thresholds=thr, seed=0)
    rows, allr = [], []
    for name, fn in MF.fixture_list():
        p = os.path.join(a.dir, f"{name}.jsonl")
        if not os.path.exists(p):
            continue
        r = compare(name, fn(), load_engine(p), cfg)
        allr.append(r)
        s = r["st"]
        rows.append(f"| {name} | {r['lab_windows']} | {fmt_d(r['pk_d'], r['pk_lab'], r['pk_eng'])} | "
                    f"{fmt_d(r['tr_d'], r['tr_lab'], r['tr_eng'])} | {r['same_set']}/{r['lab_windows']} | "
                    f"{s['engine_entries']} | {s['T3_entries']} | {s['T4_entries']} | "
                    f"{s['T3_agree']:.0%} / {s['T4_agree']:.0%} |")
        print(name, "done", flush=True)
    pk = np.concatenate([r["pk_d"] for r in allr if r["pk_d"]]) if allr else np.array([])
    tr = np.concatenate([r["tr_d"] for r in allr if r["tr_d"]]) if allr else np.array([])
    lines = [f"Lab configuration {a.config}; engine slow frames paired with lab windows by nearest time.", "",
             "| fixture | windows | window peaks (lab peaks vs engine confirmed tracks' freq) | integrated (lab tracks vs engine freq_integrated) | same confirmed set | engine golden entries (s) | lab T3 entries | lab T4 entries | state agreement with lab T3 / T4 |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"] + rows + ["",
             f"All fixtures: window peaks matched {len(pk)} of lab {sum(r['pk_lab'] for r in allr)} / engine "
             f"{sum(r['pk_eng'] for r in allr)}; within 0.05 Hz {np.mean(pk <= AGREE_HZ):.1%}; median |diff| "
             f"{np.median(pk):.3f} Hz. Integrated matched {len(tr)} of lab {sum(r['tr_lab'] for r in allr)} / engine "
             f"{sum(r['tr_eng'] for r in allr)}; within 0.05 Hz {np.mean(tr <= AGREE_HZ):.1%}; median |diff| "
             f"{np.median(tr):.3f} Hz. Same confirmed set in {sum(r['same_set'] for r in allr)} of "
             f"{sum(r['lab_windows'] for r in allr)} windows."]
    with open(a.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    with open(a.out.replace(".md", ".json"), "w") as fh:
        json.dump(allr, fh, default=float)
    print("\n".join(lines[-1:]))


if __name__ == "__main__":
    main()
