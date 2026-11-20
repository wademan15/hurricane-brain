import type { KeyRow } from '../../storage';
import { reasonPlain } from '../measured';

/**
 * One key measure over the session, drawn from the stored per-second rows. A second with no
 * measurement leaves a gap in the line: nothing is interpolated or carried over.
 */
export function KeyChart({ rows, col, label, unit }: { rows: KeyRow[]; col: string; label: string; unit: string }) {
  const W = 600;
  const H = 90;
  const pts = rows.map((r) => ({ t: r.t, v: r.cells[col]?.v ?? null, block: r.block }));
  const vals = pts.filter((p) => p.v !== null).map((p) => p.v as number);
  if (!pts.length || !vals.length) {
    const codes = [...new Set(rows.map((r) => r.cells[col]?.why).filter((w): w is NonNullable<typeof w> => !!w && w !== 'ok'))].slice(0, 2);
    const why = codes.length ? codes.map((c) => reasonPlain(c)).join(', ') : 'nothing was recorded for it';
    return (
      <div className="small dim" style={{ margin: '6px 0' }}>
        <strong>{label}</strong>: not measured in this session ({why}).
      </div>
    );
  }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t || t0 + 1;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) {
    lo -= 0.5;
    hi += 0.5;
  }
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 8) + 4;
  const y = (v: number) => H - 6 - ((v - lo) / (hi - lo)) * (H - 14);
  const segs: string[] = [];
  let cur = '';
  for (const p of pts) {
    if (p.v === null) {
      if (cur) segs.push(cur);
      cur = '';
    } else cur += `${cur ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
  }
  if (cur) segs.push(cur);
  const bounds: number[] = [];
  for (let i = 1; i < pts.length; i++) if (pts[i].block !== pts[i - 1].block) bounds.push(pts[i].t);
  const measured = vals.length;
  return (
    <figure style={{ margin: '10px 0' }}>
      <figcaption className="small">
        <strong>{label}</strong> <span className="dim">({unit}) measured in {Math.round((measured / pts.length) * 100)}% of seconds; range {lo.toFixed(2)} to {hi.toFixed(2)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${label} over the session`} preserveAspectRatio="none">
        {bounds.map((b) => (
          <line key={b} x1={x(b)} x2={x(b)} y1="0" y2={H} stroke="currentColor" strokeOpacity="0.18" strokeDasharray="3 3" />
        ))}
        {segs.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </figure>
  );
}
