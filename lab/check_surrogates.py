"""Score each spectrum-preserving C surrogate against its own unshuffled source (corrected pass rule).

Sample shuffle must remove every planted peak; block shuffle (blocks longer than a cycle), phase
randomization and channel shift must keep them.  python3 lab/check_surrogates.py > lab/out/surrogate_vs_source.txt
"""
import json, sys, numpy as np
from multiprocessing import Pool
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from hb_lab import battery as B, pipeline as P, generators as G
R = json.load(open(__import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)), "out", "bakeoff_results_pass2.json")))
THR = {k: v["threshold"] for k, v in R["tuning"].items() if "analytic" not in k}
CFG = dict(B.STAGE_CONFIGS["S1Q-P1-excess-band-a033-t3min"], thresholds=THR, seed=0)
def summ(out):
    fs = [p[0] for w in out["windows"] if not w["null"] for p in (w.get("peaks") or [])]
    on = out["states"]["phi"]["T3"]["on"]
    return fs, float(np.mean(on)) if on else 0.0
def job(a):
    kind, seed = a
    sur = B.build({"set": "C", "kind": "surrogate_" + kind, "seed": seed})
    src = G.make_random_peaks(seed, sur.duration, mode="loguniform")
    (fs1, s1), (fs2, s2) = summ(P.analyze(src, CFG)), summ(P.analyze(sur, CFG))
    planted = [p["f0"] for p in src.truth["peaks"]]
    def found(fs):  # planted peaks confirmed (within 0.5 Hz) in at least 5 windows
        return [f for f in planted if sum(abs(x - f) < 0.5 for x in fs) >= 5]
    return kind, seed, len(planted), len(found(fs1)), len(found(fs2)), s1, s2
if __name__ == "__main__":
    jobs = [(j["kind"][len("surrogate_"):], j["seed"]) for j in B.jobs_C() if j["kind"].startswith("surrogate_")]
    with Pool(4) as p:
        res = p.map(job, jobs)
    import collections
    agg = collections.defaultdict(list)
    for r in res: agg[r[0]].append(r[2:])
    for k, v in agg.items():
        v = np.array(v, float)
        print(f"{k:16s} files {len(v)} planted {v[:,0].sum():.0f} found in source {v[:,1].sum():.0f} found in surrogate {v[:,2].sum():.0f} | golden T3 time in state source {v[:,3].mean():.1%} surrogate {v[:,4].mean():.1%} | files where state presence differs {int(((v[:,3]>0)!=(v[:,4]>0)).sum())}")
