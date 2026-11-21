/**
 * The always-honest readout of the live session. Golden ratio alignment, octave alignment and
 * the chance level are always shown side by side (CLAUDE.md rule 3). A null is "not measured"
 * with its reason; frames that stop arriving show as not measured, never as the last value.
 */
import { useEffect, useState } from 'react';
import type { Cascade, HeartFrame, SlowFrame } from '../../engine/frames';
import { useServices } from '../state/app';
import { alignmentWords, chanceWords } from '../words';
import { CHANCE_B_WAIT, inHundred, measuredLine, measuredLineB, notMeasuredText, reasonPlain, showMeasured, summarizeSignal } from '../measured';
import { Fixed, StateIcon, Val } from './kit';

const SLOW_STALE_MS = 1500;
const HEART_STALE_MS = 3000;

export interface Live {
  slow: SlowFrame | null;
  heart: HeartFrame | null;
  /** True when the slow frame is too old to show. */
  slowStale: boolean;
  heartStale: boolean;
}

/** Latest frames from the hub, re-checked once a second for staleness. */
export function useLive(): Live {
  const { controller } = useServices();
  const [, setN] = useState(0);
  useEffect(() => {
    const unsub = controller.hub.subscribe((f) => {
      if (f.kind !== 'fast') setN((n) => n + 1);
    });
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, [controller]);
  const l = controller.hub.latest();
  const w = performance.now() / 1000;
  const slowStale = l.slowAt === null || (w - l.slowAt) * 1000 > SLOW_STALE_MS;
  const heartStale = l.heartAt === null || (w - l.heartAt) * 1000 > HEART_STALE_MS;
  return { slow: slowStale ? null : l.slow, heart: heartStale ? null : l.heart, slowStale, heartStale };
}

export const wait = (live: Live) => (live.slowStale ? 'stale' : 'no_frame') as 'stale' | 'no_frame';

/** "a chain of 3 peaks", or what is missing. */
export function chainText(c: Cascade | null): string {
  if (!c) return '';
  if (c.steps < 1) return 'no chain of peaks yet';
  return `a chain of ${c.steps + 1} peaks`;
}

/** The chance-A line shared by the cell and the details: "Random peaks did this well: 3 in 100". */
export function randomDidLine(c: Cascade | null, live: Live): string {
  if (!c) return `Random peaks did this well: ${notMeasuredText(wait(live))}`;
  return `Random peaks did this well: ${inHundred(c.chance.a.p)}`;
}

function AlignCell({ kind, c, live, words, driver }: { kind: 'phi' | 'oct'; c: Cascade | null; live: Live; words: boolean; driver: 'a' | 'b' }) {
  const label = kind === 'phi' ? 'Golden ratio alignment' : 'Octave alignment';
  return (
    <div className={`cellbox ${kind}`} data-testid={`cell-${kind}`}>
      <div className="k"><StateIcon kind={kind === 'phi' ? 'phi' : 'octave'} /> {label}</div>
      <div className="v">
        {c ? words ? <span className="words">{alignmentWords(c, driver)}</span> : <Fixed m={c.closeness} /> : <span className="nm">not measured<small>{reasonPlain(wait(live))}</small></span>}
      </div>
      <div className="s">{c ? (words ? chainText(c) : `${randomDidLine(c, live)} · ${chainText(c)}`) : ''}</div>
    </div>
  );
}

/** Chance level for one target as one line: random peaks (A), and your own usual pattern (B) once it is there. */
function ChanceLines({ c, live, target, words }: { c: Cascade | null; live: Live; target: string; words: boolean }) {
  if (!c) return <div><span className="nm">{target}: not measured<small>{reasonPlain(wait(live))}</small></span></div>;
  const a = c.chance.a.closeness;
  const b = c.chance.b.closeness;
  if (words) {
    return (
      <div className="chance-row">
        <span className="chance-target">{target}</span>
        <span className="chance-a words" title="Random peaks (chance A)">{chanceWords(a)}</span>
        {b.v !== null ? <span className="chance-b words" title="Your own usual pattern (chance B)"> / {chanceWords(b)}</span> : null}
      </div>
    );
  }
  return (
    <div className="chance-row">
      <span className="chance-target">{target}</span>
      <span className="chance-a" title="Random peaks (chance A)"><Fixed m={a} /></span>
      {b.v !== null ? <span className="chance-b" title="Your own usual pattern (chance B)"> / <Fixed m={b} /></span> : null}
    </div>
  );
}

export function AlignmentTrio({ live, words = false, driver = 'a' }: { live: Live; words?: boolean; driver?: 'a' | 'b' }) {
  const phi = live.slow?.cascades.phi ?? null;
  const oct = live.slow?.cascades.octave ?? null;
  const bReady = (phi?.chance.b.closeness.v ?? null) !== null || (oct?.chance.b.closeness.v ?? null) !== null;
  return (
    <div className="trio" role="group" aria-label="Golden ratio alignment, octave alignment and chance level, side by side">
      <AlignCell kind="phi" c={phi} live={live} words={words} driver={driver} />
      <AlignCell kind="oct" c={oct} live={live} words={words} driver={driver} />
      <div className="cellbox chance" data-testid="cell-chance">
        <div className="k">Chance (same procedure)</div>
        <div className="v chance-v">
          <ChanceLines c={phi} live={live} target="Golden" words={words} />
          <ChanceLines c={oct} live={live} target="Octave" words={words} />
        </div>
        <div className="s">
          {bReady ? 'Random peaks / your own usual pattern' : `Random peaks. Your own usual pattern: not measured (${CHANCE_B_WAIT})`}
        </div>
      </div>
    </div>
  );
}

/**
 * The precise numbers behind the plain wording, in an expandable view: beyond chance against
 * each chance level, the fraction of chance draws that did as well, and the chain.
 */
export function AlignmentDetails({ live, chanceDriver }: { live: Live; chanceDriver: 'a' | 'b' }) {
  const rows: { name: string; c: Cascade | null }[] = [
    { name: 'Golden ratio', c: live.slow?.cascades.phi ?? null },
    { name: 'Octave', c: live.slow?.cascades.octave ?? null },
  ];
  return (
    <div className="stack" data-testid="alignment-details">
      {rows.map(({ name, c }) => (
        <dl className="kv small" key={name}>
          <dt>{name}: beyond random peaks (A)</dt><dd>{c ? <Fixed m={c.excess_a} /> : notMeasuredText(wait(live))}</dd>
          <dt>{name}: beyond your own usual pattern (B)</dt><dd>{c ? measuredLineB(c.excess_b) : notMeasuredText(wait(live))}</dd>
          <dt>{name}: random peaks did this well</dt><dd>{c ? inHundred(c.chance.a.p) : notMeasuredText(wait(live))}</dd>
          <dt>{name}: your own usual pattern did this well</dt><dd>{c ? (c.chance.b.p.v === null ? measuredLineB(c.chance.b.p) : inHundred(c.chance.b.p)) : notMeasuredText(wait(live))}</dd>
          <dt>{name}: the chain</dt><dd>{c ? `${chainText(c)} (${c.steps} step${c.steps === 1 ? '' : 's'})` : notMeasuredText(wait(live))}</dd>
          <dt>{name}: chance level, random peaks (A)</dt><dd>{c ? measuredLine(c.chance.a.closeness) : notMeasuredText(wait(live))}</dd>
          <dt>{name}: chance level, your own usual pattern (B)</dt><dd>{c ? measuredLineB(c.chance.b.closeness) : notMeasuredText(wait(live))}</dd>
        </dl>
      ))}
      <p className="small live-sub">
        Beyond chance is 0 unless fewer than 5 in 100 chance draws do as well; above that it grows towards 1. It is not a probability. The picture and the sounds follow chance {chanceDriver.toUpperCase()} ({chanceDriver === 'a' ? 'random peaks' : 'your own usual pattern'}).
      </p>
    </div>
  );
}

export function SignalLine({ live, compact }: { live: Live; compact?: boolean }) {
  const sig = summarizeSignal(live.slow);
  const text = live.slowStale && live.slow === null ? 'Signal not measured (no frames arriving)' : compact ? sig.short : sig.text;
  return (
    <span className="chip" data-testid="signal-state" role="status">
      <span className={`dot ${sig.level === 'good' ? 'ok' : sig.level === 'none' ? '' : 'bad'}`} style={{ display: 'inline-block', width: 10, height: 10, marginRight: 6 }} aria-hidden="true" />
      {text}
    </span>
  );
}

export function PeaksLine({ live, harmonicsCount }: { live: Live; harmonicsCount: boolean }) {
  const tracks = live.slow?.tracks.filter((t) => t.state === 'confirmed' && t.freq_integrated.v !== null) ?? [];
  if (!live.slow) return <span className="chip">Peaks: not measured (no frames arriving)</span>;
  if (!tracks.length) return <span className="chip">Peaks: none confirmed against the background yet</span>;
  return (
    <>
      {tracks.map((t) => (
        <span className="chip" key={t.id} title={`track ${t.id}, ${t.band}, height ${measuredLine(t.height_db, 'dB')}`}>
          {t.band}: {showMeasured(t.freq_integrated, 'Hz').text}
          {t.harmonic_of ? ` (possible harmonic x${t.harmonic_of.n}${harmonicsCount ? ', counted as you chose' : ', not counted'})` : ''}
        </span>
      ))}
    </>
  );
}

export function HeartLine({ live, heartExpected }: { live: Live; heartExpected: boolean }) {
  if (!live.heart) {
    return <span className="chip">{heartExpected ? 'Heart: not measured (no frames arriving)' : 'Heart: no heart source connected'}</span>;
  }
  const h = live.heart;
  const src = h.source === 'chest_strap' ? 'chest strap' : h.source === 'headset_ppg' ? 'headset pulse' : 'no source';
  return (
    <>
      <span className="chip">
        HR <Val m={h.hr_bpm} unit="bpm" />
      </span>
      <span className="chip">
        RMSSD <Val m={h.rmssd_ms} unit="ms" />
      </span>
      <span className="chip">
        resonance <Val m={h.resonance_hz} unit="breaths/min" scale={60} />
      </span>
      <span className="chip faint">source: {src}</span>
    </>
  );
}
