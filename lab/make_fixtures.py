"""Write the cross-check fixtures for the Rust engine to lab/fixtures/.

Format (fixed, see lab/fixtures/README.md):
  <name>.f32   little-endian float32, samples interleaved by channel (TP9, AF7, AF8, TP10, TP9, ...),
               microvolts.  A lost packet is NaN on every channel for its 12 samples.
  <name>.json  {"channels": [...], "rate_hz": 256, "seed": N, "kind": "...", "truth": {...}}

Optionally, with --expected, also write lab/fixtures/expected/<name>.lab.json: the Python lab's own
output for that file under the chosen configuration, so the Rust engine can be compared window by window.

    python3 lab/make_fixtures.py [--expected lab/out/bakeoff_results.json --config S1-P1]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hb_lab import generators as G  # noqa: E402

OUT = os.path.join(HERE, "fixtures")
PHI = G.PHI


def sine10(seed):
    """Roadmap gate 2: a synthetic 10 Hz signal must read 10.0 Hz within 0.1."""
    rng = np.random.default_rng(seed)
    n = int(60 * G.FS)
    t = np.arange(n) / G.FS
    data = 20.0 * np.sin(2 * np.pi * 10.0 * t)[None, :] * np.array([1.0, 0.6, 0.6, 1.0])[:, None]
    bg, scale = G.background(rng, n, 1.5, 10.0)
    data = data + bg
    return G.Recording(data, kind="sine_10hz", seed=seed,
                       truth={"description": "pure 10.000 Hz sine, 20 uV on TP9/TP10 and 12 uV on AF7/AF8, "
                                             "over 1/f^1.5 background of sd 10 uV",
                              "peaks": [{"f0": 10.0, "bw": 0.0, "snr_db": None}], "chi": 1.5})


def fixture_list():
    L = []
    L.append(("gate2_sine_10hz", lambda: sine10(3_000_001)))
    L.append(("phi3_10db", lambda: G.make_cascade(3_000_002, 3, PHI, 10, 4.6, duration=120)))
    L.append(("phi5_15db", lambda: G.make_cascade(3_000_003, 5, PHI, 15, 3.4, duration=120)))
    L.append(("phi2_6db", lambda: G.make_cascade(3_000_004, 2, PHI, 6, 6.2, duration=90)))
    L.append(("phi3_3db", lambda: G.make_cascade(3_000_005, 3, PHI, 3, 4.0, duration=90)))
    L.append(("octave3_10db", lambda: G.make_cascade(3_000_006, 3, 2.0, 10, 4.5, duration=120, kind="octave_cascade")))
    for i, r in enumerate((1.5, 1.55, 1.7, 1.8)):
        L.append((f"nearmiss_{r:g}_10db", lambda r=r, i=i: G.make_cascade(3_000_010 + i, 3, r, 10, 4.5, duration=90,
                                                                          kind="near_miss_cascade")))
    L.append(("background_only", lambda: G.make_background_only(3_000_020, duration=90)))
    L.append(("white_noise", lambda: G.make_white(3_000_021, duration=60)))
    L.append(("random_bands", lambda: G.make_random_peaks(3_000_022, duration=90, mode="bands")))
    L.append(("harmonic_8hz", lambda: G.make_harmonic(3_000_023, 8.0)))
    L.append(("artifact_blinks", lambda: G.make_artifact(3_000_024, "blinks")[0]))
    L.append(("artifact_jaw_clench", lambda: G.make_artifact(3_000_025, "jaw_clench")[0]))
    L.append(("artifact_railed_mains60", lambda: _railed_mains(3_000_026)))
    L.append(("form_dissolve_120s", lambda: G.make_hard(3_000_027, "form_dissolve", duration=120,
                                                        schedule=[[25.0, 70.0]])))
    L.append(("drift_band_edge", lambda: G.make_hard(3_000_028, "drift_band_edge", duration=90)))
    L.append(("phi3_10db_loss1pct", lambda: _loss(3_000_002, 0.01)))
    L.append(("phi3_10db_phase_randomized", lambda: _phase_rand(3_000_002)))
    return L


def _railed_mains(seed):
    rec, _ = G.make_artifact(seed, "railed")
    rng = np.random.default_rng(seed + 5)
    rec.data = rec.data + G.mains(rng, rec.n, 60.0)
    rec.truth["mains_hz"] = 60.0
    rec.kind = "artifact_railed_plus_mains60"
    return rec


def _loss(seed, p):
    rec = G.make_cascade(seed, 3, PHI, 10, 4.6, duration=120)
    rec.data, frac = G.drop_packets(np.random.default_rng(seed + 31), rec.data, p)
    rec.truth["lost_packet_frac"] = frac
    rec.kind = "cascade_packet_loss"
    return rec


def _phase_rand(seed):
    rec = G.make_cascade(seed, 3, PHI, 10, 4.6, duration=120)
    rec.data = G.phase_randomize(np.random.default_rng(seed + 77), rec.data)
    rec.kind = "surrogate_phase_randomize"
    rec.truth["note"] = ("phase-randomized copy of phi3_10db: the spectrum and therefore the peaks and their "
                         "ratios are preserved; only the time structure is destroyed")
    return rec


def clean_truth(tr):
    out = {}
    for k, v in tr.items():
        if k == "peaks":
            out[k] = []
            for pk in v:
                d = {kk: vv for kk, vv in pk.items() if kk != "traj_1hz"}
                if "traj_1hz" in pk:
                    d["mean_freq_hz"] = round(float(np.mean(pk["traj_1hz"])), 4)
                    d["traj_1hz"] = pk["traj_1hz"]
                out[k].append(d)
        elif isinstance(v, (np.floating, float)):
            out[k] = round(float(v), 6)
        elif isinstance(v, (list, tuple)):
            out[k] = [round(float(x), 6) if isinstance(x, (float, np.floating)) else x for x in v]
        else:
            out[k] = v
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected", default=None, help="bake-off results JSON (for thresholds)")
    ap.add_argument("--config", default="S1-P1")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    index = []
    exp_dir = os.path.join(OUT, "expected")
    thresholds = None
    if a.expected:
        res = json.load(open(a.expected))
        thresholds = {k: v["threshold"] for k, v in res["tuning"].items() if "analytic" not in k}
        os.makedirs(exp_dir, exist_ok=True)
        from hb_lab import battery as B, pipeline as P
    for name, fn in fixture_list():
        rec = fn()
        inter = rec.data.T.astype("<f4")  # (n, 4) -> row-major interleave TP9, AF7, AF8, TP10
        inter.tofile(os.path.join(OUT, f"{name}.f32"))
        meta = {"channels": list(G.CHANNELS), "rate_hz": int(G.FS), "seed": int(rec.seed), "kind": rec.kind,
                "duration_s": round(rec.duration, 3), "truth": clean_truth(rec.truth)}
        with open(os.path.join(OUT, f"{name}.json"), "w") as fh:
            json.dump(meta, fh, indent=1)
        index.append((name, rec.kind, rec.duration))
        if thresholds is not None:
            cfg = dict(B.STAGE_CONFIGS[a.config], thresholds=thresholds, seed=0)
            out = P.analyze(rec, cfg)
            slim = {"config": a.config, "params_note": "lab PARAMS, hop 1 s (engine hop 250 ms)",
                    "mains_hz": out["mains"],
                    "windows": [{"t": w["t"], "null": w["null"], "channels": w.get("channels"),
                                 "peaks": w.get("peaks"), "tracks": w.get("tracks")} for w in out["windows"]],
                    "states": {tk: {r: v["entries"] for r, v in d.items()} for tk, d in out["states"].items()}}
            with open(os.path.join(exp_dir, f"{name}.lab.json"), "w") as fh:
                json.dump(slim, fh, default=lambda o: float(o) if isinstance(o, np.floating) else int(o))
        print(f"{name:32s} {rec.kind:28s} {rec.duration:6.1f} s", flush=True)
    return index


if __name__ == "__main__":
    main()
