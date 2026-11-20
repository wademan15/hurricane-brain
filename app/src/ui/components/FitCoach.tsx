/**
 * Live headband fit and contact coaching. Shows each sensor's contact from the engine's own
 * per-channel quality, with plain fixes for every failing channel and every kind of artifact
 * the engine saw, and a clear good-to-go state that needs the signal to stay usable for a
 * number of seconds. Pure layout: the hold logic is in state/fit.ts.
 */
import type { ChannelQuality, SlowFrame } from '../../engine/frames';
import { CHANNEL_HELP, FIX_BY_ARTIFACT, FIX_BY_REASON, GENERAL_FIT_TIPS, SMALL_HEAD_TIPS } from '../copy';
import { reasonPlain } from '../measured';
import type { FitHold } from '../state/fit';
import { Badge, Card, Num } from './kit';

/** The headband, from above, with the four sensor positions. A diagram, not a measurement. */
export function HeadDiagram({ usable }: { usable: Record<string, boolean | undefined> }) {
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

/** What to do about one channel, from its engine reason and the artifacts seen on it. */
export function fixesFor(q: ChannelQuality): string[] {
  const out: string[] = [];
  if (!q.usable) {
    out.push(FIX_BY_REASON[q.why] ?? 'Check the fit of the band.');
    const help = CHANNEL_HELP[q.name];
    if (help && (q.why === 'bad_contact' || q.why === 'no_data')) out.push(help.tip);
  }
  for (const a of q.artifacts) if (FIX_BY_ARTIFACT[a] && !out.includes(FIX_BY_ARTIFACT[a])) out.push(FIX_BY_ARTIFACT[a]);
  return out;
}

export function FitCoach({
  slow, hold, requiredS, good, smallHead,
}: { slow: SlowFrame | null; hold: FitHold; requiredS: number; good: boolean; smallHead: boolean }) {
  const byName = Object.fromEntries((slow?.quality ?? []).map((q) => [q.name, q.usable]));
  const waiting = !slow || slow.quality.length === 0;
  const progress = good ? 1 : Math.min(1, hold.goodForS / Math.max(1, requiredS));
  return (
    <div className="stack">
      <Card>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <HeadDiagram usable={byName} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <h2 data-testid="fit-state">
              {good ? 'Good to go' : waiting ? 'Waiting for the first signal' : hold.goodSinceT !== null ? 'Hold still, almost there' : 'Some sensors need attention'}
            </h2>
            <p className="dim" aria-live="polite">
              {waiting
                ? 'Nothing is measured yet. It takes a few seconds after the headset connects.'
                : good
                  ? 'Every sensor has been usable for long enough.'
                  : hold.goodSinceT !== null
                    ? `Every sensor is usable. Keep still for ${Math.max(0, Math.ceil(requiredS - hold.goodForS))} more seconds.`
                    : `Every sensor needs to be usable for ${requiredS} seconds in a row. Fix the ones marked below.`}
            </p>
            <div className="meter" role="progressbar" aria-label="Seconds of good signal" aria-valuemin={0} aria-valuemax={requiredS} aria-valuenow={Math.round(progress * requiredS)}>
              <i style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        </div>
        {slow?.quality.map((q) => {
          const fixes = fixesFor(q);
          return (
            <div className="fit-ch" key={q.name}>
              <span className={`dot ${q.usable ? 'ok' : 'bad'}`} aria-hidden="true" />
              <div style={{ flex: 1 }}>
                <div className="row split">
                  <strong>
                    {q.name} <span className="dim small">{CHANNEL_HELP[q.name]?.where ?? ''}</span>
                  </strong>
                  <Badge tone={q.usable ? 'ok' : 'bad'}>{q.usable ? 'usable' : 'not usable'}</Badge>
                </div>
                {!q.usable ? <div className="small">{reasonPlain(q.why)}.</div> : null}
                {fixes.map((f) => <div className="small" key={f}>{f}</div>)}
                <div className="small dim">
                  Clean {Math.round(q.clean_fraction * 100)}% . noise level <Num v={q.sd_uv} unit="uV" /> . muscle <Num v={q.emg_db} unit="dB" />
                  {q.artifacts.length ? ` . seen: ${q.artifacts.join(', ')}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </Card>
      <Card>
        <h3>Quick fit tips</h3>
        <ul>{GENERAL_FIT_TIPS.map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}</ul>
        <details open={smallHead}>
          <summary>Smaller heads and children</summary>
          <ul>{SMALL_HEAD_TIPS.map((t) => <li key={t} style={{ marginBottom: 6 }}>{t}</li>)}</ul>
        </details>
      </Card>
    </div>
  );
}
