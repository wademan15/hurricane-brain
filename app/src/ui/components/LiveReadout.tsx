/**
 * The always-honest readout of the live session. Golden ratio alignment, octave alignment and
 * the chance level are always shown side by side (CLAUDE.md rule 3). A null is "not measured"
 * with its reason; frames that stop arriving show as not measured, never as the last value.
 */
import { useEffect, useState } from 'react';
import type { Cascade, ChanceLevel, HeartFrame, Measured, SlowFrame } from '../../engine/frames';
import { useServices } from '../state/app';
import { measuredLine, notMeasuredText, showMeasured, summarizeSignal } from '../measured';
import { Val } from './kit';

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

const NO_FRAME: Measured = { v: null, se: null, why: 'no_data' };

function chanceText(c: ChanceLevel): Measured {
  return c.closeness;
}

function AlignCell({ kind, c, live, chanceDriver }: { kind: 'phi' | 'oct'; c: Cascade | null; live: Live; chanceDriver: 'a' | 'b' }) {
  const label = kind === 'phi' ? 'Golden ratio alignment' : 'Octave alignment';
  const closeness = c ? c.closeness : live.slowStale ? { v: null, se: null, why: 'no_data' as const } : undefined;
  const excess = c ? (chanceDriver === 'a' ? c.excess_a : c.excess_b) : undefined;
  return (
    <div className={`cellbox ${kind}`} data-testid={`cell-${kind}`}>
      <div className="k">{label}</div>
      <div className="v">
        <Val m={closeness} />
      </div>
      <div className="s">
        over chance {chanceDriver.toUpperCase()}: <Val m={excess} />
        {c ? ` . ${c.steps} step${c.steps === 1 ? '' : 's'}` : ''}
      </div>
    </div>
  );
}

export function AlignmentTrio({ live, chanceDriver }: { live: Live; chanceDriver: 'a' | 'b' }) {
  const phi = live.slow?.cascades.phi ?? null;
  const oct = live.slow?.cascades.octave ?? null;
  const miss = NO_FRAME;
  return (
    <div className="trio" aria-label="Golden ratio alignment, octave alignment and chance level, side by side">
      <AlignCell kind="phi" c={phi} live={live} chanceDriver={chanceDriver} />
      <AlignCell kind="oct" c={oct} live={live} chanceDriver={chanceDriver} />
      <div className="cellbox" data-testid="cell-chance">
        <div className="k">Chance level (same procedure)</div>
        <div className="v" style={{ fontSize: '0.9rem' }}>
          A: <Val m={phi ? chanceText(phi.chance.a) : live.slowStale ? miss : undefined} /> / <Val m={oct ? chanceText(oct.chance.a) : live.slowStale ? miss : undefined} />
        </div>
        <div className="s">
          golden / octave. B: {phi ? measuredLine(phi.chance.b.closeness) : notMeasuredText('no_frame')} / {oct ? measuredLine(oct.chance.b.closeness) : notMeasuredText('no_frame')}
        </div>
        <div className="s">p (A): {phi ? measuredLine(phi.chance.a.p) : notMeasuredText('no_frame')}</div>
      </div>
    </div>
  );
}

export function SignalLine({ live }: { live: Live }) {
  const sig = summarizeSignal(live.slow);
  const text = live.slowStale && live.slow === null ? 'Signal not measured (no frames arriving)' : sig.text;
  return (
    <span className="chip" data-testid="signal-state" role="status">
      <span className={`dot ${sig.level === 'good' ? 'ok' : sig.level === 'none' ? '' : 'bad'}`} style={{ display: 'inline-block', width: 10, height: 10, marginRight: 6 }} aria-hidden="true" />
      {text}
    </span>
  );
}

export function PeaksLine({ live }: { live: Live }) {
  const tracks = live.slow?.tracks.filter((t) => t.state === 'confirmed' && t.freq_integrated.v !== null) ?? [];
  if (!live.slow) return <span className="chip">Peaks: not measured (no frames arriving)</span>;
  if (!tracks.length) return <span className="chip">Peaks: none confirmed against the background yet</span>;
  return (
    <>
      {tracks.map((t) => (
        <span className="chip" key={t.id} title={`track ${t.id}, ${t.band}, height ${measuredLine(t.height_db, 'dB')}`}>
          {t.band}: {showMeasured(t.freq_integrated, 'Hz').text}
          {t.harmonic_of ? ` (harmonic x${t.harmonic_of.n})` : ''}
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
