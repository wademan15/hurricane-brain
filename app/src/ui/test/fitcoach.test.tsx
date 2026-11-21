import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { slowFrame } from '../../training/test-fixtures';
import { FitCoach, fixesFor } from '../components/FitCoach';

describe('fit coaching', () => {
  it('says good to go only when the hold has lasted long enough, and shows the countdown before that', () => {
    const f = slowFrame(20, {});
    const hold = (s: number) => ({ goodSinceT: 20 - s, goodForS: s, lastT: 20 });
    const early = renderToStaticMarkup(<FitCoach slow={f} hold={hold(4)} requiredS={10} good={false} smallHead={false} />);
    const done = renderToStaticMarkup(<FitCoach slow={f} hold={hold(10)} requiredS={10} good smallHead={false} />);
    expect(early).toContain('Hold still, almost there');
    expect(early).toMatch(/6 more seconds/);
    expect(early).not.toContain('Good to go');
    expect(done).toContain('Good to go');
  });

  it('gives a specific fix for each failing channel and each artifact kind seen', () => {
    const f = slowFrame(5, { usable: false, artifacts: ['muscle', 'blink'] });
    const q = f.quality[0];
    const fixes = fixesFor(q);
    expect(fixes.join(' ')).toMatch(/hair|touching the skin/i); // contact
    expect(fixes.join(' ')).toMatch(/jaw/i); // muscle
    expect(fixes.join(' ')).toMatch(/blink/i);
    // A usable channel with no artifacts needs no fix.
    expect(fixesFor(slowFrame(5, {}).quality[0])).toEqual([]);
    const html = renderToStaticMarkup(<FitCoach slow={f} hold={{ goodSinceT: null, goodForS: 0, lastT: 5 }} requiredS={10} good={false} smallHead={false} />);
    expect(html).toContain('Some sensors need attention');
    for (const name of ['TP9', 'AF7', 'AF8', 'TP10']) expect(html).toContain(name);
  });

  it('opens the small-head and children guidance when the person is a child or teen', () => {
    const f = slowFrame(5, {});
    const open = renderToStaticMarkup(<FitCoach slow={f} hold={{ goodSinceT: null, goodForS: 0, lastT: 5 }} requiredS={10} good={false} smallHead />);
    const closed = renderToStaticMarkup(<FitCoach slow={f} hold={{ goodSinceT: null, goodForS: 0, lastT: 5 }} requiredS={10} good={false} smallHead={false} />);
    expect(open).toMatch(/<details open/);
    expect(closed).not.toMatch(/<details open/);
    expect(open).toMatch(/smaller head/i);
  });
});
