/**
 * The hurricane, live. Subscribes to engine frames, maps them through the binding table
 * (bindings.ts) and draws with the WebGL renderer (hurricane.ts).
 *
 * - Redraws only when a bound parameter changed: a still measurement is a still picture.
 * - Pauses while the page is hidden. Frames keep arriving; staleness is judged on wall time, so a
 *   long pause comes back as "no data" until fresh frames arrive.
 * - Survives WebGL context loss.
 * - Tap or click anywhere: a readout shows the element hit, the frame field driving it, the
 *   measured number with its uncertainty and units, and golden ratio, octave and chance side by side.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { computeVisualState, toUniforms, type Bound, type VisualState } from './bindings.ts';
import { FrameStore, type FrameSource } from './frameStore.ts';
import { HurricaneRenderer, STORM_RADIUS_FRACTION } from './hurricane.ts';
import { VIZ_SMOOTHING, type Quality } from './params.ts';
import { alignmentRows, fmtBound, fmtMeasured, hitTest, type Readout } from './readout.ts';
import './viz.css';

export interface HurricaneViewProps {
  /** Engine frames. Slow and heart frames are used; fast frames are ignored. */
  source: FrameSource;
  /** Render resolution. Default 'medium' (device pixel ratio capped at 1, at most 1080p). */
  quality?: Quality;
  className?: string;
  style?: CSSProperties;
  /** Called when a readout opens (with it) or closes (null). */
  onReadout?: (r: Readout | null) => void;
}

const now = (): number => performance.now() / 1000;

interface Probe {
  x: number;
  y: number;
}

/** Re-read a readout's bindings from a newer state, keeping the same element. */
function refresh(r: Readout, s: VisualState): Readout {
  const all: Bound[] = [
    s.rotation, s.armCount, s.winding, s.ring, s.bandCount, s.eye, s.symmetry, s.pulse, s.swell, ...s.arms, ...s.bands,
  ];
  const byKey = new Map(all.map((b) => [b.key, b]));
  return {
    ...r,
    bindings: r.bindings.map((b) => byKey.get(b.key) ?? b),
    alignment: r.alignment ? alignmentRows(s) : null,
  };
}

export function HurricaneView({ source, quality = 'medium', className, style, onReadout }: HurricaneViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<HurricaneRenderer | null>(null);
  const stateRef = useRef<VisualState | null>(null);
  const readoutRef = useRef<Readout | null>(null);
  const onReadoutRef = useRef(onReadout);
  const [message, setMessage] = useState<string | null>('No data');
  const [glProblem, setGlProblem] = useState<string | null>(null);
  const [readout, setReadoutState] = useState<Readout | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);

  useEffect(() => {
    onReadoutRef.current = onReadout;
  }, [onReadout]);

  const setReadout = useCallback((r: Readout | null) => {
    readoutRef.current = r;
    setReadoutState(r);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const store = new FrameStore(VIZ_SMOOTHING.PULSE_MIN_INTERVAL_S, now);
    const unsubscribe = source.subscribe((f) => store.push(f));

    let renderer: HurricaneRenderer | null = null;
    try {
      renderer = new HurricaneRenderer(canvas, quality);
      if (!renderer.ok) setGlProblem('This device cannot draw the storm (WebGL is unavailable). The readouts still work.');
    } catch (e) {
      setGlProblem(`The storm could not be drawn: ${(e as Error).message}`);
    }
    rendererRef.current = renderer;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      renderer?.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const onLost = () => setGlProblem('Graphics paused: the browser reclaimed the graphics context.');
    const onRestored = () => setGlProblem(null);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    let raf = 0;
    let lastMsg: string | null | undefined;
    let lastReadoutAt = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = now();
      const s = computeVisualState(stateRef.current, store.snapshot(), t);
      stateRef.current = s;
      renderer?.draw(toUniforms(s));
      if (s.message !== lastMsg) {
        lastMsg = s.message;
        setMessage(s.message);
      }
      const r = readoutRef.current;
      if (r && t - lastReadoutAt >= 0.25) {
        lastReadoutAt = t;
        setReadoutState(refresh(r, s));
      }
    };
    const start = () => {
      if (!raf && document.visibilityState === 'visible') raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    document.addEventListener('visibilitychange', onVis);
    start();

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      ro.disconnect();
      unsubscribe();
      renderer?.dispose();
      rendererRef.current = null;
      stateRef.current = null;
    };
    // The initial quality is read once; later changes are applied below without rebuilding the context.
  }, [source]);

  useEffect(() => {
    rendererRef.current?.setQuality(quality);
  }, [quality]);

  const inspect = useCallback(
    (clientX: number, clientY: number) => {
      const wrap = wrapRef.current;
      const s = stateRef.current;
      if (!wrap || !s) return;
      const rect = wrap.getBoundingClientRect();
      const R = STORM_RADIUS_FRACTION * Math.min(rect.width, rect.height);
      const swell = toUniforms(s).swell;
      const x = (clientX - rect.left - rect.width / 2) / R / swell;
      const y = -(clientY - rect.top - rect.height / 2) / R / swell;
      const r = hitTest(s, x, y);
      setReadout(r);
      setProbe({ x: clientX - rect.left, y: clientY - rect.top });
      onReadoutRef.current?.(r);
    },
    [setReadout],
  );

  const close = useCallback(() => {
    setReadout(null);
    setProbe(null);
    onReadoutRef.current?.(null);
  }, [setReadout]);

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.hb-readout')) return;
    inspect(e.clientX, e.clientY);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' || e.key === ' ') {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect) inspect(rect.left + rect.width / 2, rect.top + rect.height / 2);
      e.preventDefault();
    }
  };

  return (
    <div
      ref={wrapRef}
      className={`hb-hurricane${className ? ` ${className}` : ''}`}
      style={style}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="img"
      aria-label={message ?? 'Hurricane: a picture of measured brain rhythms. Tap any part to see the number behind it.'}
    >
      <canvas ref={canvasRef} className="hb-hurricane-canvas" />
      {message && (
        <div className="hb-calm-message" aria-live="polite">
          {message}
        </div>
      )}
      {glProblem && <div className="hb-gl-problem">{glProblem}</div>}
      {probe && readout && <div className="hb-probe" style={{ left: probe.x, top: probe.y }} aria-hidden="true" />}
      {readout && <ReadoutPanel r={readout} onClose={close} />}
    </div>
  );
}

