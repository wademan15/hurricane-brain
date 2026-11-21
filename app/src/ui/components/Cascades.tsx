/**
 * The two cascades and the combined state, first-class on the live screen and in history.
 * Each shows whether its state is active, its steps, how long it has held, and the chance level
 * alongside (CLAUDE.md rule 3). A cascade with no frame behind it is "not measured" with a reason.
 */
import type { Cascade, SlowFrame } from '../../engine/frames';
import type { CascadeEvent, CascadeSnapshot, KeyCell } from '../../storage';
import { GOLDEN_RATIO_TEXT } from '../copy';
import { fmtDuration, measuredLine, notMeasuredText, numberLine, reasonPlain } from '../measured';
import { chainText, type Live } from './LiveReadout';
import { StateIcon } from './kit';
import { statusesOf, type StateStatus } from '../stateStatus';

type Kind = 'phi' | 'octave' | 'both';
const STATE_NAME: Record<Kind, string> = { phi: 'Golden ratio', octave: 'Octave', both: 'Both at once' };
const KIND_CLS: Record<Kind, string> = { phi: 'phi', octave: 'oct', both: 'both' };

/**
 * One state as a badge: its own icon and colour, filled with "Holding 0:09" while the engine says
 * the state is active, outlined and muted with "Not holding" when it is not. Never by colour alone.
 */
function StateBadge({ kind, status, forS, live }: { kind: Kind; status: StateStatus | null; forS: number | null; live: Live }) {
  const cls = KIND_CLS[kind];
  if (status === null) {
    return (
      <span className={`state-badge ${cls} off`} data-testid={`state-${cls}`}>
        <StateIcon kind={kind} />
        <span><strong>{STATE_NAME[kind]}</strong> <span className="nm">not measured<small>{live.slowStale ? reasonPlain('stale') : reasonPlain('no_frame')}</small></span></span>
      </span>
    );
  }
  return (
    <span className={`state-badge ${cls} ${status === 'holding' ? 'on' : status === 'fading' ? 'fade' : 'off'}`} data-testid={`state-${cls}`}>
      <StateIcon kind={kind} />
      <span><strong>{STATE_NAME[kind]}</strong> {status === 'holding' ? `Holding ${fmtDuration(forS)}` : status === 'fading' ? 'Fading' : 'Not holding'}</span>
    </span>
  );
}

/** The pinned strip: the three states, each with its own icon and a filled badge while holding. */
export function StateStrip({ live }: { live: Live }) {
  const st = live.slow?.states;
  const sx = st ? statusesOf(st) : null;
  return (
    <div className="state-strip" role="group" aria-label="Golden ratio, octave, and both at once: holding or not">
      <StateBadge kind="phi" status={sx ? sx.phi : null} forS={st ? st.phi.for_s : null} live={live} />
      <StateBadge kind="octave" status={sx ? sx.octave : null} forS={st ? st.octave.for_s : null} live={live} />
      <StateBadge kind="both" status={sx ? sx.both : null} forS={st ? st.both.for_s : null} live={live} />
    </div>
  );
}

/** Per-state detail: the chain, how long it has held, and the chance levels beside it. */
function StateCell({ kind, cascades, status, forS, live }: { kind: Kind; cascades: Cascade[]; status: StateStatus | null; forS: number | null; live: Live }) {
  const cls = KIND_CLS[kind];
  if (status === null) {
    return (
      <div className={`cellbox ${cls}`} data-testid={`cascade-${cls}`}>
        <div className="k"><StateIcon kind={kind} /> {STATE_NAME[kind]} state</div>
        <div className="v nm">
          not measured
          <small>{live.slowStale ? reasonPlain('stale') : reasonPlain('no_frame')}</small>
        </div>
      </div>
    );
  }
  return (
    <div className={`cellbox ${cls}`} data-testid={`cascade-${cls}`}>
      <div className="k"><StateIcon kind={kind} /> {STATE_NAME[kind]} state</div>
      <div className="v">{status === 'holding' ? 'Holding' : status === 'fading' ? 'Fading' : 'Not holding'}</div>
      {cascades.map((c) => (
        <div className="s" key={c.target}>
          {cascades.length > 1 ? `${c.target === 'phi' ? 'Golden' : 'Octave'}: ` : ''}
          {chainText(c)}, random peaks {measuredLine(c.chance.a.closeness)}
          {c.chance.b.closeness.v !== null ? `, your own usual pattern ${measuredLine(c.chance.b.closeness)}` : ''}
        </div>
      ))}
      <div className="s">{status === 'fading' ? 'the engine still counts this state (its exit dwell), but the measured value has already dropped below the exit level' : `${status === 'holding' ? 'holding' : 'not holding'} for ${fmtDuration(forS)}`}</div>
    </div>
  );
}

