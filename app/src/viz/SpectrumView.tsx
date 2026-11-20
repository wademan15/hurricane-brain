/**
 * Live spectrum for one site: measured spectrum with the fitted background, the flattened
 * spectrum (spectrum / background), confirmed peaks with frequency and uncertainty, band edges,
 * and marker lines where a golden ratio or octave partner of each confirmed peak would sit.
 *
 * Redraws only when a slow frame arrives (or the size changes). Nothing animates.
 * The frequency axis is logarithmic, so equal ratios are equal distances: a golden ratio
 * partner is always the same distance from its peak, and an octave partner a longer one.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BandName, SlowFrame, Track } from '../engine/frames.ts';
import { FrameStore, type FrameSource } from './frameStore.ts';
import { VIZ_SMOOTHING } from './params.ts';
import { fmtNumber } from './readout.ts';
import { reasonText, type VizReason } from './reasons.ts';
import './viz.css';

export interface SpectrumViewProps {
  source: FrameSource;
  /** Channel name ('TP9', 'AF7', ...) or composite ('temporal', 'frontal', 'all'). */
  site: string;
  className?: string;
  style?: CSSProperties;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const F_MIN = 1;
const F_MAX = 45;
const COL = {
  bg: '#03060c',
  grid: 'rgba(140,165,200,0.12)',
  axis: '#7d8aa0',
  ink: '#c9d4e3',
  psd: '#a9bedb',
  fit: '#7d8aa0',
  flat: '#d6e2f2',
  peak: '#ffffff',
  phi: '#e2b86b',
  octave: '#6fc7c0',
  band: ['rgba(120,140,190,0.07)', 'rgba(120,140,190,0.0)'],
};

const now = (): number => performance.now() / 1000;

