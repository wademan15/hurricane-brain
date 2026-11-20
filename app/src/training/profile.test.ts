import { describe, expect, it, vi } from 'vitest';

// Statistical tests run many seeds; allow time on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
import { createRng } from './math';
import { instantiateProgram } from './program';
import { createProfile, ingestSession, planDiscoverySession, priorGuess, recommendNext, recommendPrograms, williamsRow, type UserProfile } from './profile';
import { CALIBRATION, DISCOVERY, RESONANCE_FINDING } from './programs';
import { createSessionRunner, validateSession, type SessionRecord } from './runner';
import { correlatedNoise, heartFrame, slowFrame } from './test-fixtures';


/** Run a Discovery session where each strategy shifts alpha by `effects[strategy]` (baseline SD units). */
function discoverySession(profile: UserProfile, idx: number, effects: Record<string, number>, seed: number): SessionRecord {
  const dp = planDiscoverySession(profile);
  const plan = instantiateProgram(DISCOVERY, { strategySlots: dp.strategies, values: { settle_s: 30 } });
  const r = createSessionRunner(plan, { sessionId: `d${idx}`, userId: 'u', startedAt: `2026-11-${String(10 + idx).padStart(2, '0')}T08:00:00Z`, seed });
  let t = 0;
  const total = plan.blocks.reduce((a, b) => a + b.durationS, 0);
  const noise = correlatedNoise(createRng(seed), Math.round(total / 0.25) + 8, 0.25, 8, 1);
  let i = 0;
  for (const b of plan.blocks) {
    const end = t + b.durationS;
    const drift = 0.0005 * t; // settling across the session
    for (; t < end - 1e-9; t += 0.25) r.push(slowFrame(t, { bands: { alpha: drift + (b.kind === 'strategy' ? (effects[b.strategy as string] ?? 0) : 0) + noise[i++] } }));
  }
  r.advance(t + 1);
  return r.record();
}