export function CascadeStates({ live }: { live: Live }) {
  const f: SlowFrame | null = live.slow;
  const phi = f?.cascades.phi;
  const oct = f?.cascades.octave;
  return (
    <div className="trio" role="group" aria-label="Golden ratio state, octave state, and both at once" data-testid="state-cells">
      <StateCell kind="phi" cascades={phi ? [phi] : []} status={f ? statusesOf(f.states).phi : null} forS={f ? f.states.phi.for_s : null} live={live} />
      <StateCell kind="octave" cascades={oct ? [oct] : []} status={f ? statusesOf(f.states).octave : null} forS={f ? f.states.octave.for_s : null} live={live} />
      <StateCell kind="both" cascades={phi && oct ? [phi, oct] : []} status={f ? statusesOf(f.states).both : null} forS={f ? f.states.both.for_s : null} live={live} />
    </div>
  );
}

/** The golden ratio reading, honestly framed as the app's own hypothesis beside what was tested. */
export function GoldenRatioInfo() {
  return (
    <details>
      <summary>About golden ratio alignment</summary>
      <p className="small">{GOLDEN_RATIO_TEXT.measurement}</p>
      <p className="small">{GOLDEN_RATIO_TEXT.research}</p>
      <p className="small">{GOLDEN_RATIO_TEXT.winter}</p>
      <p className="small">{GOLDEN_RATIO_TEXT.mainstream}</p>
      <p className="small dim">{GOLDEN_RATIO_TEXT.stance}</p>
    </details>
  );
}

const cellText = (c: KeyCell | undefined, unit = ''): string => (c && c.v !== null ? `${Number(c.v.toFixed(3))}${unit ? ` ${unit}` : ''}` : notMeasuredText(c?.why ?? 'no_data'));

function PartRow({ p }: { p: CascadeSnapshot }) {
  return (
    <div className="small">
      <strong>{p.target === 'phi' ? 'Golden ratio' : 'Octave'}</strong>: longest chain {p.maxSteps + 1} peaks;{' '}
      {p.members.map((m) => `${m.band} ${cellText(m.freqHz, 'Hz')}`).join(' > ') || 'no members'};{' '}
      ratios {p.ratios.map((r) => cellText(r)).join(', ') || 'none'}; alignment {cellText(p.closeness)}, random peaks (A) {cellText(p.chanceA)}, your own usual pattern (B) {cellText(p.chanceB)}
    </div>
  );
}

/** The cascade event log of a stored session. */
export function CascadeEventLog({ events, tStart }: { events: CascadeEvent[]; tStart: number }) {
  if (!events.length) {
    return <p className="dim" data-testid="event-log-empty">No golden ratio, octave or combined state held during this session. Nothing was logged because nothing was measured as active.</p>;
  }
  return (
    <div className="table-wrap" data-testid="event-log" tabIndex={0} role="region" aria-label="Cascade event log, scrolls sideways">
      <table>
        <thead>
          <tr><th>State</th><th>Started</th><th>Lasted</th><th>Details (from the engine frames)</th></tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={i}>
              <td>{e.kind === 'phi' ? 'Golden ratio' : e.kind === 'octave' ? 'Octave' : 'Both at once'}</td>
              <td>{fmtDuration(e.tStart - tStart)}</td>
              <td>{numberLine(e.durationS, 's')}</td>
              <td>{e.parts.map((p) => <PartRow key={p.target} p={p} />)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
