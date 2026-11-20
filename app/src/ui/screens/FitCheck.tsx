import { useEffect, useState } from 'react';
import { Badge, Button, Card, Note, PageHeader, Num } from '../components/kit';
import { FIT_STEPS } from '../copy';
import { summarizeSignal } from '../measured';
import { useController, useServices } from '../state/app';

function useLatestSlow() {
  const { controller } = useServices();
  const [slow, setSlow] = useState(controller.hub.latest().slow);
  useEffect(() => {
    return controller.hub.subscribe((f) => {
      if (f.kind === 'slow') setSlow(f);
    });
  }, [controller]);
  return slow;
}

/** The headband, from above, with the four sensor positions. A diagram, not a measurement. */
function HeadDiagram({ usable }: { usable: Record<string, boolean | undefined> }) {
  const dot = (name: string, x: number, y: number) => {
    const u = usable[name];
    const fill = u === undefined ? 'var(--diagram-unknown)' : u ? 'var(--diagram-ok)' : 'var(--diagram-bad)';
    return (
      <g key={name}>
        <circle cx={x} cy={y} r="11" fill={fill} />
        <text x={x} y={y + (y < 100 ? -18 : 28)} textAnchor="middle" fontSize="12" fill="currentColor">{name}</text>
      </g>
    );
  };
  return (
    <svg viewBox="0 0 240 200" width="240" role="img" aria-label="Top view of a head. Front sensors AF7 and AF8 are on the forehead, rear sensors TP9 and TP10 are behind the ears." style={{ maxWidth: '100%' }}>
      <ellipse cx="120" cy="100" rx="70" ry="84" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" />
      <path d="M108 14 L120 2 L132 14" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" />
      <ellipse cx="46" cy="104" rx="8" ry="16" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" />
      <ellipse cx="194" cy="104" rx="8" ry="16" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" />
      {dot('AF7', 88, 40)}
      {dot('AF8', 152, 40)}
      {dot('TP9', 58, 128)}
      {dot('TP10', 182, 128)}
    </svg>
  );
}

export function FitCheck({ navigate }: { navigate: (to: string) => void }) {
  const st = useController();
  const slow = useLatestSlow();
  const sig = summarizeSignal(slow);
  const byName = Object.fromEntries(sig.channels.map((c) => [c.name, c.usable]));
  const live = st.link !== null;
  return (
    <div>
      <PageHeader title="Fit and signal check" sub="Contact quality for each sensor, from the engine's own measurement." />
      {!live ? (
        <Note tone="warn">
          No headset is connected, so nothing is measured. Connect a headset on the Home screen, or replay a recording to see its signal quality.{' '}
          <Button size="small" onClick={() => navigate('home')}>Go to Home</Button>
        </Note>
      ) : null}
      <Card>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <HeadDiagram usable={byName} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2>{sig.level === 'good' ? 'All sensors usable' : sig.level === 'none' ? 'Signal not measured' : 'Some sensors need attention'}</h2>
            <p className="dim" aria-live="polite">{sig.text}</p>
            {slow ? <p className="small dim">Based on the last {slow.window_s.toFixed(0)} seconds of data.</p> : null}
          </div>
        </div>
        {sig.channels.length === 0 && live ? <p className="dim">Waiting for the first data from the engine.</p> : null}
        {slow?.quality.map((q) => (
          <div className="fit-ch" key={q.name}>
            <span className={`dot ${q.usable ? 'ok' : 'bad'}`} aria-hidden="true" />
            <div style={{ flex: 1 }}>
              <div className="row split">
                <strong>{q.name}</strong>
                <Badge tone={q.usable ? 'ok' : 'bad'}>{q.usable ? 'usable' : 'not usable'}</Badge>
              </div>
              {!q.usable ? <div className="small">{sig.channels.find((c) => c.name === q.name)?.reason}. {sig.channels.find((c) => c.name === q.name)?.fix}</div> : null}
              <div className="small dim">
                Clean {Math.round(q.clean_fraction * 100)}% . noise level <Num v={q.sd_uv} unit="uV" /> . muscle <Num v={q.emg_db} unit="dB" /> . mains <Num v={q.mains_uv} unit="uV" />
                {q.artifacts.length ? ` . seen: ${q.artifacts.join(', ')}` : ''}
              </div>
            </div>
          </div>
        ))}
      </Card>
      <Card>
        <h2>Fitting the headband</h2>
        <ol className="steps">
          {FIT_STEPS.map((s) => (
            <li key={s.title}>
              <strong>{s.title}</strong>
              <div className="dim">{s.text}</div>
            </li>
          ))}
        </ol>
        <p className="small dim">Most sessions are eyes closed, so get the fit right first and then you will not need to look at the screen.</p>
      </Card>
    </div>
  );
}
