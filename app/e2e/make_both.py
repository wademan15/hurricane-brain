#!/usr/bin/env python3
"""Fake test 2: one recording with BOTH a golden ratio cascade (3.0, 4.85, 7.85 Hz) and an independent octave
cascade (6.2, 12.4, 24.8 Hz), 12 dB each, 120 s, one shared 1/f background. Built with lab/hb_lab/generators.py.
Output: out/fixtures-extra/both_phi_octave_12db.{f32,json} (same format as lab/fixtures)."""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'lab'))
from hb_lab import generators as G
seed = 4_100_001
rng, n, chi, sd, data, scale = G._new(seed, 120.0, chi=1.5, sd=15.0)
phi = [3.0 * G.PHI ** k for k in range(3)]
octv = [6.2 * 2 ** k for k in range(3)]
infos = G._add_rhythms(rng, n, data, chi, scale, phi + octv, [12.0] * 6)
truth = {"chi": chi, "sd_uv": sd, "phi_freqs": phi, "octave_freqs": octv, "snr_db": 12.0,
         "peaks": G._truth_peaks(infos, n), "note": "both cascades, independent rhythms; no shared members"}
out = os.path.join(HERE, 'out', 'fixtures-extra'); os.makedirs(out, exist_ok=True)
data.T.astype('<f4').tofile(os.path.join(out, 'both_phi_octave_12db.f32'))
json.dump({"channels": list(G.CHANNELS), "rate_hz": int(G.FS), "seed": seed, "kind": "both_cascades", "duration_s": n / G.FS, "truth": truth}, open(os.path.join(out, 'both_phi_octave_12db.json'), 'w'), indent=1)
print('ok', phi, octv)
