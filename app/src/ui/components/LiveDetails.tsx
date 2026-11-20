import type { SlowFrame } from '../../engine/frames';
import { Val } from './kit';

/** Pair table: each pair's ratio, and its closeness to each target side by side (golden, octave and the two controls). */
export function PairTable({ slow, harmonicsCount }: { slow: SlowFrame | null; harmonicsCount: boolean }) {
  if (!slow) return <p className="dim">Pairs: not measured (no frames arriving).</p>;
  const name = (id: number) => {
    const t = slow.tracks.find((x) => x.id === id);
    return t ? `${t.band} ${t.freq_integrated.v !== null ? t.freq_integrated.v.toFixed(1) : '?'} Hz` : `#${id}`;
  };
  if (!slow.pairs.length) return <p className="dim">No pairs of confirmed peaks yet, so no ratios are measured.</p>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Pairs of peaks, scrolls sideways">
      <table>
        <thead>
          <tr>
            <th>Pair (low, high)</th>
            <th>Ratio (natural log)</th>
            <th>Golden 1.618</th>
            <th>Octave 2</th>
            <th>Control 1.5</th>
            <th>Control 1.8</th>
          </tr>
        </thead>
        <tbody>
          {slow.pairs.map((p) => (
            <tr key={`${p.lo}-${p.hi}`}>
              <td>
                {name(p.lo)}, {name(p.hi)}
                {p.harmonic ? <div className="small faint">{harmonicsCount ? 'possible harmonic, counted as you chose' : 'possible harmonic, not counted'}</div> : null}
              </td>
              <td>
                <Val m={p.log_ratio} />
              </td>
              {(['phi', 'octave', 'control_1_5', 'control_1_8'] as const).map((t) => (
                <td key={t}>
                  <Val m={p.targets[t].closeness} />
                  {p.targets[t].aligned ? <div className="small">aligned</div> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small dim">Closeness runs 0 to 1. The controls (1.5 and 1.8) are ratios with no special claim, scored the same way, to show what an ordinary ratio gets.</p>
    </div>
  );
}

export function HemisphereTable({ slow }: { slow: SlowFrame | null }) {
  if (!slow || !slow.hemispheres.length) return <p className="dim">Left and right comparison: not measured (needs a confirmed peak on both sides).</p>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Left and right comparison, scrolls sideways">
      <table>
        <thead>
          <tr><th>Peak</th><th>Frequency difference L-R</th><th>Amplitude balance</th><th>Locking beyond a time-shifted copy</th><th>Left and right peak match</th></tr>
        </thead>
        <tbody>
          {slow.hemispheres.map((h) => {
            const t = slow.tracks.find((x) => x.id === h.track);
            return (
              <tr key={h.track}>
                <td>{t ? `${t.band} ${t.freq_integrated.v?.toFixed(1) ?? '?'} Hz` : `#${h.track}`}</td>
                <td><Val m={h.freq_diff} unit="Hz" /></td>
                <td><Val m={h.balance} /></td>
                <td><Val m={h.locking_excess} /></td>
                <td><Val m={h.match} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small dim">All sensors share one reference electrode, which inflates measured locking between them, and locking at zero delay cannot be told apart from that shared reference. Read the match as a rough guide, not as proof of two sides working together.</p>
    </div>
  );
}
