/**
 * Every way the UI can show "not measured" must carry its reason (CLAUDE.md rule 1). These
 * render the components with frames full of nulls, with no frame at all, and with stale frames,
 * and check that no "not measured" is left bare.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Measured, SlowFrame } from '../../engine/frames';
import { slowFrame } from '../../training/test-fixtures';
import { BlockTable } from '../components/BlockTable';
import { CascadeEventLog, CascadeStates, StateStrip } from '../components/Cascades';
import { FitCoach } from '../components/FitCoach';
import { KeyChart } from '../components/KeyChart';
import { HemisphereTable, PairTable } from '../components/LiveDetails';
import { AlignmentDetails, AlignmentTrio, HeartLine, PeaksLine, SignalLine, type Live } from '../components/LiveReadout';
import { Val, Num } from '../components/kit';
import { fmtDuration, measuredLine, notMeasuredText, numberLine } from '../measured';
import { NO_HOLD } from '../state/fit';

const NULL = (why: Measured['why']): Measured => ({ v: null, se: null, why });

/** Remove every "not measured" that has a reason after it; whatever remains is a bare one. */
function bare(html: string): string[] {
  const text = html
    .replace(/not measured<small>[^<]+<\/small>/g, '')
    .replace(/not measured( in this session)? \([^)]+\)/g, '')
    .replace(/<[^>]+>/g, ' ');
  return text.match(/.{0,30}not measured.{0,30}/gi) ?? [];
}

/** A slow frame in which every measured value is null with some reason. */
function allNull(): SlowFrame {
  const f = slowFrame(10, { alphaTrack: { freq: 12, height: 6 }, thetaTrack: { freq: 7.4, height: 5 }, hemiMatch: 0.5 });
  for (const c of [f.cascades.phi, f.cascades.octave]) {
    c.closeness = NULL('unresolved');
    c.excess_a = NULL('warming_up');
    c.excess_b = NULL('warming_up');
    c.chance = { a: { closeness: NULL('no_data'), p: NULL('no_data'), p_steps: NULL('no_data') }, b: { closeness: NULL('warming_up'), p: NULL('warming_up'), p_steps: NULL('warming_up') } };
  }
  for (const t of f.tracks) {
    t.freq_integrated = NULL('not_confirmed');
    t.height_db = NULL('not_confirmed');
  }
  const tgt = { miss: NULL('unresolved'), closeness: NULL('unresolved'), log_evidence: NULL('unresolved'), aligned: false };
  f.pairs = [{ lo: 2, hi: 1, log_ratio: NULL('unresolved'), harmonic: false, targets: { phi: tgt, octave: tgt, ratio_3: tgt, control_1_5: tgt, control_1_8: tgt } }];
  f.hemispheres = [{ track: 1, freq_diff: NULL('no_data'), balance: NULL('no_data'), locking_excess: NULL('warming_up'), match: NULL('no_data') }];
  return f;
}

const live = (slow: SlowFrame | null, stale = false): Live => ({ slow, heart: null, slowStale: stale, heartStale: stale });

