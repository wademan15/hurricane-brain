/** Child settings, the shared kit fixes and the one privacy sentence. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getProgram, createProfile } from '../../training';
import { DEFAULT_APP_SETTINGS } from '../../storage';
import { Field, Modal, Segmented } from '../components/kit';
import { PRIVACY, PRIVACY_SENTENCE } from '../copy';
import { CHILD_ENGINE_PARAMS, needsIaf, simpleViewOn } from '../session/child';
import { enginePrefs } from '../session/controller';
import { lockedReason } from '../screens/Programs';

describe('child settings', () => {
  it('the child preset values live in one place and merge with the speed', () => {
    expect(CHILD_ENGINE_PARAMS).toEqual({ quality_sd_max_uv: 200 });
    expect(enginePrefs({ responseSpeed: 'quicker', harmonicsCount: false }, 'child')).toEqual({ quality_sd_max_uv: 200, integration_s: 15 });
    expect(enginePrefs({ responseSpeed: 'steady', harmonicsCount: false }, 'adult')).toEqual({});
    expect(enginePrefs({ responseSpeed: 'steady', harmonicsCount: false })).toEqual({});
  });

  it('the simple view is on for a child by default and available to anyone', () => {
    expect(simpleViewOn({ childView: 'auto' }, 'child')).toBe(true);
    expect(simpleViewOn({ childView: 'auto' }, 'adult')).toBe(false);
    expect(simpleViewOn({ childView: 'auto' }, null)).toBe(false);
    expect(simpleViewOn({ childView: 'on' }, 'adult')).toBe(true);
    expect(simpleViewOn({ childView: 'off' }, 'child')).toBe(false);
    expect(DEFAULT_APP_SETTINGS.childView).toBe('auto');
  });

  it('band-based programs need the individual alpha frequency for a child, and calibration does not', () => {
    const profile = createProfile('p1', '2026-01-01T00:00:00.000Z', 1, {}, null);
    const alpha = getProgram('alpha_eyes_closed');
    const cal = getProgram('calibration');
    expect(alpha && cal).toBeTruthy();
    if (!alpha || !cal) return;
    expect(needsIaf(alpha, 'child', profile)).toBe(true);
    expect(needsIaf(alpha, 'adult', profile)).toBe(false);
    expect(needsIaf(cal, 'child', profile)).toBe(false);
    const withIaf = { ...profile, calibrations: [{ ...(profile.calibrations[0] ?? {}), iafHz: 8.2 }] } as never;
    expect(needsIaf(alpha, 'child', withIaf)).toBe(false);
    const still = getProgram('stillness_soft_landing');
    if (still) expect(lockedReason(still, profile, 'child') ?? '').toMatch(/Calibration/);
  });
});

describe('shared kit', () => {
  it('a group of buttons is not wrapped in a label, so tapping its hint cannot change a setting', () => {
    const html = renderToStaticMarkup(
      <Field label="Mains frequency" hint="A hint" group>
        <Segmented label="Mains" value="a" onChange={() => undefined} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />
      </Field>,
    );
    expect(html).not.toMatch(/<label/);
    expect(html).toMatch(/role="group"/);
    expect(html).toMatch(/aria-labelledby/);
    expect(renderToStaticMarkup(<Field label="Name"><input type="text" /></Field>)).toMatch(/<label/);
  });

  it('a dialog is a native modal dialog named by its heading', () => {
    const html = renderToStaticMarkup(<Modal title="Delete?" onClose={() => undefined} actions={<button type="button">Cancel</button>}><p>Sure</p></Modal>);
    expect(html).toMatch(/<dialog/);
    expect(html).toMatch(/aria-labelledby="([^"]+)"/);
    expect(html).toMatch(/<h2 id=/);
  });

  it('the privacy sentence is one accurate statement, first in the list, and names live stream out', () => {
    expect(PRIVACY[0]).toBe(PRIVACY_SENTENCE);
    expect(PRIVACY_SENTENCE).toMatch(/stays on this device unless you export it or turn on live stream out/);
    expect(PRIVACY_SENTENCE).toMatch(/only to the address you enter/);
    expect(PRIVACY.join(' ')).not.toMatch(/never sent anywhere|Nothing is sent anywhere/);
  });
});
