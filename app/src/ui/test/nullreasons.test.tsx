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
import { CascadeEventLog, CascadeStates } from '../components/Cascades';
import { FitCoach } from '../components/FitCoach';
import { KeyChart } from '../components/KeyChart';
import { HemisphereTable, PairTable } from '../components/LiveDetails';
import { AlignmentTrio, HeartLine, PeaksLine, SignalLine, type Live } from '../components/LiveReadout';
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
          <AlignmentTrio live={l} chanceDriver="a" />
          <AlignmentTrio live={l} chanceDriver="b" />
          <CascadeStates live={l} />
          <SignalLine live={l} />
          <PeaksLine live={l} />
          <HeartLine live={l} heartExpected />
          <HeartLine live={l} heartExpected={false} />
          <PairTable slow={l.slow} />
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
});