describe('every null rendering path includes its reason', () => {
  it('the text helpers', () => {
    expect(bare(measuredLine(null))).toEqual([]);
    expect(bare(measuredLine(undefined))).toEqual([]);
    expect(bare(measuredLine(NULL('ok')))).toEqual([]);
    expect(bare(measuredLine(NULL('gap')))).toEqual([]);
    expect(bare(numberLine(null))).toEqual([]);
    expect(bare(notMeasuredText('stale'))).toEqual([]);
    expect(bare(fmtDuration(null))).toEqual([]);
    expect(bare(renderToStaticMarkup(<Val m={null} />))).toEqual([]);
    expect(bare(renderToStaticMarkup(<Val m={NULL('ok')} />))).toEqual([]);
    expect(bare(renderToStaticMarkup(<Num v={null} />))).toEqual([]);
    // A reason is never empty, and a null is never shown as zero.
    expect(renderToStaticMarkup(<Val m={NULL('bad_fit')} />)).not.toMatch(/>0</);
  });

  for (const [name, l] of [['no frame yet', live(null)], ['stale frames', live(null, true)], ['all values null', live(allNull())], ['a normal frame', live(slowFrame(5))]] as const) {
    it(`the live readouts with ${name}`, () => {
      const html = renderToStaticMarkup(
        <div>
          <AlignmentTrio live={l} />
          <AlignmentDetails live={l} chanceDriver="a" />
          <AlignmentDetails live={l} chanceDriver="b" />
          <CascadeStates live={l} />
          <StateStrip live={l} />
          <SignalLine live={l} />
          <SignalLine live={l} compact />
          <PeaksLine live={l} harmonicsCount={false} />
          <HeartLine live={l} heartExpected />
          <HeartLine live={l} heartExpected={false} />
          <PairTable slow={l.slow} harmonicsCount={false} />
          <HemisphereTable slow={l.slow} />
        </div>,
      );
      expect(bare(html)).toEqual([]);
      if (name !== 'a normal frame') expect(html).toMatch(/not measured/i);
    });
  }

  it('the fit coach with no frame, and with every channel failing', () => {
    const bad = slowFrame(3, { usable: false });
    const none = renderToStaticMarkup(<FitCoach slow={null} hold={NO_HOLD} requiredS={10} good={false} smallHead={false} />);
    const failing = renderToStaticMarkup(<FitCoach slow={bad} hold={NO_HOLD} requiredS={10} good={false} smallHead />);
    expect(bare(none)).toEqual([]);
    expect(bare(failing)).toEqual([]);
    expect(failing).toMatch(/not usable/);
    expect(failing).toMatch(/Smaller heads and children/);
  });

  it('stored sessions: a chart with no values, a block with no statistics, an empty event log', () => {
    const rows = [{ t: 1, block: null, cells: { alpha_db: { v: null, why: 'bad_contact' as const } } }];
    expect(bare(renderToStaticMarkup(<KeyChart rows={rows} col="alpha_db" label="Alpha" unit="dB" />))).toEqual([]);
    expect(bare(renderToStaticMarkup(<KeyChart rows={[]} col="alpha_db" label="Alpha" unit="dB" />))).toEqual([]);
    expect(renderToStaticMarkup(<KeyChart rows={rows} col="alpha_db" label="Alpha" unit="dB" />)).toMatch(/not measured in this session \(/);
    const record = {
      id: 's', targets: [{ field: 'x' }], blocks: [{ index: 0, id: 'b', kind: 'train', strategy: null, label: null, feedback: true, eyes: 'closed', tStart: 0, tEnd: 60, plannedS: 60, cleanFraction: null, excluded: false, techniques: [], successCombined: null, stats: {}, rating: null }],
    } as never;
    expect(bare(renderToStaticMarkup(<BlockTable record={record} />))).toEqual([]);
    expect(bare(renderToStaticMarkup(<CascadeEventLog events={[]} tStart={0} />))).toEqual([]);
  });

  it('chance B that is not there yet says how long it needs, never zero', () => {
    const f = slowFrame(10, { phiExcess: 0.4, phiSteps: 2 });
    f.cascades.phi.excess_b = NULL('warming_up');
    f.cascades.phi.chance.b = { closeness: NULL('warming_up'), p: NULL('warming_up'), p_steps: NULL('warming_up') };
    const html = renderToStaticMarkup(<div><AlignmentTrio live={live(f)} /><AlignmentDetails live={live(f)} chanceDriver="a" /></div>);
    expect(bare(html)).toEqual([]);
    expect(html).toMatch(/chance B needs about 2 to 3 minutes of data/);
    expect(html).toMatch(/beyond your own usual pattern \(B\)/);
  });

  it('the main readout uses plain words, with the precise terms in the details', () => {
    const f = slowFrame(10, { phiExcess: 0.4, phiSteps: 2 });
    f.cascades.phi.chance.a.p = { v: 0.03, se: null, why: 'ok' };
    const main = renderToStaticMarkup(<div><AlignmentTrio live={live(f)} /><StateStrip live={live(f)} /></div>);
    for (const jargon of [/over chance A/i, /p \(A\)/, /\bsteps?\b/i, /in the state/i, /\bheld\b/i, /chance A\/B/i]) expect(main).not.toMatch(jargon);
    expect(main).toMatch(/Random peaks did this well: 3 in 100/);
    expect(main).toMatch(/a chain of 3 peaks/);
    // golden ratio, octave and chance stay side by side in one group
    expect(main).toMatch(/aria-label="Golden ratio alignment, octave alignment and chance level, side by side"/);
    expect(main.match(/data-testid="cell-(phi|oct|chance)"/g)).toHaveLength(3);
  });

  it('each state has its own icon class, and a filled badge only while the engine says it is holding', () => {
    const f = slowFrame(10);
    f.states.phi = { ...f.states.phi, active: true, for_s: 9, stat: { v: 0.9, why: 'ok' }, exit_at: 0.3 };
    f.states.octave = { ...f.states.octave, active: false, for_s: 4 };
    const html = renderToStaticMarkup(<StateStrip live={live(f)} />);
    expect(html).toMatch(/state-badge phi on[^>]*>[\s\S]*Holding 0:09/);
    expect(html).toMatch(/state-badge oct off[^>]*>[\s\S]*Not holding/);
    expect(html).toMatch(/state-badge both off/);
    const paths = [...html.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(paths).size).toBe(3);
  });

  it('a harmonic pair is labelled possible harmonic, not counted, also when pending', () => {
    const f = allNull();
    f.pairs = f.pairs.map((p) => ({ ...p, harmonic: true }));
    const html = renderToStaticMarkup(<PairTable slow={f} harmonicsCount={false} />);
    expect(html).toMatch(/possible harmonic, not counted/);
    expect(renderToStaticMarkup(<PairTable slow={f} harmonicsCount />)).toMatch(/possible harmonic, counted as you chose/);
  });
});
