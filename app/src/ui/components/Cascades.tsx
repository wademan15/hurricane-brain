/**
 * The two cascades and the combined state, first-class on the live screen and in history.
 * Each shows whether its state is active, its steps, how long it has held, and the chance level
 * alongside (CLAUDE.md rule 3). A cascade with no frame behind it is "not measured" with a reason.
 */
import type { Cascade, SlowFrame } from '../../engine/frames';
import type { CascadeEvent, CascadeSnapshot, KeyCell } from '../../storage';
import { GOLDEN_RATIO_TEXT } from '../copy';
import { fmtDuration, measuredLine, notMeasuredText, numberLine, reasonPlain } from '../measured';
import type { Live } from './LiveReadout';

const stateWord = (active: boolean) => (active ? 'in the state' : 'not in the state');

function CascadeCell({ cls, title, cascades, active, forS, live }: { cls: string; title: string; cascades: Cascade[]; active: boolean | null; forS: number | null; live: Live }) {
  if (active === null) {
    return (
      <div className={`cellbox ${cls}`} data-testid={`cascade-${cls}`}>
        <div className="k">{title}</div>
        <div className="v nm">
          not measured
          <small>{live.slowStale ? reasonPlain('stale') : reasonPlain('no_frame')}</small>
        </div>
      </div>
    );
  }
  return (
    <div className={`cellbox ${cls}`} data-testid={`cascade-${cls}`}>
      <div className="k">{title}</div>
      <div className="v">{stateWord(active)}</div>
      {cascades.map((c) => (
        <div className="s" key={c.target}>
          {cascades.length > 1 ? `${c.target === 'phi' ? 'golden' : 'octave'}: ` : ''}
          {c.steps} step{c.steps === 1 ? '' : 's'}, held {fmtDuration(c.held_s)}
          . chance A {measuredLine(c.chance.a.closeness)}{c.chance.b.closeness.v !== null ? `, B ${measuredLine(c.chance.b.closeness)}` : ''}
        </div>
      ))}
      <div className="s">{active ? 'in this condition' : 'out of it'} for {fmtDuration(forS)}</div>
    </div>
  );
}

export function CascadeStates({ live }: { live: Live }) {
  const f: SlowFrame | null = live.slow;
  const phi = f?.cascades.phi;
  const oct = f?.cascades.octave;
  return (
    <div className="trio" aria-label="Golden ratio cascade, octave cascade, and both at once" style={{ marginTop: 8 }}>
      <CascadeCell cls="phi" title="Golden ratio cascade" cascades={phi ? [phi] : []} active={f ? f.states.phi.active : null} forS={f ? f.states.phi.for_s : null} live={live} />
      <CascadeCell cls="oct" title="Octave cascade" cascades={oct ? [oct] : []} active={f ? f.states.octave.active : null} forS={f ? f.states.octave.for_s : null} live={live} />
      <CascadeCell cls="both" title="Both at once" cascades={phi && oct ? [phi, oct] : []} active={f ? f.states.both.active : null} forS={f ? f.states.both.for_s : null} live={live} />
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
      <strong>{p.target === 'phi' ? 'Golden ratio' : 'Octave'}</strong>: up to {p.maxSteps} step{p.maxSteps === 1 ? '' : 's'};{' '}
      {p.members.map((m) => `${m.band} ${cellText(m.freqHz, 'Hz')}`).join(' > ') || 'no members'};{' '}
      ratios {p.ratios.map((r) => cellText(r)).join(', ') || 'none'}; alignment {cellText(p.closeness)}, chance A {cellText(p.chanceA)}, chance B {cellText(p.chanceB)}
    </div>
  );
}

/** The cascade event log of a stored session. */
export function CascadeEventLog({ events, tStart }: { events: CascadeEvent[]; tStart: number }) {
  if (!events.length) {
    return <p className="dim" data-testid="event-log-empty">No golden ratio, octave or combined state held during this session. Nothing was logged because nothing was measured as active.</p>;
  }
  return (
    <div className="table-wrap" data-testid="event-log">
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
