/**
 * TEST ONLY harness page for playwright-check.mjs. Mounts the real HurricaneView and feeds it
 * hand-built fixture frames on a 250 ms timer. Never imported by the app.
 */
import { createRoot } from 'react-dom/client';
import type { Frame } from '../../engine/frames.ts';
import type { FrameSource } from '../frameStore.ts';
import { HurricaneView } from '../HurricaneView.tsx';
import { HurricaneRenderer } from '../hurricane.ts';
import type { HurricaneUniforms } from '../bindings.ts';
import { SpectrumView } from '../SpectrumView.tsx';
import type { Quality } from '../params.ts';
import {
  allNullSlow,
  bandsOnly,
  cascade,
  heartFrame,
  nullHeart,
  octaveCascadeFrame,
  phiCascadeFrame,
  slowFrame,
  track,
} from './fixtures.ts';

type Scenario = 'null' | 'static-rot' | 'static-norot' | 'phi' | 'octave' | 'bands' | 'phi-heart' | 'stop';

const listeners = new Set<(f: Frame) => void>();
const source: FrameSource = {
  subscribe(l) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
const emit = (f: Frame) => listeners.forEach((l) => l(f));

let scenario: Scenario = 'stop';
let t0 = 0;
let lastBeat = 0;

/** (c) A golden ratio cascade that builds to 3 steps over 3 s, then holds. */
function phiSequence(t: number): Frame {
  if (t < 1) return bandsOnly(t);
  const tracks = [track(1, 3.8, 5, 'delta'), track(2, 6.15, 7, 'theta'), track(3, 9.95, 11), track(4, 16.1, 6, 'beta')];
  const n = t < 2 ? 2 : t < 3 ? 3 : 4;
  const ids = [1, 2, 3, 4].slice(4 - n);
  return slowFrame({
    t, tracks, dominant: 3,
    phi: cascade('phi', ids, 0.55 + 0.1 * (n - 2), Math.max(0, t - 1)),
    match: 0.85,
  });
}

function tick() {
  const t = performance.now() / 1000 - t0;
  switch (scenario) {
    case 'null':
      emit(allNullSlow(t));
      emit(nullHeart(t));
      break;
    case 'static-rot':
      emit(phiCascadeFrame(10, 3, 40));
      break;
    case 'static-norot':
      emit(phiCascadeFrame(10, null, 40));
      break;
    case 'bands':
      emit(bandsOnly(10, null));
      break;
    case 'phi':
      emit(phiSequence(t));
      break;
    case 'octave':
      emit(octaveCascadeFrame(t, 2, Math.max(0, t)));
      break;
    case 'phi-heart': {
      emit(phiCascadeFrame(t, 3, 30 + t));
      const beats = t - lastBeat >= 0.9 ? [{ t, ibi: 900 }] : [];
      if (beats.length) lastBeat = t;
      emit(heartFrame(t, beats, (t * 2 * Math.PI) / 10));
      break;
    }
    case 'stop':
      break;
  }
}

setInterval(tick, 250);

function App({ quality }: { quality: Quality }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: '1fr', height: '100%' }}>
      <HurricaneView source={source} quality={quality} />
    </div>
  );
}

const params = new URLSearchParams(location.search);
const root = createRoot(document.getElementById('root')!);
if (params.get('view') === 'spectrum') {
  root.render(
    <div style={{ height: '100%' }}>
      <SpectrumView source={source} site={params.get('site') ?? 'temporal'} />
    </div>,
  );
} else {
  root.render(<App quality={(params.get('quality') as Quality) ?? 'medium'} />);
}

/** Draw cost at a given size: the shader at full resolution, GPU work waited for with finish(). */
function bench(w: number, h: number, n: number): { meanMs: number; p95Ms: number; api: string | null } {
  const c = document.createElement('canvas');
  c.style.cssText = `position:absolute;left:-99999px;width:${w}px;height:${h}px`;
  document.body.appendChild(c);
  const r = new HurricaneRenderer(c, 'high');
  r.resize(w, h, 1);
  const u: HurricaneUniforms = {
    rotation: 0, armCount: 4, armBrightness: [0.4, 0.6, 0.9, 0.5, 0, 0, 0, 0], winding: 1.2,
    bandCount: 2, bandBrightness: [0.3, 0.5, 0, 0, 0, 0, 0, 0], ring: 0.5, eye: 0.8, symmetry: 0.1,
    pulse: 0.3, swell: 1.01,
  };
  const times: number[] = [];
  r.draw(u, true);
  r.finish();
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    r.draw({ ...u, rotation: i * 0.01 }, true);
    r.finish();
    times.push(performance.now() - s);
  }
  const api = r.api;
  r.dispose();
  c.remove();
  times.sort((a, b) => a - b);
  return { meanMs: times.reduce((a, b) => a + b, 0) / n, p95Ms: times[Math.floor(n * 0.95)], api };
}

/** Intervals between animation frames of the live view, ms. */
function rafIntervals(n: number): Promise<number[]> {
  return new Promise((resolve) => {
    const out: number[] = [];
    let last = performance.now();
    const step = () => {
      const t = performance.now();
      out.push(t - last);
      last = t;
      if (out.length < n) requestAnimationFrame(step);
      else resolve(out);
    };
    requestAnimationFrame(step);
  });
}

declare global {
  interface Window {
    hb: {
      setScenario(s: Scenario): void;
      bench: typeof bench;
      rafIntervals: typeof rafIntervals;
    };
  }
}

window.hb = {
  setScenario(s) {
    scenario = s;
    t0 = performance.now() / 1000;
    lastBeat = -10;
    tick();
  },
  bench,
  rafIntervals,
};
