/**
 * Browser end-to-end check of the engine (test only, not shipped; driven by ../e2e.mjs).
 * Creates the real EngineClient (worker + WebAssembly), pushes a fixture in 12-sample packets
 * and summarizes what came back.
 */
import { createEngineClient, type EngineStats, type WorkerEngineClient } from '../../index';
import type { Frame, SlowFrame } from '../../frames';

interface RunOptions {
  /** URL of the fixture without extension (`.json` and `.f32` are fetched). */
  url: string;
  /** 'fast': push everything at once, as fast as possible. 'paced': one packet per 46.875 ms. */
  mode: 'fast' | 'paced';
  /** Seconds of the fixture to use (default: all). */
  seconds?: number;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function dist(xs: number[]) {
  return { n: xs.length, median: quantile(xs, 0.5), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99), max: xs.length ? Math.max(...xs) : NaN };
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function run(opts: RunOptions) {
  const meta = await (await fetch(`${opts.url}.json`)).json();
  const all = new Float32Array(await (await fetch(`${opts.url}.f32`)).arrayBuffer());
  const nch: number = meta.channels.length;
  const rate: number = meta.rate_hz;
  const samples = opts.seconds ? all.subarray(0, Math.round(opts.seconds * rate) * nch) : all;

  const longTasks: number[] = [];
  const obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
  try {
    obs.observe({ type: 'longtask', buffered: false });
  } catch {
    /* not supported */
  }

  const client = createEngineClient() as WorkerEngineClient;
  const t0 = performance.now();
  await client.init({
    streams: { eeg: { channels: meta.channels, rate_hz: rate, bits: 0, model: meta.model ?? '' }, ppg: null, motion: null, chest_strap: null },
    params: meta.params ?? undefined,
    seed: meta.seed ?? 0,
    mains_hz: meta.mains_hz ?? null,
  });
  const initMs = performance.now() - t0;

  const frames: Frame[] = [];
  const texts: string[] = [];
  let listenerMs = 0;
  client.subscribe((f) => {
    const a = performance.now();
    frames.push(f);
    texts.push(JSON.stringify(f));
    listenerMs += performance.now() - a;
  });

  const per = 12 * nch;
  const packets = Math.ceil(samples.length / per);
  const start = performance.now();
  let idx = 0;
  if (opts.mode === 'fast') {
    for (let p = 0; p < packets; p++) {
      const chunk = samples.subarray(p * per, Math.min((p + 1) * per, samples.length));
      client.pushEeg(idx, chunk);
      idx += chunk.length / nch;
    }
  } else {
    const period = (12 / rate) * 1000;
    for (let p = 0; p < packets; p++) {
      const due = start + p * period;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const chunk = samples.subarray(p * per, Math.min((p + 1) * per, samples.length));
      client.pushEeg(idx, chunk);
      idx += chunk.length / nch;
    }
  }
  const pushedMs = performance.now() - start;
  const info = await client.info(); // answered after every earlier push has been processed and delivered
  const totalMs = performance.now() - start;
  obs.disconnect();

  const st: EngineStats = client.stats();
  const slow = frames.filter((f): f is SlowFrame => f.kind === 'slow');
  const fast = frames.filter((f) => f.kind === 'fast');
  const last = slow[slow.length - 1];
  const confirmedEver = new Set<number>();
  for (const s of slow) for (const t of s.tracks) if (t.state === 'confirmed') confirmedEver.add(t.id);
  const slowMsgs = st.has_slow.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  const fastMsgs = st.has_slow.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0);
  const pick = (arr: number[], idxs: number[]) => idxs.map((i) => arr[i]);
  const summary = {
    version: info.version,
    params: Object.keys(info.params).length,
    init_ms: initMs,
    data_s: samples.length / nch / rate,
    pushes: packets,
    push_loop_ms: pushedMs,
    total_ms: totalMs,
    x_realtime: samples.length / nch / rate / (totalMs / 1000),
    frames: frames.length,
    slow: slow.length,
    fast: fast.length,
    in_order: frames.every((f, i) => i === 0 || f.t >= frames[i - 1].t),
    hash: await sha256(texts.join('\n')),
    last: last && {
      t: last.t,
      tracks: last.tracks.map((t) => ({ id: t.id, state: t.state, f: t.freq_integrated.v, h: t.height_db.v })),
      phi: { tracks: last.cascades.phi.tracks, steps: last.cascades.phi.steps, closeness: last.cascades.phi.closeness.v, chance_a: last.cascades.phi.chance.a.closeness.v },
      octave: { steps: last.cascades.octave.steps },
    },
    confirmed_ever: confirmedEver.size,
    max_phi_steps: Math.max(0, ...slow.map((s) => s.cascades.phi.steps)),
    max_octave_steps: Math.max(0, ...slow.map((s) => s.cascades.octave.steps)),
    phi_active_frames: slow.filter((s) => s.states.phi.active).length,
    timing: {
      latency_all_ms: dist(st.latency_ms),
      latency_slow_ms: dist(pick(st.latency_ms, slowMsgs)),
      latency_fast_only_ms: dist(pick(st.latency_ms, fastMsgs)),
      push_slow_ms: dist(pick(st.push_ms, slowMsgs)),
      push_fast_only_ms: dist(pick(st.push_ms, fastMsgs)),
      drain_slow_ms: dist(pick(st.drain_ms, slowMsgs)),
      drain_fast_only_ms: dist(pick(st.drain_ms, fastMsgs)),
      parse_slow_ms: dist(pick(st.parse_ms, slowMsgs)),
      parse_fast_only_ms: dist(pick(st.parse_ms, fastMsgs)),
      listener_total_ms: listenerMs,
      main_long_tasks_ms: longTasks,
    },
    error: st.error,
  };
  client.dispose();
  return summary;
}

declare global {
  interface Window {
    hbE2E: { run: typeof run; ready: boolean };
  }
}
window.hbE2E = { run, ready: true };
document.getElementById('log')!.textContent = 'ready';