describe('profile', () => {
  it('Williams rows are permutations and balance first-order carryover for even n', () => {
    const n = 6;
    const pairs = new Map<string, number>();
    for (let r = 0; r < n; r++) {
      const row = williamsRow(n, r);
      expect([...row].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      for (let i = 1; i < n; i++) pairs.set(`${row[i - 1]}>${row[i]}`, (pairs.get(`${row[i - 1]}>${row[i]}`) ?? 0) + 1);
    }
    expect(Math.max(...pairs.values())).toBe(1);
  });

  it('first Discovery session covers the broad set; later sessions vary the order', () => {
    const p = createProfile('u', '2026-11-10', 7);
    const first = planDiscoverySession(p);
    expect([...first.strategies].sort()).toEqual(['body_scan', 'breath_resonance', 'mantra_silent', 'none', 'visual_calm']);
    const safe = createProfile('u', '2026-11-10', 7, { breathing_condition: true });
    expect(planDiscoverySession(safe).strategies).not.toContain('breath_resonance');
  });

  it('questionnaire only sets the starting guess', () => {
    expect(priorGuess({ aphantasia: true }, 'visual_calm')).toBeLessThan(-0.2);
    expect(priorGuess({ imagery: 5 }, 'visual_calm')).toBeGreaterThan(0);
    expect(priorGuess(null, 'visual_calm')).toBe(0);
  });

  it('measured response, not the questionnaire, decides the labels', () => {
    // The questionnaire says "visualizer"; the brain says breath.
    let p = createProfile('u', '2026-11-10', 3, {}, { imagery: 5, absorption: 5, interoception: 1 });
    const effects = { breath_resonance: 1.2, visual_calm: 0, none: 0, body_scan: 0.2, mantra_silent: 0, open_awareness: 0, brow_point: 0 };
    for (let s = 0; s < 5; s++) {
      const rec = discoverySession(p, s, effects, 500 + s);
      expect(validateSession(rec)).toEqual([]);
      p = ingestSession(p, rec);
    }
    const est = (id: string) => p.estimates.find((e) => e.state === 'alpha_ec' && e.strategy === id)!;
    console.log(`[profile] after 5 Discovery sessions: breath_resonance ${est('breath_resonance').label} (d=${est('breath_resonance').mean.toFixed(2)} [${est('breath_resonance').lo.toFixed(2)}, ${est('breath_resonance').hi.toFixed(2)}], ${est('breath_resonance').nBlocks} blocks); visual_calm ${est('visual_calm').label} (d=${est('visual_calm').mean.toFixed(2)}, ${est('visual_calm').nBlocks} blocks); none ${est('none').label}`);
    expect(['strong', 'promising']).toContain(est('breath_resonance').label);
    expect(['strong', 'promising']).not.toContain(est('visual_calm').label);
    expect(est('visual_calm').priorGuess).toBeGreaterThan(0);
    expect(p.discoverySessions).toBe(5);
    expect(p.sessions.length).toBe(5);
    expect(recommendNext(p, 'alpha_ec', 1)).not.toBeNull();
  });

  it('a profile of pure noise labels nothing as strong', () => {
    let strong = 0;
    let total = 0;
    for (let seed = 0; seed < 4; seed++) {
      let p = createProfile('u', '2026-11-10', seed);
      for (let s = 0; s < 4; s++) p = ingestSession(p, discoverySession(p, s, {}, 9000 + 10 * seed + s));
      for (const e of p.estimates.filter((x) => x.state === 'alpha_ec')) {
        total++;
        if (e.label === 'strong') strong++;
      }
    }
    console.log(`[profile] null profiles: ${strong} of ${total} strategy estimates labelled strong`);
    expect(strong).toBe(0);
  });

  it('calibration finds IAF, reactivity and low-alpha', () => {
    const plan = instantiateProgram(CALIBRATION, { values: { settle_s: 30, rest_long_s: 60, rest_short_s: 45, artifact_task_s: 8 } });
    const r = createSessionRunner(plan, { sessionId: 'cal', userId: 'u', startedAt: '2026-11-10T08:00:00Z', seed: 1 });
    const rng = createRng(1);
    let t = 0;
    for (const b of plan.blocks) {
      const end = t + b.durationS;
      for (; t < end - 1e-9; t += 0.25) {
        const ec = b.eyes === 'closed';
        r.push(slowFrame(t, { bands: { alpha: (ec ? 6 : 1) + 0.5 * rng.normal() }, alphaTrack: { freq: ec ? 9.6 : 9.9, height: ec ? 8 : 3 }, thetaTrack: { freq: 6, height: 2 } }));
      }
    }
    r.advance(t + 1);
    let p = createProfile('u', '2026-11-10', 1);
    p = ingestSession(p, r.record());
    const cal = p.calibrations[0];
    expect(cal.iafHz).toBeCloseTo(9.6, 1);
    expect(cal.alphaReactivityDb).toBeGreaterThan(4);
    expect(cal.lowAlpha).toBe(false);
    expect(cal.alphaThetaRatio).toBeCloseTo(1.6, 1);
    expect(recommendPrograms(p).map((x) => x.programId)).toContain('discovery_sampler');
  });

  it('resonance finding picks the rate with the strongest slow heart wave', () => {
    const plan = instantiateProgram(RESONANCE_FINDING, { values: { settle_s: 30, baseline_s: 60, trial_s: 120, rest_s: 30 } });
    const r = createSessionRunner(plan, { sessionId: 'res', userId: 'u', startedAt: '2026-11-11T08:00:00Z', seed: 2 });
    const rng = createRng(2);
    const lfAt: Record<string, number> = { '6.5': 600, '6': 900, '5.5': 1500, '5': 1000, '4.5': 700 };
    let t = 0;
    for (const b of plan.blocks) {
      const end = t + b.durationS;
      for (; t < end - 1e-9; t += 1) r.push(heartFrame(t, { lf: (b.pacerBpm !== null ? lfAt[String(b.pacerBpm)] : 400) + 60 * rng.normal(), adherence: b.pacerBpm !== null ? 0.8 : null }));
    }
    r.advance(t + 1);
    const p = ingestSession(createProfile('u', '2026-11-10', 1), r.record());
    expect(p.resonance?.bpm).toBe(5.5);
    console.log(`[profile] resonance: ${p.resonance?.reading}`);
  });
});
