#!/usr/bin/env python3
"""In-app audio control stream per recording (fresh browser, real time): voices on, phi/octave/both bloom, bed on fraction. usage: analyze-audio-msgs2.py fresh2"""
import json, glob, sys
pre = sys.argv[1] if len(sys.argv) > 1 else 'fresh2'
out = {}
for f in sorted(glob.glob(f'out/{pre}_*/results.json')):
    d = json.load(open(f))['results']
    for n, v in d.items():
        ms = [x for x in v['audioMsgs'] if x['m'].get('type') == 'control']
        if not ms: out[n] = None; continue
        t0 = ms[0]['w']; bins = {}
        for x in ms:
            b = int((x['w'] - t0) / 20000) * 20
            c = x['m']['control']; vs = [q for q in c['voices'] if q['on']]
            e = bins.setdefault(b, dict(on=0, phi=0.0, oct=0.0, both=0.0, bed=0, n=0))
            e['n'] += 1; e['on'] = max(e['on'], len(vs))
            e['phi'] = max([e['phi']] + [q['phi'] for q in vs]); e['oct'] = max([e['oct']] + [q['octave'] for q in vs]); e['both'] = max([e['both']] + [q.get('both', 0) for q in vs])
            e['bed'] += 1 if c['bed']['on'] else 0
        out[n] = dict(msgs=len(ms), bins={b: dict(e, bedFrac=round(e['bed'] / e['n'], 2)) for b, e in sorted(bins.items())})
        tot = dict(maxVoices=max(e['on'] for e in bins.values()), maxPhi=max(e['phi'] for e in bins.values()), maxOct=max(e['oct'] for e in bins.values()), maxBoth=max(e['both'] for e in bins.values()), bedFracAll=round(sum(e['bed'] for e in bins.values()) / sum(e['n'] for e in bins.values()), 3))
        out[n]['summary'] = tot
        print(f"{n:34s} msgs={len(ms)} {tot}")
json.dump(out, open(f'out/{pre}-audio-summary.json', 'w'), indent=1)
