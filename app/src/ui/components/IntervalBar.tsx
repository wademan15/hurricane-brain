/** A confidence interval drawn against zero. Static: it shows stored estimates, nothing live. */
export function IntervalBar({ mean, lo, hi, scale = 1 }: { mean: number; lo: number; hi: number; scale?: number }) {
  const W = 160;
  const x = (v: number) => W / 2 + (Math.max(-scale, Math.min(scale, v)) / scale) * (W / 2 - 6);
  return (
    <svg width={W} height="22" viewBox={`0 0 ${W} 22`} role="img" aria-label={`Estimate ${mean.toFixed(2)}, interval ${lo.toFixed(2)} to ${hi.toFixed(2)}`}>
      <line x1={W / 2} y1="2" x2={W / 2} y2="20" stroke="currentColor" strokeOpacity="0.4" />
      <line x1={x(lo)} y1="11" x2={x(hi)} y2="11" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
      <circle cx={x(mean)} cy="11" r="4.5" fill="var(--accent)" />
    </svg>
  );
}
