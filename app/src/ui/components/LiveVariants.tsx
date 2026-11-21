/**
 * The pieces the theme layouts and the Readouts setting arrange (docs/design/theming.md). Each is
 * a different way to show the same engine values, and each keeps golden ratio alignment beside
 * octave alignment and the chance level. A null is "not measured" with its reason.
 */
import type { Cascade, SlowFrame } from '../../engine/frames';
import { alignmentWords, chanceWords } from '../words';
import { notMeasuredText, reasonPlain, showFixed } from '../measured';
import { chainText, wait, type Live } from './LiveReadout';
import { StateIcon } from './kit';

const fx = (m: Parameters<typeof showFixed>[0]): string => {
  const s = showFixed(m);
  return s.measured ? s.text : `not measured (${s.reason})`;
};

/** Minimal readouts: one line that carries golden ratio, octave and chance. */
export function OneLine({ live, words, driver }: { live: Live; words: boolean; driver: 'a' | 'b' }) {
  const phi = live.slow?.cascades.phi ?? null;
  const oct = live.slow?.cascades.octave ?? null;
  const none = notMeasuredText(wait(live));
  const chance = (c: Cascade | null) => (!c ? none : words ? chanceWords(c.chance.a.closeness) : fx(c.chance.a.closeness));
  return (
    <p className="one-line" role="group" aria-label="Golden ratio alignment, octave alignment and chance level, side by side">
      <span data-testid="cell-phi"><StateIcon kind="phi" /> Golden ratio alignment <strong>{phi ? (words ? alignmentWords(phi, driver) : fx(phi.closeness)) : none}</strong></span>
      <span data-testid="cell-oct"><StateIcon kind="octave" /> Octave alignment <strong>{oct ? (words ? alignmentWords(oct, driver) : fx(oct.closeness)) : none}</strong></span>
      <span data-testid="cell-chance">Chance (random peaks): golden <strong>{chance(phi)}</strong>, octave <strong>{chance(oct)}</strong></span>
    </p>
  );
}

/** The same three, as three small labelled words for the kid screen: "Golden ratio alignment: high". */
export function WordsTrio({ live, driver }: { live: Live; driver: 'a' | 'b' }) {
  const phi = live.slow?.cascades.phi ?? null;
  const oct = live.slow?.cascades.octave ?? null;
  const none = notMeasuredText(wait(live));
  return (
    <ul className="words-trio" aria-label="Golden ratio alignment, octave alignment and chance level, side by side">
      <li className="phi" data-testid="cell-phi"><StateIcon kind="phi" /> Golden ratio alignment: <strong>{phi ? alignmentWords(phi, driver) : none}</strong></li>
      <li className="oct" data-testid="cell-oct"><StateIcon kind="octave" /> Octave alignment: <strong>{oct ? alignmentWords(oct, driver) : none}</strong></li>
      <li data-testid="cell-chance">Chance level: golden <strong>{phi ? chanceWords(phi.chance.a.closeness) : none}</strong>, octave <strong>{oct ? chanceWords(oct.chance.a.closeness) : none}</strong></li>
    </ul>
  );
}

function Bar({ label, kind, c, live, words }: { label: string; kind: 'phi' | 'oct'; c: Cascade | null; live: Live; words: boolean }) {
  if (!c || c.closeness.v === null) {
    return (
      <div className={`bar-row ${kind}`}>
        <span className="bar-label"><StateIcon kind={kind === 'phi' ? 'phi' : 'octave'} /> {label}</span>
        <span className="nm">not measured<small>{c ? reasonPlain(c.closeness.why === 'ok' ? 'no_data' : c.closeness.why) : reasonPlain(wait(live))}</small></span>
      </div>
    );
  }
  const a = c.chance.a.closeness.v;
  const b = c.chance.b.closeness.v;
  return (
    <div className={`bar-row ${kind}`}>
      <span className="bar-label"><StateIcon kind={kind === 'phi' ? 'phi' : 'octave'} /> {label}</span>
      <div className="bar" role="img" aria-label={`${label} ${words ? alignmentWords(c, 'a') : c.closeness.v.toFixed(2)}${a !== null ? `, chance level random peaks ${words ? chanceWords(c.chance.a.closeness) : a.toFixed(2)}` : ''}`}>
        <i className="bar-fill" style={{ width: `${Math.round(c.closeness.v * 100)}%` }} />
        {a !== null ? <i className="bar-tick a" style={{ left: `${Math.round(a * 100)}%` }} /> : null}
        {b !== null ? <i className="bar-tick b" style={{ left: `${Math.round(b * 100)}%` }} /> : null}
      </div>
      <span className="bar-num">{words ? alignmentWords(c, 'a') : c.closeness.v.toFixed(2)}</span>
    </div>
  );
}