export function SpectrumView({ source, site, className, style }: SpectrumViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<SlowFrame | null>(null);
  const [stale, setStale] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const store = new FrameStore(VIZ_SMOOTHING.PULSE_MIN_INTERVAL_S, now);
    const unsub = source.subscribe((f) => {
      if (f.kind !== 'slow') return;
      store.push(f);
      setFrame(f);
      setStale(false);
    });
    // Staleness check only: flips the view to "not measured" when frames stop arriving.
    const id = window.setInterval(() => {
      const s = store.snapshot();
      setStale(s.slowAt === null || now() - s.slowAt > VIZ_SMOOTHING.SLOW_STALE_S);
    }, 500);
    return () => {
      unsub();
      window.clearInterval(id);
    };
  }, [source]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      setSize({ w: r.width, h: r.height, dpr: Math.min(window.devicePixelRatio || 1, 2) });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || size.w === 0) return;
    c.width = Math.round(size.w * size.dpr);
    c.height = Math.round(size.h * size.dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    drawSpectrum(ctx, size.w, size.h, stale ? null : frame, site, frame === null ? 'no_data' : 'stale');
  }, [frame, stale, site, size]);

  const spec = frame?.spectra.find((s) => s.site === site);
  const label =
    !frame || stale
      ? `Spectrum at ${site}: not measured (no data)`
      : !spec || spec.why !== 'ok'
        ? `Spectrum at ${site}: not measured (${reasonText(spec?.why ?? 'not_available')})`
        : `Spectrum at ${site} with ${frame.tracks.filter((t) => t.state === 'confirmed').length} confirmed peaks`;

  return (
    <div ref={wrapRef} className={`hb-spectrum${className ? ` ${className}` : ''}`} style={style}>
      <canvas ref={canvasRef} role="img" aria-label={label} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const db = (x: number): number => 10 * Math.log10(x);

export function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: SlowFrame | null,
  site: string,
  missingWhy: VizReason,
): void {
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';

  const spec = frame?.spectra.find((s) => s.site === site) ?? null;
  const why: VizReason = !frame ? missingWhy : !spec ? 'not_available' : spec.why;
  if (!frame || !spec || spec.why !== 'ok' || spec.psd.length === 0) {
    ctx.fillStyle = COL.axis;
    ctx.textAlign = 'center';
    ctx.fillText(`Spectrum at ${site}: not measured`, w / 2, h / 2 - 10);
    ctx.fillText(reasonText(why === 'ok' ? 'not_available' : why), w / 2, h / 2 + 10);
    return;
  }

  const padL = 44;
  const padR = 12;
  const padT = 22;
  const padB = 26;
  const gap = 18;
  const plotW = Math.max(10, w - padL - padR);
  const topH = Math.max(20, (h - padT - padB - gap) * 0.5);
  const botH = Math.max(20, h - padT - padB - gap - topH);
  const topY = padT;
  const botY = padT + topH + gap;

  const lx0 = Math.log(F_MIN);
  const lx1 = Math.log(F_MAX);
  const X = (f: number) => padL + ((Math.log(f) - lx0) / (lx1 - lx0)) * plotW;

  const freqs = spec.psd.map((_, i) => spec.f0 + i * spec.df);
  const idx = freqs.map((f, i) => [f, i] as const).filter(([f]) => f >= F_MIN && f <= F_MAX);

  // Band edges in force (shaded, labelled).
  const bandNames: BandName[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  bandNames.forEach((b, k) => {
    const [lo, hi] = frame.band_edges[b];
    const x0 = X(Math.max(lo, F_MIN));
    const x1 = X(Math.min(hi, F_MAX));
    ctx.fillStyle = COL.band[k % 2];
    ctx.fillRect(x0, topY, x1 - x0, botY + botH - topY);
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(x0, topY);
    ctx.lineTo(x0, botY + botH);
    ctx.stroke();
    ctx.fillStyle = COL.axis;
    ctx.textAlign = 'center';
    ctx.fillText(b, (x0 + x1) / 2, topY - 10);
  });

  // Top: power spectral density and fitted background, dB re 1 uV^2/Hz.
  const psdDb = idx.map(([, i]) => db(Math.max(spec.psd[i], 1e-12)));
  const exp = spec.bg_exponent.v;
  const off = spec.bg_offset.v;
  const bgDb = exp !== null && off !== null ? idx.map(([f]) => 10 * (off - exp * Math.log10(f))) : null;
  const all = bgDb ? psdDb.concat(bgDb) : psdDb;
  const yMin = Math.floor(Math.min(...all) / 5) * 5;
  const yMax = Math.ceil(Math.max(...all) / 5) * 5;
  const YT = (v: number) => topY + topH - ((v - yMin) / Math.max(1e-6, yMax - yMin)) * topH;
  axisY(ctx, padL, topY, topH, yMin, yMax, YT, 'dB µV²/Hz');
  line(ctx, idx.map(([f], k) => [X(f), YT(psdDb[k])]), COL.psd, 1.4);
  if (bgDb) {
    ctx.setLineDash([5, 4]);
    line(ctx, idx.map(([f], k) => [X(f), YT(bgDb[k])]), COL.fit, 1.2);
    ctx.setLineDash([]);
    ctx.fillStyle = COL.axis;
    ctx.textAlign = 'right';
    ctx.fillText(
      `background 1/f^${fmtNumber(exp!, spec.bg_exponent.se, '')}`,
      padL + plotW, topY + 8,
    );
  } else {
    ctx.fillStyle = COL.axis;
    ctx.textAlign = 'right';
    ctx.fillText(`background: not measured (${reasonText(spec.bg_exponent.why)})`, padL + plotW, topY + 8);
  }

  // Bottom: flattened spectrum, dB above the fitted background.
  const flatDb = idx.map(([, i]) => db(Math.max(spec.flat[i] ?? 1, 1e-6)));
  const confirmed = frame.tracks.filter((t) => t.state === 'confirmed' && t.freq.v !== null);
  const fMax = Math.max(6, ...flatDb, ...confirmed.map((t) => t.height_db.v ?? 0));
  const fMin = Math.min(-2, ...flatDb);
  const YB = (v: number) => botY + botH - ((v - fMin) / (fMax + 2 - fMin)) * botH;
  axisY(ctx, padL, botY, botH, fMin, fMax + 2, YB, 'dB above bg');
  ctx.strokeStyle = COL.grid;
  ctx.beginPath();
  ctx.moveTo(padL, YB(0));
  ctx.lineTo(padL + plotW, YB(0));
  ctx.stroke();

  // Partner markers: where a golden ratio or octave partner of each confirmed peak would sit.
  for (const t of confirmed) {
    const f = t.freq.v!;
    for (const [pf, col, dash] of [
      [f * PHI, COL.phi, [3, 3]], [f / PHI, COL.phi, [3, 3]],
      [f * 2, COL.octave, [1, 3]], [f / 2, COL.octave, [1, 3]],
    ] as [number, string, number[]][]) {
      if (pf < F_MIN || pf > F_MAX) continue;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(X(pf), botY);
      ctx.lineTo(X(pf), botY + botH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  line(ctx, idx.map(([f], k) => [X(f), YB(flatDb[k])]), COL.flat, 1.4);

  // Confirmed peaks: marker, uncertainty bar (±1 standard error), label.
  ctx.textAlign = 'center';
  const placed: number[] = [];
  for (const t of confirmed) {
    drawPeak(ctx, t, site, X, YB, placed);
  }

  // Frequency axis.
  ctx.fillStyle = COL.axis;
  ctx.textAlign = 'center';
  for (const f of [1, 2, 4, 6, 8, 10, 13, 20, 30, 45]) {
    ctx.fillText(`${f}`, X(f), botY + botH + 12);
  }
  ctx.textAlign = 'right';
  ctx.fillText('Hz', padL + plotW, botY + botH + 12);

  // Legend.
  ctx.textAlign = 'left';
  const ly = botY + 9;
  ctx.fillStyle = COL.phi;
  ctx.fillText('golden ratio partner', padL + 6, ly);
  ctx.fillStyle = COL.octave;
  ctx.fillText('octave partner', padL + 136, ly);
}

function drawPeak(
  ctx: CanvasRenderingContext2D,
  t: Track,
  site: string,
  X: (f: number) => number,
  YB: (v: number) => number,
  placed: number[],
): void {
  const f = t.freq.v!;
  const se = t.freq.se ?? null;
  const hdb = t.height_db.v;
  const x = X(f);
  const y = hdb !== null ? YB(hdb) : YB(0);
  const here = t.site === site;
  ctx.globalAlpha = here ? 1 : 0.5;
  ctx.strokeStyle = COL.peak;
  ctx.fillStyle = COL.peak;
  if (se !== null && se > 0) {
    const x0 = X(Math.max(F_MIN, f - se));
    const x1 = X(f + se);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - 4);
    ctx.lineTo(x0, y + 4);
    ctx.moveTo(x1, y - 4);
    ctx.lineTo(x1, y + 4);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fill();
  // Stack labels that would overlap.
  let ly = y - 14;
  while (placed.some((p) => Math.abs(p - x) < 70) && ly > 30) ly -= 14;
  placed.push(x);
  ctx.fillText(`${fmtNumber(f, se, 'Hz')}${here ? '' : ` (${t.site})`}`, x, ly);
  ctx.globalAlpha = 1;
}

function line(ctx: CanvasRenderingContext2D, pts: [number, number][], col: string, width: number): void {
  if (pts.length === 0) return;
  ctx.strokeStyle = col;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function axisY(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hgt: number,
  lo: number,
  hi: number,
  Y: (v: number) => number,
  unit: string,
): void {
  ctx.fillStyle = COL.axis;
  ctx.textAlign = 'right';
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    ctx.fillText(`${Math.round(v)}`, x - 6, Y(v));
  }
  ctx.save();
  ctx.translate(10, y + hgt / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(unit, 0, 0);
  ctx.restore();
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
