import { describe, expect, it } from 'vitest';
import { compileField } from './fields';
import { instantiateProgram, validateProgram, type Program } from './program';
import { NOT_OFFERED, PROGRAMS } from './programs';
import { STRATEGIES } from './strategies';

describe('program library', () => {
  it('every program validates', () => {
    for (const p of PROGRAMS) {
      const issues = validateProgram(p);
      if (issues.length) console.log(p.id, issues);
      expect(issues).toEqual([]);
    }
  });

  it('every program instantiates with defaults and at every ladder level', () => {
    for (const p of PROGRAMS) {
      const levels = p.ladder ? [1, 2, 3, 4, 5] : [undefined];
      for (const level of levels) {
        const plan = instantiateProgram(p, { level, strategySlots: ['none', 'breath_resonance', 'body_scan', 'visual_calm', 'mantra_silent'], probeOrder: ['anchor', 'control', 'control', 'anchor', 'anchor', 'control'], bestStrategy: 'open_awareness' });
        expect(plan.blocks.length).toBeGreaterThan(0);
        for (const f of plan.statFields) expect(() => compileField(f)).not.toThrow();
        if (level === 4) expect(plan.blocks.some((x) => x.kind === 'transfer')).toBe(true);
      }
    }
  });

  it('includes the required program families', () => {
    const ids = PROGRAMS.map((p) => p.id);
    for (const id of ['alpha_eyes_closed', 'alpha_eyes_open', 'theta_drift', 'alpha_theta_twilight', 'sleep_onset_descent', 'golden_ratio_alignment', 'golden_cascade_growing', 'octave_alignment', 'hemisphere_balance', 'hrv_resonance_finding', 'hrv_resonance_breathing', 'brain_heart_calm', 'emotional_state_practice', 'signature_practice', 'anchor_pairing', 'anchor_probe']) {
      expect(ids).toContain(id);
    }
    expect(NOT_OFFERED.map((n) => n.target)).toEqual(expect.arrayContaining(['gamma', 'smr', 'waking_delta', 'entrainment']));
  });

  it('is plain JSON and round-trips', () => {
    const json = JSON.stringify(PROGRAMS);
    expect(JSON.stringify(JSON.parse(json))).toBe(json);
  });

  it('rejects forbidden targets, entrainment, medical wording and golden ratio without octave and chance', () => {
    const base = PROGRAMS.find((p) => p.id === 'alpha_eyes_closed') as Program;
    const gamma: Program = { ...base, targets: [{ ...base.targets[0], field: 'spectra[temporal].bands.gamma.above_bg_db' }] };
    expect(validateProgram(gamma).some((i) => /cannot be trained/.test(i.message))).toBe(true);
    const delta: Program = { ...base, targets: [{ ...base.targets[0], field: 'spectra[temporal].bands.delta.above_bg_db' }] };
    expect(validateProgram(delta).length).toBeGreaterThan(0);
    const entrain: Program = { ...base, bindings: { ...base.bindings, sound: [...base.bindings.sound, { element: 'reward_layer', reads: 'reward', note: 'binaural beat at 10 Hz' }] } };
    expect(validateProgram(entrain).some((i) => /entrainment/.test(i.message))).toBe(true);
    const medical: Program = { ...base, summary: 'Treats anxiety.' };
    expect(validateProgram(medical).some((i) => /medical/.test(i.message))).toBe(true);
    const phiAlone: Program = { ...base, targets: [{ ...base.targets[0], field: 'cascades.phi.excess_a' }], bindings: { ...base.bindings, display: [] } };
    const msgs = validateProgram(phiAlone).map((i) => i.message).join(' ');
    expect(msgs).toMatch(/octave/);
    expect(msgs).toMatch(/chance/);
    const unknown: Program = { ...base, targets: [{ ...base.targets[0], field: 'spectra[temporal].bands.alpha.nonsense' }] };
    expect(validateProgram(unknown).length).toBeGreaterThan(0);
  });

  it('variable choices change the target field', () => {
    const p = PROGRAMS.find((x) => x.id === 'alpha_eyes_closed') as Program;
    const plan = instantiateProgram(p, { values: { alpha_metric: 'spectra[temporal].bands.alpha.above_bg_db', train_block_s: 240 } });
    expect(plan.targets[0].field).toBe('spectra[temporal].bands.alpha.above_bg_db');
    expect(plan.blocks.find((x) => x.kind === 'train')?.durationS).toBe(240);
    expect(() => instantiateProgram(p, { values: { train_block_s: 5 } })).toThrow();
    expect(() => instantiateProgram(p, { values: { no_such: 1 } })).toThrow();
  });

  it('discovery skips unfilled slots', () => {
    const p = PROGRAMS.find((x) => x.id === 'discovery_sampler') as Program;
    const plan = instantiateProgram(p, { strategySlots: ['none', 'body_scan'] });
    expect(plan.blocks.filter((x) => x.kind === 'strategy').map((x) => x.strategy)).toEqual(['none', 'body_scan']);
  });
});

describe('strategy library', () => {
  it('has unique ids, valid expected-effect fields, grades and every family', () => {
    const ids = new Set<string>();
    for (const s of STRATEGIES) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(s.steps.length).toBeGreaterThan(0);
      expect(['A', 'A-B', 'B', 'B-C', 'C', 'C-D', 'D']).toContain(s.evidence.grade);
      for (const e of s.expectedEffects) expect(() => compileField(e.field)).not.toThrow();
      expect(JSON.stringify(s)).not.toMatch(/binaural|isochronic|monaural/i);
    }
    const fams = new Set(STRATEGIES.map((s) => s.family));
    for (const f of ['breath', 'attention', 'visualization', 'body', 'emotional_recall', 'mantra_sound', 'movement']) expect(fams.has(f as never)).toBe(true);
  });
});
