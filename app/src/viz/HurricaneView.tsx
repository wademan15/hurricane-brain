/**
 * The hurricane, live. Subscribes to engine frames, maps them through the binding table
 * (bindings.ts) and draws with the WebGL renderer (hurricane.ts).
 *
 * - Redraws only when a bound parameter changed: a still measurement is a still picture.
 * - Pauses while the page is hidden. Frames keep arriving; staleness is judged on wall time, so a
 *   long pause comes back as "no data" until fresh frames arrive.
 * - Survives WebGL context loss.
 * - Accessibility:
 *   - The picture is a `role="img"` whose name is one sentence describing the measured state.
 *     The same sentence goes to a polite live region when the state changes (not every frame);
 *     the app can turn that off with `announce={false}`.
 *   - Every part of the storm is reachable by keyboard: a list of buttons ("Parts of the storm")
 *     named with the measurement bound to each, shown when it has focus.
 *   - The readout is a separate labelled region (not inside the img). Focus moves to its heading
 *     when it opens and returns where it was when it closes. Escape closes it.
 * - Tap or click anywhere on the picture: the same readout for the part under the pointer.
 * - Colours, fonts, sizes and the readout's position come from CSS custom properties
 *   (README, "Theme tokens").
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { computeVisualState, toUniforms, type VisualState, type VizOptions } from './bindings.ts';
import { FrameStore, type FrameSource } from './frameStore.ts';
import { HurricaneRenderer, STORM_RADIUS_FRACTION } from './hurricane.ts';
import { VIZ_SMOOTHING, type ChanceDriver, type Motion, type Quality } from './params.ts';
import {
  chanceInWords,
  describeState,
  EXCESS_NOTE,
  fmtBound,
  fmtMeasured,
  listParts,
  partAt,
  readoutFor,
  type Readout,
  type StormPart,
} from './readout.ts';
import { themeFromCss } from './theme.ts';
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
  /**
   * Which chance level drives winding, rings and the combined state: 'a' (random peaks, default)
   * or 'b' (own wandering). The readout always shows both.
   */
  chance?: ChanceDriver;
  /**
   * 'auto' (default) follows the system's prefers-reduced-motion. 'reduced': slow capped drift,
   * softer pulses. Both are driven only by measurements.
   */
  motion?: Motion | 'auto';
  /**
   * Announce state changes ("Hurricane: golden ratio chain of 3 peaks, holding; octave: none.")
   * through a polite live region. Default true. The picture's text alternative is always kept.
   */
  announce?: boolean;
  /** Seconds a new state must hold before it is announced (avoids chatter). Default 2. */
  announceDelayS?: number;
  /**
   * When the keyboard list of storm parts is visible: 'focus' (default: only while one of its
   * buttons has focus), 'always', or 'never' (still reachable by screen readers).
   */
  partsVisible?: 'focus' | 'always' | 'never';
  /** Show engine field paths in the readout from the start (the readout has its own toggle). */
  showFieldNames?: boolean;
  /** Extra class on the readout region, for the app shell to position it. */
  readoutClassName?: string;
}

const now = (): number => performance.now() / 1000;

interface Probe {
  x: number;
  y: number;
}

