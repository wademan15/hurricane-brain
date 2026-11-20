/// <reference lib="webworker" />
/**
 * The engine worker: hosts the WebAssembly signal engine (crates/hb-wasm) off the UI thread.
 *
 * Every push arrives as one message with its samples in a transferred buffer. After each push
 * the worker drains the engine and, if anything was produced, posts the frames back as one JSON
 * string. Messages are handled strictly in arrival order; pushes that arrive while the
 * WebAssembly module is still loading are queued and run once it is ready.
 */
import initWasm, { HbSession } from '../wasm/pkg/hb_wasm.js';
import wasmUrl from '../wasm/pkg/hb_wasm_bg.wasm?url';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let wasmReady: Promise<unknown> | null = null;
let session: HbSession | null = null;
let dead = false;
const queue: ToWorker[] = [];
let busy = false;

function post(msg: FromWorker): void {
  scope.postMessage(msg);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function drain(seq: number, started: number): void {
  if (!session || session.pending() === 0) return;
  const t1 = performance.now();
  const count = session.pending();
  const json = session.drain();
  post({ op: 'frames', seq, json, count, push_ms: t1 - started, drain_ms: performance.now() - t1 });
}

function handle(msg: ToWorker): void {
  if (msg.op === 'init') {
    session?.free();
    session = null;
    session = new HbSession(JSON.stringify(msg.config));
    post({ op: 'ready', version: session.version() });
    return;
  }
  if (msg.op === 'info') {
    post({ op: 'info', id: msg.id, version: session?.version() ?? '', params: session?.params() ?? '{}' });
    return;
  }
  const s = session;
  if (!s) return; // pushes before init: nothing to feed (EngineClient.init must come first)
  const started = performance.now();
  switch (msg.op) {
    case 'eeg':
      s.pushEeg(msg.i, msg.x);
      drain(msg.seq, started);
      break;
    case 'motion':
      s.pushMotion(msg.t, msg.acc, msg.gyro);
      drain(msg.seq, started);
      break;
    case 'ppg':
      s.pushPpg(msg.t, msg.x);
      drain(msg.seq, started);
      break;
    case 'rr':
      s.pushRr(msg.t, msg.x);
      drain(msg.seq, started);
      break;
    case 'marker':
      s.pushMarker(msg.json);
      break;
    case 'pacer':
      s.setPacer(msg.bpm);
      break;
    case 'iaf':
      s.setIaf(msg.hz);
      break;
    case 'baseline':
      s.markHeartBaseline(msg.t0, msg.t1);
      break;
  }
}

async function pump(): Promise<void> {
  if (busy || dead) return;
  busy = true;
  try {
    if (!wasmReady) wasmReady = initWasm({ module_or_path: wasmUrl });
    await wasmReady;
    while (queue.length > 0 && !dead) {
      const msg = queue.shift() as ToWorker;
      try {
        handle(msg);
      } catch (e) {
        // A Rust panic aborts (unreachable trap): the module's state is no longer trustworthy.
        const fatal = e instanceof WebAssembly.RuntimeError;
        if (fatal) {
          dead = true;
          session = null;
        }
        post({ op: 'error', message: errorText(e), fatal: fatal || msg.op === 'init' });
      }
    }
  } catch (e) {
    dead = true;
    post({ op: 'error', message: `engine module failed to load: ${errorText(e)}`, fatal: true });
  } finally {
    busy = false;
  }
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
  queue.push(ev.data);
  void pump();
};

// Start compiling the module as soon as the worker starts, before the first message.
wasmReady = initWasm({ module_or_path: wasmUrl });
wasmReady.catch(() => undefined); // reported by pump() on the first message