function ReadoutPanel({ r, onClose }: { r: Readout; onClose: () => void }) {
  return (
    <section className="hb-readout" aria-label={`Readout: ${r.element}`}>
      <header>
        <h3>{r.element}</h3>
        <button type="button" onClick={onClose} aria-label="Close readout">
          ×
        </button>
      </header>
      <p className="hb-readout-summary">{r.summary}</p>
      <table className="hb-readout-bindings">
        <thead>
          <tr>
            <th>What you see</th>
            <th>Measured</th>
          </tr>
        </thead>
        <tbody>
          {r.bindings.map((b) => (
            <tr key={b.key}>
              <td>
                {b.label}
                <code>{b.field}</code>
              </td>
              <td className={b.measured === null ? 'hb-null' : undefined}>{fmtBound(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.alignment && (
        <table className="hb-readout-alignment">
          <thead>
            <tr>
              <th />
              {r.alignment.map((a) => (
                <th key={a.label}>{a.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Steps in cascade</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{a.steps}</td>
              ))}
            </tr>
            <tr>
              <td>Closeness</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{fmtMeasured(a.closeness)}</td>
              ))}
            </tr>
            <tr>
              <td>Chance A (random peaks)</td>
              {r.alignment.map((a) => (
                <td key={a.label}>
                  {fmtMeasured(a.chanceA)}
                  {a.chanceAp.v !== null && <span className="hb-p"> p {fmtMeasured(a.chanceAp)}</span>}
                </td>
              ))}
            </tr>
            <tr>
              <td>Chance B (own wandering)</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{fmtMeasured(a.chanceB)}</td>
              ))}
            </tr>
            <tr>
              <td>Beyond chance A</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{fmtMeasured(a.excessA)}</td>
              ))}
            </tr>
            <tr>
              <td>Beyond chance B</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{fmtMeasured(a.excessB)}</td>
              ))}
            </tr>
            <tr>
              <td>Held</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{a.heldS.toFixed(1)} s</td>
              ))}
            </tr>
            <tr>
              <td>Aligned state</td>
              {r.alignment.map((a) => (
                <td key={a.label}>{a.active ? 'in alignment' : 'not in alignment'}</td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      <p className="hb-readout-note">{r.designNote}</p>
    </section>
  );
}
