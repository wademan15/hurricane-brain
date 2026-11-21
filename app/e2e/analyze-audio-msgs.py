#!/usr/bin/env python3
"""In-app audio check: what the built app's AudioEngine posted to its worklet (captured by a test-side AudioWorkletNode wrapper), real-time replay run."""
import json, sys
tag = sys.argv[1] if len(sys.argv) > 1 else 'speed1'
d = json.load(open(f'out/{tag}/results.json'))['results']
out = {}
for n, v in d.items():
    ms = [x for x in v['audioMsgs'] if x['m'].get('type') == 'control']
    if not ms: continue
    t0 = ms[0]['w']; bins = {}
    for x in ms:
        b = int((x['w'] - t0) / 10000) * 10
        c = x['m']['control']; vs = c['voices']
        e = bins.setdefault(b, dict(maxOn=0, maxPhi=0.0, maxOct=0.0, bedOn=0, n=0, maxWarmth=0.0, nullOn=0))
        e['n'] += 1; e['maxOn'] = max(e['maxOn'], sum(1 for q in vs if q['on'])); e['maxPhi'] = max([e['maxPhi']] + [q['phi'] for q in vs if q['on']]); e['maxOct'] = max([e['maxOct']] + [q['octave'] for q in vs if q['on']])
        e['bedOn'] += 1 if c['bed']['on'] else 0; e['maxWarmth'] = max(e['maxWarmth'], c['bed']['warmth'])
        e['nullOn'] += sum(1 for q in vs if q['on'] and q['freqHz'] is None)
    out[n] = {k: dict(x, bedOnFrac=round(x['bedOn'] / x['n'], 2)) for k, x in sorted(bins.items())}
    print('==', n, 'control msgs', len(ms), 'span s', round((ms[-1]['w'] - t0) / 1000))
    for k, x in out[n].items(): print('  ', k, 'voices on', x['maxOn'], 'phi', round(x['maxPhi'], 2), 'oct', round(x['maxOct'], 2), 'bedOnFrac', x['bedOnFrac'], 'warmth', round(x['maxWarmth'], 2), 'on-with-null-freq', x['nullOn'])
json.dump(out, open(f'out/{tag}/audio-msgs.json', 'w'), indent=1)
