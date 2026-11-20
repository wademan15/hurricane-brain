import { getStrategy, type SessionRecord } from '../../training';
import { fmtDuration, numberLine } from '../measured';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : x * 100);

export function BlockTable({ record }: { record: SessionRecord }) {
  const fields = record.targets.map((t) => t.field).filter((f): f is string => !!f);
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Block statistics, scrolls sideways">
      <table>
        <thead>
          <tr>
            <th>Block</th>
            <th>Length</th>
            <th>Technique</th>
            <th>Clean signal</th>
            <th>Time in target</th>
            {fields.map((f) => (
              <th key={f}>{f.split('.').slice(-2).join('.')} (mean)</th>
            ))}
            <th>Your rating</th>
          </tr>
        </thead>
        <tbody>
          {record.blocks.map((b) => (
            <tr key={b.index} style={b.excluded ? { opacity: 0.6 } : undefined}>
              <td>
                {b.index + 1}. {b.id}
                <div className="small faint">
                  {b.kind}
                  {b.feedback ? ', feedback on' : ''}
                  {b.excluded ? ', excluded' : ''}
                </div>
              </td>
              <td>{fmtDuration(b.tEnd - b.tStart)}</td>
              <td>{b.strategy && b.strategy !== 'none' ? (getStrategy(b.strategy)?.name ?? b.strategy) : b.strategy === 'none' ? 'just resting' : ''}</td>
              <td>{numberLine(pct(b.cleanFraction), '%')}</td>
              <td>{numberLine(pct(b.successCombined), '%')}</td>
              {fields.map((f) => {
                const s = b.stats[f];
                return (
                  <td key={f}>
                    {numberLine(s?.mean, '', s && s.sd !== null && s.ess ? s.sd / Math.sqrt(s.ess) : null)}
                  </td>
                );
              })}
              <td>{b.rating ? Object.entries(b.rating).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ') : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