/** Calm Instrument: alignment bars with the chance levels as ticks on the same bars. */
export function AlignmentBars({ live, words }: { live: Live; words: boolean }) {
  const phi = live.slow?.cascades.phi ?? null;
  const oct = live.slow?.cascades.octave ?? null;
  const none = notMeasuredText(wait(live));
  return (
    <div className="bars" role="group" aria-label="Golden ratio alignment, octave alignment and chance level, side by side">
      <div data-testid="cell-phi"><Bar label="Golden ratio alignment" kind="phi" c={phi} live={live} words={words} /></div>
      <div data-testid="cell-oct"><Bar label="Octave alignment" kind="oct" c={oct} live={live} words={words} /></div>
      <p className="bar-legend small" data-testid="cell-chance">
        <span className="tick-sample a" aria-hidden="true" /> Chance, random peaks: golden {phi ? (words ? chanceWords(phi.chance.a.closeness) : fx(phi.chance.a.closeness)) : none}, octave {oct ? (words ? chanceWords(oct.chance.a.closeness) : fx(oct.chance.a.closeness)) : none}.{' '}
        <span className="tick-sample b" aria-hidden="true" /> Your own usual pattern: {(phi?.chance.b.closeness.v ?? null) !== null ? 'shown as the dashed tick' : 'not measured (chance B needs about 2 to 3 minutes of data)'}.
      </p>
    </div>
  );
}

function members(slow: SlowFrame | null, c: Cascade | undefined): { id: number; text: string }[] {
  if (!slow || !c) return [];
  return c.tracks.map((id) => {
    const t = slow.tracks.find((x) => x.id === id);
    const f = t?.freq_integrated.v;
    return { id, text: t ? `${t.band} ${f !== null && f !== undefined ? f.toFixed(1) : '?'} Hz` : `#${id}` };
  });
}

/** Calm Instrument: the cascade as chips, low to high. */
export function CascadeChips({ live }: { live: Live }) {
  const slow = live.slow;
  const row = (name: string, c: Cascade | undefined) => {
    const m = members(slow, c);
    return (
      <div className="chip-row" key={name}>
        <strong>{name}</strong>
        {m.length ? m.map((x, i) => <span className="chip" key={x.id}>{i > 0 ? '→ ' : ''}{x.text}</span>) : <span className="chip">{slow ? 'no chain of peaks yet' : `not measured (${reasonPlain(wait(live))})`}</span>}
      </div>
    );
  };
  return <div className="chips-col" aria-label="The chains of peaks, low to high">{row('Golden ratio', slow?.cascades.phi)}{row('Octave', slow?.cascades.octave)}</div>;
}

/** Night Garden: the cascade as stepping stones, one per peak in the chain. */
export function StepStones({ live }: { live: Live }) {
  const slow = live.slow;
  const row = (name: string, kind: 'phi' | 'octave', c: Cascade | undefined) => {
    const n = c ? Math.max(c.steps + 1, 0) : 0;
    const total = Math.max(4, n);
    return (
      <div className={`stones ${kind}`} key={name} role="img" aria-label={`${name}: ${c ? chainText(c) : 'not measured'}`}>
        <span className="stones-name"><StateIcon kind={kind} /> {name}</span>
        <span className="stones-row" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => <i key={i} className={i < (c && c.steps > 0 ? n : 0) ? 'stone on' : 'stone'} />)}
        </span>
        <span className="small">{c ? chainText(c) : `not measured (${reasonPlain(wait(live))})`}</span>
      </div>
    );
  };
  return <div className="stones-col">{row('Golden ratio', 'phi', slow?.cascades.phi)}{row('Octave', 'octave', slow?.cascades.octave)}</div>;
}