function useReducedMotionQuery(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

const partsSignature = (ps: StormPart[]) => ps.map((p) => `${p.key}=${p.name}`).join('|');

export function HurricaneView({
  source,
  quality = 'medium',
  className,
  style,
  onReadout,
  chance = 'a',
  motion = 'auto',
  announce = true,
  announceDelayS = 2,
  partsVisible = 'focus',
  showFieldNames = false,
  readoutClassName,
}: HurricaneViewProps) {
  const systemReduced = useReducedMotionQuery();
  const resolvedMotion: Motion = motion === 'auto' ? (systemReduced ? 'reduced' : 'full') : motion;
  const optionsRef = useRef<VizOptions>({ chance, motion: resolvedMotion });
  useEffect(() => {
    optionsRef.current = { chance, motion: resolvedMotion };
  }, [chance, resolvedMotion]);

  const rootRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<HurricaneRenderer | null>(null);
  const stateRef = useRef<VisualState | null>(null);
  const readoutKeyRef = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onReadoutRef = useRef(onReadout);
  const qualityRef = useRef(quality);
  const announceRef = useRef({ on: announce, delay: announceDelayS });
  const [message, setMessage] = useState<string | null>('No data');
  const [description, setDescription] = useState('Hurricane: no data.');
  const [announcement, setAnnouncement] = useState('');
  const [parts, setParts] = useState<StormPart[]>([]);
  const [glProblem, setGlProblem] = useState<string | null>(null);
  const [readout, setReadoutState] = useState<Readout | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const ids = useId();

  useEffect(() => {
    onReadoutRef.current = onReadout;
  }, [onReadout]);
  useEffect(() => {
    announceRef.current = { on: announce, delay: announceDelayS };
  }, [announce, announceDelayS]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const picture = pictureRef.current;
    const root = rootRef.current;
    if (!canvas || !picture || !root) return;

    const store = new FrameStore(VIZ_SMOOTHING.PULSE_MIN_INTERVAL_S, now);
    const unsubscribe = source.subscribe((f) => store.push(f));

    let renderer: HurricaneRenderer | null = null;
    try {
      renderer = new HurricaneRenderer(canvas, qualityRef.current);
      if (!renderer.ok) setGlProblem('This device cannot draw the storm (WebGL is unavailable). The readouts still work.');
    } catch (e) {
      setGlProblem(`The storm could not be drawn: ${(e as Error).message}`);
    }
    rendererRef.current = renderer;

    const resize = () => {
      const rect = picture.getBoundingClientRect();
      renderer?.setTheme(themeFromCss(root));
      renderer?.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(picture);
    resize();

    const onLost = () => setGlProblem('Graphics paused: the browser reclaimed the graphics context.');
    const onRestored = () => setGlProblem(null);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    let raf = 0;
    let lastMsg: string | null | undefined;
    let lastDesc = '';
    let pendingDesc = '';
    let pendingSince = 0;
    let announced = '';
    let lastFramesSig = '';
    let lastReadoutAt = 0;
    let lastPartsSig = '';
    let lastPartsAt = -Infinity;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = now();
      const s = computeVisualState(stateRef.current, store.snapshot(), t, optionsRef.current);
      stateRef.current = s;
      renderer?.draw(toUniforms(s));
      if (s.message !== lastMsg) {
        lastMsg = s.message;
        setMessage(s.message);
      }
      // Text alternative: only when the sentence changes.
      const d = describeState(s);
      if (d !== lastDesc) {
        lastDesc = d;
        setDescription(d);
      }
      // Live region: only once a changed sentence has held for the announce delay.
      if (d !== pendingDesc) {
        pendingDesc = d;
        pendingSince = t;
      } else if (announceRef.current.on && d !== announced && t - pendingSince >= announceRef.current.delay) {
        announced = d;
        setAnnouncement(d);
      }
      // The open readout follows new frames; the keyboard part names update at most once a second.
      const snap = store.snapshot();
      const framesSig = `${snap.slowAt},${snap.heartAt}`;
      if (framesSig !== lastFramesSig || t - lastReadoutAt >= 1) {
        lastFramesSig = framesSig;
        lastReadoutAt = t;
        const key = readoutKeyRef.current;
        if (key) setReadoutState(readoutFor(s, key));
      }
      if (t - lastPartsAt >= 1) {
        lastPartsAt = t;
        const ps = listParts(s);
        const sig = partsSignature(ps);
        if (sig !== lastPartsSig) {
          lastPartsSig = sig;
          setParts(ps);
        }
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
    // Quality changes are applied below without rebuilding the context.
  }, [source]);

  useEffect(() => {
    qualityRef.current = quality;
    rendererRef.current?.setQuality(quality);
  }, [quality]);

  const open = useCallback((key: string, at: Probe | null) => {
    const s = stateRef.current;
    if (!s) return;
    if (!readoutKeyRef.current) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    const r = readoutFor(s, key);
    readoutKeyRef.current = key;
    setReadoutState(r);
    setProbe(at);
    onReadoutRef.current?.(r);
  }, []);

  const close = useCallback(() => {
    readoutKeyRef.current = null;
    setReadoutState(null);
    setProbe(null);
    onReadoutRef.current?.(null);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && back.isConnected) back.focus();
    else rootRef.current?.querySelector<HTMLElement>('.hb-parts button')?.focus();
  }, []);

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const picture = pictureRef.current;
    const s = stateRef.current;
    if (!picture || !s) return;
    const rect = picture.getBoundingClientRect();
    const R = STORM_RADIUS_FRACTION * Math.min(rect.width, rect.height);
    const swell = toUniforms(s).swell;
    const x = (e.clientX - rect.left - rect.width / 2) / R / swell;
    const y = -(e.clientY - rect.top - rect.height / 2) / R / swell;
    open(partAt(s, x, y), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && readoutKeyRef.current) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`hb-hurricane${className ? ` ${className}` : ''}`}
      style={style}
      onKeyDown={onKeyDown}
      data-parts={partsVisible}
    >
      <div
        ref={pictureRef}
        className="hb-hurricane-picture"
        role="img"
        aria-label={description}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="hb-hurricane-canvas" aria-hidden="true" />
        {message && (
          <div className="hb-calm-message" aria-hidden="true">
            {message}
          </div>
        )}
        {probe && readout && <div className="hb-probe" style={{ left: probe.x, top: probe.y }} aria-hidden="true" />}
      </div>
      <div className="hb-sr-only" aria-live="polite" aria-atomic="true">
        {announce ? announcement : ''}
      </div>
      {glProblem && (
        <div className="hb-gl-problem" role="status">
          {glProblem}
        </div>
      )}
      <nav className="hb-parts" aria-label="Parts of the storm">
        <ul>
          {parts.map((p) => (
            <li key={p.key}>
              <button type="button" onClick={() => open(p.key, null)} aria-pressed={readout?.key === p.key}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {readout && (
        <ReadoutPanel
          r={readout}
          onClose={close}
          headingId={`${ids}-readout-title`}
          className={readoutClassName}
          initialShowFields={showFieldNames}
        />
      )}
    </div>
  );
}

function ReadoutPanel({
  r,
  onClose,
  headingId,
  className,
  initialShowFields,
}: {
  r: Readout;
  onClose: () => void;
  headingId: string;
  className?: string;
  initialShowFields: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [showFields, setShowFields] = useState(initialShowFields);
  // Move focus into the readout when it opens, and when it switches to another part.
  useEffect(() => {
    headingRef.current?.focus();
  }, [r.key]);

  return (
    <section className={`hb-readout${className ? ` ${className}` : ''}`} aria-labelledby={headingId}>
      <header>
        <h3 id={headingId} ref={headingRef} tabIndex={-1}>
          {r.element}
        </h3>
        <button type="button" onClick={onClose} aria-label="Close readout">
          ×
        </button>
      </header>
      <p className="hb-readout-summary">{r.summary}</p>
      {r.chanceLines.length > 0 && (
        <ul className="hb-readout-chance">
          {r.chanceLines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <table className="hb-readout-bindings">
        <thead>
          <tr>
            <th scope="col">What you see</th>
            <th scope="col">Measured</th>
          </tr>
        </thead>
        <tbody>
          {r.bindings.map((b) => (
            <tr key={b.key}>
              <th scope="row">
                {b.label}
                {showFields && <code>{b.field}</code>}
              </th>
              <td className={b.measured === null ? 'hb-null' : undefined}>{fmtBound(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.alignment && (
        <table className="hb-readout-alignment">
          <thead>
            <tr>
              <th scope="col">
                <span className="hb-sr-only">Measure</span>
              </th>
              {r.alignment.map((a) => (
                <th scope="col" key={a.label}>
                  {a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label="Steps in cascade" cells={r.alignment.map((a) => String(a.steps))} />
            <Row label="As often as this by chance: random peaks (A)" cells={r.alignment.map((a) => chanceInWords(a.chanceAp))} />
            <Row label="As often as this by chance: own wandering (B)" cells={r.alignment.map((a) => chanceInWords(a.chanceBp))} />
            <Row label="Alignment (closeness, 0 to 1)" cells={r.alignment.map((a) => fmtMeasured(a.closeness))} />
            <Row label="Typical by chance A" cells={r.alignment.map((a) => fmtMeasured(a.chanceA))} />
            <Row label="Typical by chance B" cells={r.alignment.map((a) => fmtMeasured(a.chanceB))} />
            <Row label={`Beyond chance A (${EXCESS_NOTE})`} cells={r.alignment.map((a) => fmtMeasured(a.excessA))} />
            <Row label={`Beyond chance B (${EXCESS_NOTE})`} cells={r.alignment.map((a) => fmtMeasured(a.excessB))} />
            <Row label="Held" cells={r.alignment.map((a) => `${a.heldS.toFixed(1)} s`)} />
            <Row label="State" cells={r.alignment.map((a) => (a.active ? 'holding' : 'not holding'))} />
            {r.both && (
              <tr>
                <th scope="row">Both at once</th>
                <td colSpan={2}>{r.both.active ? `holding for ${r.both.forS.toFixed(1)} s` : 'not holding'}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <p className="hb-readout-note">{r.designNote}</p>
      <button type="button" className="hb-readout-toggle" onClick={() => setShowFields((v) => !v)} aria-pressed={showFields}>
        {showFields ? 'Hide technical names' : 'Show technical names'}
      </button>
    </section>
  );
}

function Row({ label, cells }: { label: string; cells: string[] }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {cells.map((c, i) => (
        <td key={i} className={c.startsWith('not measured') ? 'hb-null' : undefined}>
          {c}
        </td>
      ))}
    </tr>
  );
}
