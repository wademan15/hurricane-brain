"""Blind set generator (spec 10.2 I).

The seeds come from lab/blind/.seeds, which is NOT committed (lab/.gitignore).  If it does not exist,
it is created from the operating system's random source the first time this runs, by the skeptic, and
then kept privately.  Implementers receive only lab/blind/files/; the answers in lab/blind/truth/
stay with the skeptic until the final choice has been made.  Use the set once.

    python3 lab/make_blind.py [--n 40]

Output:
  lab/blind/files/<id>.f32 and <id>.json   same format as lab/fixtures, but the json carries no truth
  lab/blind/truth/<id>.json                kind, parameters and planted truth
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hb_lab import generators as G  # noqa: E402
from make_fixtures import clean_truth  # noqa: E402

BLIND = os.path.join(HERE, "blind")
SEEDS = os.path.join(BLIND, ".seeds")
KINDS = ("phi_cascade", "phi_cascade", "phi_cascade", "octave_cascade", "near_miss", "near_miss",
         "background_only", "random_loguniform", "random_bands", "harmonic", "artifact", "white_noise")


def load_or_make_seeds(n):
    os.makedirs(BLIND, exist_ok=True)
    if os.path.exists(SEEDS):
        seeds = [int(s) for s in open(SEEDS).read().split()]
        if len(seeds) >= n + 1:
            return seeds
    seeds = [secrets.randbelow(2 ** 62) for _ in range(n + 1)]
    with open(SEEDS, "w") as fh:
        fh.write("\n".join(str(s) for s in seeds) + "\n")
    os.chmod(SEEDS, 0o600)
    return seeds


def make_one(seed):
    rng = np.random.default_rng(seed)
    kind = KINDS[int(rng.integers(len(KINDS)))]
    s = int(rng.integers(2 ** 31))
    dur = float(rng.choice([90.0, 120.0]))
    if kind in ("phi_cascade", "octave_cascade", "near_miss"):
        ratio = {"phi_cascade": G.PHI, "octave_cascade": 2.0}.get(kind) or float(rng.choice([1.5, 1.55, 1.7, 1.8]))
        n_m = int(rng.integers(2, 5)) if kind != "phi_cascade" else int(rng.integers(2, 6))
        snr = float(rng.choice([3, 6, 10, 15]))
        f_start = float(rng.uniform(3.0, min(8.0, 40.0 / ratio ** (n_m - 1))))
        return G.make_cascade(s, n_m, ratio, snr, f_start, duration=dur, kind=kind)
    if kind == "background_only":
        return G.make_background_only(s, duration=dur)
    if kind == "white_noise":
        return G.make_white(s, duration=dur)
    if kind.startswith("random_"):
        return G.make_random_peaks(s, duration=dur, mode=kind.split("_")[1])
    if kind == "harmonic":
        return G.make_harmonic(s, float(rng.uniform(5, 12)), duration=dur)
    if kind == "artifact":
        return G.make_artifact(s, str(rng.choice(G.ARTIFACT_KINDS)), duration=dur)[0]
    raise ValueError(kind)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40)
    a = ap.parse_args()
    seeds = load_or_make_seeds(a.n)
    order = np.random.default_rng(seeds[0]).permutation(a.n)
    os.makedirs(os.path.join(BLIND, "files"), exist_ok=True)
    os.makedirs(os.path.join(BLIND, "truth"), exist_ok=True)
    for i in range(a.n):
        rec = make_one(seeds[1 + i])
        bid = f"blind_{order[i]:03d}"
        rec.data.T.astype("<f4").tofile(os.path.join(BLIND, "files", f"{bid}.f32"))
        with open(os.path.join(BLIND, "files", f"{bid}.json"), "w") as fh:
            json.dump({"channels": list(G.CHANNELS), "rate_hz": int(G.FS), "id": bid,
                       "duration_s": round(rec.duration, 3)}, fh)
        with open(os.path.join(BLIND, "truth", f"{bid}.json"), "w") as fh:
            json.dump({"id": bid, "kind": rec.kind, "seed": int(rec.seed), "truth": clean_truth(rec.truth)}, fh)
    print(f"wrote {a.n} blind files to {os.path.join(BLIND, 'files')} (answers in {os.path.join(BLIND, 'truth')})")


if __name__ == "__main__":
    main()
