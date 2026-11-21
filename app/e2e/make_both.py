#!/usr/bin/env python3
"""Fake test 2: one recording with BOTH a golden ratio cascade and an octave cascade, 12 dB each, 120 s, one
shared 1/f background. Built with lab/hb_lab/generators.py.
Output: out/fixtures-extra/both_phi_octave_12db.{f32,json} (same format as lab/fixtures), and with --lab also
lab/fixtures/both_phi_octave_12db.{f32,json}.

Changed by the signal architect, 21 November 2026. The first version planted 3.0, 4.85, 7.85 Hz (golden) and
6.2, 12.4, 24.8 Hz (octave). That is a bad test of "both", for reasons that have nothing to do with chance levels:
three rhythms sat 1.35 and 1.65 Hz apart between 4.8 and 7.9 Hz, closer than their own widths allow an 8 s
spectrum to separate cleanly (the 6.2 Hz centre read 0.2 to 0.3 Hz high, which broke the octave step, and the
7.85 Hz one carried an error over the resolved limit), and the 3.0 Hz member sits at the edge of the range where
eye movement and the background fit leave little sensitivity (confirmed in 30 % of frames). The two cascades now
share their root at 5 Hz: golden 5.0, 8.09, 13.09 Hz and octave 5.0, 10.0, 20.0 Hz, five rhythms, the closest
pair 1.9 Hz apart. (The engine fault the first version did expose, tracks hopping between neighbouring
rhythms, is fixed in the engine and has its own test.)"""
import json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'lab'))
from hb_lab import generators as G
seed = 4_100_001
rng, n, chi, sd, data, scale = G._new(seed, 120.0, chi=1.5, sd=15.0)
phi = [5.0 * G.PHI ** k for k in range(3)]
octv = [5.0 * 2 ** k for k in range(3)]
freqs = phi + octv[1:]
infos = G._add_rhythms(rng, n, data, chi, scale, freqs, [12.0] * len(freqs))
truth = {"chi": chi, "sd_uv": sd, "phi_freqs": phi, "octave_freqs": octv, "snr_db": 12.0,
         "peaks": G._truth_peaks(infos, n), "note": "both cascades, independent rhythms, shared root at 5 Hz"}
out = os.path.join(HERE, 'out', 'fixtures-extra'); os.makedirs(out, exist_ok=True)
data.T.astype('<f4').tofile(os.path.join(out, 'both_phi_octave_12db.f32'))
json.dump({"channels": list(G.CHANNELS), "rate_hz": int(G.FS), "seed": seed, "kind": "both_cascades", "duration_s": n / G.FS, "truth": truth}, open(os.path.join(out, 'both_phi_octave_12db.json'), 'w'), indent=1)
if '--lab' in sys.argv:
    lab = os.path.join(HERE, '..', '..', 'lab', 'fixtures')
    data.T.astype('<f4').tofile(os.path.join(lab, 'both_phi_octave_12db.f32'))
    json.dump({"channels": list(G.CHANNELS), "rate_hz": int(G.FS), "seed": seed, "kind": "both_cascades", "duration_s": n / G.FS, "truth": truth}, open(os.path.join(lab, 'both_phi_octave_12db.json'), 'w'), indent=1)
print('ok', phi, octv)
