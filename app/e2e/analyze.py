#!/usr/bin/env python3
"""Summarise out/<tag>/results.json and screenshots: readout strip over time, image metrics, pixel motion."""
import json, sys, os, re
import numpy as np
from PIL import Image
tag = sys.argv[1] if len(sys.argv) > 1 else 'speed4'
d = json.load(open(f'out/{tag}/results.json'))['results']
def img(p):
    return np.asarray(Image.open(f'out/{tag}/{p}').convert('L'), dtype=float)
def metrics(a):
    h, w = a.shape; cy, cx = h/2, w/2
    yy, xx = np.mgrid[0:h, 0:w]; r = np.hypot(yy-cy, xx-cx)
    disc = r < 0.42*min(h, w)
    bright = (a > 40)[disc].mean()
    mean = a[disc].mean()
    # angular structure: spread of mean brightness across 36 angular sectors in the annulus 0.1..0.4
    ang = np.arctan2(yy-cy, xx-cx); ann = (r > 0.08*min(h,w)) & (r < 0.42*min(h,w))
    sect = [a[ann & (ang >= -np.pi+2*np.pi*i/36) & (ang < -np.pi+2*np.pi*(i+1)/36)].mean() for i in range(36)]
    # radial structure: 24 radial rings
    rad = [a[(r >= 0.02*min(h,w)*(i+1)) & (r < 0.02*min(h,w)*(i+2))].mean() for i in range(20)]
    return dict(bright_frac=round(float(bright),4), mean=round(float(mean),2), max=float(a[disc].max()), sector_cv=round(float(np.std(sect)/max(np.mean(sect),1e-6)),3), ring_cv=round(float(np.std(rad)/max(np.mean(rad),1e-6)),3))
out = {}
for name, v in d.items():
    s = v['series']
    live = [r for r in s if r.get('el') is not None]
    peaks = set(); maxsteps = 0; seen_phi = []; seen_oct = []; chance = []
    calm = 0
    for r in live:
        for c in r['chips']:
            m = re.match(r'(\w+): ([\d.]+)', c)
            if m and not c.startswith(('Signal','Peaks','Heart')): peaks.add(c)
        m = re.search(r'(\d+) steps?', r['phi'] or ''); 
        if m: maxsteps = max(maxsteps, int(m.group(1)))
        if r.get('calm'): calm += 1
    out[name] = dict(frames=len(live), maxPhiSteps=maxsteps, calmSamples=calm, peakChips=sorted(peaks)[:12])
    shots = {}
    for k, f in v['shots'].items():
        if isinstance(f, str) and f.endswith('.png') and '-full' not in f and 'end' not in f:
            shots[f] = metrics(img(f))
    out[name]['shots'] = shots
    if 'pair' in v['shots']:
        a, b = [img(p) for p in v['shots']['pair']]
        h = min(a.shape[0], b.shape[0]); shape_equal = a.shape == b.shape; a, b = a[:h], b[:h]
        m = (a != b); m[:70, :300] = False  # ignore the elapsed-time label (top-left)
        out[name]['pairDiff'] = dict(maxAbs=float(np.abs(a-b).max()), changedPixels=int((np.abs(a-b) > 0).sum()), total=int(a.size), shapesEqual=shape_equal, changedOutsideClockLabel=int(m.sum()), maxAbsOutsideClockLabel=float(np.abs(a-b)[m].max()) if m.any() else 0.0)
json.dump(out, open(f'out/{tag}/analysis.json', 'w'), indent=1)
for n, o in out.items(): print(n, json.dumps(o)[:900])
